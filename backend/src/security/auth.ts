import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { UserRole } from "@prisma/client";
import { env } from "../config/env";
import { prisma } from "../config/prisma";

export interface AuthPayload {
  userId: string;
  brokerageId: string;
  role: UserRole;
  email: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthPayload;
    }
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
}

export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function generateToken(payload: AuthPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"],
  });
}

export function verifyToken(token: string): AuthPayload {
  return jwt.verify(token, env.JWT_SECRET) as AuthPayload;
}

/**
 * Middleware para exigir autenticação JWT e vincular o tenant (brokerageId) à requisição
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Token de autorização não fornecido" });
    return;
  }

  const token = authHeader.split(" ")[1];
  try {
    const payload = verifyToken(token);
    // Valida se o usuário e a corretora continuam ativos no banco
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      include: { brokerage: true },
    });

    if (!user || !user.active || !user.brokerage || !user.brokerage.active) {
      res.status(401).json({ error: "Usuário ou corretora inativo ou inexistente" });
      return;
    }

    req.user = {
      userId: user.id,
      brokerageId: user.brokerageId,
      role: user.role,
      email: user.email,
    };

    next();
  } catch {
    res.status(401).json({ error: "Token de autorização inválido ou expirado" });
  }
}

/**
 * Middleware para restringir acesso a papéis específicos (ex: OWNER)
 */
export function requireRoles(allowedRoles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      res.status(403).json({ error: "Acesso negado: permissões insuficientes" });
      return;
    }
    next();
  };
}
