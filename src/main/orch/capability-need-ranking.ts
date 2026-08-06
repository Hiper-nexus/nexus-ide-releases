/**
 * Busca de capacidade por NECESSIDADE, ranqueada (paridade Overclock, gap f).
 *
 * Hoje `nexus_agent_list` e `nexus_skills_inventory` DESPEJAM o catálogo: quem
 * delega recebe tudo e escolhe lendo. Numa máquina com dezenas de agentes e
 * skills isso é o pior dos dois mundos — gasta o contexto do orquestrador e
 * ainda assim faz a escolha piorar, porque a lista longa dilui o candidato bom.
 *
 * O que muda: quem chama declara a NECESSIDADE em uma frase, e recebe os poucos
 * candidatos que a atendem, com a razão do casamento. Sem necessidade
 * declarada, o comportamento antigo permanece — a lista inteira. Degradar por
 * tier, nunca errar: uma busca que não casa com nada devolve o catálogo com
 * `matched: false`, jamais um erro (D1).
 *
 * Módulo puro e sem IO: recebe candidatos, devolve ordem. Ranking é decisão de
 * produto e precisa ser testável sem catálogo de verdade no disco.
 */

export interface RankableCapability {
  readonly name: string;
  /** Descrição/prompt: onde o vocabulário da necessidade costuma estar. */
  readonly description?: string;
  /** Rótulos declarados (categoria, tags, tools) — sinal mais forte que prosa. */
  readonly labels?: readonly string[];
}

export interface RankedCapability<T extends RankableCapability> {
  readonly item: T;
  readonly score: number;
  /** Termos da necessidade que casaram — a razão, legível por humano. */
  readonly matchedTerms: readonly string[];
}

export interface CapabilityRanking<T extends RankableCapability> {
  readonly ranked: readonly RankedCapability<T>[];
  /**
   * `false` quando nada casou. Quem chama devolve o catálogo inteiro nesse
   * caso: busca sem resultado não pode ser pior que não ter buscado.
   */
  readonly matched: boolean;
}

/**
 * Palavras que aparecem em quase toda necessidade e em quase toda descrição.
 * Mantê-las faria todo candidato empatar em 1, que é o mesmo que não ranquear.
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'a', 'ao', 'aos', 'as', 'com', 'como', 'da', 'das', 'de', 'do', 'dos', 'e',
  'em', 'na', 'nas', 'no', 'nos', 'o', 'os', 'ou', 'para', 'por', 'que', 'se',
  'um', 'uma', 'and', 'for', 'from', 'in', 'of', 'on', 'or', 'that', 'the',
  'to', 'with', 'need', 'preciso', 'quero', 'agente', 'agent', 'skill',
]);

/** Termo curto demais é ruído (`ts`, `um`); 3 é o piso que preserva `api`, `git`. */
const MIN_TERM_LENGTH = 3;

/**
 * Rótulo vale mais que prosa: `category: security` é uma declaração; a mesma
 * palavra no meio de um parágrafo pode ser uma ressalva ("não faz security").
 */
const LABEL_WEIGHT = 3;
const NAME_WEIGHT = 4;
const DESCRIPTION_WEIGHT = 1;

export function extractNeedTerms(need: string): readonly string[] {
  const seen = new Set<string>();
  for (const raw of need.toLowerCase().split(/[^\p{L}\p{N}+#-]+/u)) {
    const term = raw.replace(/^[-+#]+|[-+#]+$/g, '');
    if (term.length < MIN_TERM_LENGTH) continue;
    if (STOP_WORDS.has(term)) continue;
    seen.add(term);
  }
  return Object.freeze([...seen]);
}

function scoreField(field: string, terms: readonly string[]): string[] {
  const haystack = field.toLowerCase();
  return terms.filter((term) => haystack.includes(term));
}

export function rankCapabilitiesByNeed<T extends RankableCapability>(
  candidates: readonly T[],
  need: string,
  limit: number,
): CapabilityRanking<T> {
  const terms = extractNeedTerms(need);
  if (terms.length === 0) {
    // Necessidade só de palavras vazias não é busca: devolver "nada casou"
    // faria o chamador achar que o catálogo está vazio.
    return Object.freeze({ ranked: [], matched: false });
  }

  const scored: RankedCapability<T>[] = [];
  for (const item of candidates) {
    const inName = scoreField(item.name, terms);
    const inLabels = scoreField((item.labels ?? []).join(' '), terms);
    const inDescription = scoreField(item.description ?? '', terms);
    const score =
      inName.length * NAME_WEIGHT +
      inLabels.length * LABEL_WEIGHT +
      inDescription.length * DESCRIPTION_WEIGHT;
    if (score === 0) continue;
    const matchedTerms = [...new Set([...inName, ...inLabels, ...inDescription])];
    scored.push(Object.freeze({ item, score, matchedTerms: Object.freeze(matchedTerms) }));
  }

  if (scored.length === 0) return Object.freeze({ ranked: [], matched: false });

  // Empate desfeito pelo nome: ordem estável importa mais aqui do que qualquer
  // critério esperto — o orquestrador relê a lista entre turnos.
  scored.sort((a, b) =>
    b.score !== a.score ? b.score - a.score : a.item.name.localeCompare(b.item.name),
  );
  return Object.freeze({
    ranked: Object.freeze(scored.slice(0, Math.max(1, limit))),
    matched: true,
  });
}
