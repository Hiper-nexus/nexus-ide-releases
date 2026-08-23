/**
 * Qual referência de design combina com o pedido — decidido pelo Nexus.
 *
 * Antes o prompt dizia "consulte o que combinar com o pedido" e apontava a
 * pasta: escolher virava trabalho da LLM, que precisava listar o catálogo e
 * abrir arquivos para descobrir o que era relevante. Isso é caro em tokens e
 * não determinístico — a mesma classe do `open` delegado que fez a landing
 * não abrir.
 *
 * Aqui a escolha é mecânica: casa o objetivo contra o NOME e o título de cada
 * `.md` do catálogo. Empate ou nenhuma pista devolve null e o prompt volta a
 * apontar a pasta — nunca inventa uma referência.
 */

/** Palavras que não distinguem nada e só produzem falso casamento. */
const STOPWORDS = new Set([
  'a', 'as', 'o', 'os', 'de', 'da', 'do', 'das', 'dos', 'e', 'em', 'no', 'na',
  'nos', 'nas', 'um', 'uma', 'uns', 'umas', 'para', 'pra', 'por', 'com', 'sem',
  'que', 'meu', 'minha', 'seu', 'sua', 'the', 'of', 'and', 'for', 'to', 'in',
  'crie', 'criar', 'faca', 'fazer', 'quero', 'preciso', 'pagina', 'page',
  'site', 'tela', 'design', 'style', 'estilo', 'md', 'readme', 'index',
]);

function tokens(value: string): Set<string> {
  return new Set(
    value
      .normalize('NFD')
      .replace(/[̀-ͯ]/gu, '')
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter((token) => token.length >= 3 && !STOPWORDS.has(token)),
  );
}

export interface DesignReferenceCandidate {
  /** Nome do arquivo, ex.: "pink-city.md". */
  readonly fileName: string;
  /** Primeira linha de título do arquivo, quando houver. */
  readonly title?: string;
}

export interface DesignReferencePick {
  readonly fileName: string;
  readonly score: number;
}

/**
 * Escolhe a referência de maior sobreposição com o objetivo.
 * Devolve null quando nada casa ou quando duas empatam no topo — ambiguidade
 * é motivo para NÃO decidir por conta própria.
 */
export function pickDesignReference(
  objective: string,
  candidates: readonly DesignReferenceCandidate[],
): DesignReferencePick | null {
  const wanted = tokens(objective);
  if (wanted.size === 0) return null;

  const scored = candidates
    .map((candidate) => {
      const own = tokens(
        `${candidate.fileName.replace(/\.mdx?$/iu, '')} ${candidate.title ?? ''}`,
      );
      let score = 0;
      for (const token of own) if (wanted.has(token)) score += 1;
      return { fileName: candidate.fileName, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);

  if (scored.length === 0) return null;
  const best = scored[0]!;
  const runnerUp = scored[1];
  if (runnerUp && runnerUp.score === best.score) return null;
  return best;
}
