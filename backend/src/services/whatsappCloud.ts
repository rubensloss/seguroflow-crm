import crypto from "crypto";
import { env } from "../config/env";

const GRAPH_BASE = `https://graph.facebook.com/${env.WHATSAPP_GRAPH_API_VERSION}`;

/**
 * Valida a assinatura X-Hub-Signature-256 usando o App Secret ESPECÍFICO do cliente/corretora
 * Conforme Regra 0.1 da Especificação: Não pode haver um único app secret global.
 */
export function verifyTenantWhatsAppSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  appSecret: string
): boolean {
  if (!signatureHeader || !appSecret) return false;

  const [algo, providedHex] = signatureHeader.split("=");
  if (algo !== "sha256" || !providedHex) return false;

  const expectedHex = crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const expected = Buffer.from(expectedHex, "hex");
  const provided = Buffer.from(providedHex, "hex");

  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(expected, provided);
}

/**
 * Envia mensagem de texto via WhatsApp Cloud API oficial da corretora
 */
export async function sendWhatsAppTextMessage(
  to: string,
  text: string,
  phoneNumberId: string,
  accessToken: string
): Promise<string | null> {
  const url = `${GRAPH_BASE}/${phoneNumberId}/messages`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: cleanPhoneNumber(to),
      type: "text",
      text: { body: text, preview_url: false },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Falha no envio WhatsApp Cloud (${response.status}): ${errorBody}`);
  }

  const data = (await response.json()) as { messages?: { id?: string }[] };
  return data.messages?.[0]?.id ?? null;
}

export interface TemplateComponent {
  type: "header" | "body" | "button";
  sub_type?: "quick_reply" | "url";
  index?: string | number;
  parameters: Array<{
    type: "text" | "currency" | "date_time" | "image" | "document";
    text?: string;
    document?: { link: string; filename: string };
    image?: { link: string };
  }>;
}

/**
 * Envia mensagem baseada em TEMPLATE oficial aprovado pela Meta
 * Essencial para cobrança preventiva (D-7, D-0, D+2) e avisos de renovação fora da janela de 24h
 */
export async function sendWhatsAppTemplateMessage(
  to: string,
  templateName: string,
  languageCode = "pt_BR",
  components: TemplateComponent[] = [],
  phoneNumberId: string,
  accessToken: string
): Promise<string | null> {
  const url = `${GRAPH_BASE}/${phoneNumberId}/messages`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: cleanPhoneNumber(to),
      type: "template",
      template: {
        name: templateName,
        language: { code: languageCode },
        components,
      },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Falha no envio de Template WhatsApp Cloud (${response.status}): ${errorBody}`);
  }

  const data = (await response.json()) as { messages?: { id?: string }[] };
  return data.messages?.[0]?.id ?? null;
}

/**
 * Faz download do buffer de mídia (foto de sinistro, áudio, PDF) da Meta Graph API
 */
export async function downloadWhatsAppMedia(
  mediaId: string,
  accessToken: string
): Promise<{ buffer: Buffer; mimeType: string }> {
  // 1. Obtém o download URL a partir do mediaId
  const metaUrl = `${GRAPH_BASE}/${mediaId}`;
  const metaRes = await fetch(metaUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!metaRes.ok) {
    throw new Error(`Falha ao obter metadados da mídia WhatsApp: ${metaRes.status}`);
  }

  const metaData = (await metaRes.json()) as { url: string; mime_type: string };
  const downloadUrl = metaData.url;

  // 2. Faz o download do arquivo binário
  const mediaRes = await fetch(downloadUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!mediaRes.ok) {
    throw new Error(`Falha no download binário da mídia WhatsApp: ${mediaRes.status}`);
  }

  const arrayBuffer = await mediaRes.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType: metaData.mime_type,
  };
}

/**
 * Testa a conexão com as credenciais da Meta do cliente
 */
export async function testWhatsAppConnection(
  phoneNumberId: string,
  accessToken: string
): Promise<{ success: boolean; displayPhoneNumber?: string; verifiedName?: string; error?: string }> {
  try {
    const url = `${GRAPH_BASE}/${phoneNumberId}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      const errText = await response.text();
      return { success: false, error: `Erro da Meta API (${response.status}): ${errText}` };
    }

    const data = (await response.json()) as {
      display_phone_number?: string;
      verified_name?: string;
    };

    return {
      success: true,
      displayPhoneNumber: data.display_phone_number,
      verifiedName: data.verified_name,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

function cleanPhoneNumber(phone: string): string {
  return phone.replace(/\D/g, "");
}
