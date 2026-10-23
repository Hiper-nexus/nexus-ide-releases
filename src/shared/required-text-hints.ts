export interface RequiredTextHints {
  /** Every possible match must contain at least ONE of these literal strings. */
  readonly requiredTextHints?: readonly string[];
}

/** A negative hint check only removes annotated rows; unknown rows always run. */
export function compileTextPatternPrefilter<T extends RequiredTextHints>(
  patterns: readonly T[],
): (text: string) => readonly T[] {
  const fallback = patterns.filter(pattern => !pattern.requiredTextHints?.length);
  const hints = [...new Set(patterns.flatMap(pattern => pattern.requiredTextHints ?? []))];
  const escaped = hints.map(hint => hint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // Case folding may over-admit; the original regexp remains the only matcher.
  const union = escaped.length ? new RegExp(escaped.join('|'), 'iu') : null;
  return text => union?.test(text) ? patterns : fallback;
}
