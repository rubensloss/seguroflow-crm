import { prisma } from "../config/prisma";
import {
  sendWhatsAppTextMessage,
  sendWhatsAppTemplateMessage,
  TemplateComponent,
} from "./whatsappCloud";
import { decryptSensitive } from "../security/crypto";

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
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // Janelas de data
  const dateD7 = new Date(today);
  dateD7.setDate(today.getDate() + 7);

  const dateD0 = new Date(today);

  const dateD2 = new Date(today);
  dateD2.setDate(today.getDate() - 2);

  let d7Count = 0;
  let d0Count = 0;
  let d2Count = 0;

  const baseWhere = targetBrokerageId ? { brokerageId: targetBrokerageId } : {};

  // 1. Disparos D-7 (Vencimento em exatamente 7 dias)
  const installmentsD7 = await prisma.installment.findMany({
    where: {
      ...baseWhere,
      status: "PENDING",
      sentD7At: null,
      dueDate: {
        gte: dateD7,
        lt: new Date(dateD7.getTime() + 24 * 60 * 60 * 1000),
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

  // 2. Disparos D-0 (Vencimento hoje)
  const installmentsD0 = await prisma.installment.findMany({
    where: {
      ...baseWhere,
      status: { in: ["PENDING", "SENT_D7"] },
      sentD0At: null,
      dueDate: {
        gte: dateD0,
        lt: new Date(dateD0.getTime() + 24 * 60 * 60 * 1000),
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

  // 3. Disparos D+2 (Atraso de 2 dias após vencimento)
  const installmentsD2 = await prisma.installment.findMany({
    where: {
      ...baseWhere,
      status: { in: ["PENDING", "SENT_D7", "SENT_D0"] },
      sentD2At: null,
      dueDate: {
        gte: dateD2,
        lt: new Date(dateD2.getTime() + 24 * 60 * 60 * 1000),
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
