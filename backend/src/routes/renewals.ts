import { Router, Request, Response } from "express";
import { RenewalStatus, RenewalWindow } from "@prisma/client";
import { prisma } from "../config/prisma";
import { requireAuth } from "../security/auth";
import { runRenewalsScan } from "../services/renewalsEngine";

export const renewalsRouter = Router();

// Listagem de tarefas de renovação organizadas por janelas (60d, 30d, 15d)
renewalsRouter.get("/", requireAuth, async (req: Request, res: Response) => {
  const brokerageId = req.user!.brokerageId;
  const { window, status } = req.query;

  const whereClause: any = { brokerageId };
  if (window) whereClause.alertWindow = window as RenewalWindow;
  if (status) whereClause.status = status as RenewalStatus;

  const tasks = await prisma.renewalTask.findMany({
    where: whereClause,
    include: {
      policy: {
        include: {
          insured: { select: { id: true, name: true, phone: true } },
        },
      },
      assignedUser: { select: { id: true, name: true } },
    },
    orderBy: { policy: { endDate: "asc" } },
  });

  const grouped = {
    DAYS_60: tasks.filter((t) => t.alertWindow === "DAYS_60"),
    DAYS_30: tasks.filter((t) => t.alertWindow === "DAYS_30"),
    DAYS_15: tasks.filter((t) => t.alertWindow === "DAYS_15"),
  };

  res.json({
    tasks,
    grouped,
    totalCount: tasks.length,
    pendingCount: tasks.filter((t) => t.status === "PENDING").length,
  });
});

// Atualiza o status da renovação (Renovada, Perdida com motivo, Em negociação)
renewalsRouter.patch("/:id", requireAuth, async (req: Request, res: Response) => {
  const { status, lostReason, assignedUserId } = req.body;

  const task = await prisma.renewalTask.findFirst({
    where: { id: req.params.id, brokerageId: req.user!.brokerageId },
  });

  if (!task) {
    res.status(404).json({ error: "Tarefa de renovação não encontrada" });
    return;
  }

  const updated = await prisma.renewalTask.update({
    where: { id: task.id },
    data: {
      status: status || undefined,
      lostReason: lostReason || undefined,
      assignedUserId: assignedUserId || undefined,
      lastContactAt: new Date(),
    },
  });

  // Se marcada como RENEWED, atualiza também a apólice
  if (status === "RENEWED") {
    await prisma.policy.update({
      where: { id: task.policyId },
      data: { status: "RENEWED" },
    });
  }

  res.json(updated);
});

// Varredura de renovações
renewalsRouter.post("/scan", requireAuth, async (_req: Request, res: Response) => {
  const result = await runRenewalsScan();
  res.json({
    success: true,
    message: "Varredura de renovações executada com sucesso.",
    result,
  });
});
