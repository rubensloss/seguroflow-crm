import crypto from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import { CallDirection, CallStatus, CallDraftStatus, CallIntentType, InsuranceBranch, ClaimStatus, PipelineStage } from "@prisma/client";
import { prisma } from "../config/prisma";
import { env } from "../config/env";
import { decryptSensitive } from "../security/crypto";
import { transcribeAudioBuffer } from "./transcription";
import { resolveAssistance24hPhone } from "./insurerDirectory";
import { sendWhatsAppTextMessage, sendWhatsAppTemplateMessage } from "./whatsappCloud";

function getAnthropicClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY;
  return apiKey ? new Anthropic({ apiKey }) : null;
}

/**
 * Validação rigorosa de assinatura HMAC-SHA1 do webhook da Twilio.
 * Garante que somente requisições autênticas assinadas com o AuthToken da corretora sejam aceitas.
 */
export function validateTwilioWebhookSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signatureHeader?: string
): boolean {
  if (!signatureHeader) return false;

  try {
    // Ordena as chaves dos parâmetros lexicograficamente
    const sortedKeys = Object.keys(params).sort();
    let data = url;
    for (const key of sortedKeys) {
      data += `${key}${params[key]}`;
    }

    const hmac = crypto.createHmac("sha1", authToken);
    hmac.update(data, "utf-8");
    const expectedSignature = hmac.digest("base64");

    const sigBuf = Buffer.from(signatureHeader, "utf-8");
    const expBuf = Buffer.from(expectedSignature, "utf-8");

    if (sigBuf.length !== expBuf.length) {
      return false;
    }

    return crypto.timingSafeEqual(sigBuf, expBuf);
  } catch (err) {
    console.error("Erro na validação de assinatura de telefonia:", err);
    return false;
  }
}

/**
 * Calcula o custo estimado total de uma ligação (Entrada + Repasse Móvel + Gravação + Whisper + IA)
 */
export function estimateCallCost(durationSeconds: number): number {
  const minutes = Math.max(1, Math.ceil(durationSeconds / 60));
  const inboundCost = minutes * 0.08;      // Tarifa média DID Brasil
  const forwardingCost = minutes * 0.28;   // Repasse para celular móvel BR
  const recordingCost = minutes * 0.02;    // Gravação e armazenamento
  const whisperCost = minutes * 0.035;     // OpenAI Whisper (~$0.006/min)
  const llmCost = 0.05;                    // Extração Claude Sonnet 4.5

  const total = inboundCost + forwardingCost + recordingCost + whisperCost + llmCost;
  return Math.round(total * 10000) / 10000;
}

export interface ExtractedCallIntelligence {
  intent: CallIntentType;
  summary: string;
  insurer: string | null;
  policyNumber: string | null;
  plate: string | null;
  location: string | null;
  urgency: "BAIXA" | "MEDIA" | "ALTA" | "URGENTE";
  nextSteps: string;
}

/**
 * Processa a inteligência da transcrição com o Claude Sonnet 4.5
 * REGRA RIGOROSA: NUNCA inventar dados ausentes. Se não falou a placa, 'plate' deve ser null.
 */
export async function extractCallIntelligence(
  transcription: string
): Promise<ExtractedCallIntelligence> {
  const anthropic = getAnthropicClient();

  if (!anthropic) {
    console.warn("[Telephony AI] Sem chave Anthropic — gerando estrutura básica sem inventar dados");
    return {
      intent: CallIntentType.OUTRO,
      summary: transcription.slice(0, 160) || "Transcrição de chamada recebida.",
      insurer: null,
      policyNumber: null,
      plate: null,
      location: null,
      urgency: "MEDIA",
      nextSteps: "Conferir áudio original da ligação.",
    };
  }

  const prompt = `Você é um analista especialista em atendimento telefônico de corretoras de seguros no Brasil.
Analise a transcrição desta chamada telefônica entre o segurado e a corretora.

TRANSCRIÇÃO:
"""
${transcription}
"""

REGRAS OBRIGATÓRIAS:
1. Responda ESTRITAMENTE em formato JSON.
2. NUNCA invente dados. Se a placa, seguradora, apólice ou endereço NÃO foram ditos explicitamente na conversa, preencha como null.
3. Classifique a intenção em exatamente uma destas opções: "SINISTRO", "COTACAO", "RENOVACAO", "DUVIDA", "COBRANCA", "OUTRO".
4. Resumo de no máximo 2 linhas, focado no problema e no que foi combinado.
5. Urgência: "BAIXA", "MEDIA", "ALTA" ou "URGENTE" (se for colisão/acidente em trânsito com guincho, marque URGENTE).

Estrutura JSON esperada:
{
  "intent": "SINISTRO" | "COTACAO" | "RENOVACAO" | "DUVIDA" | "COBRANCA" | "OUTRO",
  "summary": "Resumo de 2 linhas sobre o atendimento",
  "insurer": "Nome da Seguradora mencionada ou null",
  "policyNumber": "Número da Apólice mencionado ou null",
  "plate": "Placa do veículo mencionada ou null",
  "location": "Local do ocorrido ou null",
  "urgency": "BAIXA" | "MEDIA" | "ALTA" | "URGENTE",
  "nextSteps": "Próxima ação do corretor"
}`;

  try {
    const res = await anthropic.messages.create({
      model: env.ANTHROPIC_MODEL,
      max_tokens: 1000,
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
    });

    const text = res.content[0].type === "text" ? res.content[0].text : "";
    const cleanJson = text.replace(/```json/g, "").replace(/```/g, "").trim();
    const data = JSON.parse(cleanJson);

    return {
      intent: data.intent && Object.values(CallIntentType).includes(data.intent) ? data.intent : CallIntentType.OUTRO,
      summary: data.summary || "Atendimento telefônico registrado.",
      insurer: data.insurer || null,
      policyNumber: data.policyNumber || null,
      plate: data.plate || null,
      location: data.location || null,
      urgency: data.urgency || "MEDIA",
      nextSteps: data.nextSteps || "Entrar em contato com o cliente.",
    };
  } catch (err) {
    console.error("Erro na extração de inteligência da chamada:", err);
    return {
      intent: CallIntentType.OUTRO,
      summary: transcription.slice(0, 160) || "Atendimento gravado.",
      insurer: null,
      policyNumber: null,
      plate: null,
      location: null,
      urgency: "MEDIA",
      nextSteps: "Ouvir gravação da chamada.",
    };
  }
}

