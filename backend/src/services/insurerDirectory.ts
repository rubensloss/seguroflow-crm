/**
 * Diretório Oficial de Assistência 24h e Sinistros das Principais Seguradoras no Brasil.
 * Evita números genéricos ou errados em momentos de emergência/sinistro.
 */

export interface InsurerInfo {
  name: string;
  aliases: string[];
  assistance24hPhone: string;
  whatsappPhone?: string;
  website?: string;
}

export const OFFICIAL_INSURERS: InsurerInfo[] = [
  {
    name: "Porto Seguro",
    aliases: ["porto", "porto seguro", "porto seguros"],
    assistance24hPhone: "0800 727 0800",
    whatsappPhone: "551130039303",
    website: "https://www.portoseguro.com.br",
  },
  {
    name: "Azul Seguros",
    aliases: ["azul", "azul seguros"],
    assistance24hPhone: "0800 703 0203",
    whatsappPhone: "551130032985",
    website: "https://www.azulseguros.com.br",
  },
  {
    name: "Bradesco Seguros",
    aliases: ["bradesco", "bradesco auto", "bradesco seguros"],
    assistance24hPhone: "0800 701 2757",
    whatsappPhone: "551140042757",
    website: "https://www.bradescoseguros.com.br",
  },
  {
    name: "Allianz Seguros",
    aliases: ["allianz", "allianz seguros"],
    assistance24hPhone: "0800 013 0700",
    whatsappPhone: "551140901110",
    website: "https://www.allianz.com.br",
  },
  {
    name: "Tokio Marine",
    aliases: ["tokio", "tokio marine", "tokio marine seguradora"],
    assistance24hPhone: "0800 318 6546",
    whatsappPhone: "5511995786546",
    website: "https://www.tokiomarine.com.br",
  },
  {
    name: "HDI Seguros",
    aliases: ["hdi", "hdi seguros", "yelum"],
    assistance24hPhone: "0800 770 1608",
    whatsappPhone: "551140021661",
    website: "https://www.hdiseguros.com.br",
  },
  {
    name: "SulAmérica",
    aliases: ["sulamerica", "sul américa", "sulamérica seguros"],
    assistance24hPhone: "0800 725 0505",
    whatsappPhone: "551130049740",
    website: "https://www.sulamerica.com.br",
  },
  {
    name: "Mapfre Seguros",
    aliases: ["mapfre", "mapfre seguros"],
    assistance24hPhone: "0800 775 4545",
    whatsappPhone: "551140040101",
    website: "https://www.mapfre.com.br",
  },
  {
    name: "Sompo Seguros",
    aliases: ["sompo", "sompo seguros", "sompo transporte", "sompo cargas"],
    assistance24hPhone: "0800 771 9719",
    whatsappPhone: "551130040800",
    website: "https://www.sompo.com.br",
  },
  {
    name: "Zurich Seguros",
    aliases: ["zurich", "zurich seguros"],
    assistance24hPhone: "0800 729 1400",
    whatsappPhone: "551128902123",
    website: "https://www.zurich.com.br",
  },
  {
    name: "Suhai Seguradora",
    aliases: ["suhai", "suhai seguradora"],
    assistance24hPhone: "0800 327 8424",
    whatsappPhone: "551130030335",
    website: "https://suhaiseguradora.com",
  },
  {
    name: "Liberty Seguros",
    aliases: ["liberty", "liberty seguros"],
    assistance24hPhone: "0800 701 4120",
    whatsappPhone: "551132656200",
    website: "https://www.libertyseguros.com.br",
  },
];

/**
 * Obtém o telefone oficial de assistência 24h.
 * 1. Se a apólice possui assistência cadastrada, usa ela diretamente.
 * 2. Se a seguradora for reconhecida, utiliza o 0800 oficial verificado daquela seguradora.
 * 3. Se nenhuma das opções acima for satisfeita, NUNCA usa número padrão fixo de outra seguradora:
 *    retorna instrução de contato com a corretora do segurado.
 */
export function resolveAssistance24hPhone(
  policyAssistancePhone?: string | null,
  insurerName?: string | null,
  brokeragePhone?: string | null
): string {
  if (policyAssistancePhone && policyAssistancePhone.trim().length > 0) {
    return policyAssistancePhone.trim();
  }

  if (insurerName) {
    const cleanInsurer = insurerName.toLowerCase().trim();
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
