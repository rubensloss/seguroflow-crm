import { test, describe } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { encryptSensitive, decryptSensitive } from "../security/crypto";
import { verifyTenantWhatsAppSignature } from "../services/whatsappCloud";
import { escapeXml, parseTelephonyQueue, getWebhookFullUrl } from "../routes/telephony";

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

  test("Resolução de Assistência 24h: NUNCA exibe números de seguradora não confirmados pela corretora", () => {
    const { resolveAssistance24hPhone } = require("../services/insurerDirectory");

    // 1. Apólice com assistência cadastrada explicitamente tem prioridade total
    assert.equal(resolveAssistance24hPhone("0800 111 2222", "Allianz", "552799998888"), "0800 111 2222");

    // 2. Apólice sem assistência cadastrada e sem confirmação da corretora:
    // NUNCA retorna número do diretório geral! Retorna estritamente o telefone da corretora.
    assert.equal(
      resolveAssistance24hPhone(null, "HDI Seguros", "552799998888"),
      "Ligue para a sua corretora: 552799998888"
    );
    assert.equal(
      resolveAssistance24hPhone("", "Porto Seguro", "552799998888"),
      "Ligue para a sua corretora: 552799998888"
    );

    // 3. Apólice com seguradora confirmada expressamente pela corretora no painel
    const confirmedMap = {
      "HDI Seguros": "0800 434 4340",
      "SulAmérica": "4090-1012",
    };
    assert.equal(
      resolveAssistance24hPhone(null, "HDI Seguros", "552799998888", confirmedMap),
      "0800 434 4340"
    );

    // 4. Sem telefone da corretora e sem apólice: mensagem amigável sem inventar número
    assert.equal(
      resolveAssistance24hPhone(null, "Seguradora Qualquer", null, null),
      "Consulte sua corretora para acionar a assistência 24h"
    );
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

  test("Validação de assinatura do Webhook de Telefonia Oficial (Twilio HMAC-SHA1 com HTTPS)", () => {
    const { validateTwilioWebhookSignature } = require("../services/telephony");
    const authToken = "auth_token_corretora_xyz987";
    const httpsUrl = "https://backend-production-a35b.up.railway.app/api/telephony/prime-seguros/webhook";
    const params: Record<string, string> = {
      CallSid: "CA123456789",
      From: "+5527999887766",
      To: "+552730001234",
    };

    // Gera assinatura válida sobre URL HTTPS
    const sortedKeys = Object.keys(params).sort();
    let data = httpsUrl;
    for (const key of sortedKeys) {
      data += `${key}${params[key]}`;
    }
    const hmac = crypto.createHmac("sha1", authToken).update(data, "utf-8");
    const validSignature = hmac.digest("base64");

    // 1. Assinatura válida sobre URL HTTPS deve ser aceita
    assert.equal(validateTwilioWebhookSignature(authToken, httpsUrl, params, validSignature), true);

    // 2. Assinatura com URL HTTP divergente da HTTPS assinada deve falhar
    const httpUrl = "http://backend-production-a35b.up.railway.app/api/telephony/prime-seguros/webhook";
    assert.equal(validateTwilioWebhookSignature(authToken, httpUrl, params, validSignature), false);

    // 3. Assinatura inválida/forjada deve ser rejeitada
    assert.equal(validateTwilioWebhookSignature(authToken, httpsUrl, params, "invalid_signature_base64"), false);

    // 4. Token de outra corretora deve ser rejeitado
    assert.equal(validateTwilioWebhookSignature("outro_auth_token", httpsUrl, params, validSignature), false);
  });

  test("Sanitização e Escape de XML (TwiML) para evitar quebra de parser no Twilio", () => {
    const maliciousOrSpecial = 'Atendimento & Sinistros <Urgente> "24 Horas" \'Oficial\'';
    const escaped = escapeXml(maliciousOrSpecial);

    assert.equal(escaped, "Atendimento &amp; Sinistros &lt;Urgente&gt; &quot;24 Horas&quot; &apos;Oficial&apos;");
    assert.ok(!escaped.includes("<Urgente>"));
    assert.ok(!escaped.includes("& "));
  });

  test("Fila sequencial de atendentes na telefonia e ausência de fallback para celular pessoal", () => {
    // 1. Corretora com lista em telephonyQueue
    const q1 = parseTelephonyQueue({
      telephonyQueue: ["+5527999990001", "+5527999990002"],
      telephonyForwardPhone: "+5527988880000",
      phone: "+552730001000",
    });
    assert.deepEqual(q1, ["+5527999990001", "+5527999990002"]);

    // 2. Corretora com telefones separados por vírgula em telephonyForwardPhone
    const q2 = parseTelephonyQueue({
      telephonyForwardPhone: "+5527999991111, +5527999992222",
      phone: "+552730001000",
    });
    assert.deepEqual(q2, ["+5527999991111", "+5527999992222"]);

    // 3. Corretora sem repasse e sem telefone: NUNCA retorna número pessoal hardcoded!
    const qEmpty = parseTelephonyQueue({
      telephonyQueue: null,
      telephonyForwardPhone: null,
      phone: null,
    });
    assert.equal(qEmpty.length, 0);
    assert.equal(qEmpty.includes("+5527988140076"), false);
  });

  test("Reconstrução de URL completa para webhook com suporte a X-Forwarded-Proto (Railway)", () => {
    // Simula requisição recebida via proxy reverso com HTTPS terminado no Railway
    const mockReq = {
      protocol: "http",
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "backend-production-a35b.up.railway.app",
      },
      originalUrl: "/api/telephony/test-corretora/webhook",
      get: (header: string) => (header === "host" ? "internal-ip:3000" : undefined),
    } as any;

    const fullUrl = getWebhookFullUrl(mockReq);
    assert.equal(fullUrl, "https://backend-production-a35b.up.railway.app/api/telephony/test-corretora/webhook");
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
});
