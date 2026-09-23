/**
 * Briefing por ponteiro (paridade Overclock OVKA-750 / anti-T-013).
 *
 * O dossier do trabalho mora no registro (card/task file); o `prompt`/`text`
 * do spawn/write deve ser UMA linha apontando. Texto longo que re-explica o
 * card custa 80–91% mais tokens de output (medido no Overclock) e ainda
 * dessincroniza o que o executor leu do que o registro diz.
 *
 * Aqui só AVISAMOS (soft): nunca recusamos o spawn. Devolve o ponteiro de uma
 * linha sugerido para o chamador refazer o brief se quiser.
 */

export interface BriefingWarning {
  readonly kind: 'briefing_pointer';
  readonly chars: number;
  readonly refs: readonly string[];
  readonly hint: string;
}

/** Acima disto um brief que cita card/task file merece o aviso. */
export const BRIEFING_POINTER_MIN_CHARS = 300;

const REF_PATTERNS: readonly RegExp[] = [
  /\bOVKA-\d+\b/g,
  /\bC-\d{2,3}\b/g,
  /\bF-\d{2,3}\b/g,
  /TASK\/items\/[\w./-]+/g,
];

export function extractBriefingRefs(text: string): string[] {
  const found = new Set<string>();
  for (const re of REF_PATTERNS) {
    for (const match of text.matchAll(re)) {
      found.add(match[0]);
    }
  }
  return [...found];
}

/**
 * Devolve o aviso quando o texto é longo E cita card/task; caso contrário,
 * `null` (o caminho comum — brief curto ou sem referência — é silencioso).
 */
export function briefingPointerWarning(
  text: string | undefined | null,
  minLength = BRIEFING_POINTER_MIN_CHARS,
): BriefingWarning | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed.length < minLength) return null;
  const refs = extractBriefingRefs(trimmed);
  if (refs.length === 0) return null;
  const primary = refs[0];
  return {
    kind: 'briefing_pointer',
    chars: trimmed.length,
    refs: refs.slice(0, 5),
    hint:
      `briefing longo (${trimmed.length} chars) com referência ${primary}: ` +
      'prefira UMA linha apontando o registro (ex. `' +
      primary +
      '`) em vez de re-explicar o card no prompt — o executor lê o dossier no registro.',
  };
}

export function formatBriefingWarning(warning: BriefingWarning): string {
  return `[briefing] ${warning.hint}`;
}
