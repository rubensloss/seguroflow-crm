import { Router, Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../config/prisma";
import { env } from "../config/env";
import { checkRateLimit } from "../security/rateLimit";
import {
  generateOtpCode,
  createOtpChallengeToken,
  verifyOtpChallengeToken,
  sendOtpToWhatsApp,
} from "../services/otpService";
import { resolveAssistance24hPhone } from "../services/insurerDirectory";

export const clientPortalRouter = Router();

/**
 * Função utilitária para mascarar CPF (LGPD)
 * Exemplo: 12345678901 -> 123.***.***-01
 */
function maskCpf(cpf?: string | null): string | null {
  if (!cpf) return null;
  const clean = cpf.replace(/\D/g, "");
  if (clean.length !== 11) return "***.***.***-**";
  return clean.replace(/(\d{3})\d{6}(\d{2})/, "$1.***.***-$2");
}

/**
 * Função utilitária para mascarar Telefone
 * Exemplo: 5527999887766 -> (27) 9****-7766
 */
function maskPhone(phone: string): string {
  const clean = phone.replace(/\D/g, "");
  if (clean.length < 10) return "(**) ****-****";
  const ddd = clean.slice(-11, -9);
  const lastFour = clean.slice(-4);
  return `(${ddd}) 9****-${lastFour}`;
}

// 1. Solicitação de código de acesso (OTP via WhatsApp Oficial)
async function handleRequestOtp(req: Request, res: Response) {
  const brokerageSlug = req.params.brokerageSlug || req.body.brokerageSlug;
  const { identifier } = req.body; // CPF (11 dígitos) ou Telefone E.164

  if (!brokerageSlug || typeof brokerageSlug !== "string") {
    res.status(400).json({ error: "Slug da corretora é obrigatório na URL ou corpo da requisição." });
    return;
  }

  if (!identifier || typeof identifier !== "string") {
    res.status(400).json({ error: "Informe seu CPF completo ou Telefone com DDD." });
    return;
  }

  const clean = identifier.replace(/\D/g, "");
  if (clean.length < 10) {
    res.status(400).json({ error: "Documento ou telefone inválido. Informe o CPF (11 dígitos) ou telefone com DDD." });
    return;
  }

  // Rate Limiting por IP e por Identificador
  const clientIp = req.ip || req.socket.remoteAddress || "unknown";
  const rateLimitKey = `portal_req_otp:${clientIp}:${clean}`;
  const rate = checkRateLimit(rateLimitKey, 5, 10 * 60 * 1000);
  if (!rate.allowed) {
    res.status(429).json({
      error: "Muitas tentativas de envio de código. Aguarde 10 minutos antes de tentar novamente.",
    });
    return;
  }

  // 1. Identifica a corretora pelo slug
  const brokerage = await prisma.brokerage.findUnique({
    where: { slug: brokerageSlug.trim() },
    select: {
      id: true,
      name: true,
      slug: true,
      phone: true,
      whatsappPhoneNumberId: true,
      whatsappAccessTokenEncrypted: true,
    },
  });

  if (!brokerage) {
    res.status(404).json({ error: "Corretora não encontrada." });
    return;
  }

  // 2. Busca o segurado por IGUALDADE EXATA dentro da corretora
  const isCpf = clean.length === 11;
  const insured = await prisma.insured.findFirst({
    where: {
      brokerageId: brokerage.id,
      ...(isCpf
        ? { cpf: clean }
        : {
            OR: [
              { phone: clean },
              { phone: clean.startsWith("55") ? clean.slice(2) : `55${clean}` },
            ],
          }),
    },
    select: {
      id: true,
      name: true,
      phone: true,
      cpf: true,
    },
  });

  if (!insured) {
    res.status(404).json({
      error: "Segurado não localizado com estes dados na corretora selecionada. Confira o documento ou telefone informado.",
    });
    return;
  }

  // 3. Gera código de uso único (OTP)
  const otp = generateOtpCode(6);

  // 4. Cria token de desafio assinado (10 minutos)
  const challengeToken = createOtpChallengeToken({
    brokerageId: brokerage.id,
    insuredId: insured.id,
    target: clean,
    scope: "CLIENT_PORTAL_AUTH",
    otp,
  });

  // 5. Envia o código ao WhatsApp do segurado
  await sendOtpToWhatsApp({
    brokerage,
    phone: insured.phone,
    otp,
    actionDescription: "acesso ao Portal do Segurado",
  });

  res.json({
    success: true,
    message: "Código de segurança enviado com sucesso para o seu WhatsApp cadastrado.",
    challengeToken,
    maskedPhone: maskPhone(insured.phone),
    brokerageName: brokerage.name,
  });
}

clientPortalRouter.post("/:brokerageSlug/request-otp", handleRequestOtp);
clientPortalRouter.post("/request-otp", handleRequestOtp);

// 2. Validação do código OTP e emissão de Token de Acesso (2 horas)
async function handleVerifyOtp(req: Request, res: Response) {
  const { challengeToken, otp } = req.body;

  if (!challengeToken || !otp) {
    res.status(400).json({ error: "Token de desafio e código OTP são obrigatórios." });
    return;
  }

  // Rate limit para validação (evita força bruta dos 6 dígitos)
  const clientIp = req.ip || req.socket.remoteAddress || "unknown";
  const rateLimitKey = `portal_verify_otp:${clientIp}`;
  const rate = checkRateLimit(rateLimitKey, 5, 10 * 60 * 1000);
  if (!rate.allowed) {
    res.status(429).json({ error: "Muitas tentativas inválidas. Aguarde 10 minutos." });
    return;
  }

  try {
    const payload = verifyOtpChallengeToken(challengeToken, String(otp), "CLIENT_PORTAL_AUTH");

    const insured = await prisma.insured.findUnique({
      where: { id: payload.insuredId },
      include: {
        brokerage: { select: { id: true, name: true, phone: true, email: true } },
      },
    });

    if (!insured || insured.brokerageId !== payload.brokerageId) {
      res.status(404).json({ error: "Cadastro de segurado não localizado." });
      return;
    }

    // Emite JWT com validade curta de 2 HORAS (LGPD Compliance)
    const token = jwt.sign(
      {
        insuredId: insured.id,
        brokerageId: insured.brokerageId,
        name: insured.name,
        type: "CLIENT_PORTAL",
      },
      env.JWT_SECRET,
      { expiresIn: "2h" }
    );

    res.json({
      success: true,
      token,
      expiresIn: "2h",
      insured: {
        id: insured.id,
        name: insured.name,
        phone: maskPhone(insured.phone),
        cpfMasked: maskCpf(insured.cpf),
        email: insured.email,
        brokerageName: insured.brokerage.name,
      },
    });
  } catch (err: any) {
    res.status(401).json({ error: err.message || "Código inválido ou expirado." });
  }
}

clientPortalRouter.post("/:brokerageSlug/verify-otp", handleVerifyOtp);
clientPortalRouter.post("/verify-otp", handleVerifyOtp);

// 3. Rota legada desativada por segurança (LGPD)
clientPortalRouter.post("/auth", (_req: Request, res: Response) => {
  res.status(403).json({
    error: "Acesso direto por CPF/Telefone sem verificação foi bloqueado por segurança e conformidade LGPD. Utilize o fluxo seguro de OTP via WhatsApp (/request-otp e /verify-otp).",
  });
});

// Middleware de autenticação do segurado
async function requireInsuredAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Token de acesso do segurado ausente" });
    return;
  }

  try {
    const payload = jwt.verify(authHeader.split(" ")[1], env.JWT_SECRET) as {
      insuredId: string;
      brokerageId: string;
    };
    (req as any).insured = payload;
    next();
  } catch {
    res.status(401).json({ error: "Sessão expirada. Solicite um novo código de acesso." });
  }
}

