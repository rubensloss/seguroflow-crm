import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../config/prisma";
import { requireAuth, requireRoles } from "../security/auth";
import { encryptSensitive, decryptSensitive } from "../security/crypto";
import { testWhatsAppConnection } from "../services/whatsappCloud";
import { recordAuditLog } from "../services/auditLog";
import { OFFICIAL_INSURERS } from "../services/insurerDirectory";

export const brokeragesRouter = Router();

const metaConfigSchema = z.object({
  whatsappPhoneNumberId: z.string().min(1, "Phone Number ID é obrigatório"),
  whatsappBusinessAccountId: z.string().optional(),
  whatsappAccessToken: z.string().min(1, "Access Token Permanente é obrigatório"),
  whatsappAppSecret: z.string().min(1, "App Secret é obrigatório"),
  whatsappVerifyToken: z.string().min(1, "Verify Token é obrigatório"),
  alertPhone: z.string().optional(),
  agentTone: z.string().optional(),
  agentEnabled: z.boolean().optional(),
});

// Obtém configurações da corretora autenticada
brokeragesRouter.get("/settings", requireAuth, async (req: Request, res: Response) => {
  const brokerage = await prisma.brokerage.findUnique({
    where: { id: req.user!.brokerageId },
  });

  if (!brokerage) {
    res.status(404).json({ error: "Corretora não encontrada" });
    return;
  }

  res.json({
    id: brokerage.id,
    name: brokerage.name,
    slug: brokerage.slug,
    cnpj: brokerage.cnpj,
    phone: brokerage.phone,
    email: brokerage.email,
    whatsappPhoneNumberId: brokerage.whatsappPhoneNumberId,
    whatsappBusinessAccountId: brokerage.whatsappBusinessAccountId,
    whatsappVerifyToken: brokerage.whatsappVerifyToken,
    hasAccessToken: Boolean(brokerage.whatsappAccessTokenEncrypted),
    hasAppSecret: Boolean(brokerage.whatsappAppSecretEncrypted),
    alertPhone: brokerage.alertPhone,
    agentTone: brokerage.agentTone,
    agentEnabled: brokerage.agentEnabled,
  });
});

// Salva credenciais da Meta WhatsApp Cloud API (OWNER ou BROKER)
brokeragesRouter.put("/settings/whatsapp", requireAuth, requireRoles(["OWNER", "BROKER"]), async (req: Request, res: Response) => {
  const data = metaConfigSchema.parse(req.body);

  const encryptedToken = encryptSensitive(data.whatsappAccessToken);
  const encryptedSecret = encryptSensitive(data.whatsappAppSecret);

  const updated = await prisma.brokerage.update({
    where: { id: req.user!.brokerageId },
    data: {
      whatsappPhoneNumberId: data.whatsappPhoneNumberId,
      whatsappBusinessAccountId: data.whatsappBusinessAccountId,
      whatsappAccessTokenEncrypted: encryptedToken,
      whatsappAppSecretEncrypted: encryptedSecret,
      whatsappVerifyToken: data.whatsappVerifyToken,
      alertPhone: data.alertPhone,
      agentTone: data.agentTone,
      agentEnabled: data.agentEnabled ?? true,
    },
  });

  await recordAuditLog({
    brokerageId: updated.id,
    userId: req.user!.userId,
    action: "UPDATE_META_CREDENTIALS",
    resource: `Brokerage:${updated.id}`,
    req,
  });

  res.json({
    success: true,
    message: "Credenciais da Meta WhatsApp salvas com sucesso (criptografadas via AES-256-GCM).",
  });
});

// Testa conexão com a Meta Cloud API usando as credenciais salvas ou enviadas
brokeragesRouter.post("/settings/whatsapp/test", requireAuth, async (req: Request, res: Response) => {
  const brokerage = await prisma.brokerage.findUnique({
    where: { id: req.user!.brokerageId },
  });

  if (!brokerage) {
    res.status(404).json({ error: "Corretora não encontrada" });
    return;
  }

  let phoneNumberId = req.body.whatsappPhoneNumberId || brokerage.whatsappPhoneNumberId;
  let token = req.body.whatsappAccessToken;

  if (!token && brokerage.whatsappAccessTokenEncrypted) {
    token = decryptSensitive(brokerage.whatsappAccessTokenEncrypted);
  }

  if (!phoneNumberId || !token) {
    res.status(400).json({ error: "Phone Number ID e Token Permanente são necessários para testar." });
    return;
  }

  const result = await testWhatsAppConnection(phoneNumberId, token);
  res.json(result);
});

