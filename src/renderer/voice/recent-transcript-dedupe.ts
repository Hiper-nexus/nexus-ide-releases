export const RECENT_TRANSCRIPT_DUPLICATE_MS = 4_000;

export interface RecentTranscript {
  readonly text: string;
  readonly at: number;
}

function normalizedTokens(text: string): string[] {
  return text
    .toLocaleLowerCase('pt-BR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function overlapRatio(left: readonly string[], right: readonly string[]): number {
  const leftCounts = new Map<string, number>();
  for (const token of left) leftCounts.set(token, (leftCounts.get(token) ?? 0) + 1);
  let overlap = 0;
  for (const token of right) {
    const available = leftCounts.get(token) ?? 0;
    if (available === 0) continue;
    overlap += 1;
    leftCounts.set(token, available - 1);
  }
  return overlap / Math.min(left.length, right.length);
}

/**
 * Passive STT and the realtime provider can finalize the same room utterance.
 * Keep the gate conservative: a single-word reply (notably "sim") is never
 * deduped, and fuzzy matches require at least three words with 80% overlap.
 */
export function isRecentDuplicateTranscript(
  candidate: string,
  recent: RecentTranscript | null,
  now = Date.now(),
  windowMs = RECENT_TRANSCRIPT_DUPLICATE_MS,
): boolean {
  if (!recent || now < recent.at || now - recent.at > windowMs) return false;
  const candidateTokens = normalizedTokens(candidate);
  const recentTokens = normalizedTokens(recent.text);
  const shortest = Math.min(candidateTokens.length, recentTokens.length);
  if (shortest < 2) return false;
  if (candidateTokens.join(' ') === recentTokens.join(' ')) return true;
  if (shortest < 3) return false;
  return overlapRatio(candidateTokens, recentTokens) >= 0.8;
}
