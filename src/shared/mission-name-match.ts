/**
 * Resolve "abre a missão <nome>" (voz) contra a lista de missões salvas.
 *
 * Função pura, sem dependências: o renderer a usa para decidir se há UMA missão
 * óbvia, se a fala é ambígua (e então pergunta) ou se nada casa. O que ela NÃO
 * faz é escolher em silêncio:
 *
 * - nenhum título casa → `none` (nunca "a primeira da lista" como consolo);
 * - mais de um título casa → `ambiguous`, com os candidatos em ordem;
 * - só há resposta `unique` quando UM título é igual ao que foi dito, ou quando
 *   ele é o único que casa de qualquer forma.
 *
 * Alvo vazio (a pessoa só disse "abre a missão") mantém o comportamento
 * antigo: a primeira da lista, que o Main entrega da mais recente para a mais
 * antiga.
 */

/** Teto de candidatos devolvidos numa ambiguidade (fala e Jev leem no máximo isto). */
export const MAX_AMBIGUOUS_MISSION_CANDIDATES = 5;

/** Por que um título entrou na disputa, do mais forte para o mais fraco. */
export type MissionMatchReason = 'exact' | 'prefix' | 'contains' | 'words';

export interface MissionMatchCandidate<T> {
  readonly mission: T;
  readonly reason: MissionMatchReason;
}

export type MissionNameResolution<T> =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'unique';
      readonly mission: T;
      /** `most-recent` = alvo vazio, nada foi comparado. */
      readonly reason: MissionMatchReason | 'most-recent';
    }
  | {
      readonly kind: 'ambiguous';
      /** Do motivo mais forte ao mais fraco; empate pela ordem da lista. */
      readonly candidates: readonly MissionMatchCandidate<T>[];
      /** Quantas missões casaram (pode passar do teto de `candidates`). */
      readonly total: number;
    };

const TIER_BY_REASON: Readonly<Record<MissionMatchReason, number>> = {
  exact: 4,
  prefix: 3,
  contains: 2,
  words: 1,
};

/** Abaixo disto o alvo só casa palavra inteira. */
const SHORT_TARGET_CHARS = 4;

/** Palavras de ligação que não distinguem uma missão de outra. */
const FILLER_WORDS: ReadonlySet<string> = new Set([
  'a', 'o', 'as', 'os', 'um', 'uma', 'de', 'da', 'do', 'das', 'dos', 'em',
  'na', 'no', 'nas', 'nos', 'e', 'para', 'pra', 'com', 'que',
  'missao', 'missoes',
]);

/** Minúsculas, sem acento nem pontuação, espaços colapsados. */
export function normalizeMissionName(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function meaningfulWords(normalized: string): string[] {
  return normalized
    .split(' ')
    .filter((word) => word.length > 0 && !FILLER_WORDS.has(word));
}

function matchReason(
  title: string,
  wanted: string,
  wantedWords: readonly string[],
): MissionMatchReason | null {
  if (title === wanted) return 'exact';
  // Alvo curto (< 4 letras) só casa palavra inteira: "da"/"pag" dentro de outra palavra é ruído.
  const wholeWord = wanted.length >= SHORT_TARGET_CHARS;
  if (wholeWord ? title.startsWith(wanted) : title.startsWith(`${wanted} `)) return 'prefix';
  if (wholeWord ? title.includes(wanted) : ` ${title} `.includes(` ${wanted} `)) return 'contains';
  if (wantedWords.length === 0) return null;
  const titleWords = new Set(meaningfulWords(title));
  return wantedWords.every((word) => titleWords.has(word)) ? 'words' : null;
}

/** Um único caractere casaria com quase tudo; só um dígito ainda é um nome. */
function isTooShortToMatch(wanted: string): boolean {
  if (wanted.length < 2 && !/\p{N}/u.test(wanted)) return true;
  // Só palavras de ligação ("da", "a missão"): não nomeia nenhuma missão.
  return wanted !== '' && meaningfulWords(wanted).length === 0;
}

/**
 * A fala é curta demais para ser um nome (um som solto, não uma missão). Quem
 * pede ajuda ao Jev quando nada casa usa isto para não gastar a consulta com ruído.
 */
export function isMissionNameNoise(wanted: string | undefined): boolean {
  return isTooShortToMatch(normalizeMissionName(wanted ?? ''));
}

export function resolveMissionByName<T extends { readonly title: string }>(
  wanted: string | undefined,
  missions: readonly T[],
): MissionNameResolution<T> {
  const first = missions[0];
  if (first === undefined) return { kind: 'none' };

  const target = normalizeMissionName(wanted ?? '');
  if (target === '') return { kind: 'unique', mission: first, reason: 'most-recent' };
  if (isTooShortToMatch(target)) return { kind: 'none' };

  const targetWords = meaningfulWords(target);
  const ranked = missions
    .map((mission, index) => ({
      mission,
      index,
      reason: matchReason(normalizeMissionName(mission.title), target, targetWords),
    }))
    .flatMap((entry) =>
      entry.reason === null
        ? []
        : [{ mission: entry.mission, index: entry.index, reason: entry.reason }],
    )
    .sort(
      (a, b) =>
        TIER_BY_REASON[b.reason] - TIER_BY_REASON[a.reason] || a.index - b.index,
    );

  if (ranked.length === 0) return { kind: 'none' };

  const exact = ranked.filter((entry) => entry.reason === 'exact');
  const [soleExact] = exact;
  if (exact.length === 1 && soleExact) {
    return { kind: 'unique', mission: soleExact.mission, reason: 'exact' };
  }
  const [sole] = ranked;
  if (ranked.length === 1 && sole) {
    return { kind: 'unique', mission: sole.mission, reason: sole.reason };
  }
  return {
    kind: 'ambiguous',
    total: ranked.length,
    candidates: ranked
      .slice(0, MAX_AMBIGUOUS_MISSION_CANDIDATES)
      .map(({ mission, reason }) => ({ mission, reason })),
  };
}
