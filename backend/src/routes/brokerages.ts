import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../config/prisma";
import { requireAuth, requireRoles } from "../security/auth";
import { encryptSensitive, decryptSensitive } from "../security/crypto";
import { testWhatsAppConnection } from "../services/whatsappCloud";
import { recordAuditLog } from "../services/auditLog";

export const brokeragesRouter = Router();

const metaConfigSchema = z.object({
  whatsappPhoneNumberId: z.string().min(1, "Phone Number ID é obrigatório"),
  whatsappBusinessAccountId: z.string().optional(),
  whatsappAccessToken: z.string().min(1, "Access Token Permanente é obrigatório"),
  whatsappAppSecret: z.string().min(1, "App Secret é obrigatório"),
  whatsappVerifyToken: z.string().min(1, "Verify Token é obrigatório"),
  alertPhone: z.string().optional(),
  agentTone: z.string().optional(),
  agentEnabled: z.boolean().optional(),
});

// Obtém configurações da corretora autenticada
brokeragesRouter.get("/settings", requireAuth, async (req: Request, res: Response) => {
  const brokerage = await prisma.brokerage.findUnique({
    where: { id: req.user!.brokerageId },
  });

  if (!brokerage) {
    res.status(404).json({ error: "Corretora não encontrada" });
    return;
  }

  res.json({
    id: brokerage.id,
    name: brokerage.name,
    slug: brokerage.slug,
    cnpj: brokerage.cnpj,
    phone: brokerage.phone,
    email: brokerage.email,
    whatsappPhoneNumberId: brokerage.whatsappPhoneNumberId,
    whatsappBusinessAccountId: brokerage.whatsappBusinessAccountId,
    whatsappVerifyToken: brokerage.whatsappVerifyToken,
    hasAccessToken: Boolean(brokerage.whatsappAccessTokenEncrypted),
    hasAppSecret: Boolean(brokerage.whatsappAppSecretEncrypted),
    alertPhone: brokerage.alertPhone,
    agentTone: brokerage.agentTone,
    agentEnabled: brokerage.agentEnabled,
  });
});

// Salva credenciais da Meta WhatsApp Cloud API (OWNER ou BROKER)
brokeragesRouter.put("/settings/whatsapp", requireAuth, requireRoles(["OWNER", "BROKER"]), async (req: Request, res: Response) => {
  const data = metaConfigSchema.parse(req.body);

  const encryptedToken = encryptSensitive(data.whatsappAccessToken);
  const encryptedSecret = encryptSensitive(data.whatsappAppSecret);

  const updated = await prisma.brokerage.update({
    where: { id: req.user!.brokerageId },
    data: {
      whatsappPhoneNumberId: data.whatsappPhoneNumberId,
      whatsappBusinessAccountId: data.whatsappBusinessAccountId,
      whatsappAccessTokenEncrypted: encryptedToken,
      whatsappAppSecretEncrypted: encryptedSecret,
      whatsappVerifyToken: data.whatsappVerifyToken,
      alertPhone: data.alertPhone,
      agentTone: data.agentTone,
      agentEnabled: data.agentEnabled ?? true,
    },
  });

  await recordAuditLog({
    brokerageId: updated.id,
    userId: req.user!.userId,
    action: "UPDATE_META_CREDENTIALS",
    resource: `Brokerage:${updated.id}`,
    req,
  });

  res.json({
    success: true,
    message: "Credenciais da Meta WhatsApp salvas com sucesso (criptografadas via AES-256-GCM).",
  });
});

// Testa conexão com a Meta Cloud API usando as credenciais salvas ou enviadas
brokeragesRouter.post("/settings/whatsapp/test", requireAuth, async (req: Request, res: Response) => {
  const brokerage = await prisma.brokerage.findUnique({
    where: { id: req.user!.brokerageId },
  });

  if (!brokerage) {
    res.status(404).json({ error: "Corretora não encontrada" });
    return;
  }

  let phoneNumberId = req.body.whatsappPhoneNumberId || brokerage.whatsappPhoneNumberId;
  let token = req.body.whatsappAccessToken;

  if (!token && brokerage.whatsappAccessTokenEncrypted) {
    token = decryptSensitive(brokerage.whatsappAccessTokenEncrypted);
  }

  if (!phoneNumberId || !token) {
    res.status(400).json({ error: "Phone Number ID e Token Permanente são necessários para testar." });
    return;
  }

  const result = await testWhatsAppConnection(phoneNumberId, token);
  res.json(result);
});
