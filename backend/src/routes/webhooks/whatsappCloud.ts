import { Router, Request, Response } from "express";
import { prisma } from "../../config/prisma";
import { decryptSensitive } from "../../security/crypto";
import {
  verifyTenantWhatsAppSignature,
  sendWhatsAppTextMessage,
  downloadWhatsAppMedia,
} from "../../services/whatsappCloud";
import { transcribeAudioBuffer } from "../../services/transcription";
import { runAgentTurn } from "../../services/agent/claude";

export const whatsappCloudWebhookRouter = Router();

// 1. Verificação de Handshake da Meta (GET)
whatsappCloudWebhookRouter.get("/", async (req: Request, res: Response) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token) {
    // Procura por qualquer corretora cadastrada com este verify token
    const brokerage = await prisma.brokerage.findFirst({
      where: { whatsappVerifyToken: String(token) },
    });

    if (brokerage || token === "seguroflow_default_verify_token") {
      res.status(200).type("text/plain").send(String(challenge ?? ""));
      return;
    }
  }

  res.sendStatus(403);
});

// 2. Recebimento de Eventos e Mensagens da Meta (POST)
whatsappCloudWebhookRouter.post("/", async (req: Request, res: Response) => {
  // Retorna 200 imediatamente para a Meta não reenviar o webhook
  res.sendStatus(200);

  try {
    const rawBody = (req as any).rawBody as Buffer | undefined;
    const signature = req.headers["x-hub-signature-256"] as string | undefined;
    const body = req.body;

    if (body.object !== "whatsapp_business_account" || !body.entry) return;

    for (const entry of body.entry) {
      for (const change of entry.changes ?? []) {
        if (change.field !== "messages" || !change.value) continue;

        const phoneNumberId = change.value.metadata?.phone_number_id;
        if (!phoneNumberId) continue;

        // Localiza a corretora específica dona deste número
        const brokerage = await prisma.brokerage.findUnique({
          where: { whatsappPhoneNumberId: phoneNumberId },
        });

        if (!brokerage || !brokerage.whatsappAccessTokenEncrypted) {
          console.warn(`[Webhook Meta] Nenhuma corretora ativa para o phone_number_id: ${phoneNumberId}`);
          continue;
        }

        // Validação da assinatura X-Hub-Signature-256 COM O APP SECRET DO CLIENTE
        if (brokerage.whatsappAppSecretEncrypted && rawBody) {
          const appSecret = decryptSensitive(brokerage.whatsappAppSecretEncrypted);
          if (appSecret) {
            const isValid = verifyTenantWhatsAppSignature(rawBody, signature, appSecret);
            if (!isValid) {
              console.warn(`[Webhook Meta] Assinatura X-Hub-Signature-256 inválida para a corretora ${brokerage.slug}`);
              continue;
            }
          }
        }

        const accessToken = decryptSensitive(brokerage.whatsappAccessTokenEncrypted);
        if (!accessToken) continue;

        // Processa mensagens recebidas
        for (const message of change.value.messages ?? []) {
          const fromPhone = message.from;
          if (!fromPhone) continue;

          // Localiza ou vincula Segurado
          let insured = await prisma.insured.findFirst({
            where: {
              brokerageId: brokerage.id,
              phone: { contains: fromPhone.slice(-8) },
            },
          });

          // Localiza ou abre conversa
          let conversation = await prisma.conversation.findFirst({
            where: {
              brokerageId: brokerage.id,
              phone: fromPhone,
            },
          });

          if (!conversation) {
            conversation = await prisma.conversation.create({
              data: {
                brokerageId: brokerage.id,
                insuredId: insured?.id,
                phone: fromPhone,
                status: "AI_CONTROLLED",
              },
            });
          }

          let incomingText = "";
          let mediaUrl: string | undefined;
          let mediaType = message.type;

          // Processa mensagem de texto
          if (message.type === "text" && message.text?.body) {
            incomingText = message.text.body;
          }

          // Processa mensagem de áudio (transcreve com Whisper)
          else if (message.type === "audio" && message.audio?.id) {
            try {
              const { buffer, mimeType } = await downloadWhatsAppMedia(message.audio.id, accessToken);
              const transcribed = await transcribeAudioBuffer(buffer, mimeType);
              if (transcribed) {
                incomingText = `[Áudio Transcrito]: ${transcribed}`;
              } else {
                incomingText = "[Nota de voz recebida]";
              }
            } catch (err) {
              console.error("Erro ao baixar/transcrever áudio:", err);
              incomingText = "[Áudio não pôde ser transcrito]";
            }
          }

          // Processa imagens (ex: fotos de sinistro ou documentos)
          else if (message.type === "image" && message.image?.id) {
            incomingText = message.image.caption || "[Imagem enviada]";
            mediaUrl = `whatsapp-media:${message.image.id}`;
          }

          if (!incomingText) continue;

          // Salva mensagem no histórico
          await prisma.message.create({
            data: {
              conversationId: conversation.id,
              direction: "INBOUND",
              text: incomingText,
              mediaUrl,
              mediaType,
              externalId: message.id,
            },
          });

          // Se a conversa estiver sob controle humano, a IA não responde
          if (conversation.status === "HUMAN_CONTROLLED") {
            continue;
          }

          // Se o agente estiver desativado pela corretora, não responde
          if (!brokerage.agentEnabled) {
            continue;
          }

          // Busca histórico das últimas 10 mensagens para contexto
          const recentMessages = await prisma.message.findMany({
            where: { conversationId: conversation.id },
            orderBy: { sentAt: "asc" },
            take: 10,
          });

          const messageHistory = recentMessages.slice(0, -1).map((m) => ({
            role: m.direction === "INBOUND" ? ("user" as const) : ("assistant" as const),
            content: m.text,
          }));

          // Roda turno do agente
          const replyText = await runAgentTurn({
            brokerageName: brokerage.name,
            brokerageId: brokerage.id,
            phone: fromPhone,
            insuredId: insured?.id,
            messageHistory,
            userMessage: incomingText,
          });

          // Envia resposta oficial pelo WhatsApp
          const sentWamid = await sendWhatsAppTextMessage(
            fromPhone,
            replyText,
            phoneNumberId,
            accessToken
          );

          // Salva resposta do assistente no banco
          await prisma.message.create({
            data: {
              conversationId: conversation.id,
              direction: "OUTBOUND",
              text: replyText,
              externalId: sentWamid ?? undefined,
            },
          });
        }
      }
    }
  } catch (error) {
    console.error("Erro no processamento do webhook do WhatsApp Cloud:", error);
  }
});
