import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "../../config/prisma";
import { sendWhatsAppTextMessage } from "../whatsappCloud";
import { decryptSensitive } from "../../security/crypto";

export const AGENT_TOOLS: Anthropic.Tool[] = [
  {
    name: "consultarApolicesSegurado",
    description: "Busca apólices ativas e vigência do segurado pelo telefone ou CPF.",
    input_schema: {
      type: "object",
      properties: {
        cpf: { type: "string", description: "CPF do segurado (opcional se identificado pelo telefone)" },
      },
    },
  },
  {
    name: "obterAssistencia24h",
    description: "Informa o telefone 0800 e assistência 24h da seguradora da apólice ativa do segurado.",
    input_schema: {
      type: "object",
      properties: {
        policyId: { type: "string", description: "ID da apólice (se conhecido)" },
      },
      required: [],
    },
  },
  {
    name: "abrirSinistro",
    description: "Abre um chamado oficial de sinistro no sistema, registra detalhes e avisa o corretor na hora.",
    input_schema: {
      type: "object",
      properties: {
        policyId: { type: "string", description: "ID da apólice do segurado" },
        incidentType: { type: "string", description: "Tipo do ocorrido (ex: Colisão, Vidros, Furto/Roubo, Alagamento)" },
        incidentLocation: { type: "string", description: "Local do sinistro" },
        description: { type: "string", description: "Relato detalhado do segurado" },
      },
      required: ["incidentType", "description"],
    },
  },
  {
    name: "registrarAvisoPagamento",
    description: "Registra no sistema quando o segurado afirma que já efetuou o pagamento da parcela.",
    input_schema: {
      type: "object",
      properties: {
        installmentId: { type: "string", description: "ID da parcela (se identificada)" },
        observacao: { type: "string", description: "Comprovante ou informação fornecida pelo cliente" },
      },
      required: ["observacao"],
    },
  },
  {
    name: "solicitarAtendimentoHumano",
    description: "Pausa o robô de IA e transfere a conversa para o corretor humano da corretora.",
    input_schema: {
      type: "object",
      properties: {
        motivo: { type: "string", description: "Motivo da solicitação de atendimento humano" },
      },
      required: ["motivo"],
    },
  },
];

