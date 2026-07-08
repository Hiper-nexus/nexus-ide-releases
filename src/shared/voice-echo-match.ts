/** Normaliza texto para comparação de eco TTS (compartilhado main + renderer). */
export function normEcho(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const ECHO_MIN_CHARS = 6;
const WORD_OVERLAP_THRESHOLD = 0.8;

/** True quando a transcrição parece eco de texto falado recentemente pelo TTS. */
export function isLikelySpokenEcho(transcript: string, spokenText: string): boolean {
  const norm = normEcho(transcript);
  if (norm.length < ECHO_MIN_CHARS) return false;
  const window = normEcho(spokenText);
  if (!window || window.length < ECHO_MIN_CHARS) return false;
  if (window.includes(norm)) return true;
  const words = norm.split(' ').filter((w) => w.length > 2);
  if (words.length === 0) return false;
  const spoken = new Set(window.split(' '));
  const hits = words.filter((w) => spoken.has(w)).length;
  return hits / words.length >= WORD_OVERLAP_THRESHOLD;
}
