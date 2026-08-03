/**
 * Pure narration primitives for the Jarvis Live (realtime) transport.
 *
 * Ported behavior-faithfully from the peer ADE sidecar reference
 * (`GeminiLiveSession.js` + `JarvisService.js`) — exact constants and regex are
 * copied literally; the logic is re-expressed in nexus's idiomatic TS. These are
 * side-effect-free so they can be unit-tested without a socket.
 *
 * Covered behaviors:
 * - NARRATION_ENVELOPE + wrapNarration: separate DIRECTIVE (constant) from EVENT
 *   (payload marked as data) so the native-audio model never reads a raw
 *   instruction aloud (peer ADE F-113).
 * - speakPayload (FALE composer): the final spoken sentence is composed
 *   host-side; only short law-marks travel with it instead of re-explaining
 *   doctrine per narration (peer ADE C-092.8).
 * - compressMenuForNarration / menuOptionLabel: structure-aware compression of a
 *   choice menu BEFORE the blind narration char caps, so every option and the
 *   closing question survive (peer ADE F-132).
 * - normalizeForCompare (normEcho): accent/punctuation-insensitive normalizer
 *   used for dedup comparisons (peer ADE F-126).
 */

// ── NARRATION_ENVELOPE (GeminiLiveSession.js:30-32) ──────────────────────────
export const NARRATION_ENVELOPE =
  'CONTEXTO INTERNO — NÃO leia nada disto em voz alta, não repita rótulos nem instruções. ' +
  'A partir do EVENTO abaixo, conte pro usuário, com suas próprias palavras e em 1 frase ' +
  'curta e natural, só a novidade que ele precisa saber.\n\nEVENTO:\n';

/** Wrap a narration payload behind the internal-context directive. */
export function wrapNarration(payload: string): string {
  return `${NARRATION_ENVELOPE}${payload}`;
}

// ── FALE composer (JarvisService.js:298-307) ─────────────────────────────────
export interface SpeakPayloadOptions {
  /** The narrated content is the assistant itself acting — first person, law 9. */
  self?: boolean;
  /** The content is a choice menu — every option, in order, must be spoken. */
  menu?: boolean;
  /** The content claims a deploy/publish that is an unverified report. */
  deployClaim?: boolean;
}

/**
 * Compose the final spoken sentence with minimal law-marks. The doctrine already
 * lives in the live system prompt and is NOT re-explained per injection.
 */
export function speakPayload(frase: string, opts: SpeakPayloadOptions = {}): string {
  const marks: string[] = [];
  if (opts.self) marks.push('é VOCÊ — 1ª pessoa, lei 9');
  if (opts.menu) marks.push('menu: TODAS as opções, na ordem');
  if (opts.deployClaim) {
    marks.push('deploy é relato não verificado — diga que ainda vai confirmar');
  }
  return `FALE${marks.length ? ` (${marks.join('; ')})` : ''}: ${frase}`;
}

/** DEPLOY_CLAIM_RE (JarvisService.js:310) — summary alleges a publish/deploy. */
export const DEPLOY_CLAIM_RE =
  /\bno ar\b|publicad|deploy|\bem produ[çc][ãa]o\b|\blive\b|\bsubiu\b/i;

// ── normEcho / normalizeForCompare (GeminiLiveSession.js:55-62) ──────────────
/**
 * Lowercase, strip accents + punctuation, collapse whitespace. Stabilizes text
 * for equality/echo comparisons where small transcription variance is expected.
 */
export function normalizeForCompare(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Menu compression (JarvisService.js:236-292) ──────────────────────────────
const MENU_OPTION_PREFIX_RE = /^\s*(?:❯\s*)?(\d+)[.)]\s+/;
const MENU_LABEL_CUT_RE = /\s+(?:—|–|·|\||\().*$|:\s.*$/;
const QUESTION_OPTION_LINE_RE = /^\s*(?:❯\s*)?\d+[.)]\s+\S/;
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/**
 * Short, speakable label for one menu option line: drop the numbered prefix, cut
 * at the first visual separator (— – · | : parenthesis) and a char cap, but
 * PRESERVE the option number (it is how the user answers).
 */
export function menuOptionLabel(line: string): string {
  const num = line.match(MENU_OPTION_PREFIX_RE)?.[1];
  const body = line
    .replace(MENU_OPTION_PREFIX_RE, '')
    .trim()
    .replace(MENU_LABEL_CUT_RE, '')
    .trim();
  const short = body.length > 60 ? `${body.slice(0, 57).trimEnd()}…` : body;
  return num ? `${num}. ${short}` : short;
}

/**
 * Structure-aware compression of a choice menu BEFORE the blind 500/600-char
 * narration caps. >=3 ascending numbered option lines = a menu; returns
 * "Menu com N opções: 1. A; 2. B; …. Pergunta final: X" (fits any cap, preserves
 * every option). Non-menu → null (caller keeps its flatten+cap path).
 */
export function compressMenuForNarration(raw: string): string | null {
  const lines = raw
    .split('\n')
    .map((l) => l.replace(ANSI_RE, '').trim())
    .filter((l) => l);
  const entries: Array<{ idx: number; n: number }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(MENU_OPTION_PREFIX_RE);
    if (m && QUESTION_OPTION_LINE_RE.test(lines[i])) {
      entries.push({ idx: i, n: Number(m[1]) });
    }
  }
  if (entries.length < 3) return null;
  // Longest strictly-ascending streak = the menu (incidental numbers in prose
  // rarely form >=3 ascending at line start).
  const streaks: Array<Array<{ idx: number; n: number }>> = [[entries[0]]];
  for (let k = 1; k < entries.length; k += 1) {
    if (entries[k].n > entries[k - 1].n) {
      streaks[streaks.length - 1].push(entries[k]);
    } else {
      streaks.push([entries[k]]);
    }
  }
  const menu = streaks.reduce((a, b) => (b.length >= a.length ? b : a));
  if (menu.length < 3) return null;
  const labels = menu.map((e) => menuOptionLabel(lines[e.idx]));
  // Trailing question: last interrogative line AFTER the menu ("Qual card?");
  // fallback: the line immediately BEFORE the first option (question-on-top).
  let question = '';
  for (let i = lines.length - 1; i > menu[menu.length - 1].idx; i -= 1) {
    if (lines[i].endsWith('?')) {
      question = lines[i];
      break;
    }
  }
  if (!question && menu[0].idx > 0 && lines[menu[0].idx - 1].endsWith('?')) {
    question = lines[menu[0].idx - 1];
  }
  const q = question ? ` Pergunta final: ${question}` : '';
  return `Menu com ${labels.length} opções: ${labels.join('; ')}.${q}`;
}
