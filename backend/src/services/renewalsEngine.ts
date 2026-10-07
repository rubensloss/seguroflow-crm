import { prisma } from "../config/prisma";
import { RenewalWindow } from "@prisma/client";
import {
  sendWhatsAppTextMessage,
  sendWhatsAppTemplateMessage,
  isWithinCustomer24hWindow,
  TemplateComponent,
} from "./whatsappCloud";
import { decryptSensitive } from "../security/crypto";
import { getSaoPauloDateAndHour } from "./scheduler";

function getTargetDateStr(baseDateStr: string, offsetDays: number): string {
  const [year, month, day] = baseDateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day + offsetDays, 12, 0, 0));
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getCalendarDayBounds(dateStr: string): { gte: Date; lte: Date } {
  const gte = new Date(`${dateStr}T00:00:00.000Z`);
  const lte = new Date(new Date(`${dateStr}T23:59:59.999-03:00`).getTime());
  return { gte, lte };
}

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
  const { dateStr: todayBrt } = getSaoPauloDateAndHour();

  let created60 = 0;
  let created30 = 0;
  let created15 = 0;

  // Janelas calculadas no fuso de Brasília
  const days60Str = getTargetDateStr(todayBrt, 60);
  const days30Str = getTargetDateStr(todayBrt, 30);
  const days15Str = getTargetDateStr(todayBrt, 15);

  const range60 = getCalendarDayBounds(days60Str);
  const range30 = getCalendarDayBounds(days30Str);
  const range15 = getCalendarDayBounds(days15Str);

  const baseWhere = targetBrokerageId ? { brokerageId: targetBrokerageId } : {};

  // 1. Janela 60 dias
  const policies60 = await prisma.policy.findMany({
    where: {
      ...baseWhere,
      status: "ACTIVE",
      endDate: {
        gte: range60.gte,
        lte: range60.lte,
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
        gte: range30.gte,
        lte: range30.lte,
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
        gte: range15.gte,
        lte: range15.lte,
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
      `[RenewalsEngine] Template "${templateName}" falhou para ${insured.phone}. Verificando janela de 24h...`
    );
  }

  // Regra Estrita (Rodada 7): NUNCA mandar texto livre fora da janela de 24h!
  const inWindow = await isWithinCustomer24hWindow(brokerage.id, insured.phone);
  if (!inWindow) {
    console.warn(
      `[RenewalsEngine] Cliente ${insured.phone} fora da janela de 24h e template falhou. Gerando tarefa para contato manual.`
    );
    await prisma.pipelineCard.create({
      data: {
        brokerageId: brokerage.id,
        insuredId: insured.id,
        title: `📞 Contato Manual: Renovação ${policy.insurerName} (${insured.name})`,
        stage: "NOVO",
        notes: `Aviso automático de renovação (${daysLeft} dias) não pôde ser entregue via template oficial e o segurado está fora da janela de 24h do WhatsApp. Fazer contato ativo.`,
      },
    });
    return false;
  }

  // Fallback seguro: Texto livre APENAS se dentro da janela de 24h
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
