/**
 * Diretório de Sugestão de Assistência 24h e Sinistros das Seguradoras no Brasil.
 * Serve como base de SUGESTÃO para as corretoras no painel de configurações.
 * REGRA ESTRITA: Nenhum número daqui é exibido diretamente ao segurado a menos que
 * a corretora o confirme expressamente em seu painel (confirmedInsurers).
 */

export interface InsurerInfo {
  name: string;
  aliases: string[];
  assistance24hPhone: string;
  whatsappPhone?: string;
  website: string;
  verifiedAt: string;
  sourceUrl: string;
  status: "SUGGESTION_PENDING_BROKERAGE_CONFIRMATION";
}

export const OFFICIAL_INSURERS: InsurerInfo[] = [
  {
    name: "Porto Seguro",
    aliases: ["porto", "porto seguro", "porto seguros"],
    assistance24hPhone: "0800 727 0800",
    whatsappPhone: "551130039303",
    website: "https://www.portoseguro.com.br",
    verifiedAt: "2026-10-06",
    sourceUrl: "https://www.portoseguro.com.br/central-de-ajuda/telefones",
    status: "SUGGESTION_PENDING_BROKERAGE_CONFIRMATION",
  },
  {
    name: "Azul Seguros",
    aliases: ["azul", "azul seguros"],
    assistance24hPhone: "0800 703 0203",
    whatsappPhone: "551130032985",
    website: "https://www.azulseguros.com.br",
    verifiedAt: "2026-10-06",
    sourceUrl: "https://www.azulseguros.com.br/telefones-uteis",
    status: "SUGGESTION_PENDING_BROKERAGE_CONFIRMATION",
  },
  {
    name: "Bradesco Seguros",
    aliases: ["bradesco", "bradesco auto", "bradesco seguros"],
    assistance24hPhone: "0800 701 2757",
    whatsappPhone: "551140042757",
    website: "https://www.bradescoseguros.com.br",
    verifiedAt: "2026-10-06",
    sourceUrl: "https://www.bradescoseguros.com.br/clientes/atendimento",
    status: "SUGGESTION_PENDING_BROKERAGE_CONFIRMATION",
  },
  {
    name: "Allianz Seguros",
    aliases: ["allianz", "allianz seguros"],
    assistance24hPhone: "0800 013 0700",
    whatsappPhone: "551140901110",
    website: "https://www.allianz.com.br",
    verifiedAt: "2026-10-06",
    sourceUrl: "https://www.allianz.com.br/fale-com-a-allianz",
    status: "SUGGESTION_PENDING_BROKERAGE_CONFIRMATION",
  },
  {
    name: "Tokio Marine",
    aliases: ["tokio", "tokio marine", "tokio marine seguradora"],
    assistance24hPhone: "0800 318 6546",
    whatsappPhone: "5511995786546",
    website: "https://www.tokiomarine.com.br",
    verifiedAt: "2026-10-06",
    sourceUrl: "https://www.tokiomarine.com.br/atendimento",
    status: "SUGGESTION_PENDING_BROKERAGE_CONFIRMATION",
  },
  {
    name: "HDI Seguros",
    aliases: ["hdi", "hdi seguros", "yelum"],
    assistance24hPhone: "0800 434 4340 / 3003-5390",
    whatsappPhone: "551140021661",
    website: "https://www.hdiseguros.com.br",
    verifiedAt: "2026-10-06",
    sourceUrl: "https://www.hdiseguros.com.br/contato/telefones-uteis",
    status: "SUGGESTION_PENDING_BROKERAGE_CONFIRMATION",
  },
  {
    name: "SulAmérica",
    aliases: ["sulamerica", "sul américa", "sulamérica seguros"],
    assistance24hPhone: "4090-1012 / 0800 777 1012 (Auto Allianz) / 0800 725 0505 (Saúde/Vida)",
    whatsappPhone: "551130049740",
    website: "https://www.sulamerica.com.br",
    verifiedAt: "2026-10-06",
    sourceUrl: "https://www.sulamerica.com.br/canais-de-atendimento",
    status: "SUGGESTION_PENDING_BROKERAGE_CONFIRMATION",
  },
  {
    name: "Mapfre Seguros",
    aliases: ["mapfre", "mapfre seguros"],
    assistance24hPhone: "0800 775 4545",
    whatsappPhone: "551140040101",
    website: "https://www.mapfre.com.br",
    verifiedAt: "2026-10-06",
    sourceUrl: "https://www.mapfre.com.br/fale-conosco",
    status: "SUGGESTION_PENDING_BROKERAGE_CONFIRMATION",
  },
  {
    name: "Sompo Seguros",
    aliases: ["sompo", "sompo seguros", "sompo transporte", "sompo cargas"],
    assistance24hPhone: "0800 771 9719",
    whatsappPhone: "551130040800",
    website: "https://www.sompo.com.br",
    verifiedAt: "2026-10-06",
    sourceUrl: "https://www.sompo.com.br/fale-conosco",
    status: "SUGGESTION_PENDING_BROKERAGE_CONFIRMATION",
  },
  {
    name: "Zurich Seguros",
    aliases: ["zurich", "zurich seguros"],
    assistance24hPhone: "0800 729 1400",
    whatsappPhone: "551128902123",
    website: "https://www.zurich.com.br",
    verifiedAt: "2026-10-06",
    sourceUrl: "https://www.zurich.com.br/atendimento",
    status: "SUGGESTION_PENDING_BROKERAGE_CONFIRMATION",
  },
  {
    name: "Suhai Seguradora",
    aliases: ["suhai", "suhai seguradora"],
    assistance24hPhone: "0800 327 8424",
    whatsappPhone: "551130030335",
    website: "https://suhaiseguradora.com",
    verifiedAt: "2026-10-06",
    sourceUrl: "https://suhaiseguradora.com/contato",
    status: "SUGGESTION_PENDING_BROKERAGE_CONFIRMATION",
  },
  {
    name: "Liberty Seguros",
    aliases: ["liberty", "liberty seguros", "yelum"],
    assistance24hPhone: "0800 701 4120",
    whatsappPhone: "551132656200",
    website: "https://www.libertyseguros.com.br",
    verifiedAt: "2026-10-06",
    sourceUrl: "https://www.libertyseguros.com.br/atendimento",
    status: "SUGGESTION_PENDING_BROKERAGE_CONFIRMATION",
  },
];

