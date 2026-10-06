import Anthropic from "@anthropic-ai/sdk";
import { DocumentType } from "@prisma/client";
import { env } from "../config/env";

function getAnthropicClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY;
  return apiKey ? new Anthropic({ apiKey }) : null;
}

export interface ExtractedInstallment {
  installmentNumber: number;
  dueDate: string; // YYYY-MM-DD
  amount: number;
  paymentMethod?: string; // BOLETO, PIX, DEBITO, CARTAO
  paymentCode?: string;
}

export interface ExtractedDocumentData {
  documentType: DocumentType;
  confidence: number;
  data: Record<string, any>;
  installments?: ExtractedInstallment[];
  multicalculoCsvRow: string;
}

/**
 * Analisa uma imagem ou PDF de documento (CNH, CRLV, Apólice ou Proposta)
 * e extrai campos limpos + cronograma completo de parcelas via IA Multimodal.
 */
export async function extractDocumentWithAi(
  fileBuffer: Buffer,
  mimeType: string,
  docTypeHint?: DocumentType
): Promise<ExtractedDocumentData> {
  const base64 = fileBuffer.toString("base64");
  const anthropic = getAnthropicClient();

  if (!anthropic) {
    console.warn("[Document OCR] Sem ANTHROPIC_API_KEY — leitura de documento rejeitada sem inventar dados");
    throw new Error("Não foi possível ler o documento. Chave de inteligência artificial não configurada. Tente de novo ou preencha manualmente.");
  }

  const prompt = `Você é um perito em extração de documentos securitários e propostas comerciais no Brasil.
Analise a imagem deste documento (${docTypeHint || "identifique se é CNH, CRLV ou Apólice/Proposta de Seguro"}) e extraia TODOS os campos com máxima precisão.

ATENÇÃO RIGOROSA:
- Extraia ESTRITAMENTE o que estiver legível no documento. NUNCA invente ou estime dados ausentes.
- Se algum campo estiver ilegível ou ausente, deixe-o como string vazia ou nulo.
- Se for APÓLICE OU PROPOSTA: extraia a grade de pagamento com cada parcela legível (número, vencimento no formato YYYY-MM-DD, valor numérico e forma de pagamento).

Responda ESTRITAMENTE em formato JSON com esta estrutura:
{
  "documentType": "CNH" | "CRLV" | "APOLICE",
  "confidence": 0.95,
  "data": {
    // Se CNH: "nome", "cpf", "rg", "dataNascimento", "numeroRegistro", "categoria", "validade"
    // Se CRLV: "placa", "renavam", "chassi", "marcaModelo", "anoFabricacao", "anoModelo", "cor", "combustivel", "proprietario", "cpfCnpj"
    // Se APOLICE/PROPOSTA: "seguradora", "numeroApolice", "segurado", "cpf", "telefone", "vigenciaInicio", "vigenciaFim", "premioTotal", "franquia", "assistencia24h", "ramo"
  },
  "installments": [
    // Se APOLICE/PROPOSTA:
    // { "installmentNumber": 1, "dueDate": "2026-11-10", "amount": 862.50, "paymentMethod": "BOLETO", "paymentCode": "..." }
  ],
  "multicalculoCsvRow": "Valores separados por vírgula no formato padrão para colar em multicálculos"
}`;

  const mediaType = mimeType.startsWith("image/")
    ? (mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp")
    : "image/jpeg";

  try {
    const message = await anthropic.messages.create({
      model: env.ANTHROPIC_MODEL,
      max_tokens: 2000,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mediaType,
                data: base64,
              },
            },
            {
              type: "text",
              text: prompt,
            },
          ],
        },
      ],
    });

    const textResponse = message.content[0].type === "text" ? message.content[0].text : "";
    const cleanJson = textResponse.replace(/```json/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(cleanJson) as ExtractedDocumentData;
    return parsed;
  } catch (err) {
    console.error("Erro na extração de documento com IA:", err);
    throw new Error("Não foi possível ler o documento. Tente de novo ou preencha manualmente.");
  }
}
