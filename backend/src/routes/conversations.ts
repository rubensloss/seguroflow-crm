import { Router, Request, Response } from "express";
import { z } from "zod";
import { ConversationStatus, MessageDirection } from "@prisma/client";
import { prisma } from "../config/prisma";
import { requireAuth } from "../security/auth";
import { sendWhatsAppTextMessage } from "../services/whatsappCloud";
import { decryptSensitive } from "../security/crypto";
import { recordAuditLog } from "../services/auditLog";

export const conversationsRouter = Router();

/**
 * Caixa de Entrada Unificada Multi-atendente (WhatsApp da Equipe)
 * Evita que mensagens de segurados fiquem sem resposta ou "passem batido"
 */

// 1. Listagem de conversas da corretora com filtros e status de SLA
conversationsRouter.get("/", requireAuth, async (req: Request, res: Response) => {
  const brokerageId = req.user!.brokerageId;
  const { status, assignedUserId, search } = req.query;

  const whereClause: any = { brokerageId };

  if (status) whereClause.status = status as ConversationStatus;
  if (assignedUserId) whereClause.assignedUserId = String(assignedUserId);
  if (search) {
    whereClause.OR = [
      { phone: { contains: String(search) } },
      { insured: { name: { contains: String(search), mode: "insensitive" } } },
    ];
  }

  const conversations = await prisma.conversation.findMany({
    where: whereClause,
    include: {
      insured: { select: { id: true, name: true, phone: true } },
      assignedUser: { select: { id: true, name: true, email: true } },
      messages: {
        orderBy: { sentAt: "desc" },
        take: 1, // Última mensagem da conversa
      },
    },
    orderBy: { updatedAt: "desc" },
  });

  const formatted = conversations.map((c) => ({
    id: c.id,
    phone: c.phone,
    status: c.status,
    humanReason: c.humanReason,
    unreadCount: c.unreadCount,
    insured: c.insured,
    assignedUser: c.assignedUser,
    lastMessage: c.messages[0] || null,
    updatedAt: c.updatedAt,
  }));

  res.json({
    total: formatted.length,
    conversations: formatted,
  });
});

// 2. Histórico de mensagens de uma conversa específica
conversationsRouter.get("/:id/messages", requireAuth, async (req: Request, res: Response) => {
  const conversation = await prisma.conversation.findFirst({
    where: { id: req.params.id, brokerageId: req.user!.brokerageId },
    include: {
      insured: true,
      assignedUser: true,
      messages: { orderBy: { sentAt: "asc" } },
    },
  });

  if (!conversation) {
    res.status(404).json({ error: "Conversa não encontrada" });
    return;
  }

  // Zera contador de não lidas ao abrir
  if (conversation.unreadCount > 0) {
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { unreadCount: 0 },
    });
  }

  res.json(conversation);
});

// 3. Resposta manual do corretor/atendente via WhatsApp Oficial
conversationsRouter.post("/:id/reply", requireAuth, async (req: Request, res: Response) => {
  const { text } = req.body;
  if (!text || typeof text !== "string" || text.trim().length === 0) {
    res.status(400).json({ error: "Texto da mensagem é obrigatório" });
    return;
  }

  const conversation = await prisma.conversation.findFirst({
    where: { id: req.params.id, brokerageId: req.user!.brokerageId },
    include: { brokerage: true },
  });

  if (!conversation) {
    res.status(404).json({ error: "Conversa não encontrada" });
    return;
  }

  const { brokerage } = conversation;
  if (!brokerage.whatsappPhoneNumberId || !brokerage.whatsappAccessTokenEncrypted) {
    res.status(400).json({ error: "Credenciais do WhatsApp Cloud não configuradas nesta corretora" });
    return;
  }

  const token = decryptSensitive(brokerage.whatsappAccessTokenEncrypted);
  if (!token) {
    res.status(500).json({ error: "Falha ao descriptografar token da Meta" });
    return;
  }

  // Envia via Meta WhatsApp Cloud API
  const metaMessageId = await sendWhatsAppTextMessage(
    conversation.phone,
    text.trim(),
    brokerage.whatsappPhoneNumberId,
    token
  );

  // Registra mensagem no banco e transfere conversa para HUMAN_CONTROLLED
  const newMsg = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      direction: MessageDirection.OUTBOUND,
      text: text.trim(),
      externalId: metaMessageId || undefined,
    },
  });

  await prisma.conversation.update({
    where: { id: conversation.id },
    data: {
      status: ConversationStatus.HUMAN_CONTROLLED,
      assignedUserId: req.user!.userId,
      humanReason: `Atendido manualmente por ${req.user!.email}`,
      updatedAt: new Date(),
    },
  });

  await recordAuditLog({
    brokerageId: req.user!.brokerageId,
    userId: req.user!.userId,
    action: "SEND_WHATSAPP_MANUAL_REPLY",
    resource: `Conversation:${conversation.id}`,
    req,
  });

  res.json({ success: true, message: newMsg });
});

// 4. Atribuição de conversa a um corretor da equipe
conversationsRouter.patch("/:id/assign", requireAuth, async (req: Request, res: Response) => {
  const { assignedUserId } = req.body;

  const conversation = await prisma.conversation.findFirst({
    where: { id: req.params.id, brokerageId: req.user!.brokerageId },
  });

  if (!conversation) {
    res.status(404).json({ error: "Conversa não encontrada" });
    return;
  }

  const updated = await prisma.conversation.update({
    where: { id: conversation.id },
    data: {
      assignedUserId: assignedUserId || null,
      status: assignedUserId ? ConversationStatus.HUMAN_CONTROLLED : undefined,
    },
    include: { assignedUser: { select: { id: true, name: true, email: true } } },
  });

  res.json({ success: true, conversation: updated });
});

// 5. Devolver conversa para o Agente de IA ou Encerrar
conversationsRouter.patch("/:id/status", requireAuth, async (req: Request, res: Response) => {
  const { status } = req.body;

  if (!["AI_CONTROLLED", "HUMAN_CONTROLLED", "CLOSED"].includes(status)) {
    res.status(400).json({ error: "Status inválido" });
    return;
  }

  const updated = await prisma.conversation.update({
    where: { id: req.params.id },
    data: {
      status: status as ConversationStatus,
      humanReason: status === "AI_CONTROLLED" ? null : undefined,
    },
  });

  res.json({ success: true, conversation: updated });
});
