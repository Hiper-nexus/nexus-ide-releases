/**
 * Wake textual no estilo Overclock: STT → matchWakeWord.
 * Não depende de modelo acústico PT. Aceita "Jarvis" (e STT quebrado) com
 * fuzzy só no início da frase; exact match em qualquer posição.
 */

import {
  editDistance,
  looksLikeJarvisName,
  normalizeNameToken,
  stripJoinedGreeting,
} from '../../shared/jarvis-name-match';

export interface PassiveWakeMatch {
  command: string;
}

/** Aliases curtos que o Overclock + logs reais do Groq produzem. */
const DEFAULT_ALIASES = new Set([
  'jarbas',
  'jarbis',
  'javes',
  'javis',
  'jarves',
  'jarvi',
  'jarviz',
  'jarvus',
  'jarvix',
  'charvis',
  'harvis',
  'jackson',
  'jasper',
  'jacques',
  'eijax',
  'rejaves',
  // STT truncado (logs: "aja", "ja")
  'aja',
  'jar',
  'jarr',
]);

const FILLER_PREFIX = new Set([
  'ei',
  'e',
  'hey',
  'hei',
  'oi',
  'ola',
  'ok',
  'ai',
  'ae',
  'oye',
  'alo',
  'eae',
  'oie',
  'fala',
  'acorda',
  'cheguei',
  'ouca',
  'ouso',
  'escuta',
  'ajuda',
  'vem',
]);

function remainingCommand(words: readonly string[], consumedAt: number): string {
  return words
    .slice(consumedAt)
    .join(' ')
    .replace(/^[\s,.;:!?-]+/, '')
    .trim();
}

function isNameToken(
  token: string,
  expected: string,
  allowFuzzy: boolean,
  isDefaultJarvis: boolean,
): boolean {
  if (!token) return false;
  if (token === expected) return true;
  const joined = stripJoinedGreeting(token);
  if (joined && (joined === expected || looksLikeJarvisName(joined, expected))) {
    return true;
  }
  if (!allowFuzzy) return false;
  if (isDefaultJarvis && DEFAULT_ALIASES.has(token)) return true;
  // Prefixo truncado: "ja", "jar", "jarv" após STT cortar cedo
  if (
    isDefaultJarvis &&
    token.length >= 2 &&
    token.length <= 5 &&
    expected.startsWith(token) &&
    token.startsWith('ja')
  ) {
    return true;
  }
  if (expected.length >= 4 && token.length >= 4) {
    if (editDistance(token, expected, 1) <= 1) return true;
  }
  if (isDefaultJarvis && looksLikeJarvisName(token, expected)) return true;
  return false;
}

/**
 * Overclock parity: "Jarvis" exact em qualquer posição; fuzzy/alias só nos
 * 2 primeiros tokens (endereço deliberado).
 */
export function matchPassiveWakeWord(
  transcript: string,
  assistantName = 'Jarvis',
): PassiveWakeMatch | null {
  const raw = transcript.trim();
  if (!raw) return null;

  const targetParts = assistantName
    .trim()
    .split(/\s+/)
    .map(normalizeNameToken)
    .filter(Boolean);
  const expected = targetParts.length > 0 ? targetParts : ['jarvis'];
  const isDefault = expected.length === 1 && expected[0] === 'jarvis';
  const target = expected[0] ?? 'jarvis';
  const joinedTarget = expected.join('');

  const words = raw.split(/\s+/).filter(Boolean);
  const norms = words.map((w) => normalizeNameToken(w));

  // STT ultra-curto: "e ja" / "ei ja" / "e jar" (fingerprint real nos logs)
  if (words.length === 2 && isDefault) {
    const a = norms[0] ?? '';
    const b = norms[1] ?? '';
    if (FILLER_PREFIX.has(a) && (b.startsWith('ja') || isNameToken(b, target, true, true))) {
      return { command: '' };
    }
  }
  // Um token colado "eijarvis" / "heyjarvis"
  if (words.length === 1 && isDefault) {
    const one = norms[0] ?? '';
    const stripped = stripJoinedGreeting(one);
    if (stripped && isNameToken(stripped, target, true, true)) {
      return { command: '' };
    }
    if (isNameToken(one, target, true, true)) {
      return { command: '' };
    }
  }

  for (let i = 0; i < norms.length; i += 1) {
    // Fuzzy só no início (Overclock: i < 2)
    const fuzzy = i < 2;
    let consumed = 0;

    if (i + expected.length <= norms.length) {
      let all = true;
      for (let k = 0; k < expected.length; k += 1) {
        if (!isNameToken(norms[i + k] ?? '', expected[k]!, fuzzy, isDefault)) {
          all = false;
          break;
        }
      }
      if (all) consumed = expected.length;
    }

    // Nome multi-token concatenado ("sexta feira" vs "sexta-feira")
    if (consumed === 0 && joinedTarget.length >= 4) {
      let acc = '';
      for (let k = 0; i + k < norms.length && acc.length <= joinedTarget.length + 1; k += 1) {
        acc += norms[i + k] ?? '';
        if (
          acc.length >= joinedTarget.length - 1 &&
          isNameToken(acc, joinedTarget, fuzzy, isDefault)
        ) {
          consumed = k + 1;
          break;
        }
      }
    }

    // Exact single-token mid-phrase (Overclock F-057)
    if (consumed === 0 && norms[i] === target) {
      consumed = 1;
    }

    if (consumed > 0) {
      return { command: remainingCommand(words, i + consumed) };
    }
  }

  return null;
}
