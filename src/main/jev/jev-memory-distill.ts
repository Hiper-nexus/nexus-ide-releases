/**
 * Distilação de memória via TypeSafe Jev (piloto automático, superfície
 * `memoryDistill`). O resumo de um handoff aceito é texto do agente, então o
 * Nexus pede ao Jev UMA decisão `judge()` — vale a pena lembrar isto depois?
 * — antes de deixar o resumo entrar na linha trusted. Fail-open: sem chave,
 * superfície desligada ou judge fora do ar → null, e a linha nasce exatamente
 * como nasce hoje (só identificadores Main-owned).
 */
import {
  judge,
  USD_PER_INPUT_TOKEN,
  type JevQuestion,
} from './jev-client';
import { isJevSurfaceEnabled } from './jev-autopilot';
import { hasJevCredential } from './jev-secrets';
import {
  jevAnswerConfidences,
  jevAnswerProbabilities,
  recordJevDecision,
} from './jev-decision-log';

const DISTILL_TIMEOUT_MS = 6_000;

/** Teto do resumo destilado — o mesmo limite aceito pela linha trusted. */
export const DISTILLED_SUMMARY_MAX_CHARS = 400;

/** Probabilidade mínima de "vale guardar" para reter o resumo. */
const RETAIN_THRESHOLD = 0.6;

const DISTILL_QUESTIONS: Record<string, JevQuestion> = {
  worth_retaining: {
    type: 'noul',
    instructions:
      'Would future work in this project benefit from remembering this ' +
      'delivered result? Answer yes only for durable facts: decisions, ' +
      'solved problems, architecture or behavior changes. Routine progress, ' +
      'greetings and boilerplate are not worth remembering.',
    criteria: {
      true: 'a durable, useful project fact worth recalling later',
      false: 'routine progress or noise; nothing to recall later',
    },
  },
};

export interface DistillHandoffSummaryDeps {
  judge?: typeof judge;
  enabled?: () => boolean;
  hasKey?: () => boolean;
  /** Abort externo combinado ao timeout interno. */
  signal?: AbortSignal;
}

/**
 * Colapsa o resumo em uma linha única (impede forjar linhas estruturais como
 * "Mission:" na projeção) e corta no teto de 400 caracteres.
 */
export function normalizeDistilledSummary(summary: string): string | null {
  const normalized = summary.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return normalized.slice(0, DISTILLED_SUMMARY_MAX_CHARS);
}

/**
 * Decide se o resumo Main-validado de um handoff aceito deve virar memória.
 * Retorna o resumo normalizado quando sim, null quando não (incluindo toda
 * falha do Jev — o fail-open preserva o comportamento atual).
 */
export async function distillHandoffSummary(
  input: { summary: string },
  deps: DistillHandoffSummaryDeps = {},
): Promise<string | null> {
  const judgeFn = deps.judge ?? judge;
  const enabled = deps.enabled ?? (() => isJevSurfaceEnabled('memoryDistill'));
  const hasKeyFn = deps.hasKey ?? hasJevCredential;

  const summary = normalizeDistilledSummary(input.summary);
  if (!summary || !enabled() || !hasKeyFn()) return null;

  const result = await judgeFn({
    state: { summary },
    questions: DISTILL_QUESTIONS,
    timeoutMs: DISTILL_TIMEOUT_MS,
    signal: deps.signal,
    surface: 'memoryDistill',
  });
  if (!result) return null;

  const answer = result.answers.worth_retaining;
  if (answer?.type !== 'noul') return null;
  const retain = answer.noul >= RETAIN_THRESHOLD;

  recordJevDecision({
    surface: 'memoryDistill',
    model: result.model,
    questions: Object.keys(DISTILL_QUESTIONS),
    probabilities: jevAnswerProbabilities(result.answers),
    confidence: jevAnswerConfidences(result.answers),
    decision: retain ? 'retain' : 'skip',
    inputTokens: result.usage.input_tokens,
    usd: result.usage.input_tokens * USD_PER_INPUT_TOKEN,
  });

  return retain ? summary : null;
}
