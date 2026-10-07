import { Router, Request, Response } from "express";
import { z } from "zod";
import { InsuranceBranch, PolicyStatus } from "@prisma/client";
import { prisma } from "../config/prisma";
import { requireAuth } from "../security/auth";
import { recordAuditLog } from "../services/auditLog";
import { resolveAssistance24hPhone } from "../services/insurerDirectory";

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

// Atualização de apólice
policiesRouter.patch("/:id", requireAuth, async (req: Request, res: Response) => {
  const { policyNumber, insurerName, branch, assistance24hPhone, startDate, endDate, premiumAmount, itemDescription, status } = req.body;
  const policy = await prisma.policy.findFirst({
    where: { id: req.params.id, brokerageId: req.user!.brokerageId },
  });

  if (!policy) {
    res.status(404).json({ error: "Apólice não encontrada" });
    return;
  }

  const updated = await prisma.policy.update({
    where: { id: policy.id },
    data: {
      policyNumber: policyNumber || undefined,
      insurerName: insurerName || undefined,
      branch: branch || undefined,
      assistance24hPhone: assistance24hPhone !== undefined ? assistance24hPhone : undefined,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
      premiumAmount: premiumAmount !== undefined ? Number(premiumAmount) : undefined,
      itemDescription: itemDescription !== undefined ? itemDescription : undefined,
      status: status || undefined,
    },
  });

  await recordAuditLog({
    brokerageId: req.user!.brokerageId,
    userId: req.user!.userId,
    action: "UPDATE_POLICY",
    resource: `Policy:${updated.id}`,
    req,
  });

  res.json(updated);
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

// Criação automática de Apólice + Parcelas a partir do OCR de Proposta (Sem digitação manual!)
policiesRouter.post("/from-proposal-ocr", requireAuth, async (req: Request, res: Response) => {
  const brokerageId = req.user!.brokerageId;
  const {
    insurerName,
    policyNumber,
    branch = InsuranceBranch.AUTO,
    insuredName,
    insuredCpf,
    insuredPhone,
    insuredEmail,
    startDate,
    endDate,
    premiumAmount,
    commissionPercentage = 15,
    assistance24hPhone,
    itemDescription,
    installments,
  } = req.body;

  if (!insurerName || !insuredName || !insuredPhone || !premiumAmount) {
    res.status(400).json({ error: "Dados mínimos da proposta ausentes (Seguradora, Nome, Telefone ou Prêmio)" });
    return;
  }

  const premNum = Number(premiumAmount);
  const commPct = Number(commissionPercentage) || 15;
  const commAmount = (premNum * commPct) / 100;

  const result = await prisma.$transaction(async (tx) => {
    // 1. Localiza ou cria Segurado
    let insured = await tx.insured.findFirst({
      where: {
        brokerageId,
        OR: [
          insuredCpf ? { cpf: insuredCpf } : { phone: insuredPhone },
          { phone: insuredPhone },
        ],
      },
    });

    if (!insured) {
      insured = await tx.insured.create({
        data: {
          brokerageId,
          name: insuredName,
          phone: insuredPhone,
          cpf: insuredCpf || undefined,
          email: insuredEmail || undefined,
        },
      });
    }

    // 2. Cria Apólice
    const start = startDate ? new Date(startDate) : new Date();
    const end = endDate ? new Date(endDate) : new Date(start.getTime() + 365 * 24 * 60 * 60 * 1000);

    const brk = await tx.brokerage.findUnique({
      where: { id: brokerageId },
      select: { phone: true, confirmedInsurers: true },
    });

    const policy = await tx.policy.create({
      data: {
        brokerageId,
        insuredId: insured.id,
        policyNumber: policyNumber || `PROP-${Date.now().toString().slice(-6)}`,
        insurerName,
        branch: branch as InsuranceBranch,
        startDate: start,
        endDate: end,
        premiumAmount: premNum,
        commissionPercentage: commPct,
        commissionAmount: commAmount,
        assistance24hPhone: resolveAssistance24hPhone(assistance24hPhone, insurerName, brk?.phone, brk?.confirmedInsurers as any),
        itemDescription: itemDescription || "Item segurado",
        status: "ACTIVE",
      },
    });

    // 3. Cria as parcelas extraídas com as datas exatas
    const installmentsToInsert = [];
    if (Array.isArray(installments) && installments.length > 0) {
      for (const inst of installments) {
        installmentsToInsert.push({
          brokerageId,
          policyId: policy.id,
          installmentNumber: Number(inst.installmentNumber) || 1,
          dueDate: new Date(inst.dueDate),
          amount: Number(inst.amount) || premNum / installments.length,
          paymentCode: inst.paymentCode || undefined,
          status: "PENDING" as const,
        });
      }
    } else {
      // Fallback: 1 parcela única
      installmentsToInsert.push({
        brokerageId,
        policyId: policy.id,
        installmentNumber: 1,
        dueDate: new Date(start.getTime() + 5 * 24 * 60 * 60 * 1000),
        amount: premNum,
        status: "PENDING" as const,
      });
    }

    await tx.installment.createMany({ data: installmentsToInsert });

    return { policy, insured, installmentsCount: installmentsToInsert.length };
  });

  await recordAuditLog({
    brokerageId,
    userId: req.user!.userId,
    action: "CREATE_POLICY_FROM_PROPOSAL_OCR",
    resource: `Policy:${result.policy.id}`,
    req,
  });

  res.status(201).json({
    success: true,
    message: `Apólice e ${result.installmentsCount} parcelas geradas com sucesso sem digitação manual!`,
    policy: result.policy,
    insured: result.insured,
  });
});

