import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../config/prisma";
import { comparePassword, hashPassword, generateToken, requireAuth } from "../security/auth";
import { recordAuditLog } from "../services/auditLog";

export const authRouter = Router();

const registerSchema = z.object({
  brokerageName: z.string().min(2, "Nome da corretora é obrigatório"),
  cnpj: z.string().optional(),
  ownerName: z.string().min(2, "Nome do corretor é obrigatório"),
  email: z.string().email("E-mail inválido"),
  password: z.string().min(6, "A senha deve ter no mínimo 6 caracteres"),
  phone: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email("E-mail inválido"),
  password: z.string().min(1, "Senha é obrigatória"),
});

// Registro de nova corretora com usuário Dono (Owner)
authRouter.post("/register", async (req: Request, res: Response) => {
  const data = registerSchema.parse(req.body);

  const existingUser = await prisma.user.findUnique({
    where: { email: data.email.toLowerCase() },
  });

  if (existingUser) {
    res.status(409).json({ error: "Já existe um usuário cadastrado com este e-mail" });
    return;
  }

  // Gera slug a partir do nome
  let slug = data.brokerageName
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");

  const existingSlug = await prisma.brokerage.findUnique({ where: { slug } });
  if (existingSlug) {
    slug = `${slug}-${Math.floor(1000 + Math.random() * 9000)}`;
  }

  const passwordHash = await hashPassword(data.password);

  const result = await prisma.$transaction(async (tx) => {
    const brokerage = await tx.brokerage.create({
      data: {
        name: data.brokerageName,
        slug,
        cnpj: data.cnpj,
        phone: data.phone,
        email: data.email.toLowerCase(),
      },
    });

    const user = await tx.user.create({
      data: {
        brokerageId: brokerage.id,
        name: data.ownerName,
        email: data.email.toLowerCase(),
        passwordHash,
        role: "OWNER",
      },
    });

    return { brokerage, user };
  });

  const token = generateToken({
    userId: result.user.id,
    brokerageId: result.brokerage.id,
    role: result.user.role,
    email: result.user.email,
  });

  await recordAuditLog({
    brokerageId: result.brokerage.id,
    userId: result.user.id,
    action: "REGISTER_BROKERAGE",
    resource: `Brokerage:${result.brokerage.id}`,
    req,
  });

  res.status(201).json({
    token,
    user: {
      id: result.user.id,
      name: result.user.name,
      email: result.user.email,
      role: result.user.role,
    },
    brokerage: {
      id: result.brokerage.id,
      name: result.brokerage.name,
      slug: result.brokerage.slug,
    },
  });
});

// Login com e-mail e senha
authRouter.post("/login", async (req: Request, res: Response) => {
  const data = loginSchema.parse(req.body);

  const user = await prisma.user.findUnique({
    where: { email: data.email.toLowerCase() },
    include: { brokerage: true },
  });

  if (!user || !user.active) {
    res.status(401).json({ error: "Credenciais inválidas" });
    return;
  }

  const valid = await comparePassword(data.password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Credenciais inválidas" });
    return;
  }

  const token = generateToken({
    userId: user.id,
    brokerageId: user.brokerageId,
    role: user.role,
    email: user.email,
  });

  await recordAuditLog({
    brokerageId: user.brokerageId,
    userId: user.id,
    action: "LOGIN",
    resource: `User:${user.id}`,
    req,
  });

  res.json({
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
    },
    brokerage: {
      id: user.brokerage.id,
      name: user.brokerage.name,
      slug: user.brokerage.slug,
      whatsappConfigured: Boolean(user.brokerage.whatsappPhoneNumberId),
    },
  });
});

// Perfil do usuário atual autenticado
authRouter.get("/me", requireAuth, async (req: Request, res: Response) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.userId },
    include: { brokerage: true },
  });

  if (!user) {
    res.status(404).json({ error: "Usuário não encontrado" });
    return;
  }

  res.json({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
    },
    brokerage: {
      id: user.brokerage.id,
      name: user.brokerage.name,
      slug: user.brokerage.slug,
      whatsappPhoneNumberId: user.brokerage.whatsappPhoneNumberId,
      agentEnabled: user.brokerage.agentEnabled,
      alertPhone: user.brokerage.alertPhone,
    },
  });
});