// Obtém lista de seguradoras com sugestões oficiais e números confirmados pela corretora
brokeragesRouter.get("/settings/insurers", requireAuth, async (req: Request, res: Response) => {
  const brokerage = await prisma.brokerage.findUnique({
    where: { id: req.user!.brokerageId },
    select: { confirmedInsurers: true, phone: true },
  });

  res.json({
    suggestions: OFFICIAL_INSURERS,
    confirmedInsurers: brokerage?.confirmedInsurers || {},
    brokerageFallbackPhone: brokerage?.phone || null,
  });
});

// Atualiza tabela de seguradoras confirmadas da corretora
brokeragesRouter.put("/settings/insurers", requireAuth, requireRoles(["OWNER", "BROKER"]), async (req: Request, res: Response) => {
  const { confirmedInsurers } = req.body;

  if (typeof confirmedInsurers !== "object" || confirmedInsurers === null) {
    res.status(400).json({ error: "Formato inválido para confirmedInsurers" });
    return;
  }

  await prisma.brokerage.update({
    where: { id: req.user!.brokerageId },
    data: {
      confirmedInsurers: JSON.parse(JSON.stringify(confirmedInsurers)),
    },
  });

  await recordAuditLog({
    brokerageId: req.user!.brokerageId,
    userId: req.user!.userId,
    action: "UPDATE_CONFIRMED_INSURERS",
    resource: `Brokerage:${req.user!.brokerageId}`,
    details: { confirmedInsurers },
    req,
  });

  res.json({
    success: true,
    message: "Tabela de seguradoras e assistência 24h confirmada com sucesso.",
  });
});

// Configurações de Telefonia Oficial da Corretora
brokeragesRouter.get("/settings/telephony", requireAuth, async (req: Request, res: Response) => {
  const brokerage = await prisma.brokerage.findUnique({
    where: { id: req.user!.brokerageId },
    select: {
      telephonyProvider: true,
      telephonyNumber: true,
      telephonyForwardPhone: true,
      telephonyQueue: true,
      telephonyRecordingNotice: true,
      telephonyAccountSidEncrypted: true,
      telephonyAuthTokenEncrypted: true,
    },
  });

  res.json({
    telephonyProvider: brokerage?.telephonyProvider || "TWILIO",
    telephonyNumber: brokerage?.telephonyNumber || "",
    telephonyForwardPhone: brokerage?.telephonyForwardPhone || "",
    telephonyQueue: brokerage?.telephonyQueue || [],
    telephonyRecordingNotice: brokerage?.telephonyRecordingNotice || "Esta ligação é gravada para agilizar o seu atendimento.",
    hasAccountSid: Boolean(brokerage?.telephonyAccountSidEncrypted),
    hasAuthToken: Boolean(brokerage?.telephonyAuthTokenEncrypted),
  });
});

// Atualiza credenciais de Telefonia da Corretora
brokeragesRouter.put("/settings/telephony", requireAuth, requireRoles(["OWNER", "BROKER"]), async (req: Request, res: Response) => {
  const {
    telephonyProvider,
    telephonyNumber,
    telephonyForwardPhone,
    telephonyQueue,
    telephonyAccountSid,
    telephonyAuthToken,
    telephonyRecordingNotice,
  } = req.body;

  const dataToUpdate: any = {
    telephonyProvider: telephonyProvider || "TWILIO",
    telephonyNumber,
    telephonyForwardPhone,
    telephonyRecordingNotice: telephonyRecordingNotice || "Esta ligação é gravada para agilizar o seu atendimento.",
  };

  if (telephonyQueue !== undefined) {
    dataToUpdate.telephonyQueue = Array.isArray(telephonyQueue) ? telephonyQueue : null;
  }

  if (telephonyAccountSid) {
    dataToUpdate.telephonyAccountSidEncrypted = encryptSensitive(telephonyAccountSid);
  }
  if (telephonyAuthToken) {
    dataToUpdate.telephonyAuthTokenEncrypted = encryptSensitive(telephonyAuthToken);
  }

  await prisma.brokerage.update({
    where: { id: req.user!.brokerageId },
    data: dataToUpdate,
  });

  await recordAuditLog({
    brokerageId: req.user!.brokerageId,
    userId: req.user!.userId,
    action: "UPDATE_TELEPHONY_CREDENTIALS",
    resource: `Brokerage:${req.user!.brokerageId}`,
    req,
  });

  res.json({
    success: true,
    message: "Configurações de telefonia salvas com sucesso (criptografadas via AES-256-GCM).",
  });
});