/**
 * Obtém o telefone de assistência 24h para o segurado.
 * REGRA ESTRITA DE PRODUÇÃO (Rodada 6):
 * 1. Número cadastrado na apólice do segurado (se existir).
 * 2. Tabela de seguradoras confirmada expressamente pela corretora (confirmedInsurersMap).
 * 3. Fallback estrito: NUNCA exibe número de seguradora não confirmado pelo corretor.
 *    Retorna contato direto com a corretora.
 * 4. A lista padrão (OFFICIAL_INSURERS) é APENAS sugestão no painel para o corretor conferir.
 */
export function resolveAssistance24hPhone(
  policyAssistancePhone?: string | null,
  insurerName?: string | null,
  brokeragePhone?: string | null,
  confirmedInsurersMap?: Record<string, string> | null
): string {
  // 1. Número da apólice
  if (policyAssistancePhone && policyAssistancePhone.trim().length > 0) {
    return policyAssistancePhone.trim();
  }

  // 2. Confirmação expressa da corretora no painel
  if (insurerName && confirmedInsurersMap) {
    const cleanInsurer = insurerName.toLowerCase().trim();
    for (const [key, phone] of Object.entries(confirmedInsurersMap)) {
      if (cleanInsurer.includes(key.toLowerCase()) && phone && phone.trim().length > 0) {
        return phone.trim();
      }
    }
  }

  // 3. Fallback estrito: NUNCA inventa nem usa número não confirmado pela corretora
  if (brokeragePhone && brokeragePhone.trim().length > 0) {
    return `Ligue para a sua corretora: ${brokeragePhone.trim()}`;
  }

  return "Consulte sua corretora para acionar a assistência 24h";
}
