/**
 * Preferência do operador detectada no /hook/delegate (fatia 3 da memória
 * Jev). Um pré-filtro regex barato seleciona frases com marcador de
 * preferência ("sempre", "nunca", "prefiro", "always", "never"...); só então
 * UMA chamada Jev confirma que é preferência duradoura de projeto. Sem
 * marcador, zero chamadas ao Jev. A gravação é sempre kind preference e
 * scope workspace — global automático nunca.
 */
import type { ProjectExecutionScope } from '../../shared/types';
import {
  confirmOperatorPreference,
  type DistillHandoffSummaryDeps,
} from '../jev/jev-memory-distill';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import { retainTrustedMemoryBestEffort } from './trusted-memory';

/** Marcadores pt-BR/EN de preferência duradoura. */
export const PREFERENCE_MARKER_RE =
  /\b(sempre|nunca|prefiro|preferiria|prefere que|a partir de agora|de agora em diante|evite usar|não use(?:\s+\w+)?|não utilizes|obrigatoriamente|always|never|prefer|from now on)\b/i;

/** Teto do candidato extraído do prompt. */
const CANDIDATE_MAX_CHARS = 300;

export type OperatorPreferenceOutcome =
  | { retained: false; reason: 'flag-off' | 'no-marker' | 'jev-skip' | 'store-unavailable' }
  | { retained: true; reason: 'ok' };

/**
 * Extrai, do prompt, as frases com marcador de preferência — uma linha,
 * sem quebras, limitada a 300 caracteres. null quando nada casa.
 */
export function extractPreferenceCandidate(prompt: string): string | null {
  const sentences = prompt
    .split(/(?<=[.!?\n])\s+|\n+/)
    .map((sentence) => sentence.replace(/\s+/g, ' ').trim())
    .filter((sentence) => PREFERENCE_MARKER_RE.test(sentence));
  if (sentences.length === 0) return null;
  const candidate = sentences.join(' ').slice(0, CANDIDATE_MAX_CHARS).trim();
  return candidate || null;
}

export async function distillOperatorPreferenceMemory(
  scope: ProjectExecutionScope,
  prompt: string,
  deps: DistillHandoffSummaryDeps = {},
): Promise<OperatorPreferenceOutcome> {
  if (
    !getFeatureFlagRegistry().isEnabled(FEATURE_FLAG_IDS.workspaceMemory)
  ) {
    return { retained: false, reason: 'flag-off' };
  }
  const candidate = extractPreferenceCandidate(prompt);
  if (!candidate) return { retained: false, reason: 'no-marker' };

  const confirmed = await confirmOperatorPreference({ candidate }, deps);
  if (!confirmed) return { retained: false, reason: 'jev-skip' };

  const result = retainTrustedMemoryBestEffort(scope, {
    type: 'operator-preference',
    title: 'Operator preference',
    summary: candidate,
  });
  return result ? { retained: true, reason: 'ok' } : { retained: false, reason: 'store-unavailable' };
}
