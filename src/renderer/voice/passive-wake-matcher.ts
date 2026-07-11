/**
 * Text matcher used only after a short VAD-gated passive STT sample. It makes
 * the wake path resilient to pronunciation and acoustic-model misses without
 * treating arbitrary ambient speech as a command.
 *
 * Política: só "Jarvis" basta — "Jarvis", "Ei Jarvis", "acorda Jarvis",
 * "cheguei Jarvis", "olá Jarvis", "ouça Jarvis", etc.
 */

import {
  isJarvisAddressTokenIndex,
  looksLikeJarvisName,
  normalizeNameToken,
  stripJoinedGreeting,
} from '../../shared/jarvis-name-match';

const FUZZY_ADDRESS_TOKEN_COUNT = 3;

export interface PassiveWakeMatch {
  command: string;
}

function remainingCommand(words: readonly string[], consumedAt: number): string {
  return words
    .slice(consumedAt)
    .join(' ')
    .replace(/^[\s,.;:!?-]+/, '')
    .trim();
}

/**
 * Matches the configured assistant name as a direct address. Exact and near
 * STT matches share the same vocative boundary so ambient mid-sentence mentions
 * ("hoje o Jarvis falou") do not wake.
 */
export function matchPassiveWakeWord(
  transcript: string,
  assistantName = 'Jarvis',
): PassiveWakeMatch | null {
  const words = transcript.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;

  const targetParts = assistantName
    .trim()
    .split(/\s+/)
    .map(normalizeNameToken)
    .filter(Boolean);
  const expected = targetParts.length > 0 ? targetParts : ['jarvis'];
  const defaultJarvis = expected.length === 1 && expected[0] === 'jarvis';
  const target = expected[0] ?? 'jarvis';

  for (let index = 0; index <= words.length - expected.length; index += 1) {
    if (!isJarvisAddressTokenIndex(words, index)) continue;

    // Exact multi-token name
    const exact = expected.every(
      (token, offset) => normalizeNameToken(words[index + offset] ?? '') === token,
    );
    if (exact) {
      return { command: remainingCommand(words, index + expected.length) };
    }

    if (expected.length !== 1) continue;
    if (index >= FUZZY_ADDRESS_TOKEN_COUNT) continue;

    const heard = normalizeNameToken(words[index] ?? '');
    const joined = stripJoinedGreeting(heard);
    const candidates = joined ? [heard, joined] : [heard];

    for (const address of candidates) {
      const isMatch = defaultJarvis
        ? looksLikeJarvisName(address, target)
        : address === target || looksLikeJarvisName(address, target);
      if (isMatch) {
        return { command: remainingCommand(words, index + 1) };
      }
    }
  }

  return null;
}
