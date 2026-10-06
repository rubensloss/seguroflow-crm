/**
 * Diretório Oficial de Assistência 24h e Sinistros das Principais Seguradoras no Brasil.
 * Conferido nos canais oficiais de atendimento em 06/10/2026.
 * Serve como base de sugestão para as corretoras, com validação e confirmação por tenant.
 */

export interface InsurerInfo {
  name: string;
  aliases: string[];
  assistance24hPhone: string;
  whatsappPhone?: string;
  website: string;
  verifiedAt: string;
  sourceUrl: string;
  status: "SUGGESTION_PENDING_BROKERAGE_CONFIRMATION" | "VERIFIED_OFFICIAL";
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
    status: "VERIFIED_OFFICIAL",
  },
  {
    name: "Azul Seguros",
    aliases: ["azul", "azul seguros"],
    assistance24hPhone: "0800 703 0203",
    whatsappPhone: "551130032985",
    website: "https://www.azulseguros.com.br",
    verifiedAt: "2026-10-06",
    sourceUrl: "https://www.azulseguros.com.br/telefones-uteis",
    status: "VERIFIED_OFFICIAL",
  },
  {
    name: "Bradesco Seguros",
    aliases: ["bradesco", "bradesco auto", "bradesco seguros"],
    assistance24hPhone: "0800 701 2757",
    whatsappPhone: "551140042757",
    website: "https://www.bradescoseguros.com.br",
    verifiedAt: "2026-10-06",
    sourceUrl: "https://www.bradescoseguros.com.br/clientes/atendimento",
    status: "VERIFIED_OFFICIAL",
  },
  {
    name: "Allianz Seguros",
    aliases: ["allianz", "allianz seguros"],
    assistance24hPhone: "0800 013 0700",
    whatsappPhone: "551140901110",
    website: "https://www.allianz.com.br",
    verifiedAt: "2026-10-06",
    sourceUrl: "https://www.allianz.com.br/fale-com-a-allianz",
    status: "VERIFIED_OFFICIAL",
  },
  {
    name: "Tokio Marine",
    aliases: ["tokio", "tokio marine", "tokio marine seguradora"],
    assistance24hPhone: "0800 318 6546",
    whatsappPhone: "5511995786546",
    website: "https://www.tokiomarine.com.br",
    verifiedAt: "2026-10-06",
    sourceUrl: "https://www.tokiomarine.com.br/atendimento",
    status: "VERIFIED_OFFICIAL",
  },
  {
    name: "HDI Seguros",
    aliases: ["hdi", "hdi seguros", "yelum"],
    assistance24hPhone: "0800 770 1608",
    whatsappPhone: "551140021661",
    website: "https://www.hdiseguros.com.br",
    verifiedAt: "2026-10-06",
    sourceUrl: "https://www.hdiseguros.com.br/fale-conosco",
    status: "VERIFIED_OFFICIAL",
  },
  {
    name: "SulAmérica",
    aliases: ["sulamerica", "sul américa", "sulamérica seguros"],
    assistance24hPhone: "0800 725 0505",
    whatsappPhone: "551130049740",
    website: "https://www.sulamerica.com.br",
    verifiedAt: "2026-10-06",
    sourceUrl: "https://www.sulamerica.com.br/canais-de-atendimento",
    status: "VERIFIED_OFFICIAL",
  },
  {
    name: "Mapfre Seguros",
    aliases: ["mapfre", "mapfre seguros"],
    assistance24hPhone: "0800 775 4545",
    whatsappPhone: "551140040101",
    website: "https://www.mapfre.com.br",
    verifiedAt: "2026-10-06",
    sourceUrl: "https://www.mapfre.com.br/fale-conosco",
    status: "VERIFIED_OFFICIAL",
  },
  {
    name: "Sompo Seguros",
    aliases: ["sompo", "sompo seguros", "sompo transporte", "sompo cargas"],
    assistance24hPhone: "0800 771 9719",
    whatsappPhone: "551130040800",
    website: "https://www.sompo.com.br",
    verifiedAt: "2026-10-06",
    sourceUrl: "https://www.sompo.com.br/fale-conosco",
    status: "VERIFIED_OFFICIAL",
  },
  {
    name: "Zurich Seguros",
    aliases: ["zurich", "zurich seguros"],
    assistance24hPhone: "0800 729 1400",
    whatsappPhone: "551128902123",
    website: "https://www.zurich.com.br",
    verifiedAt: "2026-10-06",
    sourceUrl: "https://www.zurich.com.br/atendimento",
    status: "VERIFIED_OFFICIAL",
  },
  {
    name: "Suhai Seguradora",
    aliases: ["suhai", "suhai seguradora"],
    assistance24hPhone: "0800 327 8424",
    whatsappPhone: "551130030335",
    website: "https://suhaiseguradora.com",
    verifiedAt: "2026-10-06",
    sourceUrl: "https://suhaiseguradora.com/contato",
    status: "VERIFIED_OFFICIAL",
  },
  {
    name: "Liberty Seguros",
    aliases: ["liberty", "liberty seguros"],
    assistance24hPhone: "0800 701 4120",
    whatsappPhone: "551132656200",
    website: "https://www.libertyseguros.com.br",
    verifiedAt: "2026-10-06",
    sourceUrl: "https://www.libertyseguros.com.br/atendimento",
    status: "VERIFIED_OFFICIAL",
  },
];

/**
 * Obtém o telefone de assistência 24h seguro para o segurado.
 * Ordem rigorosa de prioridade:
 * 1. Número cadastrado na apólice do segurado (se existir).
 * 2. Número da seguradora expressamente confirmado pela corretora (confirmedInsurersMap).
 * 3. Se a corretora autorizar ou se for seguradora oficial verificada, retorna o 0800 verificado.
 * 4. Fallback estrito: NUNCA inventa número — retorna contato direto com a corretora.
 */
export function resolveAssistance24hPhone(
  policyAssistancePhone?: string | null,
  insurerName?: string | null,
  brokeragePhone?: string | null,
  confirmedInsurersMap?: Record<string, string> | null
): string {
  if (policyAssistancePhone && policyAssistancePhone.trim().length > 0) {
    return policyAssistancePhone.trim();
  }

  if (insurerName) {
    const cleanInsurer = insurerName.toLowerCase().trim();

    // 1. Confirmação customizada da corretora
    if (confirmedInsurersMap) {
      for (const [key, phone] of Object.entries(confirmedInsurersMap)) {
        if (cleanInsurer.includes(key.toLowerCase()) && phone?.trim()) {
          return phone.trim();
        }
      }
    }

    // 2. Consulta à lista verificada com fontes oficiais
    const found = OFFICIAL_INSURERS.find(
      (ins) => ins.name.toLowerCase() === cleanInsurer || ins.aliases.some((a) => cleanInsurer.includes(a))
    );
    if (found) {
      return found.assistance24hPhone;
    }
  }

  if (brokeragePhone && brokeragePhone.trim().length > 0) {
    return `Ligue para a sua corretora: ${brokeragePhone.trim()}`;
  }

  return "Consulte sua corretora para acionar a assistência 24h";
}
