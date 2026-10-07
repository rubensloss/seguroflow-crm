import { Router, Request, Response } from "express";
import { prisma } from "../config/prisma";
import { env } from "../config/env";
import { encryptSensitive, decryptSensitive } from "../security/crypto";
import {
  validateTwilioWebhookSignature,
  handleMissedCall,
  processCallAudio,
} from "../services/telephony";
import { CallDirection, CallStatus } from "@prisma/client";

export const telephonyRouter = Router();

/**
 * Escapa caracteres especiais XML para garantir TwiML bem-formado.
 */
export function escapeXml(unsafe: string): string {
  if (!unsafe) return "";
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Reconstrói a URL pública completa do webhook para validação HMAC-SHA1 do Twilio.
 * Considera PUBLIC_BASE_URL configurado e cabeçalhos de proxy reverso (Railway / Cloudflare).
 */
export function getWebhookFullUrl(req: Request): string {
  const publicBase = process.env.PUBLIC_BASE_URL || env.PUBLIC_BASE_URL;
  if (publicBase && publicBase.trim().length > 0) {
    const base = publicBase.trim().replace(/\/$/, "");
    return `${base}${req.originalUrl}`;
  }

  const protoHeader = req.headers["x-forwarded-proto"];
  const proto = typeof protoHeader === "string"
    ? protoHeader.split(",")[0].trim()
    : req.protocol;

  const hostHeader = req.headers["x-forwarded-host"];
  const host = typeof hostHeader === "string"
    ? hostHeader.split(",")[0].trim()
    : req.get("host") || "localhost";

  return `${proto}://${host}${req.originalUrl}`;
}

/**
 * Extrai a fila ordenada de telefones da equipe para repasse sequencial.
 * NUNCA utiliza número pessoal padrão hardcoded.
 */
export function parseTelephonyQueue(brokerage: {
  telephonyQueue?: any;
  telephonyForwardPhone?: string | null;
  phone?: string | null;
}): string[] {
  // 1. Array explícito em telephonyQueue
  if (Array.isArray(brokerage.telephonyQueue) && brokerage.telephonyQueue.length > 0) {
    const list = brokerage.telephonyQueue
      .map((item) => (typeof item === "string" ? item : item?.phone))
      .filter((p): p is string => Boolean(p && typeof p === "string" && p.trim().length > 0))
      .map((p) => p.trim());
    if (list.length > 0) return list;
  }

  // 2. Lista separada por vírgula / ponto-e-vírgula em telephonyForwardPhone
  if (brokerage.telephonyForwardPhone && brokerage.telephonyForwardPhone.trim().length > 0) {
    const phones = brokerage.telephonyForwardPhone
      .split(/[,;\n]+/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    if (phones.length > 0) return phones;
  }

  // 3. Telefone geral da corretora
  if (brokerage.phone && brokerage.phone.trim().length > 0) {
    return [brokerage.phone.trim()];
  }

  return [];
}

/**
 * Autentica o webhook da operadora telefônica (Twilio HMAC-SHA1).
 * Rejeita com 401 caso a corretora não tenha token configurado ou a assinatura seja inválida.
 */
function verifyTwilioWebhook(brokerage: any, req: Request, res: Response): boolean {
  if (!brokerage || !brokerage.telephonyAuthTokenEncrypted) {
    console.warn(`[Telefonia] Rejeitado: Corretora sem Auth Token de telefonia configurado.`);
    res.status(401).type("text/xml").send("<Response><Reject/></Response>");
    return false;
  }

  const authToken = decryptSensitive(brokerage.telephonyAuthTokenEncrypted);
  if (!authToken) {
    console.warn(`[Telefonia] Rejeitado: Não foi possível decifrar o Auth Token.`);
    res.status(401).type("text/xml").send("<Response><Reject/></Response>");
    return false;
  }

  const twilioSignature = req.headers["x-twilio-signature"] as string | undefined;
  if (!twilioSignature) {
    console.warn(`[Telefonia] Rejeitado: Cabeçalho X-Twilio-Signature ausente.`);
    res.status(401).type("text/xml").send("<Response><Reject/></Response>");
    return false;
  }

  const fullUrl = getWebhookFullUrl(req);
  const isValid = validateTwilioWebhookSignature(
    authToken,
    fullUrl,
    req.body as Record<string, string>,
    twilioSignature
  );

  if (!isValid) {
    console.warn(`[Telefonia] Rejeitado: Assinatura inválida para a URL ${fullUrl}`);
    res.status(401).type("text/xml").send("<Response><Reject/></Response>");
    return false;
  }

  return true;
}

/**
 * Webhook Principal de Chamada de Entrada (Inbound Call)
 * Recebe chamadas de entrada, autentica, toca o aviso legal e inicia a fila de repasse.
 */
telephonyRouter.post("/:brokerageSlug/webhook", async (req: Request, res: Response) => {
  const { brokerageSlug } = req.params;

  const brokerage = await prisma.brokerage.findUnique({
    where: { slug: brokerageSlug },
  });

  if (!brokerage) {
    res.status(404).type("text/xml").send("<Response><Reject/></Response>");
    return;
  }

  // 1. Exige autenticação e assinatura oficial Twilio
  if (!verifyTwilioWebhook(brokerage, req, res)) {
    return;
  }

  const callSid = req.body.CallSid || `CALL-${Date.now()}`;
  const fromPhone = req.body.From || "";
  const toPhone = req.body.To || brokerage.telephonyNumber || "";
  const callStatus = (req.body.CallStatus || "ringing").toLowerCase();

  // Localiza segurado se cadastrado pelo telefone
  const cleanPhone = fromPhone.replace(/\D/g, "");
  const insured = cleanPhone
    ? await prisma.insured.findFirst({
        where: {
          brokerageId: brokerage.id,
          phone: { contains: cleanPhone.slice(-8) },
        },
      })
    : null;

  // Se a chamada de entrada encerrou prematuramente antes do atendimento
  if (["no-answer", "busy", "failed", "canceled"].includes(callStatus)) {
    await prisma.callRecord.create({
      data: {
        id: callSid,
        brokerageId: brokerage.id,
        insuredId: insured?.id,
        fromPhone,
        toPhone,
        direction: CallDirection.INBOUND,
        status: CallStatus.NO_ANSWER,
        summary: "Chamada perdida cancelada ou não atendida.",
      },
    });

    await handleMissedCall({
      brokerageId: brokerage.id,
      fromPhone,
      callRecordId: callSid,
    });

    res.type("text/xml").send("<Response><Hangup/></Response>");
    return;
  }

  // 2. Extrai a fila ordenada de telefones da equipe
  const queue = parseTelephonyQueue(brokerage);

  // Se a corretora NÃO possui telefone/fila de repasse configurado:
  // NUNCA repassa para telefone pessoal não autorizado!
  if (queue.length === 0) {
    await prisma.callRecord.create({
      data: {
        id: callSid,
        brokerageId: brokerage.id,
        insuredId: insured?.id,
        fromPhone,
        toPhone,
        direction: CallDirection.INBOUND,
        status: CallStatus.NO_ANSWER,
        summary: "Chamada recebida sem telefone de repasse configurado na corretora.",
      },
    });

    await handleMissedCall({
      brokerageId: brokerage.id,
      fromPhone,
      callRecordId: callSid,
    });

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="pt-BR">Não foi possível completar sua ligação agora. Você receberá retorno pelo WhatsApp.</Say>
  <Hangup/>
</Response>`;
    res.type("text/xml").send(twiml);
    return;
  }

  // 3. Monta TwiML de atendimento:
  // - Aviso legal de gravação com escape XML
  // - Inicia discagem para o primeiro atendente da fila com timeout de 15s
  // - Callback de gravação e action para próximo da fila caso não atenda
  const recordingNotice = brokerage.telephonyRecordingNotice || "Esta ligação é gravada para agilizar o seu atendimento.";
  const baseUrl = getWebhookFullUrl(req).split("/api/telephony")[0];
  const callbackUrl = `${baseUrl}/api/telephony/${brokerageSlug}/recording-callback?callSid=${encodeURIComponent(callSid)}`;
  const actionUrl = `${baseUrl}/api/telephony/${brokerageSlug}/dial-step?step=1&callSid=${encodeURIComponent(callSid)}&fromPhone=${encodeURIComponent(fromPhone)}&toPhone=${encodeURIComponent(toPhone)}`;

  const firstPhone = queue[0];

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="pt-BR">${escapeXml(recordingNotice)}</Say>
  <Dial timeout="15" record="record-from-answer" recordingStatusCallback="${escapeXml(callbackUrl)}" action="${escapeXml(actionUrl)}">
    <Number>${escapeXml(firstPhone)}</Number>
  </Dial>
</Response>`;

  res.type("text/xml").send(twiml);
});

/**
 * Fila Sequencial da Equipe (Multi-Agent Queue Step)
 * Chamado pelo Twilio se o atendente anterior não atender ou estiver ocupado.
 */
telephonyRouter.post("/:brokerageSlug/dial-step", async (req: Request, res: Response) => {
  const { brokerageSlug } = req.params;

  const brokerage = await prisma.brokerage.findUnique({
    where: { slug: brokerageSlug },
  });

  if (!brokerage) {
    res.status(404).type("text/xml").send("<Response><Reject/></Response>");
    return;
  }

  if (!verifyTwilioWebhook(brokerage, req, res)) {
    return;
  }

  const dialCallStatus = (req.body.DialCallStatus || "").toLowerCase();
  const callSid = (req.query.callSid as string) || req.body.CallSid || `CALL-${Date.now()}`;
  const fromPhone = (req.query.fromPhone as string) || req.body.From || "";
  const toPhone = (req.query.toPhone as string) || req.body.To || brokerage.telephonyNumber || "";
  const step = parseInt((req.query.step as string) || "1", 10);

  // Se a ligação foi atendida e concluída pelo atendente anterior, encerra
  if (dialCallStatus === "completed" || dialCallStatus === "answered") {
    res.type("text/xml").send("<Response><Hangup/></Response>");
    return;
  }

  // Atendente não atendeu ou estava ocupado: tenta o próximo da fila
  const queue = parseTelephonyQueue(brokerage);

  if (step < queue.length) {
    const nextPhone = queue[step];
    const baseUrl = getWebhookFullUrl(req).split("/api/telephony")[0];
    const callbackUrl = `${baseUrl}/api/telephony/${brokerageSlug}/recording-callback?callSid=${encodeURIComponent(callSid)}`;
    const actionUrl = `${baseUrl}/api/telephony/${brokerageSlug}/dial-step?step=${step + 1}&callSid=${encodeURIComponent(callSid)}&fromPhone=${encodeURIComponent(fromPhone)}&toPhone=${encodeURIComponent(toPhone)}`;

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="15" record="record-from-answer" recordingStatusCallback="${escapeXml(callbackUrl)}" action="${escapeXml(actionUrl)}">
    <Number>${escapeXml(nextPhone)}</Number>
  </Dial>
</Response>`;

    res.type("text/xml").send(twiml);
    return;
  }

  // Toda a fila de atendentes foi esgotada sem atendimento:
  // Trata como ligação perdida oficial (Card urgente + WhatsApp com assistência 24h)
  const cleanPhone = fromPhone.replace(/\D/g, "");
  const insured = cleanPhone
    ? await prisma.insured.findFirst({
        where: {
          brokerageId: brokerage.id,
          phone: { contains: cleanPhone.slice(-8) },
        },
      })
    : null;

  await prisma.callRecord.upsert({
    where: { id: callSid },
    create: {
      id: callSid,
      brokerageId: brokerage.id,
      insuredId: insured?.id,
      fromPhone,
      toPhone,
      direction: CallDirection.INBOUND,
      status: CallStatus.NO_ANSWER,
      summary: `Chamada não atendida após tentar todos os ${queue.length} atendente(s) da fila.`,
    },
    update: {
      status: CallStatus.NO_ANSWER,
      summary: `Chamada não atendida após tentar todos os ${queue.length} atendente(s) da fila.`,
    },
  });

  await handleMissedCall({
    brokerageId: brokerage.id,
    fromPhone,
    callRecordId: callSid,
  });

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="pt-BR">Não foi possível completar sua ligação agora. Nossos atendentes estão ocupados. Você receberá retorno pelo WhatsApp.</Say>
  <Hangup/>
</Response>`;

  res.type("text/xml").send(twiml);
});

/**
 * Callback de Gravação Finalizada
 * Recebe a URL do áudio gravado pela operadora e processa Whisper + Claude Sonnet 4.5
 */
telephonyRouter.post("/:brokerageSlug/recording-callback", async (req: Request, res: Response) => {
  const { brokerageSlug } = req.params;
  const callSid = (req.query.callSid as string) || req.body.CallSid;
  const recordingUrl = req.body.RecordingUrl;
  const duration = parseInt(req.body.RecordingDuration || "0", 10);

  const brokerage = await prisma.brokerage.findUnique({
    where: { slug: brokerageSlug },
  });

  if (!brokerage) {
    res.status(404).send("Brokerage not found");
    return;
  }

  // Exige validação de assinatura para evitar injeção de áudios forjados
  if (!verifyTwilioWebhook(brokerage, req, res)) {
    return;
  }

  if (!recordingUrl) {
    res.status(200).send("OK");
    return;
  }

  // Cria ou atualiza o registro da chamada
  const call = await prisma.callRecord.upsert({
    where: { id: callSid },
    create: {
      id: callSid,
      brokerageId: brokerage.id,
      fromPhone: req.body.From || "Desconhecido",
      toPhone: req.body.To || brokerage.telephonyNumber || "",
      direction: CallDirection.INBOUND,
      status: CallStatus.COMPLETED,
      durationSeconds: duration,
      recordingUrl: `${recordingUrl}.mp3`,
      summary: "Processando transcrição e inteligência...",
    },
    update: {
      durationSeconds: duration,
      recordingUrl: `${recordingUrl}.mp3`,
      status: CallStatus.COMPLETED,
    },
  });

  // Processa áudio em segundo plano (baixa com Basic Auth, salva cópia criptografada, limpa Twilio e roda Whisper + Claude)
  (async () => {
    try {
      let authHeader: string | undefined;
      if (brokerage.telephonyAccountSidEncrypted && brokerage.telephonyAuthTokenEncrypted) {
        const sid = decryptSensitive(brokerage.telephonyAccountSidEncrypted);
        const token = decryptSensitive(brokerage.telephonyAuthTokenEncrypted);
        if (sid && token) {
          authHeader = `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`;
        }
      }

      const headers: Record<string, string> = {};
      if (authHeader) headers["Authorization"] = authHeader;

      // 1. Baixa áudio (tenta com Basic Auth exigido pela Twilio e fallback sem auth)
      let audioRes = await fetch(`${recordingUrl}.mp3`, { headers });
      if (!audioRes.ok && authHeader) {
        audioRes = await fetch(`${recordingUrl}.mp3`);
      }

      if (audioRes.ok) {
        const arrayBuf = await audioRes.arrayBuffer();
        const audioBuffer = Buffer.from(arrayBuf);

        // 2. Guarda cópia criptografada localmente (AES-256-GCM)
        const encryptedAudio = encryptSensitive(audioBuffer.toString("base64"));
        await prisma.callRecord.update({
          where: { id: call.id },
          data: {
            recordingAudioEncrypted: encryptedAudio,
          },
        });

        // 3. Apaga a gravação remota no Twilio por privacidade e segurança LGPD
        if (authHeader) {
          try {
            await fetch(recordingUrl, {
              method: "DELETE",
              headers: { Authorization: authHeader },
            });
          } catch (delErr) {
            console.warn(`[Telefonia] Falha ao deletar gravação no Twilio após cópia local:`, delErr);
          }
        }

        // 4. Executa Whisper e extração com Claude Sonnet
        await processCallAudio({
          callRecordId: call.id,
          audioBuffer,
          mimeType: "audio/mp3",
          durationSeconds: duration,
        });
      }
    } catch (err) {
      console.error(`Erro ao processar gravação assíncrona da chamada ${callSid}:`, err);
    }
  })();

  res.status(200).send("OK");
});
