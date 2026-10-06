import { Router, Request, Response } from "express";
import { prisma } from "../config/prisma";
import { requireAuth } from "../security/auth";

export const dashboardRouter = Router();

// Painel de Indicadores 100% reais calculados no banco (Módulo 6)
dashboardRouter.get("/kpis", requireAuth, async (req: Request, res: Response) => {
  const brokerageId = req.user!.brokerageId;

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

  // 1. Parcelas e compliance de pagamento
  const totalInstallments = await prisma.installment.count({
    where: { brokerageId },
  });

  const paidInstallments = await prisma.installment.count({
    where: { brokerageId, status: "PAID" },
  });

  const overdueInstallments = await prisma.installment.count({
    where: { brokerageId, status: "OVERDUE" },
  });

  const claimedPaidInstallments = await prisma.installment.count({
    where: { brokerageId, status: "CLAIMED_PAID" },
  });

  const paymentComplianceRate =
    totalInstallments > 0
      ? Math.round((paidInstallments / totalInstallments) * 100)
      : null;

  // 2. Sinistros abertos
  const openClaimsCount = await prisma.claim.count({
    where: {
      brokerageId,
      status: { in: ["OPEN", "DOCS_COLLECTED", "FORWARDED_TO_INSURER", "IN_ANALYSIS"] },
    },
  });

  const totalClaimsCount = await prisma.claim.count({
    where: { brokerageId },
  });

  // 3. Renovações do Mês
  const monthRenewals = await prisma.renewalTask.findMany({
    where: {
      brokerageId,
      policy: {
        endDate: { gte: startOfMonth, lte: endOfMonth },
      },
    },
  });

  const renewedCount = monthRenewals.filter((r) => r.status === "RENEWED").length;
  const lostCount = monthRenewals.filter((r) => r.status === "LOST").length;
  const inNegotiationCount = monthRenewals.filter((r) => r.status === "IN_NEGOTIATION" || r.status === "CONTACTED").length;

  // 4. Funil de Vendas por Fase
  const pipelineGroups = await prisma.pipelineCard.groupBy({
    by: ["stage"],
    where: { brokerageId },
    _count: { id: true },
    _sum: { value: true },
  });

  const funnelByStage: Record<string, { count: number; totalValue: number }> = {
    NOVO: { count: 0, totalValue: 0 },
    COTACAO: { count: 0, totalValue: 0 },
    PROPOSTA: { count: 0, totalValue: 0 },
    EMISSAO: { count: 0, totalValue: 0 },
    POS_VENDA: { count: 0, totalValue: 0 },
  };

  for (const group of pipelineGroups) {
    funnelByStage[group.stage] = {
      count: group._count.id,
      totalValue: Number(group._sum.value || 0),
    };
  }

  // 5. Total de segurados e apólices ativas
  const totalInsureds = await prisma.insured.count({ where: { brokerageId } });
  const activePolicies = await prisma.policy.count({
    where: { brokerageId, status: "ACTIVE" },
  });

  res.json({
    kpis: {
      paymentComplianceRate, // null se não houver dados, conforme regra 0.1 #6
      paidInstallments,
      overdueInstallments,
      claimedPaidInstallments,
      totalInstallments,
      openClaimsCount,
      totalClaimsCount,
      totalInsureds,
      activePolicies,
      renewals: {
        totalExpiringThisMonth: monthRenewals.length,
        renewedCount,
        lostCount,
        inNegotiationCount,
      },
      funnelByStage,
    },
  });
});