/**
 * Processamento completo do áudio de uma ligação (Whisper + Claude + Gravação em banco)
 */
export async function processCallAudio(params: {
  callRecordId: string;
  audioBuffer: Buffer;
  mimeType?: string;
  durationSeconds?: number;
}) {
  const { callRecordId, audioBuffer, mimeType = "audio/ogg", durationSeconds = 60 } = params;

  // 1. Transcreve com Whisper
  const transcription = await transcribeAudioBuffer(audioBuffer, mimeType);
  const text = transcription || "[Áudio gravado — sem voz detectada ou transcrição indisponível]";

  // 2. Extrai dados com Claude Sonnet 4.5
  const intelligence = await extractCallIntelligence(text);

  // 3. Estima custo
  const cost = estimateCallCost(durationSeconds);

  // 4. Atualiza registro da chamada
  const updated = await prisma.callRecord.update({
    where: { id: callRecordId },
    data: {
      transcription: text,
      summary: intelligence.summary,
      intent: intelligence.intent,
      extractedData: {
        insurer: intelligence.insurer,
        policyNumber: intelligence.policyNumber,
        plate: intelligence.plate,
        location: intelligence.location,
        urgency: intelligence.urgency,
        nextSteps: intelligence.nextSteps,
      },
      durationSeconds,
      estimatedCost: cost,
      draftStatus: CallDraftStatus.PENDING,
    },
  });

  return updated;
}

/**
 * Trata ligação não atendida (chamada perdida):
 * - Dispara mensagem via WhatsApp oficial com aviso e telefone da assistência 24h
 * - Cria card urgente de ligação perdida no funil
 * - Notifica alertPhone da corretora
 */
export async function handleMissedCall(params: {
  brokerageId: string;
  fromPhone: string;
  callRecordId?: string;
}) {
  const { brokerageId, fromPhone, callRecordId } = params;

  const brokerage = await prisma.brokerage.findUnique({
    where: { id: brokerageId },
  });
  if (!brokerage) return;

  // Localiza segurado pelo telefone
  const cleanPhone = fromPhone.replace(/\D/g, "");
  const insured = await prisma.insured.findFirst({
    where: {
      brokerageId,
      phone: { contains: cleanPhone.slice(-8) },
    },
    include: {
      policies: {
        where: { status: "ACTIVE" },
        take: 1,
      },
    },
  });

  const activePolicy = insured?.policies?.[0];
  const assistancePhone = resolveAssistance24hPhone(
    activePolicy?.assistance24hPhone,
    activePolicy?.insurerName,
    brokerage.phone,
    brokerage.confirmedInsurers as Record<string, string> | null
  );

  // 1. Mensagem de retorno no WhatsApp para o cliente
  const clientMessage = `Olá! Identificamos que você acabou de ligar para a ${brokerage.name}. No momento nossos atendentes estão em linha ou fora do horário comercial, mas já registramos o seu contato e vamos retornar em instantes!

🚨 Caso seja uma emergência ou necessidade de guincho/assistência 24h, acione diretamente:
📞 ${assistancePhone}

SeguroFlow · Atendimento Inteligente`;

  try {
    if (brokerage.whatsappAccessTokenEncrypted && brokerage.whatsappPhoneNumberId) {
      const token = decryptSensitive(brokerage.whatsappAccessTokenEncrypted);
      if (token) {
        await sendWhatsAppTextMessage(
          cleanPhone,
          clientMessage,
          brokerage.whatsappPhoneNumberId,
          token
        );
      }
    }
  } catch (err) {
    console.warn("Não foi possível enviar WhatsApp de chamada perdida:", err);
  }

  // 2. Alerta imediato no WhatsApp do corretor se houver alertPhone
  if (brokerage.alertPhone && brokerage.whatsappAccessTokenEncrypted && brokerage.whatsappPhoneNumberId) {
    try {
      const token = decryptSensitive(brokerage.whatsappAccessTokenEncrypted);
      if (token) {
        await sendWhatsAppTextMessage(
          brokerage.alertPhone,
          `⚠️ [LIGAÇÃO PERDIDA] O número ${fromPhone}${insured ? ` (${insured.name})` : ""} acabou de ligar para a sua corretora e não foi atendido. Retorne imediatamente!`,
          brokerage.whatsappPhoneNumberId,
          token
        );
      }
    } catch (e) {
      console.warn("Falha ao notificar alertPhone sobre ligação perdida:", e);
    }
  }

  // 3. Cria card de prioridade no Funil de Vendas (NOVO)
  await prisma.pipelineCard.create({
    data: {
      brokerageId,
      insuredId: insured?.id,
      title: `🚨 Ligação Perdida: ${insured ? insured.name : fromPhone}`,
      stage: PipelineStage.NOVO,
      notes: `Chamada não atendida registrada em ${new Date().toLocaleString("pt-BR")}. Retornar com prioridade máxima.`,
    },
  });
}
