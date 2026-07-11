/**
 * Matching permissivo do nome "Jarvis" para wake / engajamento.
 * isJarvisWakeAddress → matchWakeWord do Overclock (port em overclock-voice-nlu).
 */

import { matchWakeWord } from './overclock-voice-nlu';

/** Aliases observados em STT PT-BR (Groq/Whisper) + sotaque. */
export const JARVIS_STT_ALIASES = new Set([
  'jarvis',
  'jarbas',
  'jarbis',
  'javes',
  'javis',
  'jarves',
  'jarvi',
  'jarvez',
  'jarvins',
  'jarvix',
  'jarwis',
  'jarvie',
  'jarvies',
  'jarv',
  'yavis',
  'charvis',
  'harvis',
  'garvis',
  'jarwis',
  'jackson',
  'jasper',
  'jervis',
  'jives',
  'jave',
  'eijax',
  'rejaves',
  'jacques',
  'carvis',
  'marvis',
  'zarvis',
  'jarviz',
  'jarvus',
  'gervis',
  'geravis',
]);

/**
 * Prefixo curto antes do nome: cumprimento OU verbo de chamada.
 * "acorda jarvis", "cheguei jarvis", "ouça jarvis", "oi jarvis".
 */
export const WAKE_PREFIX_TOKENS = new Set([
  // cumprimentos
  'hey',
  'hei',
  'ei',
  'e',
  'oi',
  'ola',
  'oye',
  'ai',
  'ae',
  'eh',
  'hello',
  'olaa',
  'oie',
  'fala',
  'falae',
  'ok',
  'alo',
  'alou',
  'eae',
  'iae',
  // chamada / atenção
  'acorda',
  'acordar',
  'acorde',
  'acordou',
  'chega',
  'cheguei',
  'chegado',
  'chegando',
  'ouca',
  'ouco',
  'ouso',
  'ouve',
  'ouvir',
  'escuta',
  'escute',
  'escutar',
  'ajuda',
  'ajudar',
  'vem',
  'volta',
  'voltar',
  'ativa',
  'ativar',
  'liga',
  'ligar',
  'abre',
  'abrir',
  'psiu',
  'eihe',
  'porfavor',
  'please',
  // NÃO incluir artigo "o"/"a" sozinho — "o jarvis falou…" ambient.
  // "o jarvis" (só 2 tokens) é tratado em isJarvisWakeAddress.
]);

/** @deprecated use WAKE_PREFIX_TOKENS — mantido para imports legados */
const WAKE_GREETINGS = WAKE_PREFIX_TOKENS;

export function normalizeNameToken(value: string): string {
  return value
    .toLocaleLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

/** Distância de edição (Levenshtein) com early-exit. */
export function editDistance(left: string, right: string, max = 3): number {
  if (left === right) return 0;
  if (Math.abs(left.length - right.length) > max) return max + 1;
  const rows = left.length + 1;
  const cols = right.length + 1;
  let prev = Array.from({ length: cols }, (_, i) => i);
  for (let r = 1; r < rows; r += 1) {
    const curr = [r];
    let rowMin = r;
    for (let c = 1; c < cols; c += 1) {
      const cost = left[r - 1] === right[c - 1] ? 0 : 1;
      const v = Math.min(prev[c]! + 1, curr[c - 1]! + 1, prev[c - 1]! + cost);
      curr[c] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = curr;
  }
  return prev[right.length]!;
}

/**
 * Token isolado parece "Jarvis"? (exato, alias, prefixo jarv*, ou ≤2 edits).
 */
export function looksLikeJarvisName(raw: string, target = 'jarvis'): boolean {
  const heard = normalizeNameToken(raw);
  if (!heard || heard.length < 3) return false;
  const expected = normalizeNameToken(target) || 'jarvis';

  if (heard === expected) return true;
  if (JARVIS_STT_ALIASES.has(heard)) return true;

  // Prefixo característico: jarv… / jarb… / charv…
  if (/^(jarv|jarb|charv|harv|garv|yav)/.test(heard) && heard.length >= 4) {
    return true;
  }

  // Sufixo …rvis / …avis em nomes curtos (javes, travis-like)
  if (heard.length >= 4 && heard.length <= 10) {
    if (/(rvis|avis|arvis|erves|arves)$/.test(heard)) {
      const dist = editDistance(heard, expected, 3);
      if (dist <= 2) return true;
    }
  }

  // Fuzzy geral: até 2 edits para alvo ≥5 chars; 1 edit se alvo 4
  const maxEdits = expected.length >= 5 ? 2 : 1;
  if (heard.length >= 3 && heard.length <= 12) {
    if (editDistance(heard, expected, maxEdits) <= maxEdits) return true;
  }

  return false;
}

const JOINED_GREETING_PREFIXES = [
  'hey',
  'hei',
  'ei',
  'e',
  'oi',
  'ola',
  'oye',
  'ai',
  'eh',
  'ok',
] as const;

/** "heyjarvis" / "eijarbas" colados pelo STT. */
export function stripJoinedGreeting(token: string): string | null {
  const heard = normalizeNameToken(token);
  for (const g of JOINED_GREETING_PREFIXES) {
    if (heard.startsWith(g) && heard.length > g.length + 2) {
      return heard.slice(g.length);
    }
  }
  return null;
}

/**
 * Transcript é chamada à Jarvis? Mesma regra do Overclock matchWakeWord.
 */
export function isJarvisWakeAddress(
  text: string,
  assistantName = 'Jarvis',
): boolean {
  return matchWakeWord(text, assistantName) !== null;
}
