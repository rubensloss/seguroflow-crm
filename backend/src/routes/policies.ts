import { Router, Request, Response } from "express";
import { z } from "zod";
import { InsuranceBranch, PolicyStatus } from "@prisma/client";
import { prisma } from "../config/prisma";
import { requireAuth } from "../security/auth";
import { recordAuditLog } from "../services/auditLog";

export const policiesRouter = Router();

const policySchema = z.object({
  insuredId: z.string().min(1, "Segurado é obrigatório"),
  policyNumber: z.string().min(1, "Número da apólice é obrigatório"),
  insurerName: z.string().min(1, "Seguradora é obrigatória"),
  branch: z.nativeEnum(InsuranceBranch).default(InsuranceBranch.AUTO),
  assistance24hPhone: z.string().optional(),
  startDate: z.string(),
  endDate: z.string(),
  premiumAmount: z.number().positive("Valor do prêmio deve ser positivo"),
  itemDescription: z.string().optional(),
  installmentsCount: z.number().int().min(1).max(12).default(1),
  firstDueDate: z.string().optional(),
});

// Listagem de apólices com filtros
policiesRouter.get("/", requireAuth, async (req: Request, res: Response) => {
  const { status, branch, q } = req.query;
  const brokerageId = req.user!.brokerageId;

  const whereClause: any = { brokerageId };

  if (status) whereClause.status = status as PolicyStatus;
  if (branch) whereClause.branch = branch as InsuranceBranch;
  if (q) {
    whereClause.OR = [
      { policyNumber: { contains: String(q) } },
      { insurerName: { contains: String(q), mode: "insensitive" } },
      { insured: { name: { contains: String(q), mode: "insensitive" } } },
    ];
  }

  const policies = await prisma.policy.findMany({
    where: whereClause,
    include: {
      insured: { select: { id: true, name: true, phone: true, cpf: true } },
      installments: { orderBy: { installmentNumber: "asc" } },
    },
    orderBy: { endDate: "asc" },
  });

  res.json(policies);
});

// Detalhes da apólice
policiesRouter.get("/:id", requireAuth, async (req: Request, res: Response) => {
  const policy = await prisma.policy.findFirst({
    where: { id: req.params.id, brokerageId: req.user!.brokerageId },
    include: {
      insured: true,
      installments: { orderBy: { installmentNumber: "asc" } },
      claims: true,
      renewals: true,
    },
  });

  if (!policy) {
    res.status(404).json({ error: "Apólice não encontrada" });
    return;
  }

  res.json(policy);
});

// Criação de apólice e geração automática de parcelas
policiesRouter.post("/", requireAuth, async (req: Request, res: Response) => {
  const data = policySchema.parse(req.body);
  const brokerageId = req.user!.brokerageId;

  const start = new Date(data.startDate);
  const end = new Date(data.endDate);
  const firstDue = data.firstDueDate ? new Date(data.firstDueDate) : new Date(start);

  const installmentAmount = (data.premiumAmount / data.installmentsCount).toFixed(2);

  const result = await prisma.$transaction(async (tx) => {
    const policy = await tx.policy.create({
      data: {
        brokerageId,
        insuredId: data.insuredId,
        policyNumber: data.policyNumber,
        insurerName: data.insurerName,
        branch: data.branch,
        assistance24hPhone: data.assistance24hPhone,
        startDate: start,
        endDate: end,
        premiumAmount: data.premiumAmount,
        itemDescription: data.itemDescription,
      },
    });

    // Cria as parcelas
    const installmentsData = [];
    for (let i = 1; i <= data.installmentsCount; i++) {
      const due = new Date(firstDue);
      due.setMonth(due.getMonth() + (i - 1));

      installmentsData.push({
        brokerageId,
        policyId: policy.id,
        installmentNumber: i,
        dueDate: due,
        amount: Number(installmentAmount),
        status: "PENDING" as const,
      });
    }

    await tx.installment.createMany({ data: installmentsData });

    return policy;
  });

  await recordAuditLog({
    brokerageId,
    userId: req.user!.userId,
    action: "CREATE_POLICY",
    resource: `Policy:${result.id}`,
    req,
  });

  res.status(201).json(result);
});