// Listagem oficial completa dos 9 modelos de mensagem Meta com consulta na Graph API
brokeragesRouter.get("/settings/templates", requireAuth, async (req: Request, res: Response) => {
  const brokerage = await prisma.brokerage.findUnique({
    where: { id: req.user!.brokerageId },
  });

  const SYSTEM_TEMPLATES = [
    {
      name: "auth_otp_code",
      category: "AUTHENTICATION",
      description: "Envio de código OTP para acesso ao Portal do Segurado e Sinistro Online.",
      trigger: "Login com código de uso único (LGPD)",
      variables: [
        { index: 1, name: "Código de Verificação", example: "492018" },
      ],
      suggestedText: "{{1}} é seu código de verificação para acesso seguro ao Portal do Cliente. Válido por 10 minutos. Não compartilhe com ninguém.",
    },
    {
      name: "cobranca_d7",
      category: "UTILITY",
      description: "Aviso preventivo amigável 7 dias antes do vencimento da parcela.",
      trigger: "Régua D-7 (Automática diária às 09h BRT)",
      variables: [
        { index: 1, name: "Nome do Segurado", example: "Carlos Silva" },
        { index: 2, name: "Seguradora", example: "Porto Seguro" },
        { index: 3, name: "Data de Vencimento", example: "15/10/2026" },
        { index: 4, name: "Valor da Parcela", example: "R$ 380,00" },
        { index: 5, name: "Código Pix / Linha Digitável", example: "00020126580014br.gov.bcb.pix..." },
      ],
      suggestedText: "Olá, {{1}}! Lembramos que sua parcela da {{2}} no valor de {{4}} vence em 7 dias ({{3}}). Chave/Pix para pagamento direto à seguradora: {{5}}",
    },
    {
      name: "cobranca_d0",
      category: "UTILITY",
      description: "Lembrete no dia exato do vencimento da parcela.",
      trigger: "Régua D-0 (Automática diária às 09h BRT)",
      variables: [
        { index: 1, name: "Nome do Segurado", example: "Carlos Silva" },
        { index: 2, name: "Seguradora", example: "Porto Seguro" },
        { index: 3, name: "Data de Vencimento", example: "08/10/2026" },
        { index: 4, name: "Valor da Parcela", example: "R$ 380,00" },
        { index: 5, name: "Código Pix / Linha Digitável", example: "00020126580014br.gov.bcb.pix..." },
      ],
      suggestedText: "Olá, {{1}}! Sua parcela da {{2}} ({{4}}) vence hoje ({{3}}). Segue a chave Pix/código oficial para garantir a vigência ininterrupta do seu seguro: {{5}}",
    },
    {
      name: "cobranca_d2",
      category: "UTILITY",
      description: "Alerta preventivo 2 dias após vencimento sem confirmação de baixa.",
      trigger: "Régua D+2 (Automática diária às 09h BRT)",
      variables: [
        { index: 1, name: "Nome do Segurado", example: "Carlos Silva" },
        { index: 2, name: "Seguradora", example: "Porto Seguro" },
        { index: 3, name: "Data de Vencimento", example: "06/10/2026" },
        { index: 4, name: "Valor da Parcela", example: "R$ 380,00" },
        { index: 5, name: "Código Pix / 2ª Via", example: "00020126580014br.gov.bcb.pix..." },
      ],
      suggestedText: "Aviso amigável: {{1}}, não identificamos a baixa da parcela de {{4}} da {{2}} vencida em {{3}}. Caso já tenha pago, desconsidere. Segue 2ª via/Pix atualizado: {{5}}",
    },
    {
      name: "renovacao_60d",
      category: "UTILITY",
      description: "Abertura do ciclo de renovação 60 dias antes do vencimento da apólice.",
      trigger: "Motor de Renovações (D-60 diário)",
      variables: [
        { index: 1, name: "Nome do Segurado", example: "Mariana Souza" },
        { index: 2, name: "Seguradora", example: "Allianz" },
        { index: 3, name: "Dias Restantes", example: "60" },
        { index: 4, name: "Data de Término da Vigência", example: "06/12/2026" },
      ],
      suggestedText: "Olá, {{1}}! Sua apólice da {{2}} vencerá em {{3}} dias ({{4}}). Já iniciamos a busca das melhores condições no mercado para sua renovação.",
    },
    {
      name: "renovacao_30d",
      category: "UTILITY",
      description: "Apresentação e estudo de propostas de renovação 30 dias antes do vencimento.",
      trigger: "Motor de Renovações (D-30 diário)",
      variables: [
        { index: 1, name: "Nome do Segurado", example: "Mariana Souza" },
        { index: 2, name: "Seguradora", example: "Allianz" },
        { index: 3, name: "Dias Restantes", example: "30" },
        { index: 4, name: "Data de Término da Vigência", example: "06/11/2026" },
      ],
      suggestedText: "Olá, {{1}}! Sua apólice de seguro da {{2}} vencerá em {{3}} dias ({{4}}). Nossos consultores já prepararam as propostas comparativas para sua escolha.",
    },
    {
      name: "renovacao_15d",
      category: "UTILITY",
      description: "Alerta prioritário a 15 dias do encerramento da vigência para evitar sinistro sem cobertura.",
      trigger: "Motor de Renovações (D-15 diário)",
      variables: [
        { index: 1, name: "Nome do Segurado", example: "Mariana Souza" },
        { index: 2, name: "Seguradora", example: "Allianz" },
        { index: 3, name: "Dias Restantes", example: "15" },
        { index: 4, name: "Data de Término da Vigência", example: "22/10/2026" },
      ],
      suggestedText: "Atenção {{1}}: Sua apólice da {{2}} encerra em apenas {{3}} dias ({{4}}). Confirme sua renovação hoje para manter suas coberturas e bônus intactos.",
    },
    {
      name: "sinistro_status_update",
      category: "UTILITY",
      description: "Atualização automática de status da regulação de sinistro.",
      trigger: "Mudança de Fase do Sinistro no Painel",
      variables: [
        { index: 1, name: "Nome do Segurado", example: "Rodrigo Lima" },
        { index: 2, name: "Novo Status Traduzido", example: "Documentos Enviados à Seguradora" },
        { index: 3, name: "Seguradora", example: "Bradesco Seguros" },
        { index: 4, name: "Número da Apólice", example: "AP-2026-99182" },
      ],
      suggestedText: "Olá, {{1}}! Informamos que o seu sinistro da apólice {{4}} ({{3}}) teve uma atualização: {{2}}. Nossa equipe segue acompanhando todo o processo para você.",
    },
    {
      name: "ligacao_perdida",
      category: "UTILITY",
      description: "Retorno automático imediato quando o segurado liga e a equipe está ocupada.",
      trigger: "Chamada Telefônica Não Atendida / Fila Esgotada",
      variables: [
        { index: 1, name: "Nome da Corretora", example: "SeguroFlow Prime" },
        { index: 2, name: "Telefone de Assistência 24h ou Plantão", example: "0800 727 0800" },
      ],
      suggestedText: "Olá! Identificamos que você acabou de ligar para a {{1}}. Nossa equipe já registrou seu contato e retornará em breve. Em caso de emergência ou guincho 24h, ligue: {{2}}",
    },
    {
      name: "alerta_corretor",
      category: "UTILITY",
      description: "Aviso interno prioritário para o celular de plantão/alerta do corretor sobre sinistros e chamadas perdidas.",
      trigger: "Abertura de Sinistro (Portal/IA) ou Ligação Telefônica Perdida",
      variables: [
        { index: 1, name: "Tipo do Alerta", example: "Sinistro Aberto" },
        { index: 2, name: "Nome do Segurado / Contato", example: "Carlos Silva" },
        { index: 3, name: "Resumo da Ocorrência", example: "Colisão com guincho solicitado na Av. Vitória" },
        { index: 4, name: "Link do Painel", example: "https://creativealways.com.br/seguroflow/painel" },
      ],
      suggestedText: "⚠️ Alerta Corretora: {{1}} registrado para {{2}}. Resumo: {{3}}. Acesse o painel para gerenciar o atendimento: {{4}}",
    },
  ];

  let metaTemplatesMap: Record<string, { status: string; id?: string }> = {};
  let metaConnected = false;
  let metaError: string | null = null;

  if (brokerage?.whatsappBusinessAccountId && brokerage?.whatsappAccessTokenEncrypted) {
    try {
      const token = decryptSensitive(brokerage.whatsappAccessTokenEncrypted);
      if (token) {
        const metaRes = await fetch(
          `https://graph.facebook.com/v21.0/${brokerage.whatsappBusinessAccountId}/message_templates?limit=100`,
          {
            headers: { Authorization: `Bearer ${token}` },
          }
        );
        if (metaRes.ok) {
          metaConnected = true;
          const metaData = (await metaRes.json()) as { data?: Array<{ name: string; status: string; id?: string }> };
          if (Array.isArray(metaData.data)) {
            for (const t of metaData.data) {
              metaTemplatesMap[t.name.toLowerCase()] = {
                status: t.status,
                id: t.id,
              };
            }
          }
        } else {
          const errBody = await metaRes.text();
          metaError = `Erro da Meta API (${metaRes.status}): ${errBody.slice(0, 120)}`;
        }
      }
    } catch (err: unknown) {
      metaError = err instanceof Error ? err.message : String(err);
      console.warn("[Meta Templates Fetch Error]:", err);
    }
  }

  const templatesWithStatus = SYSTEM_TEMPLATES.map((tmpl) => {
    const metaInfo = metaTemplatesMap[tmpl.name.toLowerCase()];
    let metaStatus = "NOT_CONFIGURED";
    if (metaConnected) {
      metaStatus = metaInfo ? metaInfo.status : "PENDING_CREATION";
    }
    return {
      ...tmpl,
      metaStatus,
      metaId: metaInfo?.id || null,
    };
  });

  res.json({
    templates: templatesWithStatus,
    metaConnected,
    metaError,
    wabaId: brokerage?.whatsappBusinessAccountId || null,
  });
});
