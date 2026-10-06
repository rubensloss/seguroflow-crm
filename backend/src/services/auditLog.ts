import { Request } from "express";
import { prisma } from "../config/prisma";

export interface LogParams {
  brokerageId: string;
  userId?: string;
  action: string;
  resource: string;
  details?: Record<string, unknown>;
  req?: Request;
}

export async function recordAuditLog(params: LogParams) {
  try {
    const ipAddress = params.req?.ip || params.req?.socket?.remoteAddress;
    const userAgent = params.req?.headers["user-agent"];

    await prisma.auditLog.create({
      data: {
        brokerageId: params.brokerageId,
        userId: params.userId,
        action: params.action,
        resource: params.resource,
        details: params.details ? JSON.parse(JSON.stringify(params.details)) : undefined,
        ipAddress: ipAddress ? String(ipAddress) : undefined,
        userAgent: userAgent ? String(userAgent) : undefined,
      },
    });
  } catch (error) {
    console.error("Falha ao registrar AuditLog LGPD:", error);
  }
}
