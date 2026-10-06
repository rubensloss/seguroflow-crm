import { prisma } from "../config/prisma";
import { RenewalWindow } from "@prisma/client";
import {
  sendWhatsAppTextMessage,
  sendWhatsAppTemplateMessage,
  TemplateComponent,
} from "./whatsappCloud";
import { decryptSensitive } from "../security/crypto";

/**
 * Motor de Varredura de Renovações (60, 30 e 15 dias)
 * Localiza apólices próximas ao vencimento, cria tarefas para o corretor
 * e dispara alerta inicial preventivo ao segurado via WhatsApp Oficial Meta.
 *
 * @param targetBrokerageId Opcional. Se informado, isola a varredura exclusivamente para esta corretora.
 */
export async function runRenewalsScan(targetBrokerageId?: string): Promise<{
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

  const baseWhere = targetBrokerageId ? { brokerageId: targetBrokerageId } : {};

  // 1. Janela 60 dias
  const policies60 = await prisma.policy.findMany({
    where: {
      ...baseWhere,
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
    await dispatchRenewalNotification(pol, 60);
    created60++;
  }

  // 2. Janela 30 dias
  const policies30 = await prisma.policy.findMany({
    where: {
      ...baseWhere,
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
    await dispatchRenewalNotification(pol, 30);
    created30++;
  }

  // 3. Janela 15 dias
  const policies15 = await prisma.policy.findMany({
    where: {
      ...baseWhere,
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
    await dispatchRenewalNotification(pol, 15);
    created15++;
  }

  return { created60, created30, created15 };
}

async function dispatchRenewalNotification(policy: any, daysLeft: number): Promise<boolean> {
  const { brokerage, insured } = policy;

  if (
    !brokerage.whatsappPhoneNumberId ||
    !brokerage.whatsappAccessTokenEncrypted ||
    !insured?.phone
  ) {
    return false;
  }

  const token = decryptSensitive(brokerage.whatsappAccessTokenEncrypted);
  if (!token) return false;

  const endFormatted = new Date(policy.endDate).toLocaleDateString("pt-BR");
  const templateName = `renovacao_${daysLeft}d`;

  // Parâmetros do template Meta
  const components: TemplateComponent[] = [
    {
      type: "body",
      parameters: [
        { type: "text", text: insured.name },
        { type: "text", text: policy.insurerName },
        { type: "text", text: String(daysLeft) },
        { type: "text", text: endFormatted },
      ],
    },
  ];

  // Tentativa 1: Template oficial Meta
  try {
    const msgId = await sendWhatsAppTemplateMessage(
      insured.phone,
      templateName,
      "pt_BR",
      components,
      brokerage.whatsappPhoneNumberId,
      token
    );
    if (msgId) return true;
  } catch (err) {
    console.warn(
      `[RenewalsEngine] Template "${templateName}" falhou para ${insured.phone}. Tentando fallback de texto...`
    );
  }

  // Fallback: Texto livre para janela de 24h
  const fallbackMessage = `Olá, *${insured.name}*!\n\nSua apólice de seguro (*${policy.insurerName}*) vencerá em *${daysLeft} dias* (${endFormatted}).\n\nNossa equipe já está preparando o estudo de renovação com as melhores condições e bônus aplicados. Podemos falar a respeito?`;

  try {
    await sendWhatsAppTextMessage(
      insured.phone,
      fallbackMessage,
      brokerage.whatsappPhoneNumberId,
      token
    );
    return true;
  } catch (textErr) {
    console.error(`[RenewalsEngine] Erro ao enviar aviso de renovação para ${insured.phone}:`, textErr);
    return false;
  }
}
