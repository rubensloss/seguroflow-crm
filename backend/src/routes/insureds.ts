import { Router, Request, Response } from "express";
import { z } from "zod";
import { AuthorizedContactRole } from "@prisma/client";
import { prisma } from "../config/prisma";
import { requireAuth } from "../security/auth";
import { recordAuditLog } from "../services/auditLog";

export const insuredsRouter = Router();

const insuredSchema = z.object({
  name: z.string().min(2, "Nome é obrigatório"),
  cpf: z.string().optional(),
  phone: z.string().min(8, "Telefone é obrigatório"),
  email: z.string().email().optional().or(z.literal("")),
  notes: z.string().optional(),
});

const contactSchema = z.object({
  name: z.string().min(2, "Nome é obrigatório"),
  phone: z.string().min(8, "Telefone é obrigatório"),
  role: z.nativeEnum(AuthorizedContactRole).default(AuthorizedContactRole.MOTORISTA),
  canClaims: z.boolean().default(true),
  canBilling: z.boolean().default(false),
  canRenewal: z.boolean().default(false),
  notes: z.string().optional(),
});

// Listagem de segurados do tenant com busca
insuredsRouter.get("/", requireAuth, async (req: Request, res: Response) => {
  const { q } = req.query;
  const brokerageId = req.user!.brokerageId;

  const whereClause: any = { brokerageId };
  if (q) {
    const search = String(q).trim();
    whereClause.OR = [
      { name: { contains: search, mode: "insensitive" } },
      { cpf: { contains: search } },
      { phone: { contains: search } },
      { authorizedContacts: { some: { phone: { contains: search } } } },
      { authorizedContacts: { some: { name: { contains: search, mode: "insensitive" } } } },
    ];
  }

  const insureds = await prisma.insured.findMany({
    where: whereClause,
    include: {
      policies: {
        select: {
          id: true,
          policyNumber: true,
          insurerName: true,
          branch: true,
          subBranch: true,
          status: true,
          endDate: true,
        },
      },
      authorizedContacts: {
        select: {
          id: true,
          name: true,
          phone: true,
          role: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  res.json(insureds);
});

// Detalhes de um segurado específico
insuredsRouter.get("/:id", requireAuth, async (req: Request, res: Response) => {
  const insured = await prisma.insured.findFirst({
    where: { id: req.params.id, brokerageId: req.user!.brokerageId },
    include: {
      policies: {
        include: {
          installments: { orderBy: { installmentNumber: "asc" } },
          claims: true,
          items: true,
        },
      },
      authorizedContacts: { orderBy: { createdAt: "asc" } },
      documents: true,
      conversations: {
        include: {
          messages: { orderBy: { sentAt: "desc" }, take: 20 },
        },
      },
    },
  });

  if (!insured) {
    res.status(404).json({ error: "Segurado não encontrado" });
    return;
  }

  await recordAuditLog({
    brokerageId: req.user!.brokerageId,
    userId: req.user!.userId,
    action: "VIEW_INSURED",
    resource: `Insured:${insured.id}`,
    req,
  });

  res.json(insured);
});

// Criação de segurado
insuredsRouter.post("/", requireAuth, async (req: Request, res: Response) => {
  const data = insuredSchema.parse(req.body);
  const brokerageId = req.user!.brokerageId;

  const insured = await prisma.insured.create({
    data: {
      brokerageId,
      name: data.name,
      cpf: data.cpf ? data.cpf.replace(/\D/g, "") : undefined,
      phone: data.phone.replace(/\D/g, ""),
      email: data.email || undefined,
      notes: data.notes,
    },
  });

  await recordAuditLog({
    brokerageId,
    userId: req.user!.userId,
    action: "CREATE_INSURED",
    resource: `Insured:${insured.id}`,
    req,
  });

  res.status(201).json(insured);
});

// Edição de segurado
insuredsRouter.patch("/:id", requireAuth, async (req: Request, res: Response) => {
  const { name, cpf, phone, email, notes } = req.body;
  const brokerageId = req.user!.brokerageId;

  const insured = await prisma.insured.findFirst({
    where: { id: req.params.id, brokerageId },
  });

  if (!insured) {
    res.status(404).json({ error: "Segurado não encontrado" });
    return;
  }

  const updated = await prisma.insured.update({
    where: { id: insured.id },
    data: {
      name: name || undefined,
      cpf: cpf !== undefined ? (cpf ? cpf.replace(/\D/g, "") : null) : undefined,
      phone: phone ? phone.replace(/\D/g, "") : undefined,
      email: email !== undefined ? (email || null) : undefined,
      notes: notes !== undefined ? notes : undefined,
    },
  });

  await recordAuditLog({
    brokerageId,
    userId: req.user!.userId,
    action: "UPDATE_INSURED",
    resource: `Insured:${updated.id}`,
    req,
  });

  res.json(updated);
});

// =============================================================================
// CONTATOS AUTORIZADOS (Motorista, Gestor de Frota, Financeiro, Sócio)
// =============================================================================

// Listar contatos autorizados do segurado
insuredsRouter.get("/:id/contacts", requireAuth, async (req: Request, res: Response) => {
  const brokerageId = req.user!.brokerageId;
  const insured = await prisma.insured.findFirst({
    where: { id: req.params.id, brokerageId },
  });

  if (!insured) {
    res.status(404).json({ error: "Segurado não encontrado" });
    return;
  }

  const contacts = await prisma.authorizedContact.findMany({
    where: { insuredId: insured.id, brokerageId },
    orderBy: { createdAt: "asc" },
  });

  res.json(contacts);
});

// Cadastrar contato autorizado
insuredsRouter.post("/:id/contacts", requireAuth, async (req: Request, res: Response) => {
  const brokerageId = req.user!.brokerageId;
  const insured = await prisma.insured.findFirst({
    where: { id: req.params.id, brokerageId },
  });

  if (!insured) {
    res.status(404).json({ error: "Segurado não encontrado" });
    return;
  }

  const data = contactSchema.parse(req.body);
  const cleanPhone = data.phone.replace(/\D/g, "");

  const contact = await prisma.authorizedContact.create({
    data: {
      brokerageId,
      insuredId: insured.id,
      name: data.name.trim(),
      phone: cleanPhone,
      role: data.role,
      canClaims: data.canClaims,
      canBilling: data.canBilling,
      canRenewal: data.canRenewal,
      notes: data.notes?.trim() || null,
    },
  });

  await recordAuditLog({
    brokerageId,
    userId: req.user!.userId,
    action: "CREATE_AUTHORIZED_CONTACT",
    resource: `AuthorizedContact:${contact.id}`,
    req,
  });

  res.status(201).json(contact);
});

// Atualizar contato autorizado
insuredsRouter.patch("/:id/contacts/:contactId", requireAuth, async (req: Request, res: Response) => {
  const brokerageId = req.user!.brokerageId;
  const contact = await prisma.authorizedContact.findFirst({
    where: { id: req.params.contactId, insuredId: req.params.id, brokerageId },
  });

  if (!contact) {
    res.status(404).json({ error: "Contato autorizado não encontrado" });
    return;
  }

  const { name, phone, role, canClaims, canBilling, canRenewal, notes } = req.body;
  const cleanPhone = phone ? String(phone).replace(/\D/g, "") : undefined;

  const updated = await prisma.authorizedContact.update({
    where: { id: contact.id },
    data: {
      name: name ? String(name).trim() : undefined,
      phone: cleanPhone,
      role: role || undefined,
      canClaims: canClaims !== undefined ? Boolean(canClaims) : undefined,
      canBilling: canBilling !== undefined ? Boolean(canBilling) : undefined,
      canRenewal: canRenewal !== undefined ? Boolean(canRenewal) : undefined,
      notes: notes !== undefined ? (notes ? String(notes).trim() : null) : undefined,
    },
  });

  await recordAuditLog({
    brokerageId,
    userId: req.user!.userId,
    action: "UPDATE_AUTHORIZED_CONTACT",
    resource: `AuthorizedContact:${updated.id}`,
    req,
  });

  res.json(updated);
});

// Remover contato autorizado
insuredsRouter.delete("/:id/contacts/:contactId", requireAuth, async (req: Request, res: Response) => {
  const brokerageId = req.user!.brokerageId;
  const contact = await prisma.authorizedContact.findFirst({
    where: { id: req.params.contactId, insuredId: req.params.id, brokerageId },
  });

  if (!contact) {
    res.status(404).json({ error: "Contato autorizado não encontrado" });
    return;
  }

  await prisma.authorizedContact.delete({ where: { id: contact.id } });

  await recordAuditLog({
    brokerageId,
    userId: req.user!.userId,
    action: "DELETE_AUTHORIZED_CONTACT",
    resource: `AuthorizedContact:${contact.id}`,
    req,
  });

  res.json({ success: true, message: "Contato autorizado removido com sucesso." });
});

// Importação em lote de contatos autorizados via CSV
insuredsRouter.post("/:id/contacts/import", requireAuth, async (req: Request, res: Response) => {
  const brokerageId = req.user!.brokerageId;
  const insured = await prisma.insured.findFirst({
    where: { id: req.params.id, brokerageId },
  });

  if (!insured) {
    res.status(404).json({ error: "Segurado não encontrado" });
    return;
  }

  const csvText = String(req.body.csvText || "");
  const lines = csvText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);

  if (lines.length === 0) {
    res.status(400).json({ error: "Texto CSV vazio" });
    return;
  }

  let imported = 0;
  const startIndex = lines[0].toLowerCase().includes("nome") ? 1 : 0;

  for (let i = startIndex; i < lines.length; i++) {
    const parts = lines[i].split(/[,;]/).map((p) => p.trim().replace(/^["']|["']$/g, ""));
    if (parts.length < 2) continue;

    // Formato esperado: Nome, Telefone, Função (Motorista/Gestor/Financeiro), PodeSinistro (S/N), PodeCobranca (S/N), PodeRenovacao (S/N)
    const [name, rawPhone, rawRole, rawClaims, rawBilling, rawRenewal] = parts;
    if (!name || !rawPhone) continue;

    const phone = rawPhone.replace(/\D/g, "");
    if (!phone) continue;

    let role: AuthorizedContactRole = AuthorizedContactRole.MOTORISTA;
    const upperRole = (rawRole || "").toUpperCase();
    if (upperRole.includes("GESTOR")) role = AuthorizedContactRole.GESTOR_FROTA;
    else if (upperRole.includes("FINANC")) role = AuthorizedContactRole.FINANCEIRO;
    else if (upperRole.includes("SOCIO")) role = AuthorizedContactRole.SOCIO;
    else if (upperRole.includes("OUTRO")) role = AuthorizedContactRole.OUTRO;

    const canClaims = rawClaims ? ["S", "SIM", "1", "TRUE"].includes(rawClaims.toUpperCase()) : (role === "MOTORISTA" || role === "GESTOR_FROTA");
    const canBilling = rawBilling ? ["S", "SIM", "1", "TRUE"].includes(rawBilling.toUpperCase()) : (role === "FINANCEIRO" || role === "SOCIO");
    const canRenewal = rawRenewal ? ["S", "SIM", "1", "TRUE"].includes(rawRenewal.toUpperCase()) : (role === "GESTOR_FROTA" || role === "SOCIO");

    await prisma.authorizedContact.create({
      data: {
        brokerageId,
        insuredId: insured.id,
        name,
        phone,
        role,
        canClaims,
        canBilling,
        canRenewal,
      },
    });
    imported++;
  }

  res.json({
    success: true,
    imported,
    message: `${imported} contatos autorizados importados com sucesso.`,
  });
});
