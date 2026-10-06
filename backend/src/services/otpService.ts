import crypto from "crypto";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { decryptSensitive } from "../security/crypto";
import { sendWhatsAppTextMessage, sendWhatsAppTemplateMessage } from "./whatsappCloud";

export interface OtpChallengePayload {
  insuredId?: string;
  brokerageId: string;
  policyId?: string;
  target: string; // Telefone ou CPF normalizado
  scope: "CLIENT_PORTAL_AUTH" | "CLAIM_INTAKE_VERIFY";
  otpHash: string;
}

/**
 * Gera código OTP numérico seguro de uso único
 */
export function generateOtpCode(length: number = 6): string {
  const min = Math.pow(10, length - 1);
  const max = Math.pow(10, length) - 1;
  return crypto.randomInt(min, max + 1).toString();
}

/**
 * Cria token de desafio assinado com validade de 10 minutos
 */
export function createOtpChallengeToken(data: {
  brokerageId: string;
  target: string;
  scope: "CLIENT_PORTAL_AUTH" | "CLAIM_INTAKE_VERIFY";
  otp: string;
  insuredId?: string;
  policyId?: string;
}): string {
  const otpHash = crypto
    .createHmac("sha256", env.JWT_SECRET)
    .update(data.otp.trim())
    .digest("hex");

  const payload: OtpChallengePayload = {
    brokerageId: data.brokerageId,
    target: data.target,
    scope: data.scope,
    otpHash,
    insuredId: data.insuredId,
    policyId: data.policyId,
  };

  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: "10m" });
}

/**
 * Valida o token de desafio e confere o código OTP digitado
 */
export function verifyOtpChallengeToken(
  token: string,
  enteredOtp: string,
  expectedScope: "CLIENT_PORTAL_AUTH" | "CLAIM_INTAKE_VERIFY"
): OtpChallengePayload {
  let decoded: OtpChallengePayload;
  try {
    decoded = jwt.verify(token, env.JWT_SECRET) as OtpChallengePayload;
  } catch (err) {
    throw new Error("Código ou sessão de verificação expirada. Solicite um novo código.");
  }

  if (decoded.scope !== expectedScope) {
    throw new Error("Escopo de autenticação inválido.");
  }

  const enteredHash = crypto
    .createHmac("sha256", env.JWT_SECRET)
    .update(String(enteredOtp).trim())
    .digest("hex");

  const bufExpected = Buffer.from(decoded.otpHash, "hex");
  const bufEntered = Buffer.from(enteredHash, "hex");

  if (bufExpected.length !== bufEntered.length || !crypto.timingSafeEqual(bufExpected, bufEntered)) {
    throw new Error("Código de verificação incorreto. Confira os números digitados.");
  }

  return decoded;
}

/**
 * Envia o código OTP via WhatsApp oficial Meta da corretora
 */
export async function sendOtpToWhatsApp(params: {
  brokerage: {
    name: string;
    whatsappPhoneNumberId?: string | null;
    whatsappAccessTokenEncrypted?: string | null;
  };
  phone: string;
  otp: string;
  actionDescription: string;
}): Promise<{ sent: boolean; channel: "WHATSAPP_CLOUD" | "WHATSAPP_TEMPLATE" | "DEV_LOG" }> {
  const { brokerage, phone, otp, actionDescription } = params;

  if (brokerage.whatsappPhoneNumberId && brokerage.whatsappAccessTokenEncrypted) {
    const phoneNumberId = brokerage.whatsappPhoneNumberId;
    try {
      const token = decryptSensitive(brokerage.whatsappAccessTokenEncrypted);
      if (token) {
        // Tenta enviar via template de autenticação se disponível
        try {
          await sendWhatsAppTemplateMessage(
            phone,
            "auth_otp_code",
            "pt_BR",
            [
              {
                type: "body",
                parameters: [{ type: "text", text: otp }],
              },
              {
                type: "button",
                sub_type: "url",
                index: 0,
                parameters: [{ type: "text", text: otp }],
              },
            ],
            phoneNumberId,
            token
          );
          return { sent: true, channel: "WHATSAPP_TEMPLATE" };
        } catch (tmplErr) {
          // Fallback: mensagem direta de texto
          const messageText = `🔐 *${brokerage.name} — Código de Segurança*\n\nSeu código de verificação para ${actionDescription} é:\n\n*${otp}*\n\nEste código expira em 10 minutos. Nunca compartilhe este código com terceiros.`;
          await sendWhatsAppTextMessage(phone, messageText, phoneNumberId, token);
          return { sent: true, channel: "WHATSAPP_CLOUD" };
        }
      }
    } catch (err) {
      console.error(`[OTP WhatsApp Error] Falha ao enviar para ${phone}:`, err);
    }
  }

  console.log(`[OTP Dev/Fallback] Código para ${phone} (${brokerage.name}): ${otp}`);
  return { sent: true, channel: "DEV_LOG" };
}
