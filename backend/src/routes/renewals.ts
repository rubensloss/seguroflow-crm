import { Router, Request, Response } from "express";
import { RenewalStatus, RenewalWindow } from "@prisma/client";
import { prisma } from "../config/prisma";
import { requireAuth } from "../security/auth";
import { runRenewalsScan } from "../services/renewalsEngine";

export const renewalsRouter = Router();

// Listagem de tarefas de renovação organizadas por janelas (60d, 30d, 15d)
renewalsRouter.get("/", requireAuth, async (req: Request, res: Response) => {
  const brokerageId = req.user!.brokerageId;
  const { window, status } = req.query;

  const whereClause: any = { brokerageId };
  if (window) whereClause.alertWindow = window as RenewalWindow;
  if (status) whereClause.status = status as RenewalStatus;

  const tasks = await prisma.renewalTask.findMany({
    where: whereClause,
    include: {
      policy: {
        include: {
          insured: { select: { id: true, name: true, phone: true } },
        },
      },
      assignedUser: { select: { id: true, name: true } },
    },
    orderBy: { policy: { endDate: "asc" } },
  });

  const grouped = {
    DAYS_60: tasks.filter((t) => t.alertWindow === "DAYS_60"),
    DAYS_30: tasks.filter((t) => t.alertWindow === "DAYS_30"),
    DAYS_15: tasks.filter((t) => t.alertWindow === "DAYS_15"),
  };

  res.json({
    tasks,
    grouped,
    totalCount: tasks.length,
    pendingCount: tasks.filter((t) => t.status === "PENDING").length,
  });
});

// Relatório mensal de retenção de renovações e análise de perdas
renewalsRouter.get("/report", requireAuth, async (req: Request, res: Response) => {
  const brokerageId = req.user!.brokerageId;
  const monthParam = typeof req.query.month === "string" && /^\d{4}-\d{2}$/.test(req.query.month)
    ? req.query.month
    : new Date().toISOString().slice(0, 7);

  const [yearStr, monthStr] = monthParam.split("-");
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);

  const startDate = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  const endDate = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));

  const policies = await prisma.policy.findMany({
    where: {
      brokerageId,
      endDate: {
        gte: startDate,
        lt: endDate,
      },
    },
    include: {
      renewals: true,
      assignedUser: { select: { id: true, name: true } },
    },
  });

  const totalPoliciesExpired = policies.length;
  let totalRenewed = 0;
  let totalLost = 0;
  let totalPending = 0;

  let lostPremium = 0;
  let lostCommission = 0;
  let retainedPremium = 0;
  let retainedCommission = 0;

  const reasonCounts: Record<string, number> = {
    PRECO: 0,
    VENDEU_BEM: 0,
    FECHOU_BANCO: 0,
    FECHOU_OUTRA_CORRETORA: 0,
    SEM_CONTATO: 0,
    OUTRO: 0,
  };

  const brokerMap: Record<
    string,
    {
      brokerId: string | null;
      brokerName: string;
      totalExpired: number;
      renewed: number;
      lost: number;
      pending: number;
      lostPremium: number;
      lostCommission: number;
    }
  > = {};

  const subBranchMap: Record<
    string,
    {
      subBranch: string;
      totalExpired: number;
      renewed: number;
      lost: number;
      pending: number;
      lostPremium: number;
      lostCommission: number;
    }
  > = {};

  for (const pol of policies) {
    const premium = Number(pol.premiumAmount || 0);
    const comm = pol.commissionAmount != null
      ? Number(pol.commissionAmount)
      : premium * (Number(pol.commissionPercentage || 0) / 100);

    const brokerId = pol.assignedUserId || null;
    const brokerName = pol.assignedUser ? pol.assignedUser.name : "Não atribuído";
    const brokerKey = brokerId || "unassigned";

    if (!brokerMap[brokerKey]) {
      brokerMap[brokerKey] = {
        brokerId,
        brokerName,
        totalExpired: 0,
        renewed: 0,
        lost: 0,
        pending: 0,
        lostPremium: 0,
        lostCommission: 0,
      };
    }
    brokerMap[brokerKey].totalExpired += 1;

    const subBranchKey = pol.subBranch || "Outros";
    if (!subBranchMap[subBranchKey]) {
      subBranchMap[subBranchKey] = {
        subBranch: subBranchKey,
        totalExpired: 0,
        renewed: 0,
        lost: 0,
        pending: 0,
        lostPremium: 0,
        lostCommission: 0,
      };
    }
    subBranchMap[subBranchKey].totalExpired += 1;

    const isRenewed = pol.status === "RENEWED" || pol.renewals.some((r) => r.status === "RENEWED");
    const lostTask = pol.renewals.find((r) => r.status === "LOST");
    const isLost = !isRenewed && Boolean(lostTask);

    if (isRenewed) {
      totalRenewed += 1;
      retainedPremium += premium;
      retainedCommission += comm;
      brokerMap[brokerKey].renewed += 1;
      subBranchMap[subBranchKey].renewed += 1;
    } else if (isLost && lostTask) {
      totalLost += 1;
      lostPremium += premium;
      lostCommission += comm;
      brokerMap[brokerKey].lost += 1;
      brokerMap[brokerKey].lostPremium += premium;
      brokerMap[brokerKey].lostCommission += comm;

      subBranchMap[subBranchKey].lost += 1;
      subBranchMap[subBranchKey].lostPremium += premium;
      subBranchMap[subBranchKey].lostCommission += comm;

      const rawReason = (lostTask.lostReason || "OUTRO").trim().toUpperCase();
      if (reasonCounts[rawReason] !== undefined) {
        reasonCounts[rawReason] += 1;
      } else {
        reasonCounts["OUTRO"] += 1;
      }
    } else {
      totalPending += 1;
      brokerMap[brokerKey].pending += 1;
      subBranchMap[subBranchKey].pending += 1;
    }
  }

  const retentionRate = totalPoliciesExpired > 0
    ? Number(((totalRenewed / totalPoliciesExpired) * 100).toFixed(1))
    : 0;

  const reasonLabels: Record<string, string> = {
    PRECO: "Preço / Concorrência",
    VENDEU_BEM: "Vendeu o Bem / Sem Interesse",
    FECHOU_BANCO: "Fechou com Banco",
    FECHOU_OUTRA_CORRETORA: "Fechou com Outra Corretora",
    SEM_CONTATO: "Sem Contato / Não Respondeu",
    OUTRO: "Outro Motivo",
  };

  const lossesByReason = Object.entries(reasonCounts).map(([reason, count]) => ({
    reason,
    label: reasonLabels[reason] || reason,
    count,
    percentage: totalLost > 0 ? Number(((count / totalLost) * 100).toFixed(1)) : 0,
  }));

  const byBroker = Object.values(brokerMap).map((b) => ({
    ...b,
    retentionRate: b.totalExpired > 0 ? Number(((b.renewed / b.totalExpired) * 100).toFixed(1)) : 0,
    lostPremium: Number(b.lostPremium.toFixed(2)),
    lostCommission: Number(b.lostCommission.toFixed(2)),
  }));

  const bySubBranch = Object.values(subBranchMap).map((sb) => ({
    ...sb,
    retentionRate: sb.totalExpired > 0 ? Number(((sb.renewed / sb.totalExpired) * 100).toFixed(1)) : 0,
    lostPremium: Number(sb.lostPremium.toFixed(2)),
    lostCommission: Number(sb.lostCommission.toFixed(2)),
  }));

  res.json({
    month: monthParam,
    retentionRate,
    totalPoliciesExpired,
    totalRenewed,
    totalLost,
    totalPending,
    lossesByReason,
    byBroker,
    bySubBranch,
    financialImpact: {
      lostPremium: Number(lostPremium.toFixed(2)),
      lostCommission: Number(lostCommission.toFixed(2)),
      retainedPremium: Number(retainedPremium.toFixed(2)),
      retainedCommission: Number(retainedCommission.toFixed(2)),
    },
  });
});

