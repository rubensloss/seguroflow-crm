import { Router, Request, Response } from "express";
import { prisma } from "../config/prisma";
import { requireAuth, requireRoles } from "../security/auth";
import { recordAuditLog } from "../services/auditLog";

export const privacyRouter = Router();

// Exportação completa de dados da corretora (Portabilidade LGPD)
privacyRouter.get("/export", requireAuth, requireRoles(["OWNER"]), async (req: Request, res: Response) => {
  const brokerageId = req.user!.brokerageId;

  const data = await prisma.brokerage.findUnique({
    where: { id: brokerageId },
    include: {
      users: { select: { id: true, name: true, email: true, role: true, createdAt: true } },
      insureds: {
        include: {
          policies: { include: { installments: true, claims: true } },
          documents: true,
        },
      },
      pipelineCards: true,
      auditLogs: { take: 500, orderBy: { createdAt: "desc" } },
    },
  });

  await recordAuditLog({
    brokerageId,
    userId: req.user!.userId,
    action: "LGPD_EXPORT_DATA",
    resource: `Brokerage:${brokerageId}`,
    req,
  });

  res.setHeader("Content-Disposition", `attachment; filename=seguroflow-lgpd-export-${brokerageId}.json`);
  res.setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(data, null, 2));
});

// Exclusão completa de dados de um segurado (Direito ao esquecimento LGPD)
privacyRouter.delete("/insured/:id", requireAuth, requireRoles(["OWNER"]), async (req: Request, res: Response) => {
  const insured = await prisma.insured.findFirst({
    where: { id: req.params.id, brokerageId: req.user!.brokerageId },
  });

  if (!insured) {
    res.status(404).json({ error: "Segurado não encontrado" });
    return;
  }

  await prisma.insured.delete({ where: { id: insured.id } });

  await recordAuditLog({
    brokerageId: req.user!.brokerageId,
    userId: req.user!.userId,
    action: "LGPD_DELETE_INSURED",
    resource: `Insured:${insured.id}`,
    details: { name: insured.name, phone: insured.phone },
    req,
  });

  res.json({ success: true, message: "Dados do segurado apagados com sucesso em conformidade com a LGPD." });
});

// Consulta de Logs de Auditoria LGPD
privacyRouter.get("/audit-logs", requireAuth, requireRoles(["OWNER"]), async (req: Request, res: Response) => {
  const logs = await prisma.auditLog.findMany({
    where: { brokerageId: req.user!.brokerageId },
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  res.json(logs);
});
