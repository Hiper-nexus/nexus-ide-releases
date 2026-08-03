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

// Defesa em profundidade além do strip de code-fence: a voz NUNCA deve soletrar
// sintaxe de tool-call / JSON que vaze FORA de crases (ex.: uma wake de handoff
// com `Mais detalhes: mcp__agent__handoff_list({ids:["h-5t"]})` na tela).
// Espelha os regexes do voiceSafeText do peer ADE (:14,:16,:18,:30).
/** Chamada mcp__ com args — tolera 1 nível de parênteses aninhados. */
const MCP_CALL_RE = /\bmcp__[\w.-]+\s*\((?:[^()]|\([^()]*\))*\)/g;
/** Nome de tool mcp__ solto (sem args). */
const MCP_NAME_RE = /\bmcp__[\w.-]+\b/g;
/** Objeto JSON "de payload": {"key": ...} ou {key: ...}. */
const JSON_BLOB_RE = /\{[^{}]*(?:"[^"]*"|\w+)\s*:[^{}]*\}/g;
// Ponteiro órfão: exige os dois-pontos e nada narrável depois — evita comer a
// prosa "Mais detalhes sobre X" (sem `:`) enquanto ainda tira o ponteiro solto
// que sobra após o strip da chamada mcp__ ("Mais detalhes: <call removida>").
const ORPHAN_POINTER_RE = /\b(?:Mais detalhes|Responda via)\s*:\s*(?![\wÀ-ú"'`])/g;

/** Strip ANSI, code, tool-call/JSON syntax, and TUI decoration; collapse whitespace. */
export function cleanText(raw: string): string {
  let out = raw
    .replace(ANSI_RE, '')
    .replace(FENCED_CODE_RE, ' ')
    // Sintaxe técnica solta (fora de crases): chamadas mcp__ primeiro, depois o
    // ponteiro que ficou órfão após o strip da chamada.
    .replace(MCP_CALL_RE, ' ')
    .replace(MCP_NAME_RE, ' ')
    .replace(ORPHAN_POINTER_RE, ' ');
  // JSON de payload: algumas passadas desmontam aninhamento raso.
  for (let i = 0; i < 3; i += 1) {
    const next = out.replace(JSON_BLOB_RE, ' ');
    if (next === out) break;
    out = next;
  }
  return out
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
