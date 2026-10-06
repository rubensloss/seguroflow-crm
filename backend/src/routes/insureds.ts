import { Router, Request, Response } from "express";
import { z } from "zod";
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
          status: true,
          endDate: true,
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
        },
      },
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

