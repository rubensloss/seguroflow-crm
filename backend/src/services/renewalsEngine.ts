import { prisma } from "../config/prisma";
import { RenewalWindow } from "@prisma/client";
import { sendWhatsAppTextMessage } from "./whatsappCloud";
import { decryptSensitive } from "../security/crypto";

/**
 * Motor de Varredura de Renovações (60, 30 e 15 dias)
 * Localiza apólices próximas ao vencimento e cria tarefas para o corretor
 */
export async function runRenewalsScan(): Promise<{
  created60: number;
  created30: number;
  created15: number;
}> {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  let created60 = 0;
  let created30 = 0;
  let created15 = 0;

  // Janelas
  const days60Date = new Date(today.getTime() + 60 * 24 * 60 * 60 * 1000);
  const days30Date = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);
  const days15Date = new Date(today.getTime() + 15 * 24 * 60 * 60 * 1000);

  // 1. Janela 60 dias
  const policies60 = await prisma.policy.findMany({
    where: {
      status: "ACTIVE",
      endDate: {
        gte: days60Date,
        lt: new Date(days60Date.getTime() + 24 * 60 * 60 * 1000),
      },
      renewals: { none: { alertWindow: RenewalWindow.DAYS_60 } },
    },
    include: { insured: true, brokerage: true },
  });

  for (const pol of policies60) {
    await prisma.renewalTask.create({
      data: {
        brokerageId: pol.brokerageId,
        policyId: pol.id,
        alertWindow: RenewalWindow.DAYS_60,
        status: "PENDING",
      },
    });
    created60++;
  }

  // 2. Janela 30 dias
  const policies30 = await prisma.policy.findMany({
    where: {
      status: "ACTIVE",
      endDate: {
        gte: days30Date,
        lt: new Date(days30Date.getTime() + 24 * 60 * 60 * 1000),
      },
      renewals: { none: { alertWindow: RenewalWindow.DAYS_30 } },
    },
    include: { insured: true, brokerage: true },
  });

  for (const pol of policies30) {
    await prisma.renewalTask.create({
      data: {
        brokerageId: pol.brokerageId,
        policyId: pol.id,
        alertWindow: RenewalWindow.DAYS_30,
        status: "PENDING",
      },
    });
    created30++;
  }

  // 3. Janela 15 dias
  const policies15 = await prisma.policy.findMany({
    where: {
      status: "ACTIVE",
      endDate: {
        gte: days15Date,
        lt: new Date(days15Date.getTime() + 24 * 60 * 60 * 1000),
      },
      renewals: { none: { alertWindow: RenewalWindow.DAYS_15 } },
    },
    include: { insured: true, brokerage: true },
  });

  for (const pol of policies15) {
    await prisma.renewalTask.create({
      data: {
        brokerageId: pol.brokerageId,
        policyId: pol.id,
        alertWindow: RenewalWindow.DAYS_15,
        status: "PENDING",
      },
    });
    created15++;
  }

  return { created60, created30, created15 };
}
