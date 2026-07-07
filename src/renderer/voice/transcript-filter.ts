/**
 * Filtro de transcrição-lixo do Whisper, CONSCIENTE DE CONTEXTO.
 *
 * O Whisper alucina frases fixas em silêncio/ruído ("you", "thank you",
 * "obrigado por assistir" — créditos de YouTube do corpus). Numa captura FRIA
 * (wake/PTT do nada), essas frases sozinhas são quase sempre alucinação.
 * MAS em conversa ativa, "valeu", "tchau", "oi" são respostas legítimas — o
 * filtro antigo descartava e a JARVIS parecia surda ("falei e ela ignorou").
 *
 * Regra: lista completa só vale fora de conversa; em conversa ativa, apenas
 * os artefatos que nunca são fala real (créditos, pontuação pura).
 */

/** Alucinações clássicas do Whisper em áudio sem fala. */
const COLD_GHOSTS = new Set([
  'you', 'thank you', 'thanks', 'thank you.', 'thanks for watching',
  'thanks for watching!', 'you.', 'bye', 'bye.', '.', 'obrigado',
  'obrigado.', 'obrigado por assistir', 'valeu', 'tchau', 'até a próxima',
  'e aí', 'e ai', 'ei', 'oi', 'legendas pela comunidade amara.org', 'amara.org',
]);

/** Artefatos que NUNCA são fala real, mesmo em conversa. */
const HARD_GHOSTS = new Set([
  '.', 'legendas pela comunidade amara.org', 'amara.org',
  'thanks for watching', 'thanks for watching!', 'obrigado por assistir',
  'ah', 'ai', 'ai ai', 'hum', 'hmm', 'hm', 'uh', 'uhum',
]);

/** Eco da própria JARVIS (TTS vazando no mic) — descarta mesmo em conversa. */
const JARVIS_SELF_ECHO = new Set([
  'nao entendi o pedido',
  'nao entendi',
  'nao compreendi',
  'pode repetir',
  'repita por favor',
  'desculpa nao entendi',
]);

function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

function normalizeToken(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function tokenized(text: string): Array<{ raw: string; norm: string }> {
  return text
    .trim()
    .split(/\s+/)
    .map((raw) => ({ raw, norm: normalizeToken(raw) }))
    .filter((token) => token.norm.length > 0);
}

function startsWithPattern(
  tokens: Array<{ raw: string; norm: string }>,
  pattern: string[],
): boolean {
  if (tokens.length < pattern.length) return false;
  return pattern.every((part, index) => tokens[index]?.norm === part);
}

function stripLeadingPatterns(
  tokens: Array<{ raw: string; norm: string }>,
  patterns: string[][],
): Array<{ raw: string; norm: string }> {
  let rest = tokens;
  let changed = true;
  while (changed && rest.length > 0) {
    changed = false;
    for (const pattern of patterns) {
      if (startsWithPattern(rest, pattern)) {
        rest = rest.slice(pattern.length);
        changed = true;
        break;
      }
    }
  }
  return rest;
}

function wakeEchoPatterns(userName: string): string[][] {
  const user = normalizeToken(userName);
  const patterns = [
    ['hey', 'jarvis'],
    ['ei', 'jarvis'],
    ['e', 'jarvis'],
    ['e', 'javes'],
    ['ei', 'javes'],
    ['ok', 'jarvis'],
    ['jarvis'],
    ['javes'],
    ['jave'],
    ['estou', 'ouvindo'],
  ];
  if (!user) {
    return [
      ...patterns,
      ['pois', 'nao'],
      ['pues', 'no'],
      ['sim'],
      ['diga'],
    ];
  }
  return [
    ['pois', 'nao', user],
    ['pues', 'no', user],
    ['sim', user],
    ['diga', user],
    ...patterns,
    ['pois', 'nao'],
    ['pues', 'no'],
    ['sim'],
    ['diga'],
  ];
}

/**
 * Wake pre-roll intentionally captures the user's "Hey Jarvis" and may also
 * catch the cached acknowledgement leaking from speakers. Strip those leading
 * assistant/wake fragments so "Hey Jarvis, pois não patrão, abre terminal"
 * becomes just "abre terminal" before the fast-path/brain sees it.
 */
export function stripWakeAckEcho(text: string, userName: string): string {
  const tokens = tokenized(text);
  if (tokens.length === 0) return '';
  const rest = stripLeadingPatterns(tokens, wakeEchoPatterns(userName));
  let out = rest.map((token) => token.raw).join(' ').trim();
  const user = normalizeToken(userName);
  if (user) {
    const n = normalizeToken(out);
    // Vocativo do ack (PT patrão / ES patrón) vazado pelo alto-falante.
    if (n === user || n === 'patron' || n === 'patrao') return '';
  }
  return out;
}

/** Só eco do ack / wake — nada que deva virar turno ou resposta realtime. */
export function isWakeAckOnlyTranscript(text: string, userName: string): boolean {
  const stripped = stripWakeAckEcho(text, userName);
  if (!stripped.trim()) return true;
  return isDiscardableTranscript(stripped, { inConversation: false });
}

/**
 * true = descartar em silêncio (não virar turno). `inConversation` = há uma
 * conversa ativa com a JARVIS (janela de memória curta ainda quente).
 */
export function isDiscardableTranscript(
  text: string,
  opts: { inConversation: boolean },
): boolean {
  const clean = normalize(text);
  if (clean.length === 0) return true;
  if (JARVIS_SELF_ECHO.has(clean)) return true;
  return opts.inConversation ? HARD_GHOSTS.has(clean) : COLD_GHOSTS.has(clean);
}
