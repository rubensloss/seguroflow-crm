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

  test("Resolução de Assistência 24h sem fallback incorreto de outra seguradora", () => {
    const { resolveAssistance24hPhone } = require("../services/insurerDirectory");

    // 1. Apólice com assistência cadastrada explicitamente
    assert.equal(resolveAssistance24hPhone("0800 111 2222", "Allianz", "552799998888"), "0800 111 2222");

    // 2. Apólice sem assistência cadastrada, mas de seguradora reconhecida (Allianz)
    assert.equal(resolveAssistance24hPhone(null, "Allianz Seguros", "552799998888"), "0800 013 0700");

    // 3. Porto Seguro reconhecida
    assert.equal(resolveAssistance24hPhone("", "Porto Seguro", "552799998888"), "0800 727 0800");

    // 4. Seguradora desconhecida/não cadastrada: JAMAIS retorna número da Porto! Retorna fallback da corretora
    const fallbackResult = resolveAssistance24hPhone(null, "Seguradora Regional XPTO", "(27) 98814-0076");
    assert.equal(fallbackResult, "Ligue para a sua corretora: (27) 98814-0076");
    assert.notEqual(fallbackResult.includes("0800 727 0800"), true);
  });

  test("Geração e validação de código OTP com token de desafio seguro (LGPD)", () => {
    const {
      generateOtpCode,
      createOtpChallengeToken,
      verifyOtpChallengeToken,
    } = require("../services/otpService");

    const otp = generateOtpCode(6);
    assert.match(otp, /^\d{6}$/);

    const token = createOtpChallengeToken({
      brokerageId: "brk_test_1",
      insuredId: "ins_test_1",
      target: "5527999998888",
      scope: "CLIENT_PORTAL_AUTH",
      otp,
    });

    // Código correto deve validar e decodificar com sucesso
    const decoded = verifyOtpChallengeToken(token, otp, "CLIENT_PORTAL_AUTH");
    assert.equal(decoded.brokerageId, "brk_test_1");
    assert.equal(decoded.insuredId, "ins_test_1");

    // Código incorreto deve lançar erro
    assert.throws(() => {
      verifyOtpChallengeToken(token, "000000", "CLIENT_PORTAL_AUTH");
    }, /Código de verificação incorreto/);

    // Escopo diferente deve falhar
    assert.throws(() => {
      verifyOtpChallengeToken(token, otp, "CLAIM_INTAKE_VERIFY");
    }, /Escopo de autenticação inválido/);
  });

  test("Cálculo de Data e Hora estritamente no fuso America/Sao_Paulo (Evita disparo às 21h UTC)", () => {
    const { getSaoPauloDateAndHour } = require("../services/scheduler");

    // Simula 21:00 em Brasília = 00:00 UTC do dia seguinte
    const utcMidnightDate = new Date("2026-10-15T00:30:00.000Z");
    const sp = getSaoPauloDateAndHour(utcMidnightDate);

    // Em Brasília (UTC-3), 00:30 UTC do dia 15 ainda é 21:30 do dia 14!
    assert.equal(sp.dateStr, "2026-10-14");
    assert.equal(sp.hour, 21);
    assert.equal(sp.minute, 30);

    // O scheduler exige hour === 9, logo 21h NUNCA dispara!
    assert.notEqual(sp.hour, 9);
  });

  test("Limitador de taxa (Rate Limiter) bloqueia após limite de tentativas", () => {
    const { checkRateLimit } = require("../security/rateLimit");
    const testKey = `test_rate_limit_${Date.now()}`;

    // 3 tentativas permitidas em 1 minuto
    assert.equal(checkRateLimit(testKey, 3, 60000).allowed, true);
    assert.equal(checkRateLimit(testKey, 3, 60000).allowed, true);
    assert.equal(checkRateLimit(testKey, 3, 60000).allowed, true);

    // 4ª tentativa deve ser bloqueada
    const fourth = checkRateLimit(testKey, 3, 60000);
    assert.equal(fourth.allowed, false);
    assert.equal(fourth.remaining, 0);
  });

  test("Leitura de Documentos (OCR) rejeita sem chave de IA e NUNCA inventa dados fictícios", async () => {
    const { extractDocumentWithAi } = require("../services/documentOcr");

    // Sem chave configurada, deve lançar erro explícito em vez de devolver Carlos Eduardo/Maria Fernanda
    await assert.rejects(
      async () => {
        await extractDocumentWithAi(Buffer.from("dummy-image-content"), "image/jpeg", "CNH");
      },
      /Não foi possível ler o documento/
    );
  });

  test("Validação de assinatura do Webhook de Telefonia Oficial (Twilio HMAC-SHA1)", () => {
    const { validateTwilioWebhookSignature } = require("../services/telephony");
    const authToken = "auth_token_corretora_xyz987";
    const url = "https://backend-production-a35b.up.railway.app/api/telephony/prime-seguros/webhook";
    const params: Record<string, string> = {
      CallSid: "CA123456789",
      From: "+5527999887766",
      To: "+552730001234",
    };

    // Gera assinatura válida
    const sortedKeys = Object.keys(params).sort();
    let data = url;
    for (const key of sortedKeys) {
      data += `${key}${params[key]}`;
    }
    const hmac = crypto.createHmac("sha1", authToken).update(data, "utf-8");
    const validSignature = hmac.digest("base64");

    // 1. Assinatura válida deve ser aceita
    assert.equal(validateTwilioWebhookSignature(authToken, url, params, validSignature), true);

    // 2. Assinatura inválida/forjada deve ser rejeitada
    assert.equal(validateTwilioWebhookSignature(authToken, url, params, "invalid_signature_base64"), false);

    // 3. Token de outra corretora deve ser rejeitado
    assert.equal(validateTwilioWebhookSignature("outro_auth_token", url, params, validSignature), false);
  });

  test("Transcrição e extração de chamada sem placa gera campo vazio (null), nunca inventado", async () => {
    const { extractCallIntelligence } = require("../services/telephony");

    // Conversa onde o cliente NÃO mencionou a placa do carro
    const conversation = "Olá, meu carro quebrou no meio da pista aqui na Enseada do Suá. Preciso de um guincho urgente porque está travando o trânsito.";
    const result = await extractCallIntelligence(conversation);

    // Regra estrita: NUNCA inventar placa
    assert.equal(result.plate, null);
    assert.equal(result.policyNumber, null);
  });

  test("Estimativa de custo de ligação calcula de forma transparente por duração", () => {
    const { estimateCallCost } = require("../services/telephony");

    // Ligação de 60 segundos (1 minuto)
    const cost1Min = estimateCallCost(60);
    assert.ok(cost1Min > 0.40 && cost1Min < 0.60, `Custo esperado para 1 min ~R$ 0.46, obtido: ${cost1Min}`);

    // Ligação de 3 minutos
    const cost3Min = estimateCallCost(180);
    assert.ok(cost3Min > cost1Min, "Custo de 3 min deve ser maior que 1 min");
  });

  test("Resolução de assistência 24h prioriza mapa customizado da corretora", () => {
    const { resolveAssistance24hPhone } = require("../services/insurerDirectory");

    const customBrokerageMap = {
      "Allianz": "0800 999 8888 (Central VIP)",
    };

    // Deve retornar o número personalizado confirmado pela corretora
    const customResult = resolveAssistance24hPhone(null, "Allianz", "552799998888", customBrokerageMap);
    assert.equal(customResult, "0800 999 8888 (Central VIP)");
  });
});

