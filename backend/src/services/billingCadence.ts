import { prisma } from "../config/prisma";
import {
  sendWhatsAppTextMessage,
  sendWhatsAppTemplateMessage,
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
 * Motor da Régua de Cobrança Preventiva (D-7, D-0, D+2)
 * Dispara automaticamente lembretes com código Pix / boleto da SEGURADORA.
 *
 * Em conformidade com as regras da Meta WhatsApp Cloud API:
 * Disparos fora da janela de 24h utilizam TEMPLATES oficiais aprovados
 * (cobranca_d7, cobranca_d0, cobranca_d2) com parâmetros dinâmicos.
 *
 * @param targetBrokerageId Opcional. Se informado, isola a execução exclusivamente para esta corretora.
 */
export async function runBillingCadenceScan(targetBrokerageId?: string): Promise<{
  d7Count: number;
  d0Count: number;
  d2Count: number;
}> {
  const { dateStr: todayBrt } = getSaoPauloDateAndHour();

  // Janelas de data calculadas no fuso de Brasília
  const dateD7Str = getTargetDateStr(todayBrt, +7);
  const dateD0Str = todayBrt;
  const dateD2Str = getTargetDateStr(todayBrt, -2);

  const rangeD7 = getCalendarDayBounds(dateD7Str);
  const rangeD0 = getCalendarDayBounds(dateD0Str);
  const rangeD2 = getCalendarDayBounds(dateD2Str);

  let d7Count = 0;
  let d0Count = 0;
  let d2Count = 0;

  const baseWhere = targetBrokerageId ? { brokerageId: targetBrokerageId } : {};

  // 1. Disparos D-7 (Vencimento em exatamente 7 dias no horário de Brasília)
  const installmentsD7 = await prisma.installment.findMany({
    where: {
      ...baseWhere,
      status: "PENDING",
      sentD7At: null,
      dueDate: {
        gte: rangeD7.gte,
        lte: rangeD7.lte,
      },
    },
    include: {
      policy: { include: { insured: true } },
      brokerage: true,
    },
  });

  for (const inst of installmentsD7) {
    if (await dispatchInstallmentAlert(inst, "D-7")) {
      await prisma.installment.update({
        where: { id: inst.id },
        data: { sentD7At: new Date(), status: "SENT_D7" },
      });
      d7Count++;
    }
  }

  // 2. Disparos D-0 (Vencimento hoje no horário de Brasília)
  const installmentsD0 = await prisma.installment.findMany({
    where: {
      ...baseWhere,
      status: { in: ["PENDING", "SENT_D7"] },
      sentD0At: null,
      dueDate: {
        gte: rangeD0.gte,
        lte: rangeD0.lte,
      },
    },
    include: {
      policy: { include: { insured: true } },
      brokerage: true,
    },
  });

  for (const inst of installmentsD0) {
    if (await dispatchInstallmentAlert(inst, "D-0")) {
      await prisma.installment.update({
        where: { id: inst.id },
        data: { sentD0At: new Date(), status: "SENT_D0" },
      });
      d0Count++;
    }
  }

  // 3. Disparos D+2 (Atraso de 2 dias após vencimento no horário de Brasília)
  const installmentsD2 = await prisma.installment.findMany({
    where: {
      ...baseWhere,
      status: { in: ["PENDING", "SENT_D7", "SENT_D0"] },
      sentD2At: null,
      dueDate: {
        gte: rangeD2.gte,
        lte: rangeD2.lte,
      },
    },
    include: {
      policy: { include: { insured: true } },
      brokerage: true,
    },
  });

  for (const inst of installmentsD2) {
    if (await dispatchInstallmentAlert(inst, "D+2")) {
      await prisma.installment.update({
        where: { id: inst.id },
        data: { sentD2At: new Date(), status: "OVERDUE" },
      });
      d2Count++;
    }
  }

  return { d7Count, d0Count, d2Count };
}

async function dispatchInstallmentAlert(
  installment: any,
  phase: "D-7" | "D-0" | "D+2"
): Promise<boolean> {
  const { brokerage, policy } = installment;
  const insured = policy.insured;

  if (
    !brokerage.whatsappPhoneNumberId ||
    !brokerage.whatsappAccessTokenEncrypted ||
    !insured.phone
  ) {
    return false;
  }

  const token = decryptSensitive(brokerage.whatsappAccessTokenEncrypted);
  if (!token) return false;

  const dueFormatted = new Date(installment.dueDate).toLocaleDateString("pt-BR");
  const valorFormatted = Number(installment.amount).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
  const paymentCode = installment.paymentCode || "Consulte o boleto enviado";

  // Mapeamento de template oficial Meta por fase
  const templateNameMap: Record<string, string> = {
    "D-7": "cobranca_d7",
    "D-0": "cobranca_d0",
    "D+2": "cobranca_d2",
  };
  const templateName = templateNameMap[phase];

  // Componentes estruturados para o template Meta
  const components: TemplateComponent[] = [
    {
      type: "body",
      parameters: [
        { type: "text", text: insured.name },
        { type: "text", text: policy.insurerName },
        { type: "text", text: dueFormatted },
        { type: "text", text: valorFormatted },
        { type: "text", text: paymentCode },
      ],
    },
  ];

  // 1ª Tentativa: Envio via Template Oficial Aprovado (obrigatório fora da janela de 24h)
  try {
    const msgId = await sendWhatsAppTemplateMessage(
      insured.phone,
      templateName,
      "pt_BR",
      components,
      brokerage.whatsappPhoneNumberId,
      token
    );
    if (msgId) {
      return true;
    }
  } catch (templateErr) {
    console.warn(
      `[BillingCadence] Template "${templateName}" falhou para ${insured.phone}. Tentando fallback de texto... Detalhes:`,
      templateErr instanceof Error ? templateErr.message : templateErr
    );
  }

  // Fallback: Envio via texto livre caso a conversa esteja dentro da janela de 24h
  let fallbackMessage = "";
  if (phase === "D-7") {
    fallbackMessage = `Olá, *${insured.name}*! Tudo bem?\n\nPassando para lembrar que a parcela ${installment.installmentNumber} do seu seguro (*${policy.insurerName}*) vence em *${dueFormatted}* no valor de *${valorFormatted}*.\n\nCódigo para pagamento:\n\`${paymentCode}\`\n\nQualquer dúvida, estamos à disposição!`;
  } else if (phase === "D-0") {
    fallbackMessage = `Olá, *${insured.name}*!\n\nLembramos que sua parcela do seguro (*${policy.insurerName}*) vence *HOJE (${dueFormatted})* no valor de *${valorFormatted}*.\n\nCódigo de pagamento:\n\`${paymentCode}\`\n\nCaso já tenha efetuado o pagamento, por favor desconsidere!`;
  } else {
    fallbackMessage = `Atenção, *${insured.name}*!\n\nConstatamos que a parcela do seu seguro (*${policy.insurerName}*) com vencimento em ${dueFormatted} ainda não consta compensada. Para evitar a suspensão da cobertura da sua apólice, regularize seu pagamento:\n\nCódigo:\n\`${paymentCode}\``;
  }

  try {
    await sendWhatsAppTextMessage(
      insured.phone,
      fallbackMessage,
      brokerage.whatsappPhoneNumberId,
      token
    );
    return true;
  } catch (textErr) {
    console.error(`[BillingCadence] Erro definitivo ao enviar alerta ${phase} para ${insured.phone}:`, textErr);
    return false;
  }
}
