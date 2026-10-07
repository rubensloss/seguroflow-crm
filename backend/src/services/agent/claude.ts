import Anthropic from "@anthropic-ai/sdk";
import { env } from "../../config/env";
import { prisma } from "../../config/prisma";
import { buildSystemPrompt } from "./systemPrompt";
import { AGENT_TOOLS, executeAgentTool } from "./tools";
import {
  sendWhatsAppTextMessage,
  sendWhatsAppTemplateMessage,
  isWithinCustomer24hWindow,
} from "../whatsappCloud";
import { decryptSensitive } from "../../security/crypto";

function getAnthropicClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY;
  return apiKey ? new Anthropic({ apiKey }) : null;
}

export interface AgentTurnParams {
  brokerageName: string;
  brokerageId: string;
  phone: string;
  insuredId?: string;
  messageHistory: Array<{ role: "user" | "assistant"; content: string }>;
  userMessage: string;
  isSimulation?: boolean;
}

export interface AgentTurnResult {
  reply: string;
  simulatedDispatches: string[];
}

/**
 * Fallback honesto quando a IA está indisponível (sem chave, sem crédito ou erro de API):
 * 1. Responde mensagem fixa e transparente com o telefone de contato da corretora;
 * 2. Transfere a conversa para HUMAN_CONTROLLED;
 * 3. Cria card no funil com o título "atendimento sem IA";
 * 4. Dispara alerta_corretor respeitando regras da Meta e janela de 24h.
 */
export async function handleAiUnavailableFallback(params: {
  brokerageId: string;
  brokerageName: string;
  phone: string;
  insuredId?: string;
  userMessage: string;
  reason: string;
}): Promise<string> {
  const { brokerageId, brokerageName, phone, insuredId, userMessage, reason } = params;

  // 1. Busca dados da corretora
  const brokerage = await prisma.brokerage.findUnique({
    where: { id: brokerageId },
  }).catch(() => null);

  const brokerPhone = brokerage?.phone || brokerage?.alertPhone || brokerage?.telephonyNumber || "o telefone da corretora";
  const reply = `Recebemos sua mensagem. Um atendente da ${brokerageName} vai te responder em instantes. Em caso de acidente, ligue ${brokerPhone}.`;

  // 2. Passa a conversa para HUMAN_CONTROLLED
  const cleanPhone = phone.replace(/\D/g, "");
  const last8 = cleanPhone.slice(-8);

  await prisma.conversation.updateMany({
    where: { brokerageId, phone: { contains: last8 } },
    data: {
      status: "HUMAN_CONTROLLED",
      humanReason: `Atendimento sem IA (${reason})`,
    },
  }).catch((err) => console.error("[Agent AI Fallback] Erro ao atualizar conversa:", err));

  // 3. Cria card no funil com o título "atendimento sem IA"
  let targetInsured = null;
  if (insuredId) {
    targetInsured = await prisma.insured.findUnique({ where: { id: insuredId } }).catch(() => null);
  } else {
    targetInsured = await prisma.insured.findFirst({
      where: { brokerageId, phone: { contains: last8 } },
    }).catch(() => null);
  }

  const callerName = targetInsured?.name || phone;

  await prisma.pipelineCard.create({
    data: {
      brokerageId,
      insuredId: targetInsured?.id,
      title: "atendimento sem IA",
      stage: "NOVO",
      notes: `Mensagem: "${userMessage}". Motivo: ${reason}. Robô pausado para atendimento humano.`,
    },
  }).catch((cardErr) => console.error("[Agent AI Fallback] Erro ao criar pipelineCard:", cardErr));

  // 4. Envia alerta_corretor se alertPhone configurado
  if (brokerage?.alertPhone && brokerage?.whatsappPhoneNumberId && brokerage?.whatsappAccessTokenEncrypted) {
    const token = decryptSensitive(brokerage.whatsappAccessTokenEncrypted);
    if (token) {
      const alertPhone = brokerage.alertPhone;
      const phoneNumberId = brokerage.whatsappPhoneNumberId;
      const panelUrl = `${env.PUBLIC_BASE_URL || "https://creativealways.com.br/seguroflow/painel"}`;
      const summary = `Atendimento sem IA (${reason}): ${userMessage.slice(0, 80)}`;

      try {
        const components = [
          {
            type: "body" as const,
            parameters: [
              { type: "text" as const, text: "Atendimento sem IA" },
              { type: "text" as const, text: callerName },
              { type: "text" as const, text: summary },
              { type: "text" as const, text: panelUrl },
            ],
          },
        ];

        await sendWhatsAppTemplateMessage(
          alertPhone,
          "alerta_corretor",
          "pt_BR",
          components,
          phoneNumberId,
          token
        );
      } catch (templateErr) {
        console.warn("[Agent AI Fallback] Template alerta_corretor falhou. Verificando janela 24h...", templateErr);
        const inWindow = await isWithinCustomer24hWindow(brokerageId, alertPhone).catch(() => false);
        if (inWindow) {
          const alertMsg = `⚠️ *ATENDIMENTO SEM IA - SeguroFlow*\n\nCliente: *${callerName}* (${phone})\nMensagem: ${userMessage}\nMotivo: ${reason}\n\nAcesse: ${panelUrl}`;
          await sendWhatsAppTextMessage(alertPhone, alertMsg, phoneNumberId, token).catch(() => {});
        } else {
          console.warn(`[Agent AI Fallback] Celular de alerta (${alertPhone}) fora da janela de 24h. Texto livre bloqueado.`);
        }
      }
    }
  }

  return reply;
}

