import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../config/prisma";
import { requireAuth } from "../security/auth";
import { runAgentTurnDetailed } from "../services/agent/claude";
import { env } from "../config/env";

export const simulatorRouter = Router();

// Limite de mensagens diárias por corretora no simulador (Controle de custo de IA)
const DAILY_LIMIT = 100;
const dailyUsageTracker = new Map<string, number>();

// Sessões em memória para histórico da conversa simulada
const sessionHistory = new Map<string, Array<{ role: "user" | "assistant"; content: string }>>();

function getUsageKey(brokerageId: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return `${brokerageId}:${today}`;
}

export function getDailySimulatorCount(brokerageId: string): number {
  const key = getUsageKey(brokerageId);
  return dailyUsageTracker.get(key) || 0;
}

export function incrementSimulatorCount(brokerageId: string): number {
  const key = getUsageKey(brokerageId);
  const current = dailyUsageTracker.get(key) || 0;
  dailyUsageTracker.set(key, current + 1);
  return current + 1;
}

export function resetSimulatorUsage(brokerageId: string): void {
  const key = getUsageKey(brokerageId);
  dailyUsageTracker.delete(key);
}

const messageSchema = z.object({
  message: z.string().min(1, "Mensagem não pode ser vazia"),
  insuredId: z.string().optional(),
  phone: z.string().optional(),
  sessionId: z.string().optional(),
});

// Status do simulador: limite restante e configuração
simulatorRouter.get("/status", requireAuth, async (req: Request, res: Response) => {
  const brokerageId = req.user!.brokerageId;
  const count = getDailySimulatorCount(brokerageId);
  const anthropicConfigured = Boolean(process.env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY);

  res.json({
    dailyUsage: count,
    dailyLimit: DAILY_LIMIT,
    remaining: Math.max(0, DAILY_LIMIT - count),
    anthropicConfigured,
  });
});

// Envia mensagem no simulador de atendimento
simulatorRouter.post("/message", requireAuth, async (req: Request, res: Response) => {
  const data = messageSchema.parse(req.body);
  const brokerageId = req.user!.brokerageId;

  // 1. Verifica limite diário
  const currentUsage = getDailySimulatorCount(brokerageId);
  if (currentUsage >= DAILY_LIMIT) {
    res.status(429).json({
      error: `Limite diário de ${DAILY_LIMIT} mensagens no simulador atingido para esta corretora. O limite será renovado amanhã.`,
      dailyUsage: currentUsage,
      dailyLimit: DAILY_LIMIT,
    });
    return;
  }

  // 2. Busca corretora
  const brokerage = await prisma.brokerage.findUnique({
    where: { id: brokerageId },
    select: { id: true, name: true, phone: true },
  });

  if (!brokerage) {
    res.status(404).json({ error: "Corretora não encontrada" });
    return;
  }

  // 3. Resolve segurado / telefone do contexto simulado
  let simulatedPhone = (data.phone || "").replace(/\D/g, "");
  let resolvedInsuredId = data.insuredId;

  if (resolvedInsuredId) {
    const insured = await prisma.insured.findFirst({
      where: { id: resolvedInsuredId, brokerageId },
    });
    if (insured) {
      if (!simulatedPhone) simulatedPhone = insured.phone;
    } else {
      resolvedInsuredId = undefined;
    }
  }

  // Fallback de telefone de teste seguro (nunca número pessoal)
  if (!simulatedPhone) {
    simulatedPhone = "5527999990000";
  }

  // 4. Histórico da sessão
  const sessionKey = `${brokerageId}:${data.sessionId || "default"}`;
  const history = sessionHistory.get(sessionKey) || [];

  // 5. Executa agente Claude em modo de simulação
  const turnResult = await runAgentTurnDetailed({
    brokerageName: brokerage.name,
    brokerageId,
    phone: simulatedPhone,
    insuredId: resolvedInsuredId,
    messageHistory: history,
    userMessage: data.message,
    isSimulation: true,
  });

  // Atualiza histórico em memória
  history.push({ role: "user", content: data.message });
  history.push({ role: "assistant", content: turnResult.reply });
  // Limita histórico a últimas 20 mensagens
  if (history.length > 20) {
    history.splice(0, history.length - 20);
  }
  sessionHistory.set(sessionKey, history);

  // Incrementa contador diário
  const newCount = incrementSimulatorCount(brokerageId);

  res.json({
    reply: turnResult.reply,
    simulatedDispatches: turnResult.simulatedDispatches,
    sessionId: data.sessionId || "default",
    dailyUsage: newCount,
    dailyLimit: DAILY_LIMIT,
    remaining: Math.max(0, DAILY_LIMIT - newCount),
  });
});

// Limpa dados criados durante a simulação (Sinistros e Cards marcados como SIMULAÇÃO)
simulatorRouter.post("/clear", requireAuth, async (req: Request, res: Response) => {
  const brokerageId = req.user!.brokerageId;

  const [deletedClaims, deletedCards, deletedConversations] = await prisma.$transaction([
    prisma.claim.deleteMany({
      where: { brokerageId, isSimulation: true },
    }),
    prisma.pipelineCard.deleteMany({
      where: { brokerageId, isSimulation: true },
    }),
    prisma.conversation.deleteMany({
      where: { brokerageId, isSimulation: true },
    }),
  ]);

  // Limpa histórico de sessões em memória desta corretora
  for (const key of Array.from(sessionHistory.keys())) {
    if (key.startsWith(`${brokerageId}:`)) {
      sessionHistory.delete(key);
    }
  }

  res.json({
    success: true,
    message: "Dados de simulação excluídos com sucesso.",
    deleted: {
      claims: deletedClaims.count,
      cards: deletedCards.count,
      conversations: deletedConversations.count,
    },
  });
});
