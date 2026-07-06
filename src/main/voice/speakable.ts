import type { VoiceSpeakMode } from '../../shared/voice-config';

/**
 * Condense raw agent / terminal output into a short spoken response (the Jarvis
 * "talk back" step). Pure and fully unit-testable. Never speaks code blocks or
 * long dumps verbatim: `summary` mode distils to 1–3 sentences.
 */

const MAX_SUMMARY_CHARS = 240;
const MAX_SUMMARY_SENTENCES = 3;
const MAX_FULL_CHARS = 1200;
const MIN_MEANINGFUL_CHARS = 8;

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;
const FENCED_CODE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`]*`/g;
// Non-global twins for `.test()` — a /g regex's lastIndex is stateful across
// calls and would make repeated detections flaky.
const HAS_CODE_RE = /`[^`]*`|```[\s\S]*?```/;
// Box-drawing, block, and common spinner/braille glyphs that pollute TUI output.
const BOX_GLYPH_RE = /[─-╿▀-▟⠀-⣿■-◿]/g;

/** Strip ANSI, code, and TUI decoration; collapse whitespace. */
export function cleanText(raw: string): string {
  return raw
    .replace(ANSI_RE, '')
    .replace(FENCED_CODE_RE, ' ')
    .replace(INLINE_CODE_RE, ' ')
    .replace(BOX_GLYPH_RE, ' ')
    // Drop bare shell-prompt / bullet noise at line starts.
    .replace(/^[\s>$#•▸●○*-]+/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split into sentences on ., !, ? boundaries (keeping it simple + robust). */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function truncateAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trim()}…`;
}

/**
 * Produce the exact string to speak for a given mode. Returns '' when there is
 * nothing worth speaking (mode 'off', or empty/meaningless input) — callers skip
 * TTS on an empty result.
 */
export function toSpeakable(raw: string, mode: VoiceSpeakMode): string {
  if (mode === 'off') return '';

  const cleaned = cleanText(raw);

  if (mode === 'full') {
    return truncateAtWord(cleaned, MAX_FULL_CHARS);
  }

  // summary
  if (cleaned.length < MIN_MEANINGFUL_CHARS) {
    // The output was essentially all code / decoration.
    const hadCode = HAS_CODE_RE.test(raw);
    return hadCode ? 'Pronto. A resposta é quase toda código — veja o pane.' : '';
  }

  const sentences = splitSentences(cleaned).slice(0, MAX_SUMMARY_SENTENCES);
  const summary = sentences.join(' ');
  return truncateAtWord(summary || cleaned, MAX_SUMMARY_CHARS);
}
