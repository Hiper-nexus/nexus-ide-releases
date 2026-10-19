import type { TimedWord } from './captions';

/**
 * Script ↔ recognized speech alignment (F-1602, study §5.3 step 10).
 *
 * When the person records the narration, a recognizer gives the TIME of each
 * word but gets names wrong ("Clôde" for Claude, "Nexus Cide" for NexusIDE,
 * "Nexus e de ponto app" for nexuside.app). The script has the right spelling.
 * This is a global sequence alignment (dynamic programming) between the script
 * words and the recognized words, where one script word may take up to 6
 * recognized words and one recognized word may cover up to 4 script words, so a
 * single split name never shifts the rest of the narration by one word (the
 * lockstep `alignScriptWords` is enough for TTS, where both lists come from the
 * same text, not here). Every output word is a SCRIPT word; speech only gives
 * the times. Pure: no I/O.
 */

export const MAX_SPOKEN_PER_SCRIPT_WORD = 6;
export const MAX_SCRIPT_PER_SPOKEN_WORD = 4;
const SKIP_SPOKEN = 0.7;
const SKIP_SCRIPT = 0.75;
const GROUP_PENALTY = 0.04;
const MIN_BAND = 80;

export interface SpeechAlignment {
  /** One entry per script word, script spelling, times from speech. */
  readonly words: TimedWord[];
  /** Script words matched to speech with similarity ≥ 0.5 (0..1). */
  readonly matchedRatio: number;
  /** Script words with no speech under them (time interpolated). */
  readonly unmatched: number;
  /** Recognized words that matched no script word (ad-libs, noise). */
  readonly extraSpoken: number;
}

export function foldWord(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

/** 1 = same letters, 0 = nothing in common. */
export function wordSimilarity(a: string, b: string): number {
  if (!a && !b) return 1;
  const longest = Math.max(a.length, b.length);
  return 1 - levenshtein(a, b) / longest;
}

const SKIP_SPOKEN_OP = 0;
const SKIP_SCRIPT_OP = 1;
const groupOp = (a: number, b: number) => 2 + (a - 1) * MAX_SPOKEN_PER_SCRIPT_WORD + (b - 1);

export function alignScriptToSpeech(script: readonly string[], spoken: readonly TimedWord[]): SpeechAlignment {
  const n = script.length;
  const m = spoken.length;
  if (n === 0) return { words: [], matchedRatio: 1, unmatched: 0, extraSpoken: m };
  if (m === 0) {
    return { words: script.map((text) => ({ text, startMs: 0, endMs: 0 })), matchedRatio: 0, unmatched: n, extraSpoken: 0 };
  }
  const s = script.map(foldWord);
  const r = spoken.map((word) => foldWord(word.text));
  // Diagonal band: speech and script advance together; the band absorbs
  // ad-libs and dropped words without an n×m matrix for long narrations.
  const band = Math.max(MIN_BAND, Math.abs(n - m) + MIN_BAND);
  const width = 2 * band + 1;
  const center = (i: number) => Math.round((i * m) / n);
  const index = (i: number, j: number): number => {
    const offset = j - center(i) + band;
    return offset < 0 || offset >= width ? -1 : i * width + offset;
  };
  const cost = new Float64Array((n + 1) * width).fill(Number.POSITIVE_INFINITY);
  const op = new Int16Array((n + 1) * width).fill(-1);
  const at = (i: number, j: number) => {
    const k = index(i, j);
    return k < 0 ? Number.POSITIVE_INFINITY : cost[k];
  };
  cost[index(0, 0)] = 0;
  for (let i = 0; i <= n; i += 1) {
    const lo = Math.max(0, center(i) - band);
    const hi = Math.min(m, center(i) + band);
    for (let j = lo; j <= hi; j += 1) {
      if (i === 0 && j === 0) continue;
      const k = index(i, j);
      let best = Number.POSITIVE_INFINITY;
      let bestOp = -1;
      if (j > 0) {
        const candidate = at(i, j - 1) + SKIP_SPOKEN;
        if (candidate < best) {
          best = candidate;
          bestOp = SKIP_SPOKEN_OP;
        }
      }
      if (i > 0) {
        const candidate = at(i - 1, j) + SKIP_SCRIPT;
        if (candidate < best) {
          best = candidate;
          bestOp = SKIP_SCRIPT_OP;
        }
      }
      for (let a = 1; a <= MAX_SCRIPT_PER_SPOKEN_WORD && a <= i; a += 1) {
        const scriptText = s.slice(i - a, i).join('');
        const maxB = a === 1 ? MAX_SPOKEN_PER_SCRIPT_WORD : 1;
        for (let b = 1; b <= maxB && b <= j; b += 1) {
          const previous = at(i - a, j - b);
          if (!Number.isFinite(previous)) continue;
          const spokenText = r.slice(j - b, j).join('');
          // A group pays its dissimilarity once per word it covers: grouping is for
          // real splits, never a shortcut over words nobody said.
          const candidate =
            previous + (1 - wordSimilarity(scriptText, spokenText)) * Math.max(a, b) + GROUP_PENALTY * (a + b - 2);
          if (candidate < best) {
            best = candidate;
            bestOp = groupOp(a, b);
          }
        }
      }
      cost[k] = best;
      op[k] = bestOp;
    }
  }

  // Backtrack.
  const assigned: Array<{ startMs: number; endMs: number } | null> = new Array(n).fill(null);
  let matched = 0;
  let extraSpoken = 0;
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const code = op[index(i, j)];
    if (code === SKIP_SPOKEN_OP) {
      extraSpoken += 1;
      j -= 1;
      continue;
    }
    if (code === SKIP_SCRIPT_OP) {
      i -= 1;
      continue;
    }
    if (code < 2) throw new Error('alinhamento sem caminho (banda estreita demais)');
    const a = Math.floor((code - 2) / MAX_SPOKEN_PER_SCRIPT_WORD) + 1;
    const b = ((code - 2) % MAX_SPOKEN_PER_SCRIPT_WORD) + 1;
    const startMs = spoken[j - b].startMs;
    const endMs = spoken[j - 1].endMs;
    const scriptText = s.slice(i - a, i).join('');
    if (wordSimilarity(scriptText, r.slice(j - b, j).join('')) >= 0.5) matched += a;
    // Several script words under one spoken word: split by letter count.
    const lengths = s.slice(i - a, i).map((word) => Math.max(1, word.length));
    const total = lengths.reduce((sum, value) => sum + value, 0);
    let cursor = startMs;
    for (let offset = 0; offset < a; offset += 1) {
      const span = ((endMs - startMs) * lengths[offset]) / total;
      assigned[i - a + offset] = { startMs: Math.round(cursor), endMs: Math.round(cursor + span) };
      cursor += span;
    }
    i -= a;
    j -= b;
  }

  // Script words nobody said get the gap between their neighbours.
  const words: TimedWord[] = [];
  let unmatched = 0;
  for (let w = 0; w < n; w += 1) {
    const own = assigned[w];
    if (own) {
      words.push({ text: script[w], ...own });
      continue;
    }
    unmatched += 1;
    const previousEnd = words.length > 0 ? words[words.length - 1].endMs : 0;
    const next = assigned.slice(w + 1).find(Boolean);
    words.push({ text: script[w], startMs: previousEnd, endMs: next ? Math.max(previousEnd, next.startMs) : previousEnd });
  }
  return { words, matchedRatio: matched / n, unmatched, extraSpoken };
}
