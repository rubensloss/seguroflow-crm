import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../config/prisma";
import { requireAuth } from "../security/auth";
import { runBillingCadenceScan } from "../services/billingCadence";
import { recordAuditLog } from "../services/auditLog";

export const installmentsRouter = Router();

// Listagem de parcelas com filtros (Módulo 2: Régua de cobrança preventiva)
installmentsRouter.get("/", requireAuth, async (req: Request, res: Response) => {
  const { status, limit } = req.query;
  const brokerageId = req.user!.brokerageId;

  const whereClause: any = { brokerageId };
  if (status) whereClause.status = status;

  const installments = await prisma.installment.findMany({
    where: whereClause,
    include: {
      policy: {
        include: {
          insured: { select: { id: true, name: true, phone: true } },
        },
      },
    },
    orderBy: { dueDate: "asc" },
    take: limit ? Number(limit) : 100,
  });

  res.json(installments);
});

// Atualiza código de pagamento (Pix/Boleto emitido pela seguradora)
installmentsRouter.patch("/:id/payment-code", requireAuth, async (req: Request, res: Response) => {
  const { paymentCode, pdfBoletoUrl } = req.body;

  const installment = await prisma.installment.findFirst({
    where: { id: req.params.id, brokerageId: req.user!.brokerageId },
  });

  if (!installment) {
    res.status(404).json({ error: "Parcela não encontrada" });
    return;
  }

  const updated = await prisma.installment.update({
    where: { id: installment.id },
    data: {
      paymentCode: paymentCode || undefined,
      pdfBoletoUrl: pdfBoletoUrl || undefined,
    },
  });

  res.json(updated);
});

// Baixa manual da parcela (confirmada pela corretora junto à seguradora)
installmentsRouter.post("/:id/mark-paid", requireAuth, async (req: Request, res: Response) => {
  const installment = await prisma.installment.findFirst({
    where: { id: req.params.id, brokerageId: req.user!.brokerageId },
  });

  if (!installment) {
    res.status(404).json({ error: "Parcela não encontrada" });
    return;
  }

  const updated = await prisma.installment.update({
    where: { id: installment.id },
    data: {
      status: "PAID",
      paidAt: new Date(),
    },
  });

  await recordAuditLog({
    brokerageId: req.user!.brokerageId,
    userId: req.user!.userId,
    action: "MARK_INSTALLMENT_PAID",
    resource: `Installment:${updated.id}`,
    req,
  });

  res.json({ success: true, installment: updated });
});

// Disparo manual/agendado da régua preventiva (D-7, D-0, D+2)
installmentsRouter.post("/run-cadence", requireAuth, async (_req: Request, res: Response) => {
  const result = await runBillingCadenceScan();
  res.json({
    success: true,
    message: "Varredura da régua de cobrança preventiva executada com sucesso.",
    result,
  });
});
