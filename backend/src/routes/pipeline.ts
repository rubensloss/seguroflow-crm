import { Router, Request, Response } from "express";
import { z } from "zod";
import { PipelineStage } from "@prisma/client";
import { prisma } from "../config/prisma";
import { requireAuth } from "../security/auth";

export const pipelineRouter = Router();

const cardSchema = z.object({
  title: z.string().min(2, "Título é obrigatório"),
  value: z.number().optional(),
  insuredId: z.string().optional(),
  stage: z.nativeEnum(PipelineStage).default(PipelineStage.NOVO),
  slaHours: z.number().int().min(1).default(24),
  source: z.string().optional(),
  notes: z.string().optional(),
  assignedUserId: z.string().optional(),
});

// Listagem de cards agrupados por estágio com cálculo de SLA (Módulo 3)
pipelineRouter.get("/", requireAuth, async (req: Request, res: Response) => {
  const brokerageId = req.user!.brokerageId;

  const cards = await prisma.pipelineCard.findMany({
    where: { brokerageId },
    include: {
      insured: { select: { id: true, name: true, phone: true } },
      assignedUser: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  const now = new Date().getTime();

  // Enriquece com cálculo de tempo na fase e estouro de SLA
  const enriched = cards.map((c) => {
    const hoursInStage = (now - new Date(c.stageEnteredAt).getTime()) / (1000 * 60 * 60);
    const slaBreached = hoursInStage > c.slaHours;

    return {
      ...c,
      hoursInStage: Math.round(hoursInStage * 10) / 10,
      slaBreached,
    };
  });

  // Agrupa pelos 5 estágios
  const stages: Record<string, typeof enriched> = {
    NOVO: [],
    COTACAO: [],
    PROPOSTA: [],
    EMISSAO: [],
    POS_VENDA: [],
  };

  for (const card of enriched) {
    if (stages[card.stage]) {
      stages[card.stage].push(card);
    }
  }

  res.json({
    cards: enriched,
    stages,
    totalCount: cards.length,
    slaAlertsCount: enriched.filter((c) => c.slaBreached).length,
  });
});

// Criação de card no funil
pipelineRouter.post("/", requireAuth, async (req: Request, res: Response) => {
  const data = cardSchema.parse(req.body);
  const brokerageId = req.user!.brokerageId;

  const card = await prisma.pipelineCard.create({
    data: {
      brokerageId,
      title: data.title,
      value: data.value,
      insuredId: data.insuredId,
      stage: data.stage,
      slaHours: data.slaHours,
      source: data.source || "WhatsApp",
      notes: data.notes,
      assignedUserId: data.assignedUserId || req.user!.userId,
      stageEnteredAt: new Date(),
    },
    include: { insured: true },
  });

  res.status(201).json(card);
});

// Movimentação de card entre fases (arrastar no Kanban)
pipelineRouter.patch("/:id/stage", requireAuth, async (req: Request, res: Response) => {
  const { stage } = req.body;

  if (!Object.values(PipelineStage).includes(stage)) {
    res.status(400).json({ error: "Estágio inválido" });
    return;
  }

  const card = await prisma.pipelineCard.findFirst({
    where: { id: req.params.id, brokerageId: req.user!.brokerageId },
  });

  if (!card) {
    res.status(404).json({ error: "Card não encontrado" });
    return;
  }

  const updated = await prisma.pipelineCard.update({
    where: { id: card.id },
    data: {
      stage,
      stageEnteredAt: new Date(), // Reinicia o contador de SLA na nova fase
    },
  });

  res.json(updated);
});
