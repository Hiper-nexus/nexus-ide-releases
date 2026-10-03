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
import { getWorkspaceMemoryStore } from './workspace-memory';

/** Marcadores pt-BR/EN de preferência duradoura. */
export const PREFERENCE_MARKER_RE =
  /\b(sempre|nunca|prefiro|preferiria|prefere que|a partir de agora|de agora em diante|evite usar|não use(?:\s+\w+)?|não utilizes|obrigatoriamente|always|never|prefer|from now on)\b/i;

/** Teto do candidato extraído do prompt. */
const CANDIDATE_MAX_CHARS = 300;

/**
 * Contexto que vai ao Jev é limitado, mas a busca no texto do operador pode
 * alcançar a preferência no fim de uma mensagem longa (teto separado).
 */
const CONTEXT_MAX_CHARS = 1_500;
const PROMPT_MAX_CHARS = 65_536;
const INJECTED_MESSAGE_RE = /<\/?(?:task-notification|pasted_content|system-reminder|tool_result|workspace-handoff)\b|\[Nexus\]|^\s*#\s*AGENTS\.md\b|^\s*(?:log da CI|CI log)\b/im;

const PREFERENCE_SOURCE = 'trusted:operator-preference';

/**
 * Candidatos aguardando o Jev, por banco de workspace. Sem teto diário
 * (decisão do operador, 2026-09-27): o mesmo prompt repetido em rajada vai
 * ao Jev uma vez só; conteúdo distinto é trabalho legítimo.
 */
const pendingCandidates = new WeakMap<object, Set<string>>();

/**
 * Moldura em que a frase com marcador não é regra do operador: exemplo,
 * citação, texto sob análise ou instrução explicitamente recusada. Com ela
 * no prompt nada é gravado (zero chamadas ao Jev) — "não adote X" nunca vira X.
 */
const NOT_ADOPTED_RE =
  /\b(?:exemplos?|examples?|prompt injection|cita[cç](?:[aã]o|[oõ]es)|quoted?|quotes)\b|\bn[aã]o\s+(?:adote|adotem|siga|sigam|aplique|apliquem|grave|guarde|memorize|obede[cç]a)\b|\b(?:do not|don't|dont)\s+(?:adopt|follow|apply|obey|remember|store|save)\b/i;

/** Trecho citado (bloco de código, linha com ">", texto entre aspas duplas). */
function withoutQuotedText(prompt: string): string {
  return prompt
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/^[ \t]*>.*$/gm, ' ')
    .replace(/"[^"\n]*"|“[^”\n]*”|«[^»\n]*»/g, ' ');
}

export type OperatorPreferenceOutcome =
  | {
      retained: false;
      reason:
        | 'flag-off'
        | 'no-marker'
        | 'not-adopted'
        | 'dedupe'
        | 'jev-skip'
        | 'store-unavailable';
    }
  | { retained: true; reason: 'ok' };

/**
 * Extrai, do prompt, as frases com marcador de preferência — uma linha,
 * sem quebras, limitada a 300 caracteres. null quando nada casa ou quando o
 * prompt cita/nega a regra em vez de adotá-la.
 */
export function extractPreferenceCandidate(prompt: string): string | null {
  if (prompt.length > PROMPT_MAX_CHARS || NOT_ADOPTED_RE.test(prompt) || INJECTED_MESSAGE_RE.test(prompt)) return null;
  const sentences = withoutQuotedText(prompt)
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
  if (!PREFERENCE_MARKER_RE.test(prompt)) return { retained: false, reason: 'no-marker' };
  const candidate = extractPreferenceCandidate(prompt);
  if (!candidate) return { retained: false, reason: 'not-adopted' };

  // Duplicata sai antes do Jev: "never/always" é comum em prompt trivial e
  // cada chamada custa.
  let pending: Set<string>;
  try {
    const store = getWorkspaceMemoryStore(scope);
    const hits = store.recall({ query: candidate, limit: 3, includeGlobal: false, trustedOnly: true });
    if (hits.some((hit) => hit.source === PREFERENCE_SOURCE && hit.content.includes(candidate))) {
      return { retained: false, reason: 'dedupe' };
    }
    pending = pendingCandidates.get(store) ?? new Set<string>();
    if (pending.has(candidate)) return { retained: false, reason: 'dedupe' };
    pending.add(candidate);
    pendingCandidates.set(store, pending);
  } catch {
    return { retained: false, reason: 'store-unavailable' };
  }

  try {
    // O Jev vê a frase E a mensagem de onde ela saiu: o recorte sozinho
    // esconderia negação, citação ou exemplo.
    const confirmed = await confirmOperatorPreference(
      { candidate, context: preferenceContext(prompt, candidate) },
      deps,
    );
    if (!confirmed) return { retained: false, reason: 'jev-skip' };

    const result = retainTrustedMemoryBestEffort(scope, {
      type: 'operator-preference',
      title: 'Operator preference',
      summary: candidate,
    });
    return result ? { retained: true, reason: 'ok' } : { retained: false, reason: 'store-unavailable' };
  } finally {
    pending.delete(candidate);
  }
}

/** Preserve the candidate's surrounding message, even when it occurs late. */
function preferenceContext(prompt: string, candidate: string): string {
  if (prompt.length <= CONTEXT_MAX_CHARS) return prompt;
  const index = prompt.indexOf(candidate.split(/\n/)[0]!);
  const start = Math.max(0, (index >= 0 ? index : prompt.length) - 600);
  return prompt.slice(start, start + CONTEXT_MAX_CHARS);
}
