import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "../../config/prisma";
import { env } from "../../config/env";
import {
  sendWhatsAppTextMessage,
  sendWhatsAppTemplateMessage,
  isWithinCustomer24hWindow,
} from "../whatsappCloud";
import { decryptSensitive } from "../../security/crypto";
import { resolveAssistance24hPhone } from "../insurerDirectory";

export const AGENT_TOOLS: Anthropic.Tool[] = [
  {
    name: "consultarApolicesSegurado",
    description: "Busca apólices ativas e vigência do segurado pelo telefone, CPF ou placa de veículo.",
    input_schema: {
      type: "object",
      properties: {
        cpf: { type: "string", description: "CPF do segurado (opcional se identificado pelo telefone)" },
        plate: { type: "string", description: "Placa do veículo (para frotas ou consulta direta de veículo)" },
      },
    },
  },
  {
    name: "obterAssistencia24h",
    description: "Retorna o Kit do Sinistro completo (0800 da seguradora, número da apólice, placa/item segurado, titular e CPF mascarado) pronto para o segurado ligar para a assistência.",
    input_schema: {
      type: "object",
      properties: {
        policyId: { type: "string", description: "ID da apólice (se conhecido)" },
        plate: { type: "string", description: "Placa do veículo envolvido (essencial para apólices de frota)" },
      },
      required: [],
    },
  },
  {
    name: "abrirSinistro",
    description: "Abre um chamado oficial de sinistro no sistema, vincula à apólice e veículo da frota (se aplicável), e avisa o corretor na hora.",
    input_schema: {
      type: "object",
      properties: {
        policyId: { type: "string", description: "ID da apólice do segurado" },
        plate: { type: "string", description: "Placa do veículo envolvido no sinistro (obrigatório para frotas)" },
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

export interface AgentToolContext {
  brokerageId: string;
  phone: string;
  insuredId?: string;
  isSimulation?: boolean;
  simulatedDispatches?: string[];
}

/**
 * Identifica o originador da mensagem: titular, contato autorizado (ex: motorista/gestor) ou desconhecido.
 */
async function resolveCaller(brokerageId: string, phone: string, insuredId?: string) {
  if (insuredId) {
    const direct = await prisma.insured.findFirst({
      where: { id: insuredId, brokerageId },
    });
    if (direct) {
      return {
        type: "INSURED" as const,
        insured: direct,
        contact: null,
        role: "TITULAR",
        canClaims: true,
        canBilling: true,
        canRenewal: true,
      };
    }
  }

  const cleanPhone = phone.replace(/\D/g, "");
  const last8 = cleanPhone.slice(-8);

  // 1. Telefone direto do Segurado titular
  const directInsured = await prisma.insured.findFirst({
    where: {
      brokerageId,
      phone: { contains: last8 },
    },
  });

  if (directInsured) {
    return {
      type: "INSURED" as const,
      insured: directInsured,
      contact: null,
      role: "TITULAR",
      canClaims: true,
      canBilling: true,
      canRenewal: true,
    };
  }

  // 2. Contato autorizado do segurado (ex: Motorista, Gestor de Frota, Financeiro)
  const authorizedContact = await prisma.authorizedContact.findFirst({
    where: {
      brokerageId,
      phone: { contains: last8 },
    },
    include: { insured: true },
  });

  if (authorizedContact) {
    return {
      type: "AUTHORIZED_CONTACT" as const,
      insured: authorizedContact.insured,
      contact: authorizedContact,
      role: authorizedContact.role,
      canClaims: authorizedContact.canClaims,
      canBilling: authorizedContact.canBilling,
      canRenewal: authorizedContact.canRenewal,
    };
  }

  // 3. Contato não cadastrado
  return {
    type: "UNKNOWN" as const,
    insured: null,
    contact: null,
    role: "DESCONHECIDO",
    canClaims: false,
    canBilling: false,
    canRenewal: false,
  };
}

/**
 * Trata tentativa de contato por telefone desconhecido que informa uma placa:
 * Proteção LGPD total: NÃO vaza número de apólice nem CPF/CNPJ.
 * Passa o telefone da corretora, cria um card no CRM e chama um humano.
 */
async function handleUnknownCallerAttempt(
  brokerageId: string,
  phone: string,
  plate?: string,
  isSimulation?: boolean,
  simulatedDispatches?: string[]
): Promise<string> {
  const brokerage = await prisma.brokerage.findUnique({
    where: { id: brokerageId },
    select: { phone: true, name: true },
  });
  const brokerPhone = brokerage?.phone || "da corretora";
  const cleanPlate = plate ? String(plate).toUpperCase().replace(/[^A-Z0-9]/g, "") : "";

  // Cria o card no funil de CRM
  await prisma.pipelineCard.create({
    data: {
      brokerageId,
      title: `contato não cadastrado pediu assistência – placa ${cleanPlate || "não informada"}`,
      stage: "NOVO",
      notes: `Telefone solicitante: ${phone}. O contato tentou atendimento informando placa ${cleanPlate || "não informada"}, mas não está cadastrado como titular nem motorista autorizado. Dados retidos por segurança (LGPD).`,
      source: "WhatsApp",
      isSimulation: Boolean(isSimulation),
    },
  });

  // Pausa o robô para atendimento humano
  await prisma.conversation.updateMany({
    where: { brokerageId, phone: { contains: phone.slice(-8) } },
    data: {
      status: "HUMAN_CONTROLLED",
      humanReason: `Contato não cadastrado solicitou assistência para placa ${cleanPlate || "não informada"}`,
    },
  });

  if (isSimulation && simulatedDispatches) {
    simulatedDispatches.push(
      `[Simulação] Criaria card 'contato não cadastrado pediu assistência – placa ${cleanPlate || "não informada"}' no CRM e transferiria para humano.`
    );
  }

  return JSON.stringify({
    sucesso: false,
    bloqueadoSeguranca: true,
    mensagem: `Seu telefone (${phone}) não consta cadastrado como titular ou motorista autorizado para este veículo. Por normas rigorosas de segurança (LGPD), o número da apólice e o CPF não podem ser informados aqui. Por favor, entre em contato diretamente com a nossa corretora pelo telefone ${brokerPhone}. Já abri um chamado interno para que nossa equipe acompanhe seu caso.`,
    telefoneCorretora: brokerPhone,
    tipoTelefone: "corretora",
  });
}

/**
 * Localiza veículo de frota por placa (PolicyItem ou Policy.itemDescription).
 */
async function resolveVehicleByPlate(brokerageId: string, plate?: string, insuredId?: string) {
  if (!plate) return null;
  const cleanPlate = String(plate).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!cleanPlate) return null;

  // Busca em PolicyItem ativo da corretora
  const item = await prisma.policyItem.findFirst({
    where: {
      brokerageId,
      plate: { contains: cleanPlate, mode: "insensitive" },
      status: "ACTIVE",
      ...(insuredId ? { policy: { insuredId } } : {}),
    },
    include: {
      policy: {
        include: {
          brokerage: { select: { phone: true, name: true, confirmedInsurers: true } },
          insured: { select: { id: true, name: true, cpf: true, phone: true } },
        },
      },
    },
  });

  if (item) return { item, policy: item.policy };

  // Fallback: busca em apólices ativas com itemDescription
  const policyByDesc = await prisma.policy.findFirst({
    where: {
      brokerageId,
      status: "ACTIVE",
      itemDescription: { contains: cleanPlate, mode: "insensitive" },
      ...(insuredId ? { insuredId } : {}),
    },
    include: {
      brokerage: { select: { phone: true, name: true, confirmedInsurers: true } },
      insured: { select: { id: true, name: true, cpf: true, phone: true } },
    },
  });

  if (policyByDesc) return { item: null, policy: policyByDesc };

  return null;
}

export async function executeAgentTool(
  toolName: string,
  args: Record<string, unknown>,
  context: AgentToolContext
): Promise<string> {
  const { brokerageId, phone, insuredId, isSimulation, simulatedDispatches } = context;
  const caller = await resolveCaller(brokerageId, phone, insuredId);

  switch (toolName) {
    case "consultarApolicesSegurado": {
      // Se caller for desconhecido e tiver informado placa
      if (caller.type === "UNKNOWN" && args.plate) {
        return handleUnknownCallerAttempt(brokerageId, phone, String(args.plate), isSimulation, simulatedDispatches);
      }

      if (caller.type === "UNKNOWN") {
        return JSON.stringify({
          encontrado: false,
          mensagem: "Telefone não identificado no cadastro da corretora. Informe seu CPF para localização.",
        });
      }

      const targetInsuredId = caller.insured?.id || insuredId;

      const insured = await prisma.insured.findFirst({
        where: {
          brokerageId,
          OR: [
            targetInsuredId ? { id: targetInsuredId } : {},
            { phone: { contains: phone.slice(-8) } },
            args.cpf ? { cpf: String(args.cpf).replace(/\D/g, "") } : {},
          ],
        },
        include: {
          policies: {
            where: { status: "ACTIVE" },
            include: {
              items: { where: { status: "ACTIVE" } },
            },
          },
        },
      });

      if (!insured || insured.policies.length === 0) {
        return JSON.stringify({
          encontrado: false,
          mensagem: "Nenhuma apólice ativa encontrada para os dados informados.",
        });
      }

      // Se filtrou por placa
      if (args.plate) {
        const cleanPlate = String(args.plate).toUpperCase().replace(/[^A-Z0-9]/g, "");
        const matched = insured.policies.filter((p) => {
          const hasInDesc = (p.itemDescription || "").toUpperCase().includes(cleanPlate);
          const hasInItems = p.items.some((it) => (it.plate || "").toUpperCase().includes(cleanPlate));
          return hasInDesc || hasInItems;
        });

        if (matched.length === 0) {
          return JSON.stringify({
            encontrado: false,
            mensagem: `Nenhum veículo com a placa ${cleanPlate} foi localizado nas apólices ativas.`,
          });
        }

        return JSON.stringify({
          encontrado: true,
          seguradoNome: insured.name,
          apolices: matched.map((p) => ({
            id: p.id,
            numero: p.policyNumber,
            seguradora: p.insurerName,
            ramo: p.branch,
            subRamo: p.subBranch,
            vigenciaAte: p.endDate.toISOString().split("T")[0],
            assistencia24h: p.assistance24hPhone,
            item: p.itemDescription,
            itensFrota: p.items.map((it) => ({
              id: it.id,
              placa: it.plate,
              modelo: it.makeModel,
              ano: it.year,
            })),
          })),
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
          subRamo: p.subBranch,
          vigenciaAte: p.endDate.toISOString().split("T")[0],
          assistencia24h: p.assistance24hPhone,
          item: p.itemDescription,
          totalItensFrota: p.items.length,
        })),
      });
    }

    case "obterAssistencia24h": {
      // 1. Telefone desconhecido informando placa -> Proteção de dados total
      if (caller.type === "UNKNOWN") {
        if (args.plate) {
          return handleUnknownCallerAttempt(brokerageId, phone, String(args.plate), isSimulation, simulatedDispatches);
        }
        const brokerage = await prisma.brokerage.findUnique({
          where: { id: brokerageId },
          select: { phone: true, name: true, confirmedInsurers: true },
        });
        const fallback = resolveAssistance24hPhone(null, null, brokerage?.phone, brokerage?.confirmedInsurers as any);
        return JSON.stringify({
          sucesso: false,
          mensagem: "Telefone não identificado no sistema. Favor ligar para a corretora.",
          assistencia24h: fallback.phone,
          tipoTelefone: fallback.type,
          instrucao: `Informe o contato de plantão da corretora: ${fallback.phone}`,
        });
      }

      // 2. Contato autorizado sem permissão de sinistro
      if (caller.type === "AUTHORIZED_CONTACT" && !caller.canClaims) {
        return JSON.stringify({
          sucesso: false,
          bloqueadoPermissao: true,
          mensagem: `Seu contato (${caller.contact?.name}) está cadastrado com função ${caller.role}, sem permissão de abertura de chamado de assistência. Favor solicitar ao gestor responsável.`,
        });
      }

      let policy: any = null;
      let vehicleItem: any = null;

      // 3. Se informou placa, busca na frota da corretora / do segurado
      if (args.plate) {
        const resolved = await resolveVehicleByPlate(brokerageId, String(args.plate), caller.insured?.id);
        if (!resolved) {
          // Placa que não existe -> NÃO inventa e transfere para atendimento humano!
          await prisma.conversation.updateMany({
            where: { brokerageId, phone: { contains: phone.slice(-8) } },
            data: {
              status: "HUMAN_CONTROLLED",
              humanReason: `Placa ${args.plate} não encontrada na frota cadastrada`,
            },
          });

          return JSON.stringify({
            sucesso: false,
            placaNaoEncontrada: true,
            mensagem: `A placa ${String(args.plate).toUpperCase()} não foi localizada em nenhuma apólice ativa da sua empresa. Para não acionar a seguradora incorreta, estou transferindo você para um corretor da nossa equipe verificar seu cadastro.`,
            instrucao: "A placa não existe no sistema. Nunca invente dados de seguradora. Transfira para atendimento humano.",
          });
        }

        policy = resolved.policy;
        vehicleItem = resolved.item;
      } else {
        // Busca por policyId ou apólice ativa do segurado
        policy = await prisma.policy.findFirst({
          where: {
            brokerageId,
            ...(args.policyId
              ? { id: String(args.policyId) }
              : caller.insured
              ? { insuredId: caller.insured.id, status: "ACTIVE" }
              : {}),
          },
          include: {
            brokerage: { select: { phone: true, name: true, confirmedInsurers: true } },
            insured: { select: { name: true, cpf: true, phone: true } },
            items: { where: { status: "ACTIVE" } },
          },
        });
      }

      if (!policy) {
        const brokerage = await prisma.brokerage.findUnique({
          where: { id: brokerageId },
          select: { phone: true, name: true, confirmedInsurers: true },
        });
        const fallback = resolveAssistance24hPhone(null, null, brokerage?.phone, brokerage?.confirmedInsurers as any);
        return JSON.stringify({
          sucesso: false,
          mensagem: "Apólice específica não identificada.",
          assistencia24h: fallback.phone,
          tipoTelefone: fallback.type,
          instrucao: `Informe ao segurado o contato de plantão da corretora: ${fallback.phone}`,
        });
      }

      // Se a apólice possui múltiplos itens de frota e nenhuma placa foi informada:
      if (!args.plate && policy.items && policy.items.length > 1) {
        return JSON.stringify({
          sucesso: false,
          requerPlaca: true,
          mensagem: `Identifiquei que esta apólice (${policy.insurerName} nº ${policy.policyNumber}) é uma Frota com ${policy.items.length} veículos cadastrados. Por favor, me informe a placa do veículo envolvido para emitir o Kit do Sinistro específico.`,
        });
      }

      const assistance = resolveAssistance24hPhone(
        policy.assistance24hPhone,
        policy.insurerName,
        policy.brokerage?.phone,
        policy.brokerage?.confirmedInsurers as any
      );

      const rawCpf = policy.insured?.cpf ? policy.insured.cpf.replace(/\D/g, "") : "";
      const maskedCpf = rawCpf.length === 11
        ? `***.${rawCpf.slice(3, 6)}.${rawCpf.slice(6, 9)}-**`
        : rawCpf ? `***${rawCpf.slice(-4)}` : "";

      const contactLine = assistance.type === "corretora"
        ? `📞 Ligue para a corretora: ${assistance.phone}`
        : `📞 Assistência 24h da seguradora: ${assistance.phone}`;

      // Monta identificação do item/veículo
      let itemPlaca: string | null = null;
      if (vehicleItem) {
        itemPlaca = `${vehicleItem.makeModel || "Veículo"} - Placa ${vehicleItem.plate}${vehicleItem.year ? ` (${vehicleItem.year})` : ""}${vehicleItem.identification ? ` - ${vehicleItem.identification}` : ""}`;
      } else if (policy.itemDescription && policy.itemDescription.trim().length > 0) {
        itemPlaca = policy.itemDescription.trim();
      }

      const itemLine = itemPlaca ? `🚗 *Item/Placa:* ${itemPlaca}\n` : "";

      const kitSinistro = {
        seguradora: policy.insurerName,
        telefoneAssistencia: assistance.phone,
        tipoTelefone: assistance.type,
        apolice: policy.policyNumber,
        itemPlaca,
        titular: policy.insured?.name || "Segurado",
        cpf: maskedCpf || null,
        policyItemId: vehicleItem?.id || null,
      };

      if (isSimulation && simulatedDispatches) {
        simulatedDispatches.push(`[Simulação] Enviaria Kit do Sinistro (${policy.insurerName} / ${assistance.phone}) para ${phone}`);
      }

      return JSON.stringify({
        sucesso: true,
        seguradora: policy.insurerName,
        assistencia24h: assistance.phone,
        tipoTelefone: assistance.type,
        numeroApolice: policy.policyNumber,
        itemOuPlaca: itemPlaca,
        titular: policy.insured?.name || "Segurado",
        cpfMascarado: maskedCpf || null,
        kitSinistro,
        mensagemPronta: `🚨 *KIT DO SINISTRO — Central 24h*\n\n${contactLine}\n🏢 *Seguradora:* ${policy.insurerName}\n📄 *Apólice:* ${policy.policyNumber}\n${itemLine}👤 *Titular:* ${policy.insured?.name || "Segurado"}${maskedCpf ? ` (${maskedCpf})` : ""}\n\n_Ao ligar, tenha esses dados em mãos para que o guincho ou assistência seja liberado sem burocracia!_`,
      });
    }

    case "abrirSinistro": {
      // 1. Telefone desconhecido informando placa
      if (caller.type === "UNKNOWN") {
        return handleUnknownCallerAttempt(brokerageId, phone, args.plate ? String(args.plate) : undefined, isSimulation, simulatedDispatches);
      }

      // 2. Contato autorizado sem permissão de sinistro
      if (caller.type === "AUTHORIZED_CONTACT" && !caller.canClaims) {
        return JSON.stringify({
          sucesso: false,
          bloqueadoPermissao: true,
          mensagem: `Seu contato (${caller.contact?.name}) não possui permissão para abertura de sinistros. Favor solicitar ao gestor responsável.`,
        });
      }

      const targetInsuredId = caller.insured?.id || insuredId;
      let targetPolicyId = args.policyId as string | undefined;
      let resolvedPolicyItemId: string | undefined = undefined;

      // Se informou placa, localiza o item e a apólice
      if (args.plate) {
        const resolved = await resolveVehicleByPlate(brokerageId, String(args.plate), targetInsuredId);
        if (resolved) {
          targetPolicyId = resolved.policy.id;
          if (resolved.item) {
            resolvedPolicyItemId = resolved.item.id;
          }
        }
      }

      if (!targetPolicyId) {
        const pol = await prisma.policy.findFirst({
          where: { brokerageId, ...(targetInsuredId ? { insuredId: targetInsuredId, status: "ACTIVE" } : {}) },
        });
        targetPolicyId = pol?.id;
      }

      if (!targetPolicyId || !targetInsuredId) {
        return JSON.stringify({
          sucesso: false,
          mensagem: "Não foi possível abrir o sinistro sem o cadastro do segurado e apólice identificados.",
        });
      }

      const claim = await prisma.claim.create({
        data: {
          brokerageId,
          insuredId: targetInsuredId,
          policyId: targetPolicyId,
          policyItemId: resolvedPolicyItemId,
          incidentType: String(args.incidentType),
          incidentLocation: args.incidentLocation ? String(args.incidentLocation) : undefined,
          description: String(args.description),
          status: "OPEN",
          isSimulation: Boolean(isSimulation),
          brokerNotifiedAt: new Date(),
        },
        include: { policy: true, insured: true, brokerage: true },
      });

      // Em modo de SIMULAÇÃO: NUNCA envia mensagem real de WhatsApp!
      if (isSimulation) {
        const alertPhone = claim.brokerage.alertPhone || "5527999990000";
        if (simulatedDispatches) {
          simulatedDispatches.push(`[Simulação] Enviaria template alerta_corretor para ${alertPhone}`);
        }
        return JSON.stringify({
          sucesso: true,
          isSimulation: true,
          sinistroId: claim.id,
          seguradora: claim.policy.insurerName,
          assistencia24h: claim.policy.assistance24hPhone,
          mensagem: "[Simulação] Sinistro registrado como simulação. Nenhum WhatsApp real foi disparado.",
        });
      }

      // Notifica o corretor no WhatsApp oficial (Template alerta_corretor) se configurado alertPhone
      if (claim.brokerage.alertPhone && claim.brokerage.whatsappPhoneNumberId && claim.brokerage.whatsappAccessTokenEncrypted) {
        const token = decryptSensitive(claim.brokerage.whatsappAccessTokenEncrypted);
        if (token) {
          const alertPhone = claim.brokerage.alertPhone;
          const phoneNumberId = claim.brokerage.whatsappPhoneNumberId;
          const panelUrl = `${env.PUBLIC_BASE_URL || "https://creativealways.com.br/seguroflow/painel"}`;
          const summary = `${claim.incidentType}${claim.incidentLocation ? ` em ${claim.incidentLocation}` : ""}: ${claim.description.slice(0, 80)}`;

          try {
            const components = [
              {
                type: "body" as const,
                parameters: [
                  { type: "text" as const, text: "Sinistro Aberto (IA)" },
                  { type: "text" as const, text: claim.insured.name },
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
            console.warn("[Agent Tools] Template alerta_corretor falhou para alertPhone. Verificando janela 24h...", templateErr);
            const inWindow = await isWithinCustomer24hWindow(brokerageId, alertPhone);
            if (inWindow) {
              const alertMsg = `🚨 *ALERTA DE SINISTRO - SeguroFlow*\n\nSegurado: *${claim.insured.name}*\nTipo: *${claim.incidentType}*\nSeguradora: *${claim.policy.insurerName}*\nTelefone: ${claim.insured.phone}\nRelato: ${claim.description}\n\nAcesse: ${panelUrl}`;
              await sendWhatsAppTextMessage(alertPhone, alertMsg, phoneNumberId, token).catch(() => {});
            } else {
              console.warn(`[Agent Tools] Celular de alerta (${alertPhone}) fora da janela de 24h. Texto livre bloqueado.`);
            }
          }
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
      // 1. Se contato autorizado sem permissão financeira (ex: motorista) -> Bloqueia!
      if (caller.type === "AUTHORIZED_CONTACT" && !caller.canBilling) {
        return JSON.stringify({
          sucesso: false,
          bloqueadoPermissao: true,
          mensagem: `Você está identificado como ${caller.role}. Por políticas de segurança e privacidade, informações financeiras, cobranças e boletos são restritos ao titular ou setor financeiro da empresa. Favor solicitar ao gestor responsável.`,
        });
      }

      // 2. Telefone desconhecido
      if (caller.type === "UNKNOWN") {
        return JSON.stringify({
          sucesso: false,
          bloqueadoPermissao: true,
          mensagem: "Telefone não reconhecido para registro financeiro. Favor contatar diretamente a corretora.",
        });
      }

      const targetInsuredId = caller.insured?.id || insuredId;

      const installment = await prisma.installment.findFirst({
        where: {
          brokerageId,
          ...(args.installmentId
            ? { id: String(args.installmentId) }
            : targetInsuredId
            ? { policy: { insuredId: targetInsuredId }, status: { in: ["PENDING", "SENT_D7", "SENT_D0", "SENT_D2", "OVERDUE"] } }
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

      if (isSimulation && simulatedDispatches) {
        simulatedDispatches.push(`[Simulação] Registraria aviso de pagamento para a parcela ${installment?.installmentNumber || 1}`);
      }

      return JSON.stringify({
        sucesso: true,
        mensagem: "Aviso de pagamento registrado. A equipe da corretora foi informada para baixa com a seguradora.",
      });
    }

    case "solicitarAtendimentoHumano": {
      if (isSimulation) {
        if (simulatedDispatches) {
          simulatedDispatches.push(`[Simulação] Pausaria bot e transferiria para corretor humano (motivo: ${args.motivo || "Solicitado"})`);
        }
        return JSON.stringify({
          sucesso: true,
          isSimulation: true,
          mensagem: "[Simulação] Atendimento humano acionado com sucesso no simulador.",
        });
      }

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
