import { test, describe } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { encryptSensitive, decryptSensitive } from "../security/crypto";
import { verifyTenantWhatsAppSignature } from "../services/whatsappCloud";

describe("SeguroFlow — Regras de Negócio e Segurança", () => {
  test("Criptografia AES-256-GCM cifra e decifra tokens da Meta com autenticação", () => {
    const rawMetaToken = "EAAGm0PX4ZBBOwBZC9X7vZCPx7qK8...";
    const encrypted = encryptSensitive(rawMetaToken);

    assert.notEqual(encrypted, rawMetaToken);
    assert.match(encrypted, /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);

    const decrypted = decryptSensitive(encrypted);
    assert.equal(decrypted, rawMetaToken);

    // Teste de adulteração (tampering)
    const tampered = encrypted.slice(0, -2) + "ff";
    const failedDecryption = decryptSensitive(tampered);
    assert.equal(failedDecryption, null);
  });

  test("Validação de Webhook X-Hub-Signature-256 por App Secret do Tenant", () => {
    const tenantAppSecret = "secret_corretora_abc123";
    const rawPayload = Buffer.from(JSON.stringify({ object: "whatsapp_business_account", entry: [] }));

    // Gera assinatura válida HMAC-SHA256
    const validHash = crypto.createHmac("sha256", tenantAppSecret).update(rawPayload).digest("hex");
    const signatureHeader = `sha256=${validHash}`;

    const isValid = verifyTenantWhatsAppSignature(rawPayload, signatureHeader, tenantAppSecret);
    assert.equal(isValid, true);

    // Assinatura com secret incorreto (outro cliente) deve falhar
    const isWrongSecretValid = verifyTenantWhatsAppSignature(rawPayload, signatureHeader, "outro_secret_errado");
    assert.equal(isWrongSecretValid, false);

    // Assinatura adulterada deve falhar
    const isTamperedValid = verifyTenantWhatsAppSignature(rawPayload, `sha256=1234567890abcdef`, tenantAppSecret);
    assert.equal(isTamperedValid, false);
  });

  test("Cálculo de SLA no Funil de Vendas", () => {
    const now = Date.now();
    const slaHours = 24;

    // Card criado há 10 horas -> Dentro do SLA
    const entry10hAgo = new Date(now - 10 * 60 * 60 * 1000);
    const hoursElapsed10 = (now - entry10hAgo.getTime()) / (1000 * 60 * 60);
    assert.equal(hoursElapsed10 > slaHours, false);

    // Card criado há 30 horas -> Estourou SLA
    const entry30hAgo = new Date(now - 30 * 60 * 60 * 1000);
    const hoursElapsed30 = (now - entry30hAgo.getTime()) / (1000 * 60 * 60);
    assert.equal(hoursElapsed30 > slaHours, true);
  });
});