export async function runAgentTurnDetailed(params: AgentTurnParams): Promise<AgentTurnResult> {
  const { brokerageName, brokerageId, phone, insuredId, messageHistory, userMessage, isSimulation } = params;
  const anthropic = getAnthropicClient();
  const simulatedDispatches: string[] = [];

  // Se ANTHROPIC_API_KEY não estiver configurada
  if (!anthropic) {
    if (isSimulation) {
      return {
        reply: "IA não configurada",
        simulatedDispatches: [],
      };
    }

    // Modo real sem chave: NUNCA inventa respostas nem executa ferramentas
    console.log("[Agent Turn] Sem chave Anthropic — executando transferência humana sem dados fictícios");
    const reply = await handleAiUnavailableFallback({
      brokerageId,
      brokerageName,
      phone,
      insuredId,
      userMessage,
      reason: "sem chave de IA configurada",
    });

    return {
      reply,
      simulatedDispatches: [],
    };
  }

  const system = buildSystemPrompt(brokerageName);

  const messages: Anthropic.MessageParam[] = [
    ...messageHistory.map((m) => ({
      role: m.role,
      content: m.content,
    })),
    {
      role: "user",
      content: userMessage,
    },
  ];

  try {
    let response = await anthropic.messages.create({
      model: env.ANTHROPIC_MODEL,
      max_tokens: 1024,
      system,
      messages,
      tools: AGENT_TOOLS,
    });

    // Loop de execução de ferramentas (tool use)
    let turns = 0;
    while (response.stop_reason === "tool_use" && turns < 5) {
      turns++;
      const toolUseBlock = response.content.find((b) => b.type === "tool_use");
      if (!toolUseBlock || toolUseBlock.type !== "tool_use") break;

      const toolResult = await executeAgentTool(
        toolUseBlock.name,
        toolUseBlock.input as Record<string, unknown>,
        { brokerageId, phone, insuredId, isSimulation, simulatedDispatches }
      );

      // Adiciona resposta do modelo e resultado da ferramenta ao histórico
      messages.push({ role: "assistant", content: response.content });
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseBlock.id,
            content: toolResult,
          },
        ],
      });

      response = await anthropic.messages.create({
        model: env.ANTHROPIC_MODEL,
        max_tokens: 1024,
        system,
        messages,
        tools: AGENT_TOOLS,
      });
    }

    const textBlock = response.content.find((b) => b.type === "text");
    const reply = textBlock && textBlock.type === "text"
      ? textBlock.text
      : "Entendido! Se precisar de mais alguma informação ou apoio com sua apólice, estou à disposição.";

    return {
      reply,
      simulatedDispatches,
    };
  } catch (err: any) {
    console.error("Erro na chamada à API da Anthropic:", err);
    if (isSimulation) {
      return {
        reply: "IA não configurada",
        simulatedDispatches,
      };
    }

    const reply = await handleAiUnavailableFallback({
      brokerageId,
      brokerageName,
      phone,
      insuredId,
      userMessage,
      reason: "erro ou limite de crédito na API Anthropic",
    });

    return {
      reply,
      simulatedDispatches,
    };
  }
}

export async function runAgentTurn(params: AgentTurnParams): Promise<string> {
  const result = await runAgentTurnDetailed(params);
  return result.reply;
}
