import { Router, Request, Response } from "express";
import { z } from "zod";
import { ClaimStatus } from "@prisma/client";
import { prisma } from "../config/prisma";
import { requireAuth } from "../security/auth";
import { recordAuditLog } from "../services/auditLog";
import { checkRateLimit } from "../security/rateLimit";
import {
  generateOtpCode,
  createOtpChallengeToken,
  verifyOtpChallengeToken,
  sendOtpToWhatsApp,
} from "../services/otpService";
import { resolveAssistance24hPhone } from "../services/insurerDirectory";
import { sendWhatsAppTextMessage } from "../services/whatsappCloud";
import { decryptSensitive } from "../security/crypto";

export const claimsRouter = Router();

const claimSchema = z.object({
  insuredId: z.string().min(1, "Segurado é obrigatório"),
  policyId: z.string().min(1, "Apólice é obrigatória"),
  incidentType: z.string().min(1, "Tipo de ocorrência é obrigatório"),
  incidentDate: z.string().optional(),
  incidentLocation: z.string().optional(),
  description: z.string().min(5, "Descrição é obrigatória"),
  policeReportUrl: z.string().optional(),
});

// Listagem de sinistros (Módulo 1)
claimsRouter.get("/", requireAuth, async (req: Request, res: Response) => {
  const { status } = req.query;
  const brokerageId = req.user!.brokerageId;

  const whereClause: any = { brokerageId };
  if (status) whereClause.status = status as ClaimStatus;

  const claims = await prisma.claim.findMany({
    where: whereClause,
    include: {
      insured: { select: { id: true, name: true, phone: true } },
      policy: {
        select: {
          id: true,
          policyNumber: true,
          insurerName: true,
          branch: true,
          assistance24hPhone: true,
        },
      },
      assignedUser: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  res.json(claims);
});

// Detalhes de um sinistro
claimsRouter.get("/:id", requireAuth, async (req: Request, res: Response) => {
  const claim = await prisma.claim.findFirst({
    where: { id: req.params.id, brokerageId: req.user!.brokerageId },
    include: {
      insured: true,
      policy: true,
      assignedUser: true,
    },
  });

  if (!claim) {
    res.status(404).json({ error: "Sinistro não encontrado" });
    return;
  }

  res.json(claim);
});

// Abertura manual de sinistro pela corretora
claimsRouter.post("/", requireAuth, async (req: Request, res: Response) => {
  const data = claimSchema.parse(req.body);
  const brokerageId = req.user!.brokerageId;

  const claim = await prisma.claim.create({
    data: {
      brokerageId,
      insuredId: data.insuredId,
      policyId: data.policyId,
      incidentType: data.incidentType,
      incidentDate: data.incidentDate ? new Date(data.incidentDate) : new Date(),
      incidentLocation: data.incidentLocation,
      description: data.description,
      policeReportUrl: data.policeReportUrl,
      status: "OPEN",
      assignedUserId: req.user!.userId,
      brokerNotifiedAt: new Date(),
    },
    include: { policy: true, insured: true },
  });

  await recordAuditLog({
    brokerageId,
    userId: req.user!.userId,
    action: "CREATE_CLAIM",
    resource: `Claim:${claim.id}`,
    req,
  });

  res.status(201).json(claim);
});

// Atualização de status e andamento do sinistro
claimsRouter.patch("/:id/status", requireAuth, async (req: Request, res: Response) => {
  const { status, assignedUserId, description } = req.body;

  const claim = await prisma.claim.findFirst({
    where: { id: req.params.id, brokerageId: req.user!.brokerageId },
  });

  if (!claim) {
    res.status(404).json({ error: "Sinistro não encontrado" });
    return;
  }

  const updated = await prisma.claim.update({
    where: { id: claim.id },
    data: {
      status: status || undefined,
      assignedUserId: assignedUserId || undefined,
      description: description ? `${claim.description}\n[Atualização]: ${description}` : undefined,
    },
  });

  await recordAuditLog({
    brokerageId: req.user!.brokerageId,
    userId: req.user!.userId,
    action: "UPDATE_CLAIM_STATUS",
    resource: `Claim:${updated.id}`,
    details: { oldStatus: claim.status, newStatus: updated.status },
    req,
  });

  res.json(updated);
});

// Solicitação de código de confirmação para Sinistro Online (Anti-Spam / Anti-Fraude)
claimsRouter.post("/online-intake/request-verification", async (req: Request, res: Response) => {
  const { brokerageSlug, brokerageId, policyNumber, phoneOrCpf } = req.body;

  if ((!brokerageSlug && !brokerageId) || !policyNumber || !phoneOrCpf) {
    res.status(400).json({ error: "Corretora, Número da Apólice e Telefone/CPF são obrigatórios." });
    return;
  }

  const cleanDoc = String(phoneOrCpf).replace(/\D/g, "");
  const clientIp = req.ip || req.socket.remoteAddress || "unknown";
  const rateLimitKey = `claim_req:${clientIp}:${cleanDoc}`;
  const rate = checkRateLimit(rateLimitKey, 5, 15 * 60 * 1000);
  if (!rate.allowed) {
    res.status(429).json({ error: "Muitas tentativas. Aguarde 15 minutos para solicitar novo código." });
    return;
  }

  // 1. Identifica a corretora
  const brokerage = await prisma.brokerage.findFirst({
    where: {
      OR: [
        brokerageSlug ? { slug: String(brokerageSlug).trim() } : { id: "undefined" },
        brokerageId ? { id: String(brokerageId).trim() } : { id: "undefined" },
      ],
    },
  });

  if (!brokerage) {
    res.status(404).json({ error: "Corretora não encontrada." });
    return;
  }

  // 2. Busca a apólice ativa com conferência estrita de dados
  const policy = await prisma.policy.findFirst({
    where: {
      brokerageId: brokerage.id,
      policyNumber: String(policyNumber).trim(),
      status: "ACTIVE",
    },
    include: { insured: true },
  });

  if (!policy) {
    res.status(404).json({ error: "Apólice ativa não encontrada nesta corretora com este número." });
    return;
  }

  // 3. Valida se o documento ou telefone informado confere com o titular da apólice
  const cleanInsuredPhone = policy.insured.phone.replace(/\D/g, "");
  const cleanInsuredCpf = policy.insured.cpf ? policy.insured.cpf.replace(/\D/g, "") : "";

  const matchesCpf = cleanDoc.length === 11 && cleanInsuredCpf === cleanDoc;
  const matchesPhone = cleanDoc.length >= 10 && (cleanInsuredPhone === cleanDoc || cleanInsuredPhone.endsWith(cleanDoc));

  if (!matchesCpf && !matchesPhone) {
    res.status(401).json({ error: "Os dados de identificação (CPF ou Telefone) não conferem com o titular da apólice." });
    return;
  }

  // 4. Gera código OTP e envia ao WhatsApp do segurado
  const otp = generateOtpCode(6);
  const verificationToken = createOtpChallengeToken({
    brokerageId: brokerage.id,
    policyId: policy.id,
    insuredId: policy.insured.id,
    target: cleanDoc,
    scope: "CLAIM_INTAKE_VERIFY",
    otp,
  });

  await sendOtpToWhatsApp({
    brokerage,
    phone: policy.insured.phone,
    otp,
    actionDescription: `abertura de aviso de sinistro da apólice ${policy.policyNumber}`,
  });

  const maskedPhone = policy.insured.phone.replace(/(\d{4})\d{4}(\d{4})/, "$1-****-$2");

  res.json({
    success: true,
    message: "Código de confirmação enviado via WhatsApp ao segurado titular da apólice.",
    verificationToken,
    maskedPhone,
    brokerageName: brokerage.name,
    policyNumber: policy.policyNumber,
  });
});

// Abertura de Sinistro Online (Auto & Transporte de Cargas RCTR-C) — Protegido contra Spam
claimsRouter.post("/online-intake", async (req: Request, res: Response) => {
  const {
    brokerageSlug,
    brokerageId,
    phoneOrCpf,
    policyNumber,
    verificationToken,
    verificationCode,
    incidentType,
    incidentDate,
    incidentLocation,
    description,
    policeReportUrl,
    photos,
    workshopName,
    cargoManifestNumber,
  } = req.body;

  if (!description || !incidentType) {
    res.status(400).json({ error: "Tipo de Ocorrência e Descrição são obrigatórios." });
    return;
  }

  const clientIp = req.ip || req.socket.remoteAddress || "unknown";
  const rateLimitKey = `claim_submit:${clientIp}`;
  const rate = checkRateLimit(rateLimitKey, 10, 15 * 60 * 1000);
  if (!rate.allowed) {
    res.status(429).json({ error: "Limite de tentativas excedido. Tente novamente mais tarde." });
    return;
  }

  // 1. Identifica a corretora
  const brokerage = await prisma.brokerage.findFirst({
    where: {
      OR: [
        brokerageSlug ? { slug: String(brokerageSlug).trim() } : { id: "undefined" },
        brokerageId ? { id: String(brokerageId).trim() } : { id: "undefined" },
      ],
    },
  });

  if (!brokerage) {
    res.status(400).json({ error: "Corretora não identificada. Utilize o link oficial da sua corretora." });
    return;
  }

  let verifiedInsuredId: string;
  let verifiedPolicyId: string;

  // 2. Fluxo com verificação OTP (Recomendado / Seguro)
  if (verificationToken && verificationCode) {
    try {
      const payload = verifyOtpChallengeToken(verificationToken, String(verificationCode), "CLAIM_INTAKE_VERIFY");
      if (payload.brokerageId !== brokerage.id || !payload.insuredId || !payload.policyId) {
        res.status(403).json({ error: "Código de verificação pertence a outra sessão ou corretora." });
        return;
      }
      verifiedInsuredId = payload.insuredId;
      verifiedPolicyId = payload.policyId;
    } catch (err: any) {
      res.status(401).json({ error: err.message || "Código de confirmação inválido." });
      return;
    }
  } else {
    // 3. Fallback: Conferência estrita combinada de Apólice + CPF/Telefone
    if (!policyNumber || !phoneOrCpf) {
      res.status(400).json({
        error: "Para abrir o sinistro, informe o código de verificação recebido no WhatsApp ou forneça Apólice e CPF/Telefone completos.",
      });
      return;
    }

    const clean = String(phoneOrCpf).replace(/\D/g, "");
    const policy = await prisma.policy.findFirst({
      where: {
        brokerageId: brokerage.id,
        policyNumber: String(policyNumber).trim(),
        status: "ACTIVE",
      },
      include: { insured: true },
    });

    if (!policy) {
      res.status(404).json({ error: "Apólice ativa não encontrada nesta corretora com este número." });
      return;
    }

    const cleanInsuredPhone = policy.insured.phone.replace(/\D/g, "");
    const cleanInsuredCpf = policy.insured.cpf ? policy.insured.cpf.replace(/\D/g, "") : "";

    const matchesCpf = clean.length === 11 && cleanInsuredCpf === clean;
    const matchesPhone = clean.length >= 10 && (cleanInsuredPhone === clean || cleanInsuredPhone.endsWith(clean));

    if (!matchesCpf && !matchesPhone) {
      res.status(401).json({ error: "O CPF ou Telefone informado não confere com o titular cadastrado da apólice." });
      return;
    }

    verifiedInsuredId = policy.insured.id;
    verifiedPolicyId = policy.id;
  }

  const policy = await prisma.policy.findUnique({
    where: { id: verifiedPolicyId },
    include: { insured: true, brokerage: true },
  });

  if (!policy) {
    res.status(404).json({ error: "Apólice não localizada." });
    return;
  }

  // Cria o sinistro no banco
  const claim = await prisma.claim.create({
    data: {
      brokerageId: brokerage.id,
      insuredId: verifiedInsuredId,
      policyId: verifiedPolicyId,
      incidentType,
      incidentDate: incidentDate ? new Date(incidentDate) : new Date(),
      incidentLocation: incidentLocation || undefined,
      description,
      policeReportUrl: policeReportUrl || undefined,
      photos: photos || undefined,
      workshopName: workshopName || undefined,
      cargoManifestNumber: cargoManifestNumber || undefined,
      status: "OPEN",
      brokerNotifiedAt: new Date(),
    },
  });

  // Notifica o corretor via WhatsApp se configurado alertPhone
  if (brokerage.alertPhone && brokerage.whatsappPhoneNumberId && brokerage.whatsappAccessTokenEncrypted) {
    const alertPhone = brokerage.alertPhone;
    const phoneNumberId = brokerage.whatsappPhoneNumberId;
    try {
      const token = decryptSensitive(brokerage.whatsappAccessTokenEncrypted);
      if (token) {
        const alertMsg = `🚨 *NOVO SINISTRO REGISTRADO — ${brokerage.name}*\n\nProtocolo: SIN-${claim.id.slice(-6).toUpperCase()}\nSegurado: ${policy.insured.name}\nApólice: ${policy.policyNumber}\nTipo: ${incidentType}\nDescrição: ${description}\n\nAcesse o painel para iniciar o atendimento!`;
        await sendWhatsAppTextMessage(alertPhone, alertMsg, phoneNumberId, token);
      }
    } catch (err) {
      console.error("[Alerta Sinistro Corretor Error]:", err);
    }
  }

  const protocol = `SIN-${new Date().getFullYear()}-${claim.id.slice(-6).toUpperCase()}`;
  const assistancePhone = resolveAssistance24hPhone(policy.assistance24hPhone, policy.insurerName, brokerage.phone);

  res.status(201).json({
    success: true,
    protocol,
    claimId: claim.id,
    message: "Aviso de sinistro registrado e verificado com sucesso! Nossa equipe foi notificada.",
    insuredName: policy.insured.name,
    policyNumber: policy.policyNumber,
    insurerName: policy.insurerName,
    assistance24hPhone: assistancePhone,
  });
});

// BI de Sinistralidade & Métricas Avançadas de Sinistro
claimsRouter.get("/analytics/bi", requireAuth, async (req: Request, res: Response) => {
  const brokerageId = req.user!.brokerageId;

  const [claims, policies] = await Promise.all([
    prisma.claim.findMany({
      where: { brokerageId },
      include: { policy: { select: { insurerName: true, branch: true, premiumAmount: true } } },
    }),
    prisma.policy.findMany({
      where: { brokerageId, status: "ACTIVE" },
      select: { premiumAmount: true },
    }),
  ]);

  const totalClaims = claims.length;
  const totalPremiumEarned = policies.reduce((acc, p) => acc + Number(p.premiumAmount), 0);

  const byStatus: Record<string, number> = {};
  const byIncidentType: Record<string, number> = {};
  const byBranch: Record<string, number> = {};
  const byInsurer: Record<string, number> = {};
  let totalIndemnity = 0;

  for (const c of claims) {
    byStatus[c.status] = (byStatus[c.status] || 0) + 1;
    byIncidentType[c.incidentType] = (byIncidentType[c.incidentType] || 0) + 1;
    
    const branch = c.policy?.branch || "OUTROS";
    byBranch[branch] = (byBranch[branch] || 0) + 1;

    const insurer = c.policy?.insurerName || "Outras";
    byInsurer[insurer] = (byInsurer[insurer] || 0) + 1;

    if (c.indemnityAmount) {
      totalIndemnity += Number(c.indemnityAmount);
    }
  }

  // Taxa de sinistralidade estimada: (Indenizações Totais / Prêmio Total) * 100
  const lossRatioPercent = totalPremiumEarned > 0 ? Number(((totalIndemnity / totalPremiumEarned) * 100).toFixed(1)) : 0;

  res.json({
    overview: {
      totalClaims,
      openClaims: (byStatus["OPEN"] || 0) + (byStatus["DOCS_COLLECTED"] || 0) + (byStatus["IN_ANALYSIS"] || 0),
      closedClaims: (byStatus["CLOSED"] || 0) + (byStatus["APPROVED"] || 0),
      totalIndemnityPaid: totalIndemnity,
      totalPremiumPortfolio: totalPremiumEarned,
      estimatedLossRatioPercent: lossRatioPercent,
    },
    byStatus,
    byIncidentType,
    byBranch,
    byInsurer,
  });
});
