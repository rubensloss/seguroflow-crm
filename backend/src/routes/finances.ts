import { Router, Request, Response } from "express";
import { prisma } from "../config/prisma";
import { requireAuth } from "../security/auth";

export const financesRouter = Router();

/**
 * Módulo Financeiro & Gestão de Comissões
 * Controla faturamento da corretora e blinda contra o estorno de comissões por cancelamento
 */
financesRouter.get("/overview", requireAuth, async (req: Request, res: Response) => {
  const brokerageId = req.user!.brokerageId;

  // 1. Apólices ativas com previsão de comissão
  const policies = await prisma.policy.findMany({
    where: { brokerageId, status: "ACTIVE" },
    select: {
      id: true,
      policyNumber: true,
      insurerName: true,
      premiumAmount: true,
      commissionPercentage: true,
      commissionAmount: true,
      insured: { select: { name: true, phone: true } },
      installments: {
        select: {
          id: true,
          installmentNumber: true,
          amount: true,
          dueDate: true,
          status: true,
        },
      },
    },
  });

  let totalPremium = 0;
  let totalEstimatedCommission = 0;
  const clawbackRiskList: Array<{
    policyId: string;
    policyNumber: string;
    insurerName: string;
    insuredName: string;
    insuredPhone: string;
    commissionAtRisk: number;
    overdueInstallmentsCount: number;
    oldestOverdueDate: Date;
  }> = [];

  const insurerDistribution: Record<string, { policiesCount: number; totalPremium: number; totalCommission: number }> = {};

  for (const pol of policies) {
    const prem = Number(pol.premiumAmount);
    totalPremium += prem;

    const comm = pol.commissionAmount ? Number(pol.commissionAmount) : (prem * (Number(pol.commissionPercentage) || 15)) / 100;
    totalEstimatedCommission += comm;

    // Distribuição por seguradora
    if (!insurerDistribution[pol.insurerName]) {
      insurerDistribution[pol.insurerName] = { policiesCount: 0, totalPremium: 0, totalCommission: 0 };
    }
    insurerDistribution[pol.insurerName].policiesCount++;
    insurerDistribution[pol.insurerName].totalPremium += prem;
    insurerDistribution[pol.insurerName].totalCommission += comm;

    // Detecção de Risco de Estorno: parcelas OVERDUE ou pendentes há mais de 2 dias do vencimento
    const overdueInsts = pol.installments.filter(
      (inst) => inst.status === "OVERDUE" || (inst.status !== "PAID" && new Date(inst.dueDate) < new Date(Date.now() - 2 * 24 * 60 * 60 * 1000))
    );

    if (overdueInsts.length > 0) {
      const oldest = overdueInsts.sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime())[0];
      clawbackRiskList.push({
        policyId: pol.id,
        policyNumber: pol.policyNumber,
        insurerName: pol.insurerName,
        insuredName: pol.insured.name,
        insuredPhone: pol.insured.phone,
        commissionAtRisk: Number(comm.toFixed(2)),
        overdueInstallmentsCount: overdueInsts.length,
        oldestOverdueDate: oldest.dueDate,
      });
    }
  }

  // Total de comissões em risco iminente de estorno
  const totalCommissionAtRisk = clawbackRiskList.reduce((acc, curr) => acc + curr.commissionAtRisk, 0);

  res.json({
    summary: {
      totalActivePolicies: policies.length,
      totalPremiumPortfolio: totalPremium,
      totalEstimatedCommission,
      totalCommissionAtRisk,
      clawbackRiskCount: clawbackRiskList.length,
    },
    clawbackRiskList: clawbackRiskList.sort((a, b) => b.commissionAtRisk - a.commissionAtRisk),
    insurerDistribution,
  });
});
