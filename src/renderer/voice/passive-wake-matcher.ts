/**
 * Text matcher used only after a short VAD-gated passive STT sample. It makes
 * the wake path resilient to pronunciation and acoustic-model misses without
 * treating arbitrary ambient speech as a command.
 */

// Observed across the local/Groq STT paths. "Jackson" is a recurring
// Portuguese transcription of a spoken "Jarvis" on the Fifine microphone.
const JARVIS_STT_ALIASES = new Set([
  'jarbas',
  'jarbis',
  'javes',
  'javis',
  'jarves',
  'jackson',
  'jasper',
  'eijax',
  'rejaves',
  'jacques',
]);
const FUZZY_ADDRESS_TOKEN_COUNT = 2;
// Some STT outputs collapse a quickly spoken "Hey Jarvis" into one token.
// These are deliberately complete greetings rather than arbitrary prefixes,
// so a word such as "superjarvis" cannot wake the assistant by suffix alone.
const JOINED_GREETING_PREFIXES = ['hey', 'hei', 'ei', 'e', 'oi', 'ola'] as const;
const GREETING_TOKENS = new Set<string>(JOINED_GREETING_PREFIXES);

export interface PassiveWakeMatch {
  command: string;
}

function normalizeToken(value: string): string {
  return value
    .toLocaleLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

function withinOneEdit(left: string, right: string): boolean {
  if (Math.abs(left.length - right.length) > 1) return false;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length] <= 1;
}

function remainingCommand(words: readonly string[], consumedAt: number): string {
  return words
    .slice(consumedAt)
    .join(' ')
    .replace(/^[\s,.;:!?-]+/, '')
    .trim();
}

function joinedGreetingAddress(token: string): string | null {
  for (const greeting of JOINED_GREETING_PREFIXES) {
    if (token.startsWith(greeting) && token.length > greeting.length) {
      return token.slice(greeting.length);
    }
  }
  return null;
}

function isAddressPosition(words: readonly string[], index: number): boolean {
  if (index === 0) return true;
  if (index !== 1) return false;
  return GREETING_TOKENS.has(normalizeToken(words[0] ?? ''));
}

/**
 * Matches the configured assistant name exactly anywhere in the phrase. Near
 * matches are accepted only as an address in the first two tokens, which lets
 * Whisper's "jarvix" / "jarbas" wake Jarvis while rejecting ambient mentions.
 */
export function matchPassiveWakeWord(
  transcript: string,
  assistantName = 'Jarvis',
): PassiveWakeMatch | null {
  const words = transcript.trim().split(/\s+/).filter(Boolean);
  const target = assistantName
    .trim()
    .split(/\s+/)
    .map(normalizeToken)
    .filter(Boolean);
  const expected = target.length > 0 ? target : ['jarvis'];
  const defaultJarvis = expected.length === 1 && expected[0] === 'jarvis';

  for (let index = 0; index <= words.length - expected.length; index += 1) {
    const exact = expected.every(
      (token, offset) => normalizeToken(words[index + offset] ?? '') === token,
    );
    if (exact) {
      return { command: remainingCommand(words, index + expected.length) };
    }

    if (
      index >= FUZZY_ADDRESS_TOKEN_COUNT ||
      expected.length !== 1 ||
      !isAddressPosition(words, index)
    ) {
      continue;
    }
    const heard = normalizeToken(words[index] ?? '');
    const joinedAddress = joinedGreetingAddress(heard);
    const address = joinedAddress ?? heard;
    const exactAddress = address === expected[0];
    const alias =
      defaultJarvis &&
      (JARVIS_STT_ALIASES.has(heard) || JARVIS_STT_ALIASES.has(address));
    const fuzzy = expected[0].length >= 4 && withinOneEdit(address, expected[0]);
    if (exactAddress || alias || fuzzy) {
      return { command: remainingCommand(words, index + 1) };
    }
  }

  return null;
}
