/**
 * Wake textual = Overclock matchWakeWord (port autorizado).
 * Interface Nexus: { command } ≡ Overclock { rest }.
 */

import { matchWakeWord } from '../../shared/overclock-voice-nlu';

export interface PassiveWakeMatch {
  /** Texto após o nome (comando embutido no mesmo utterance). */
  command: string;
}

const PASSIVE_PREFIX_FILLERS = new Set(['ei', 'hey', 'oi', 'ola', 'ok', 'okay', 'acorda']);

function words(value: string): string[] {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .match(/[a-z0-9]+/g) ?? [];
}

/**
 * Embedded commands are more dangerous than a wake-only acknowledgement.
 * Accept them from passive STT only when the configured name is exact and at
 * the start (optionally after one natural wake filler). Fuzzy aliases,
 * truncations and mid-sentence mentions remain useful for wake-only matching,
 * but can no longer turn TV/video speech into Nexus commands.
 */
export function isTrustedPassiveEmbeddedCommand(
  transcript: string,
  assistantName = 'Jarvis',
): boolean {
  const transcriptWords = words(transcript);
  const nameWords = words(assistantName);
  if (transcriptWords.length === 0 || nameWords.length === 0) return false;
  const offset = PASSIVE_PREFIX_FILLERS.has(transcriptWords[0] ?? '') ? 1 : 0;
  if (transcriptWords.length <= offset + nameWords.length) return false;
  return nameWords.every((word, index) => transcriptWords[offset + index] === word);
}

/**
 * Wake-only vindo do STT passivo precisa ser exato. Aliases são úteis como
 * indício acústico, mas não podem abrir uma sessão por conta própria: vídeos
 * produziram "jars"/"jabs" e o matcher fuzzy os promoveu a Jarvis.
 */
export function isTrustedPassiveWakeOnly(
  transcript: string,
  assistantName = 'Jarvis',
): boolean {
  const transcriptWords = words(transcript);
  const nameWords = words(assistantName);
  if (transcriptWords.length === 0 || nameWords.length === 0) return false;
  const offset = PASSIVE_PREFIX_FILLERS.has(transcriptWords[0] ?? '') ? 1 : 0;
  if (transcriptWords.length !== offset + nameWords.length) return false;
  return nameWords.every((word, index) => transcriptWords[offset + index] === word);
}

/**
 * Detecta chamada à assistente no transcript do STT passivo.
 * Delega 100% ao matchWakeWord do Overclock (+ truncamentos no mesmo módulo).
 */
export function matchPassiveWakeWord(
  transcript: string,
  assistantName = 'Jarvis',
): PassiveWakeMatch | null {
  const hit = matchWakeWord(transcript, assistantName);
  if (!hit) return null;
  return { command: hit.rest };
}
