import { Router, Request, Response } from "express";
import { z } from "zod";
import { ClaimStatus } from "@prisma/client";
import { prisma } from "../config/prisma";
import { requireAuth } from "../security/auth";
import { recordAuditLog } from "../services/auditLog";

export const claimsRouter = Router();

const claimSchema = z.object({
  insuredId: z.string().min(1, "Segurado é obrigatório"),
  policyId: z.string().min(1, "Apólice é obrigatória"),
  incidentType: z.string().min(1, "Tipo de ocorrência é obrigatório"),
  incidentDate: z.string().optional(),
  incidentLocation: z.string().optional(),
  description: z.string().min(5, "Descrição é obrigatória"),
  policeReportUrl: z.string().optional(),
});

// Listagem de sinistros (Módulo 1)
claimsRouter.get("/", requireAuth, async (req: Request, res: Response) => {
  const { status } = req.query;
  const brokerageId = req.user!.brokerageId;

  const whereClause: any = { brokerageId };
  if (status) whereClause.status = status as ClaimStatus;

  const claims = await prisma.claim.findMany({
    where: whereClause,
    include: {
      insured: { select: { id: true, name: true, phone: true } },
      policy: {
        select: {
          id: true,
          policyNumber: true,
          insurerName: true,
          branch: true,
          assistance24hPhone: true,
        },
      },
      assignedUser: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  res.json(claims);
});

// Detalhes de um sinistro
claimsRouter.get("/:id", requireAuth, async (req: Request, res: Response) => {
  const claim = await prisma.claim.findFirst({
    where: { id: req.params.id, brokerageId: req.user!.brokerageId },
    include: {
      insured: true,
      policy: true,
      assignedUser: true,
    },
  });

  if (!claim) {
    res.status(404).json({ error: "Sinistro não encontrado" });
    return;
  }

  res.json(claim);
});

// Abertura manual de sinistro pela corretora
claimsRouter.post("/", requireAuth, async (req: Request, res: Response) => {
  const data = claimSchema.parse(req.body);
  const brokerageId = req.user!.brokerageId;

  const claim = await prisma.claim.create({
    data: {
      brokerageId,
      insuredId: data.insuredId,
      policyId: data.policyId,
      incidentType: data.incidentType,
      incidentDate: data.incidentDate ? new Date(data.incidentDate) : new Date(),
      incidentLocation: data.incidentLocation,
      description: data.description,
      policeReportUrl: data.policeReportUrl,
      status: "OPEN",
      assignedUserId: req.user!.userId,
      brokerNotifiedAt: new Date(),
    },
    include: { policy: true, insured: true },
  });

  await recordAuditLog({
    brokerageId,
    userId: req.user!.userId,
    action: "CREATE_CLAIM",
    resource: `Claim:${claim.id}`,
    req,
  });

  res.status(201).json(claim);
});

// Atualização de status e andamento do sinistro
claimsRouter.patch("/:id/status", requireAuth, async (req: Request, res: Response) => {
  const { status, assignedUserId, description } = req.body;

  const claim = await prisma.claim.findFirst({
    where: { id: req.params.id, brokerageId: req.user!.brokerageId },
  });

  if (!claim) {
    res.status(404).json({ error: "Sinistro não encontrado" });
    return;
  }

  const updated = await prisma.claim.update({
    where: { id: claim.id },
    data: {
      status: status || undefined,
      assignedUserId: assignedUserId || undefined,
      description: description ? `${claim.description}\n[Atualização]: ${description}` : undefined,
    },
  });

  await recordAuditLog({
    brokerageId: req.user!.brokerageId,
    userId: req.user!.userId,
    action: "UPDATE_CLAIM_STATUS",
    resource: `Claim:${updated.id}`,
    details: { oldStatus: claim.status, newStatus: updated.status },
    req,
  });

  res.json(updated);
});

// Abertura de Sinistro Online (Auto & Transporte de Cargas RCTR-C) — Pode ser usado via link seguro ou QR Code
claimsRouter.post("/online-intake", async (req: Request, res: Response) => {
  const {
    phoneOrCpf,
    policyNumber,
    incidentType,
    incidentDate,
    incidentLocation,
    description,
    policeReportUrl,
    photos,
    workshopName,
    cargoManifestNumber,
  } = req.body;

  if (!phoneOrCpf || !description || !incidentType) {
    res.status(400).json({ error: "Telefone/CPF, Tipo de Ocorrência e Descrição são obrigatórios." });
    return;
  }

  const clean = String(phoneOrCpf).replace(/\D/g, "");

  // Localiza o segurado por telefone ou CPF
  const insured = await prisma.insured.findFirst({
    where: {
      OR: [
        { phone: { contains: clean.slice(-8) } },
        { cpf: { contains: clean.length >= 8 ? clean : "undefined" } },
      ],
    },
    include: {
      brokerage: true,
      policies: {
        where: { status: "ACTIVE" },
        orderBy: { endDate: "desc" },
      },
    },
  });

  if (!insured) {
    res.status(404).json({ error: "Segurado não localizado no cadastro da corretora." });
    return;
  }

  // Localiza apólice correspondente
  let policy = policyNumber
    ? insured.policies.find((p) => p.policyNumber.includes(policyNumber))
    : insured.policies[0];

  if (!policy && insured.policies.length > 0) {
    policy = insured.policies[0];
  }

  if (!policy) {
    res.status(400).json({ error: "Nenhuma apólice ativa encontrada para vincular este sinistro." });
    return;
  }

  const claim = await prisma.claim.create({
    data: {
      brokerageId: insured.brokerageId,
      insuredId: insured.id,
      policyId: policy.id,
      incidentType,
      incidentDate: incidentDate ? new Date(incidentDate) : new Date(),
      incidentLocation: incidentLocation || undefined,
      description,
      policeReportUrl: policeReportUrl || undefined,
      photos: photos || undefined,
      workshopName: workshopName || undefined,
      cargoManifestNumber: cargoManifestNumber || undefined,
      status: "OPEN",
      brokerNotifiedAt: new Date(),
    },
  });

  const protocol = `SIN-${new Date().getFullYear()}-${claim.id.slice(-6).toUpperCase()}`;

  res.status(201).json({
    success: true,
    protocol,
    claimId: claim.id,
    message: "Aviso de sinistro registrado com sucesso! Nosso corretor já foi notificado.",
    insuredName: insured.name,
    policyNumber: policy.policyNumber,
    insurerName: policy.insurerName,
    assistance24hPhone: policy.assistance24hPhone || "0800 727 0800",
  });
});

// BI de Sinistralidade & Métricas Avançadas de Sinistro
claimsRouter.get("/analytics/bi", requireAuth, async (req: Request, res: Response) => {
  const brokerageId = req.user!.brokerageId;

  const [claims, policies] = await Promise.all([
    prisma.claim.findMany({
      where: { brokerageId },
      include: { policy: { select: { insurerName: true, branch: true, premiumAmount: true } } },
    }),
    prisma.policy.findMany({
      where: { brokerageId, status: "ACTIVE" },
      select: { premiumAmount: true },
    }),
  ]);

  const totalClaims = claims.length;
  const totalPremiumEarned = policies.reduce((acc, p) => acc + Number(p.premiumAmount), 0);

  const byStatus: Record<string, number> = {};
  const byIncidentType: Record<string, number> = {};
  const byBranch: Record<string, number> = {};
  const byInsurer: Record<string, number> = {};
  let totalIndemnity = 0;

  for (const c of claims) {
    byStatus[c.status] = (byStatus[c.status] || 0) + 1;
    byIncidentType[c.incidentType] = (byIncidentType[c.incidentType] || 0) + 1;
    
    const branch = c.policy?.branch || "OUTROS";
    byBranch[branch] = (byBranch[branch] || 0) + 1;

    const insurer = c.policy?.insurerName || "Outras";
    byInsurer[insurer] = (byInsurer[insurer] || 0) + 1;

    if (c.indemnityAmount) {
      totalIndemnity += Number(c.indemnityAmount);
    }
  }

  // Taxa de sinistralidade estimada: (Indenizações Totais / Prêmio Total) * 100
  const lossRatioPercent = totalPremiumEarned > 0 ? Number(((totalIndemnity / totalPremiumEarned) * 100).toFixed(1)) : 0;

  res.json({
    overview: {
      totalClaims,
      openClaims: (byStatus["OPEN"] || 0) + (byStatus["DOCS_COLLECTED"] || 0) + (byStatus["IN_ANALYSIS"] || 0),
      closedClaims: (byStatus["CLOSED"] || 0) + (byStatus["APPROVED"] || 0),
      totalIndemnityPaid: totalIndemnity,
      totalPremiumPortfolio: totalPremiumEarned,
      estimatedLossRatioPercent: lossRatioPercent,
    },
    byStatus,
    byIncidentType,
    byBranch,
    byInsurer,
  });
});
