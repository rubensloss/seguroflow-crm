import { prisma } from "./config/prisma";
import { hashPassword } from "./security/auth";
import { encryptSensitive } from "./security/crypto";
import { InsuranceBranch, PipelineStage, RenewalWindow } from "@prisma/client";

import crypto from "crypto";

async function main() {
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_PROD_SEED !== "true") {
    console.error("⛔ SEGURANÇA: Execução de seed bloqueada em ambiente de PRODUÇÃO!");
    process.exit(1);
  }

  console.log("🌱 Iniciando seed seguro do SeguroFlow...");

  // 1. Cria ou atualiza Corretora Piloto
  const slug = "seguroflow-prime";
  let brokerage = await prisma.brokerage.findUnique({ where: { slug } });

  const dummyToken = encryptSensitive("EAAGm0PX4ZBBOwBZC9X7vZCPx7qK8SAMPLE");
  const dummySecret = encryptSensitive("secret_seguroflow_prime_app");

  if (!brokerage) {
    brokerage = await prisma.brokerage.create({
      data: {
        name: "SeguroFlow Prime Corretora",
        slug,
        cnpj: "12.345.678/0001-90",
        phone: "5527988140076",
        email: "contato@seguroflowprime.com.br",
        alertPhone: "5527988140076",
        whatsappPhoneNumberId: "109876543210987",
        whatsappAccessTokenEncrypted: dummyToken,
        whatsappAppSecretEncrypted: dummySecret,
        whatsappVerifyToken: "seguroflow_prime_token_2026",
      },
    });
  }

  // 2. Cria Usuário Dono (Owner)
  const initialPassword = process.env.SEED_ADMIN_PASSWORD || "dev_seguroflow_" + crypto.randomBytes(4).toString("hex");
  const passwordHash = await hashPassword(initialPassword);
  const ownerEmail = "rubens@seguroflow.com.br";

  let user = await prisma.user.findUnique({ where: { email: ownerEmail } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        brokerageId: brokerage.id,
        name: "Rubens Corretor",
        email: ownerEmail,
        passwordHash,
        role: "OWNER",
      },
    });
  }

  // 3. Cria Segurados
  const seguradosData = [
    { name: "Mariana Costa Silveira", phone: "5527999887766", cpf: "12345678901", email: "mariana@exemplo.com.br" },
    { name: "Carlos Eduardo Pereira", phone: "5527998881122", cpf: "23456789012", email: "carlos@exemplo.com.br" },
    { name: "Beatriz Nogueira Lima", phone: "5527997773344", cpf: "34567890123", email: "beatriz@exemplo.com.br" },
  ];

  for (const s of seguradosData) {
    let insured = await prisma.insured.findFirst({
      where: { brokerageId: brokerage.id, phone: s.phone },
    });

    if (!insured) {
      insured = await prisma.insured.create({
        data: {
          brokerageId: brokerage.id,
          name: s.name,
          phone: s.phone,
          cpf: s.cpf,
          email: s.email,
        },
      });

      // Cria Apólice
      const policy = await prisma.policy.create({
        data: {
          brokerageId: brokerage.id,
          insuredId: insured.id,
          policyNumber: `APOL-${Math.floor(100000 + Math.random() * 900000)}`,
          insurerName: "Porto Seguro",
          branch: InsuranceBranch.AUTO,
          assistance24hPhone: "0800 727 0800",
          startDate: new Date(),
          endDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
          premiumAmount: 3200.0,
          itemDescription: "Toyota Corolla Cross 2024",
        },
      });

      // Cria Parcelas para testar a régua (D-7, D-0)
      const now = new Date();
      const dueD7 = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      const dueD0 = new Date(now);

      await prisma.installment.create({
        data: {
          brokerageId: brokerage.id,
          policyId: policy.id,
          installmentNumber: 1,
          dueDate: dueD0,
          amount: 800.0,
          paymentCode: "00020126580014br.gov.bcb.pix0136porto-seguro-pix-oficial520400005303986540800.005802BR",
          status: "PENDING",
        },
      });

      await prisma.installment.create({
        data: {
          brokerageId: brokerage.id,
          policyId: policy.id,
          installmentNumber: 2,
          dueDate: dueD7,
          amount: 800.0,
          paymentCode: "00020126580014br.gov.bcb.pix0136porto-seguro-pix-oficial-parc2520400005303986540800.005802BR",
          status: "PENDING",
        },
      });

      // Cria tarefa de renovação
      await prisma.renewalTask.create({
        data: {
          brokerageId: brokerage.id,
          policyId: policy.id,
          alertWindow: RenewalWindow.DAYS_60,
          status: "PENDING",
          assignedUserId: user.id,
        },
      });
    }
  }

  // 4. Cria Cards no Funil (Kanban)
  const funilCards = [
    { title: "Cotação Frota - Indústria ABC", value: 12500, stage: PipelineStage.COTACAO, source: "Indicação" },
    { title: "Proposta Seguro Vida - Dr. Marcos", value: 3800, stage: PipelineStage.PROPOSTA, source: "WhatsApp" },
    { title: "Emissão Seguro Auto - Fernanda Lima", value: 2900, stage: PipelineStage.EMISSAO, source: "Site" },
  ];

  for (const c of funilCards) {
    await prisma.pipelineCard.create({
      data: {
        brokerageId: brokerage.id,
        title: c.title,
        value: c.value,
        stage: c.stage,
        source: c.source,
        assignedUserId: user.id,
      },
    });
  }

  console.log("✅ Seed concluído com sucesso!");
  console.log(`Corretora: ${brokerage.name} (${brokerage.slug})`);
  console.log(`Usuário de Teste: ${ownerEmail} | Senha: seguroflow2026`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
