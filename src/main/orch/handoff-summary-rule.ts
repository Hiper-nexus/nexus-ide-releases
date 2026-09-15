/**
 * Régua do `summary` de handoff (paridade Overclock 1.3.23, handoff_submit):
 * "1–2 sentences (≤280 chars)… >400 chars is auto-condensed (original →
 * fullText)".
 *
 * O summary é o que o orquestrador LÊ colado no PTY dele; a íntegra vai para o
 * registro (`overclock.fullText`, lida por nexus_handoff_list). Acima de 400
 * caracteres, corta na ÚLTIMA fronteira de frase entre 280 e 400 — nunca no
 * meio de uma palavra — e, sem fronteira nessa janela, corta seco em 400 com
 * reticência. O marcador `[compacted]` é mantido por compatibilidade com quem
 * já o procura no texto.
 *
 * Decisão deliberada: NÃO recusa summaries acima de 1500 (como o Overclock
 * faz). A identidade de replay do Nexus é o payload cru, e recusar quebraria
 * workers em campo por um limite que a condensação já neutraliza.
 */

export const HANDOFF_SUMMARY_IDEAL_CHARS = 280;
export const HANDOFF_SUMMARY_CONDENSE_FROM_CHARS = 400;
export const HANDOFF_FULLTEXT_CAP_CHARS = 60_000;
export const HANDOFF_SUMMARY_COMPACTED_MARK = '[compacted]';

export interface CondensedHandoffSummary {
  readonly summary: string;
  readonly condensed: boolean;
  /** Texto original completo quando houve condensação. */
  readonly original?: string;
}

const SENTENCE_END = /[.!?…](?=\s|$)|\n/g;

function lastSentenceBoundary(
  text: string,
  minEnd: number,
  maxEnd: number,
): number | null {
  let best: number | null = null;
  for (const match of text.matchAll(SENTENCE_END)) {
    const end = match.index + match[0].length;
    if (end < minEnd) continue;
    if (end > maxEnd) break;
    best = end;
  }
  return best;
}

export function condenseHandoffSummary(text: string): CondensedHandoffSummary {
  const trimmed = text.trim();
  if (trimmed.length <= HANDOFF_SUMMARY_CONDENSE_FROM_CHARS) {
    return { summary: trimmed, condensed: false };
  }
  const boundary = lastSentenceBoundary(
    trimmed,
    HANDOFF_SUMMARY_IDEAL_CHARS,
    HANDOFF_SUMMARY_CONDENSE_FROM_CHARS,
  );
  const head =
    boundary !== null
      ? trimmed.slice(0, boundary).trim()
      : `${trimmed.slice(0, HANDOFF_SUMMARY_CONDENSE_FROM_CHARS - 1).trimEnd()}…`;
  return {
    summary: `${head} ${HANDOFF_SUMMARY_COMPACTED_MARK}`,
    condensed: true,
    original: trimmed,
  };
}

/** Íntegra registrada como artifact: mesmo teto do `fullText` declarado. */
export function capHandoffFullText(text: string): string {
  return text.length > HANDOFF_FULLTEXT_CAP_CHARS
    ? `${text.slice(0, HANDOFF_FULLTEXT_CAP_CHARS)}\n[...]`
    : text;
}
