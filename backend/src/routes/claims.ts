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