// 4. Painel consolidado do segurado (Apólices, Assistência 24h, Faturas e Sinistros)
clientPortalRouter.get("/dashboard", requireInsuredAuth, async (req: Request, res: Response) => {
  const { insuredId, brokerageId } = (req as any).insured;

  const insured = await prisma.insured.findFirst({
    where: { id: insuredId, brokerageId },
    include: {
      brokerage: { select: { name: true, phone: true, email: true, confirmedInsurers: true } },
      policies: {
        where: { status: "ACTIVE" },
        include: {
          installments: {
            where: { status: { in: ["PENDING", "SENT_D7", "SENT_D0", "SENT_D2", "OVERDUE"] } },
            orderBy: { dueDate: "asc" },
            take: 3,
          },
        },
      },
      claims: {
        where: { status: { not: "CLOSED" } },
        orderBy: { createdAt: "desc" },
      },
    },
  });

  if (!insured) {
    res.status(404).json({ error: "Segurado não encontrado" });
    return;
  }

  // Formata cartões virtuais de seguro com número de assistência resolvido corretamente
  const virtualCards = insured.policies.map((pol) => {
    const phone = resolveAssistance24hPhone(pol.assistance24hPhone, pol.insurerName, insured.brokerage.phone, (insured.brokerage as any).confirmedInsurers);
    const cleanPhone = phone.replace(/\D/g, "");
    return {
      policyId: pol.id,
      policyNumber: pol.policyNumber,
      insurerName: pol.insurerName,
      branch: pol.branch,
      itemDescription: pol.itemDescription,
      endDate: pol.endDate,
      assistance24hPhone: phone,
      assistanceCallLink: cleanPhone ? `tel:${cleanPhone}` : undefined,
      assistanceWhatsAppLink: cleanPhone ? `https://wa.me/55${cleanPhone}` : undefined,
      pendingInstallments: pol.installments.map((inst) => ({
        id: inst.id,
        installmentNumber: inst.installmentNumber,
        amount: Number(inst.amount),
        dueDate: inst.dueDate,
        status: inst.status,
        paymentCode: inst.paymentCode,
      })),
    };
  });

  res.json({
    insured: {
      name: insured.name,
      phone: maskPhone(insured.phone),
      cpf: maskCpf(insured.cpf),
      brokerage: insured.brokerage,
    },
    virtualCards,
    activeClaims: insured.claims,
  });
});
