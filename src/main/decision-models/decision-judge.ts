import type { DecisionSettings, DecisionRoute, DecisionUsageReceipt } from '../../shared/decision-models';
import type { JudgeInput, JevResult } from '../jev/jev-client';
import { recordJevNoAnswer, type JevNoAnswerReason } from '../jev/jev-decision-log';
import { judgeClef, type ClefConnection } from './clef-client';
import { resolveDecisionRoute, type DecisionAvailability } from './decision-routing';
import { decisionConfigurationKey, getClefConnection, getDecisionAvailability, getDecisionSettings } from './decision-availability';
import { decisionResultCostUsd } from './decision-pricing';
import { onDecisionConfigurationChanged } from './decision-revision';

export interface DecisionJudgeDeps {
  nativeJudge: (input: JudgeInput) => Promise<JevResult | null>;
  getSettings?: () => DecisionSettings;
  getAvailability?: () => DecisionAvailability;
  getConfigurationKey?: () => string;
  getClefConnection?: () => ClefConnection | undefined;
  fetch?: typeof fetch;
  now?: () => number;
}

function noAnswer(input: JudgeInput, route: DecisionRoute | null, reason: JevNoAnswerReason, usage?: DecisionUsageReceipt): null {
  if (input.surface && route) recordJevNoAnswer({ surface: input.surface, model: route.model,
    sessionId: input.sessionId, missionId: input.missionId, reason, provider: route.provider, route, usage });
  try { input.onNoAnswer?.(reason); }
  catch { console.warn('[decision-models] no-answer callback failed'); }
  return null;
}

async function performDecision(input: JudgeInput, deps: DecisionJudgeDeps): Promise<JevResult | null> {
  const settings = (deps.getSettings ?? getDecisionSettings)();
  const available = (deps.getAvailability ?? (() => getDecisionAvailability(settings)))();
  const route = resolveDecisionRoute(input, settings, available);
  if (!route) {
    // Preserve the native client's no-key accounting without ever sending it images.
    if (settings.mode === 'jev' && !available.jev && !input.images?.length) return deps.nativeJudge(input);
    return noAnswer(input, null, input.signal?.aborted ? 'aborted' : 'client-error');
  }
  const configuration = deps.getConfigurationKey ?? decisionConfigurationKey;
  const before = configuration();
  const started = (deps.now ?? (() => performance.now()))();
  const revoked = new AbortController();
  const unsubscribe = onDecisionConfigurationChanged(() => revoked.abort());
  const currentInput = { ...input, signal: input.signal ? AbortSignal.any([input.signal, revoked.signal]) : revoked.signal };
  let failureUsage: DecisionUsageReceipt | undefined;
  try {
    if (currentInput.signal.aborted) return noAnswer(input, route, 'aborted');
    const connection = route.provider === 'clef' ? (deps.getClefConnection ?? (() => getClefConnection(settings)))() : undefined;
    const result = route.provider === 'jev'
      ? await deps.nativeJudge({ ...currentInput, model: route.model })
      : connection ? await judgeClef({ ...currentInput, onUsage: receipt => { failureUsage = receipt; input.onUsage?.(receipt); },
          onNoAnswer: reason => { noAnswer(input, route, reason, failureUsage); } },
          { ...connection, model: route.model as ClefConnection['model'] }, { fetch: deps.fetch, now: deps.now })
        : noAnswer(input, route, 'client-error');
    if (!result) return null;
    if (currentInput.signal.aborted || configuration() !== before) return noAnswer(input, route, 'aborted', {
      inputTokens: result.usage.input_tokens, usd: decisionResultCostUsd({ ...result, route }),
      requestCount: result.requestCount ?? 1, durationMs: result.durationMs ?? (deps.now ?? (() => performance.now()))() - started,
      usageIncomplete: false,
    });
    const actualRoute = { ...route, model: result.model };
    return { ...result, route: actualRoute, requestCount: result.requestCount ?? 1,
      durationMs: result.durationMs ?? (deps.now ?? (() => performance.now()))() - started,
      estimatedUsd: decisionResultCostUsd({ ...result, route: actualRoute }) };
  } catch { return noAnswer(input, route, currentInput.signal.aborted ? 'aborted' : 'network'); }
  finally { unsubscribe(); }
}

/** Configuration and credential failures cannot escape the advisory decision boundary. */
export async function judgeDecision(input: JudgeInput, deps: DecisionJudgeDeps): Promise<JevResult | null> {
  try { return await performDecision(input, deps); }
  catch { return noAnswer(input, null, input.signal?.aborted ? 'aborted' : 'network'); }
}
