/**
 * Session/handoff compaction — grok-build compaction idea, lightweight.
 * Shrink long agent text for kickoff / memory without an LLM call.
 */
export interface CompactTextOptions {
  maxChars: number;
  keepHead?: number;
  keepTail?: number;
}

/**
 * Keep head + tail of long text with an omission marker (no LLM).
 */
export function compactText(
  text: string,
  options: CompactTextOptions,
): { text: string; omitted: boolean } {
  const max = Math.max(80, options.maxChars);
  if (text.length <= max) return { text, omitted: false };
  const head = options.keepHead ?? Math.floor(max * 0.55);
  const tail = options.keepTail ?? Math.floor(max * 0.3);
  const marker = '\n…[compacted]…\n';
  const budget = max - marker.length;
  const h = Math.min(head, Math.floor(budget * 0.65));
  const t = Math.min(tail, budget - h);
  return {
    text: `${text.slice(0, h)}${marker}${text.slice(-t)}`,
    omitted: true,
  };
}

/**
 * Compact an array of handoff summaries for mission kickoff memory.
 */
export function compactHandoffSummaries(
  summaries: readonly string[],
  maxTotalChars: number,
): string {
  if (summaries.length === 0) return '';
  const per = Math.max(120, Math.floor(maxTotalChars / summaries.length));
  const parts = summaries.map((s, i) => {
    const c = compactText(s.trim(), { maxChars: per });
    return `${i + 1}. ${c.text}`;
  });
  let joined = parts.join('\n');
  if (joined.length > maxTotalChars) {
    joined = compactText(joined, { maxChars: maxTotalChars }).text;
  }
  return joined;
}
