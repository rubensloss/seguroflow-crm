import { Router, Request, Response } from "express";
import { prisma } from "../config/prisma";
import { decryptSensitive } from "../security/crypto";
import {
  validateTwilioWebhookSignature,
  handleMissedCall,
  processCallAudio,
} from "../services/telephony";
import { CallDirection, CallStatus } from "@prisma/client";

export const telephonyRouter = Router();

/**
 * Webhook de Telefonia Oficial (Twilio / Zenvia) por Corretora (Slug)
 * Recebe chamadas de entrada, toca o aviso legal de gravação e repassa para o corretor.
 */
telephonyRouter.post("/:brokerageSlug/webhook", async (req: Request, res: Response) => {
  const { brokerageSlug } = req.params;

  const brokerage = await prisma.brokerage.findUnique({
    where: { slug: brokerageSlug },
  });

  if (!brokerage) {
    res.status(404).send("<Response><Reject/></Response>");
    return;
  }

  // Validação de assinatura se a corretora possui Auth Token configurado
  if (brokerage.telephonyAuthTokenEncrypted) {
    const authToken = decryptSensitive(brokerage.telephonyAuthTokenEncrypted);
    if (authToken) {
      const twilioSignature = req.headers["x-twilio-signature"] as string | undefined;
      const fullUrl = `${req.protocol}://${req.get("host")}${req.originalUrl}`;

      const isValid = validateTwilioWebhookSignature(
        authToken,
        fullUrl,
        req.body as Record<string, string>,
        twilioSignature
      );

      if (!isValid) {
        console.warn(`[Telefonia] Assinatura inválida no webhook da corretora ${brokerageSlug}`);
        res.status(401).send("<Response><Reject/></Response>");
        return;
      }
    }
  }

  const callSid = req.body.CallSid || `CALL-${Date.now()}`;
  const fromPhone = req.body.From || "";
  const toPhone = req.body.To || brokerage.telephonyNumber || "";
  const callStatus = (req.body.CallStatus || "ringing").toLowerCase();

  // Localiza segurado se cadastrado
  const cleanPhone = fromPhone.replace(/\D/g, "");
  const insured = cleanPhone
    ? await prisma.insured.findFirst({
        where: {
          brokerageId: brokerage.id,
          phone: { contains: cleanPhone.slice(-8) },
        },
      })
    : null;

  // Se a chamada terminou sem ser atendida (Perdida)
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
        summary: "Chamada perdida não atendida pelo corretor.",
      },
    });

    // Dispara fluxo de chamada perdida (WhatsApp + Alerta + Card no Funil)
    await handleMissedCall({
      brokerageId: brokerage.id,
      fromPhone,
      callRecordId: callSid,
    });

    res.type("text/xml").send("<Response><Hangup/></Response>");
    return;
  }

  // Chamada de Entrada Ativa:
  // 1. Toca mensagem legal de gravação
  // 2. Repassa chamada (<Dial>) para o celular do corretor com gravação ligada
  const forwardPhone = brokerage.telephonyForwardPhone || brokerage.phone || "+5527988140076";
  const recordingNotice = brokerage.telephonyRecordingNotice || "Esta ligação é gravada para agilizar o seu atendimento.";
  const callbackUrl = `${req.protocol}://${req.get("host")}/api/telephony/${brokerageSlug}/recording-callback?callSid=${callSid}`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="pt-BR">${recordingNotice}</Say>
  <Dial record="record-from-answer" recordingStatusCallback="${callbackUrl}">
    <Number>${forwardPhone}</Number>
  </Dial>
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

  if (!brokerage || !recordingUrl) {
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

  // Processa áudio em segundo plano (baixa e roda Whisper + Claude)
  (async () => {
    try {
      const audioRes = await fetch(`${recordingUrl}.mp3`);
      if (audioRes.ok) {
        const arrayBuf = await audioRes.arrayBuffer();
        await processCallAudio({
          callRecordId: call.id,
          audioBuffer: Buffer.from(arrayBuf),
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
