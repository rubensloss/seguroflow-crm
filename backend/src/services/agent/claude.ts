import Anthropic from "@anthropic-ai/sdk";
import { env } from "../../config/env";
import { buildSystemPrompt } from "./systemPrompt";
import { AGENT_TOOLS, executeAgentTool } from "./tools";

const anthropic = env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }) : null;

export interface AgentTurnParams {
  brokerageName: string;
  brokerageId: string;
  phone: string;
  insuredId?: string;
  messageHistory: Array<{ role: "user" | "assistant"; content: string }>;
  userMessage: string;
}

export async function runAgentTurn(params: AgentTurnParams): Promise<string> {
  const { brokerageName, brokerageId, phone, insuredId, messageHistory, userMessage } = params;

  if (!anthropic) {
    console.log("[Agent Mock Turn] Executando resposta simulada sem chave Anthropic");
    if (userMessage.toLowerCase().includes("sinistro") || userMessage.toLowerCase().includes("bateram")) {
      await executeAgentTool(
        "abrirSinistro",
        { incidentType: "Colisão", description: userMessage },
        { brokerageId, phone, insuredId }
      );
      return `Lamento pelo ocorrido! Já abri um chamado de sinistro prioritário para a equipe da ${brokerageName} e notifiquei o corretor responsável. Para socorro ou guincho agora mesmo, a assistência 24h da sua seguradora está disponível. Você precisa de guincho neste momento?`;
    }
    if (userMessage.toLowerCase().includes("paguei") || userMessage.toLowerCase().includes("comprovante")) {
      await executeAgentTool(
        "registrarAvisoPagamento",
        { observacao: userMessage },
        { brokerageId, phone, insuredId }
      );
      return `Perfeito! Já registrei que a parcela foi paga e notifiquei a equipe da ${brokerageName} para baixar o status junto à seguradora. Muito obrigado pelo aviso!`;
    }
    return `Olá! Sou a assistente virtual da ${brokerageName}. Como posso ajudar com sua apólice ou atendimento hoje?`;
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
    while (response.stop_reason === "tool_use") {
      const toolUseBlock = response.content.find((b) => b.type === "tool_use");
      if (!toolUseBlock || toolUseBlock.type !== "tool_use") break;

      const toolResult = await executeAgentTool(
        toolUseBlock.name,
        toolUseBlock.input as Record<string, unknown>,
        { brokerageId, phone, insuredId }
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
    return textBlock && textBlock.type === "text"
      ? textBlock.text
      : "Recebi sua mensagem. Como posso ajudar mais com seu seguro?";
  } catch (error) {
    console.error("Erro no processamento do turno do agente Claude:", error);
    return `Olá! Recebi sua mensagem na ${brokerageName}. Nosso corretor já foi notificado e responderá em instantes.`;
  }
}
