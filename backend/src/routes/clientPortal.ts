import { Router, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../config/prisma";
import { env } from "../config/env";

export const clientPortalRouter = Router();

/**
 * Portal do Segurado (Área do Cliente)
 * Acesso direto do segurado sem senhas complexas (Magic Link via CPF ou Telefone)
 */

// 1. Autenticação rápida do segurado
clientPortalRouter.post("/auth", async (req: Request, res: Response) => {
  const { identifier } = req.body; // CPF ou Telefone

  if (!identifier || typeof identifier !== "string") {
    res.status(400).json({ error: "Informe seu CPF ou Telefone com DDD" });
    return;
  }

  const clean = identifier.replace(/\D/g, "");

  const insured = await prisma.insured.findFirst({
    where: {
      OR: [
        { cpf: { contains: clean.length >= 8 ? clean : "undefined" } },
        { phone: { contains: clean.slice(-8) } },
      ],
    },
    include: { brokerage: { select: { id: true, name: true, phone: true, email: true } } },
  });

  if (!insured) {
    res.status(404).json({ error: "Segurado não localizado com este documento ou telefone." });
    return;
  }

  const token = jwt.sign(
    {
      insuredId: insured.id,
      brokerageId: insured.brokerageId,
      name: insured.name,
      phone: insured.phone,
    },
    env.JWT_SECRET,
    { expiresIn: "30d" }
  );

  res.json({
    success: true,
    token,
    insured: {
      id: insured.id,
      name: insured.name,
      phone: insured.phone,
      email: insured.email,
      brokerageName: insured.brokerage.name,
    },
  });
});

// Middleware de autenticação do segurado
async function requireInsuredAuth(req: Request, res: Response, next: () => void) {
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
    res.status(401).json({ error: "Sessão expirada. Faça login novamente." });
  }
}

// 2. Painel consolidado do segurado (Apólices, Assistência 24h, Faturas e Sinistros)
clientPortalRouter.get("/dashboard", requireInsuredAuth, async (req: Request, res: Response) => {
  const { insuredId, brokerageId } = (req as any).insured;

  const insured = await prisma.insured.findUnique({
    where: { id: insuredId },
    include: {
      brokerage: { select: { name: true, phone: true, email: true } },
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

  // Formata cartões virtuais de seguro
  const virtualCards = insured.policies.map((pol) => {
    const phone = pol.assistance24hPhone || "0800 727 0800";
    const cleanPhone = phone.replace(/\D/g, "");
    return {
      policyId: pol.id,
      policyNumber: pol.policyNumber,
      insurerName: pol.insurerName,
      branch: pol.branch,
      itemDescription: pol.itemDescription,
      endDate: pol.endDate,
      assistance24hPhone: phone,
      assistanceCallLink: `tel:${cleanPhone}`,
      assistanceWhatsAppLink: `https://wa.me/55${cleanPhone}`,
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
      phone: insured.phone,
      cpf: insured.cpf,
      brokerage: insured.brokerage,
    },
    virtualCards,
    activeClaims: insured.claims,
  });
});
