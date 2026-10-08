import type { DecisionSettings, DecisionRoute, DecisionUsageReceipt } from '../../shared/decision-models';
import type { JudgeInput, JevResult } from '../jev/jev-client';
import { recordJevNoAnswer, type JevNoAnswerReason } from '../jev/jev-decision-log';
import { judgeClef, type ClefConnection } from './clef-client';
import { judgeLuna } from './luna-client';
import { resolveLunaApiKey } from './luna-credentials';
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
  resolveLunaKey?: () => string | undefined;
  fetch?: typeof fetch;
  now?: () => number;
}

/** Nothing was sent: a measured zero, so the journal never reads it as an unknown count. */
const NO_REQUEST_USAGE: DecisionUsageReceipt = { inputTokens: 0, usd: 0, requestCount: 0, durationMs: 0, usageIncomplete: false };
const INTERNAL_WARN_INTERVAL_MS = 60_000;
let lastInternalWarnAt = -Infinity;

/** Only the error class leaves this function: messages can carry paths, keys or page text. */
function warnInternalFailure(error: unknown, now: () => number): void {
  const at = now();
  const since = at - lastInternalWarnAt;
  if (since >= 0 && since < INTERNAL_WARN_INTERVAL_MS) return;
  lastInternalWarnAt = at;
  console.warn(`[decision-models] internal failure (${error instanceof Error ? error.name : 'unknown'})`);
}

function failureReason(error: unknown, input: JudgeInput, now: () => number): JevNoAnswerReason {
  if (input.signal?.aborted) return 'aborted';
  warnInternalFailure(error, now);
  return 'internal-error';
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
    if (currentInput.signal.aborted) return noAnswer(input, route, 'aborted', NO_REQUEST_USAGE);
    const watched = { ...currentInput, onUsage: (receipt: DecisionUsageReceipt) => { failureUsage = receipt; input.onUsage?.(receipt); },
      onNoAnswer: (reason: JevNoAnswerReason) => { noAnswer(input, route, reason, failureUsage); } };
    const connection = route.provider === 'clef' ? (deps.getClefConnection ?? (() => getClefConnection(settings)))() : undefined;
    const lunaKey = route.provider === 'luna' ? (deps.resolveLunaKey ?? resolveLunaApiKey)()?.trim() : undefined;
    const result = route.provider === 'jev'
      ? await deps.nativeJudge({ ...currentInput, model: route.model })
      : route.provider === 'luna'
        ? lunaKey ? await judgeLuna(watched, lunaKey, { fetch: deps.fetch, now: deps.now })
          : noAnswer(input, route, 'client-error', NO_REQUEST_USAGE)
        : connection ? await judgeClef(watched, { ...connection, model: route.model as ClefConnection['model'] }, { fetch: deps.fetch, now: deps.now })
          : noAnswer(input, route, 'client-error', NO_REQUEST_USAGE);
    if (!result) return null;
    const elapsed = (): number => result.durationMs ?? (deps.now ?? (() => performance.now()))() - started;
    if (currentInput.signal.aborted || configuration() !== before) return noAnswer(input, route, 'aborted', {
      inputTokens: result.usageMissing ? null : result.usage.input_tokens,
      usd: result.usageMissing ? null : decisionResultCostUsd({ ...result, route }),
      requestCount: result.requestCount ?? 1, durationMs: elapsed(), usageIncomplete: Boolean(result.usageMissing),
    });
    const actualRoute = { ...route, model: result.model };
    return { ...result, route: actualRoute, requestCount: result.requestCount ?? 1, durationMs: elapsed(),
      ...(result.usageMissing ? {} : { estimatedUsd: decisionResultCostUsd({ ...result, route: actualRoute }) }) };
  } catch (error) { return noAnswer(input, route, failureReason(error, currentInput, deps.now ?? Date.now)); }
  finally { unsubscribe(); }
}

/** Configuration and credential failures cannot escape the advisory decision boundary. */
export async function judgeDecision(input: JudgeInput, deps: DecisionJudgeDeps): Promise<JevResult | null> {
  try { return await performDecision(input, deps); }
  catch (error) { return noAnswer(input, null, failureReason(error, input, deps.now ?? Date.now)); }
}
