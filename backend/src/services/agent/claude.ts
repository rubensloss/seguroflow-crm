import Anthropic from "@anthropic-ai/sdk";
import { env } from "../../config/env";
import { buildSystemPrompt } from "./systemPrompt";
import { AGENT_TOOLS, executeAgentTool } from "./tools";

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

export async function runAgentTurnDetailed(params: AgentTurnParams): Promise<AgentTurnResult> {
  const { brokerageName, brokerageId, phone, insuredId, messageHistory, userMessage, isSimulation } = params;
  const anthropic = getAnthropicClient();
  const simulatedDispatches: string[] = [];

  // Se ANTHROPIC_API_KEY não estiver configurada
  if (!anthropic) {
    if (isSimulation) {
      // Regra 2: "Se a ANTHROPIC_API_KEY não estiver configurada, mostrar a mensagem 'IA não configurada' (nunca uma resposta inventada)."
      return {
        reply: "IA não configurada",
        simulatedDispatches: [],
      };
    }

    console.log("[Agent Mock Turn] Executando resposta simulada sem chave Anthropic");
    if (userMessage.toLowerCase().includes("sinistro") || userMessage.toLowerCase().includes("bateram")) {
      await executeAgentTool(
        "abrirSinistro",
        { incidentType: "Colisão", description: userMessage },
        { brokerageId, phone, insuredId, isSimulation: false, simulatedDispatches }
      );
      return {
        reply: `Lamento pelo ocorrido! Já abri um chamado de sinistro prioritário para a equipe da ${brokerageName} e notifiquei o corretor responsável. Para socorro ou guincho agora mesmo, a assistência 24h da sua seguradora está disponível. Você precisa de guincho neste momento?`,
        simulatedDispatches,
      };
    }
    if (userMessage.toLowerCase().includes("paguei") || userMessage.toLowerCase().includes("comprovante")) {
      await executeAgentTool(
        "registrarAvisoPagamento",
        { observacao: userMessage },
        { brokerageId, phone, insuredId, isSimulation: false, simulatedDispatches }
      );
      return {
        reply: `Perfeito! Já registrei que a parcela foi paga e notifiquei a equipe da ${brokerageName} para baixar o status junto à seguradora. Muito obrigado pelo aviso!`,
        simulatedDispatches,
      };
    }
    return {
      reply: `Olá! Sou a assistente virtual da ${brokerageName}. Como posso ajudar com sua apólice ou atendimento hoje?`,
      simulatedDispatches,
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
    return {
      reply: `Desculpe, tive uma instabilidade momentânea no processamento inteligente. Estou transferindo você para a nossa equipe da ${brokerageName}.`,
      simulatedDispatches,
    };
  }
}

export async function runAgentTurn(params: AgentTurnParams): Promise<string> {
  const result = await runAgentTurnDetailed(params);
  return result.reply;
}
