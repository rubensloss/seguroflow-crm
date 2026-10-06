import crypto from "crypto";
import { env } from "../config/env";

// Garante uma chave de exatamente 32 bytes (256 bits) usando SHA-256
const masterKey = crypto.createHash("sha256").update(env.ENCRYPTION_KEY).digest();

/**
 * Criptografa dados sensíveis (tokens de acesso Meta, app secrets) usando AES-256-GCM.
 * Retorna uma string no formato: iv_hex:auth_tag_hex:ciphertext_hex
 */
export function encryptSensitive(plainText: string): string {
  if (!plainText) return "";
  const iv = crypto.randomBytes(12); // Padrão recomendado de 96 bits para GCM
  const cipher = crypto.createCipheriv("aes-256-gcm", masterKey, iv);
  
  let encrypted = cipher.update(plainText, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag();

  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
}

/**
 * Descriptografa dados sensíveis usando AES-256-GCM.
 * Lança erro caso a tag de autenticação seja inválida (proteção contra adulteração).
 */
export function decryptSensitive(encryptedText: string | null | undefined): string | null {
  if (!encryptedText) return null;
  try {
    const parts = encryptedText.split(":");
    if (parts.length !== 3) return null;

    const [ivHex, authTagHex, cipherHex] = parts;
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");
    const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(cipherHex, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch (error) {
    console.error("Falha na descriptografia AES-256-GCM:", error);
    return null;
  }
}