// Atualiza o status da renovação (Renovada, Perdida com motivo, Em negociação)
renewalsRouter.patch("/:id", requireAuth, async (req: Request, res: Response) => {
  const { status, lostReason, lostNotes, assignedUserId } = req.body;

  if (status === "LOST") {
    if (!lostReason || typeof lostReason !== "string" || !lostReason.trim()) {
      res.status(400).json({
        error: "O motivo da perda (lostReason) é obrigatório ao marcar a renovação como perdida (LOST).",
      });
      return;
    }
  }

  const task = await prisma.renewalTask.findFirst({
    where: { id: req.params.id, brokerageId: req.user!.brokerageId },
  });

  if (!task) {
    res.status(404).json({ error: "Tarefa de renovação não encontrada" });
    return;
  }

  const updated = await prisma.renewalTask.update({
    where: { id: task.id },
    data: {
      status: status || undefined,
      lostReason: status === "LOST" ? lostReason.trim() : (lostReason || undefined),
      lostNotes: lostNotes !== undefined ? lostNotes : undefined,
      assignedUserId: assignedUserId || undefined,
      lastContactAt: new Date(),
    },
  });

  // Se marcada como RENEWED, atualiza também a apólice
  if (status === "RENEWED") {
    await prisma.policy.update({
      where: { id: task.policyId },
      data: { status: "RENEWED" },
    });
  }

  res.json(updated);
});

// Varredura manual de renovações — ISOLADA por corretora
renewalsRouter.post("/scan", requireAuth, async (req: Request, res: Response) => {
  if (req.user!.role !== "OWNER" && req.user!.role !== "BROKER") {
    res.status(403).json({ error: "Apenas administradores e corretores podem acionar a varredura manual." });
    return;
  }

  const result = await runRenewalsScan(req.user!.brokerageId);
  res.json({
    success: true,
    message: "Varredura de renovações executada com sucesso para a sua corretora.",
    result,
  });
});
