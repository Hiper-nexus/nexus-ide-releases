/**
 * Wake textual = Overclock matchWakeWord (port autorizado).
 * Interface Nexus: { command } ≡ Overclock { rest }.
 */

import { matchWakeWord } from '../../shared/overclock-voice-nlu';

export interface PassiveWakeMatch {
  /** Texto após o nome (comando embutido no mesmo utterance). */
  command: string;
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
