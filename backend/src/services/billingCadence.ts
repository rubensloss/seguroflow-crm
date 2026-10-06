import { prisma } from "../config/prisma";
import { sendWhatsAppTextMessage, sendWhatsAppTemplateMessage } from "./whatsappCloud";
import { decryptSensitive } from "../security/crypto";

/**
 * Motor da Régua de Cobrança Preventiva (D-7, D-0, D+2)
 * Dispara automaticamente lembretes com código Pix / boleto da SEGURADORA.
 */
export async function runBillingCadenceScan(): Promise<{
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

  // 1. Disparos D-7 (Vencimento em exatamente 7 dias)
  const installmentsD7 = await prisma.installment.findMany({
    where: {
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

  let message = "";
  if (phase === "D-7") {
    message = `Olá, *${insured.name}*! Tudo bem?\n\nPassando para lembrar que a parcela ${installment.installmentNumber} do seu seguro (*${policy.insurerName}*) vence em *${dueFormatted}* no valor de *${valorFormatted}*.\n\nCódigo para pagamento:\n\`${installment.paymentCode || "Consulte o boleto enviado"}\`\n\nQualquer dúvida, estamos à disposição!`;
  } else if (phase === "D-0") {
    message = `Olá, *${insured.name}*!\n\nLembramos que sua parcela do seguro (*${policy.insurerName}*) vence *HOJE (${dueFormatted})* no valor de *${valorFormatted}*.\n\nCódigo de pagamento:\n\`${installment.paymentCode || "Consulte seu boleto"}\`\n\nCaso já tenha efetuado o pagamento, por favor desconsidere!`;
  } else {
    message = `Atenção, *${insured.name}*!\n\nConstatamos que a parcela do seu seguro (*${policy.insurerName}*) com vencimento em ${dueFormatted} ainda não consta compensada. Para evitar a suspensão da cobertura da sua apólice, regularize seu pagamento:\n\nCódigo:\n\`${installment.paymentCode || "Consulte a corretora"}\``;
  }

  try {
    await sendWhatsAppTextMessage(
      insured.phone,
      message,
      brokerage.whatsappPhoneNumberId,
      token
    );
    return true;
  } catch (error) {
    console.error(`Erro ao enviar alerta ${phase} para ${insured.phone}:`, error);
    return false;
  }
}