export async function executeAgentTool(
  toolName: string,
  args: Record<string, unknown>,
  context: { brokerageId: string; phone: string; insuredId?: string }
): Promise<string> {
  const { brokerageId, phone, insuredId } = context;

  switch (toolName) {
    case "consultarApolicesSegurado": {
      const insured = await prisma.insured.findFirst({
        where: {
          brokerageId,
          OR: [
            { phone: { contains: phone.slice(-8) } },
            args.cpf ? { cpf: String(args.cpf).replace(/\D/g, "") } : {},
          ],
        },
        include: { policies: { where: { status: "ACTIVE" } } },
      });

      if (!insured || insured.policies.length === 0) {
        return JSON.stringify({
          encontrado: false,
          mensagem: "Nenhuma apólice ativa encontrada para os dados informados.",
        });
      }

      return JSON.stringify({
        encontrado: true,
        seguradoNome: insured.name,
        apolices: insured.policies.map((p) => ({
          id: p.id,
          numero: p.policyNumber,
          seguradora: p.insurerName,
          ramo: p.branch,
          vigenciaAte: p.endDate.toISOString().split("T")[0],
          assistencia24h: p.assistance24hPhone,
          item: p.itemDescription,
        })),
      });
    }

    case "obterAssistencia24h": {
      const policy = await prisma.policy.findFirst({
        where: {
          brokerageId,
          ...(args.policyId
            ? { id: String(args.policyId) }
            : insuredId
            ? { insuredId, status: "ACTIVE" }
            : {}),
        },
      });

      if (!policy) {
        return JSON.stringify({
          sucesso: false,
          mensagem: "Apólice não localizada para informar o contato 24h.",
        });
      }

      return JSON.stringify({
        sucesso: true,
        seguradora: policy.insurerName,
        assistencia24h: policy.assistance24hPhone || "Consulte seu corretor para o 0800 específico",
        item: policy.itemDescription,
      });
    }

    case "abrirSinistro": {
      let targetPolicyId = args.policyId as string | undefined;

      if (!targetPolicyId) {
        const pol = await prisma.policy.findFirst({
          where: { brokerageId, ...(insuredId ? { insuredId, status: "ACTIVE" } : {}) },
        });
        targetPolicyId = pol?.id;
      }

      if (!targetPolicyId || !insuredId) {
        return JSON.stringify({
          sucesso: false,
          mensagem: "Não foi possível abrir o sinistro sem o cadastro do segurado e apólice identificados.",
        });
      }

      const claim = await prisma.claim.create({
        data: {
          brokerageId,
          insuredId,
          policyId: targetPolicyId,
          incidentType: String(args.incidentType),
          incidentLocation: args.incidentLocation ? String(args.incidentLocation) : undefined,
          description: String(args.description),
          status: "OPEN",
          brokerNotifiedAt: new Date(),
        },
        include: { policy: true, insured: true, brokerage: true },
      });

      // Notifica o corretor no WhatsApp caso tenha alertPhone configurado
      if (claim.brokerage.alertPhone && claim.brokerage.whatsappPhoneNumberId && claim.brokerage.whatsappAccessTokenEncrypted) {
        const token = decryptSensitive(claim.brokerage.whatsappAccessTokenEncrypted);
        if (token) {
          const alertMsg = `🚨 *ALERTA DE SINISTRO - SeguroFlow*\n\nSegurado: *${claim.insured.name}*\nTipo: *${claim.incidentType}*\nSeguradora: *${claim.policy.insurerName}*\nTelefone: ${claim.insured.phone}\nRelato: ${claim.description}`;
          sendWhatsAppTextMessage(claim.brokerage.alertPhone, alertMsg, claim.brokerage.whatsappPhoneNumberId, token).catch(() => {});
        }
      }

      return JSON.stringify({
        sucesso: true,
        sinistroId: claim.id,
        seguradora: claim.policy.insurerName,
        assistencia24h: claim.policy.assistance24hPhone,
        mensagem: "Sinistro registrado com sucesso no painel da corretora e corretor notificado.",
      });
    }

    case "registrarAvisoPagamento": {
      const installment = await prisma.installment.findFirst({
        where: {
          brokerageId,
          ...(args.installmentId
            ? { id: String(args.installmentId) }
            : insuredId
            ? { policy: { insuredId }, status: { in: ["PENDING", "SENT_D7", "SENT_D0", "SENT_D2", "OVERDUE"] } }
            : {}),
        },
      });

      if (installment) {
        await prisma.installment.update({
          where: { id: installment.id },
          data: {
            status: "CLAIMED_PAID",
            claimedPaidAt: new Date(),
            claimedPaidNote: String(args.observacao),
          },
        });
      }

      return JSON.stringify({
        sucesso: true,
        mensagem: "Aviso de pagamento registrado. A equipe da corretora foi informada para baixa com a seguradora.",
      });
    }

    case "solicitarAtendimentoHumano": {
      // Localiza a conversa e marca como HUMAN_CONTROLLED
      await prisma.conversation.updateMany({
        where: { brokerageId, phone: { contains: phone.slice(-8) } },
        data: {
          status: "HUMAN_CONTROLLED",
          humanReason: String(args.motivo || "Solicitado pelo segurado"),
        },
      });

      return JSON.stringify({
        sucesso: true,
        mensagem: "Robô pausado. A conversa foi encaminhada com prioridade para um corretor humano assumir.",
      });
    }

    default:
      return JSON.stringify({ erro: `Ferramenta desconhecida: ${toolName}` });
  }
}
