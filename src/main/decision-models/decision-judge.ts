import type { DecisionSettings, DecisionRoute, DecisionUsageReceipt } from '../../shared/decision-models';
import type { JudgeInput, JevResult } from '../jev/jev-client';
import { recordJevDecision, recordJevNoAnswer, type JevNoAnswerReason } from '../jev/jev-decision-log';
import { judgeClef, type ClefConnection } from './clef-client';
import { judgeLuna } from './luna-client';
import { resolveLunaApiKey } from './luna-credentials';
import { combineEnsembleAnswers } from './decision-ensemble';
import {
  ensembleMembers, JEV_PINNED_SURFACES, REVERSIBLE_ENSEMBLE_SURFACES, resolveDecisionRoute, type DecisionAvailability,
} from './decision-routing';
import { decisionConfigurationKey, getClefConnection, getDecisionAvailability, getDecisionSettings } from './decision-availability';
import { decisionResultCostUsd, estimateDecisionCostUsd, estimateDecisionInputTokens } from './decision-pricing';
import { aggregateUsageReceipts, decisionResultUsage } from './decision-usage';
import { onDecisionConfigurationChanged } from './decision-revision';
import {
  decisionBudgetChargeForUsage, getDecisionBudgetLedger, type DecisionBudgetLedger, type DecisionBudgetReservation,
} from './decision-budget';
import { DECISION_ENGINE_POLICY, planAutoDecision } from './decision-engine';
import { isDecisionProviderBlocked, recordDecisionProviderFailure, recordDecisionProviderSuccess } from './decision-health';
import { readDecisionQualityTable, type DecisionQualityTable } from './decision-quality';
import { missionDecisionBudgetUsd } from '../../shared/decision-models';

export interface DecisionJudgeDeps {
  nativeJudge: (input: JudgeInput) => Promise<JevResult | null>;
  getSettings?: () => DecisionSettings;
  getAvailability?: () => DecisionAvailability;
  getConfigurationKey?: () => string;
  getClefConnection?: () => ClefConnection | undefined;
  resolveLunaKey?: () => string | undefined;
  fetch?: typeof fetch;
  now?: () => number;
  /** Livro de orçamento por missão (F-1164); padrão = o do processo, reconstruído do diário. */
  budgetLedger?: DecisionBudgetLedger;
  /** Tabela de qualidade do roteador v2 (F-1165); `null` = priors embutidos. */
  getQualityTable?: () => DecisionQualityTable | null;
}

/** Recibo visto por uma consulta com reserva: decide o acerto do orçamento. */
interface UsageTracker { usage?: DecisionUsageReceipt; noAnswerUsage?: DecisionUsageReceipt }
const usageTrackers = new WeakMap<object, UsageTracker>();

/** Nothing was sent: a measured zero, so the journal never reads it as an unknown count. */
const NO_REQUEST_USAGE: DecisionUsageReceipt = { inputTokens: 0, usd: 0, requestCount: 0, durationMs: 0, usageIncomplete: false };
/** A failure that reported no receipt (it threw): the spend is unknown, never zero. */
const UNKNOWN_USAGE: DecisionUsageReceipt = { inputTokens: null, usd: null, requestCount: 0, durationMs: 0, usageIncomplete: true };
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
  const tracker = usageTrackers.get(input);
  if (tracker && usage) tracker.noAnswerUsage = usage;
  // O dono da falha publica um recibo lógico, inclusive quando revoga uma resposta paga.
  if (usage) {
    try { input.onUsage?.(usage); }
    catch { console.warn('[decision-models] usage callback failed'); }
  }
  const budgetChargedUsd = input.budgetChargeFor?.(usage ?? tracker?.usage);
  if (input.surface && route) recordJevNoAnswer({ surface: input.surface, model: route.model,
    sessionId: input.sessionId, missionId: input.missionId, reason, provider: route.provider, route, usage,
    ...(budgetChargedUsd === undefined ? {} : { budgetChargedUsd }) });
  try { input.onNoAnswer?.(reason); }
  catch { console.warn('[decision-models] no-answer callback failed'); }
  return null;
}

async function callMember(
  input: JudgeInput, deps: DecisionJudgeDeps, member: DecisionRoute, settings: DecisionSettings,
): Promise<JevResult | null> {
  const connection = member.provider === 'clef' ? (deps.getClefConnection ?? (() => getClefConnection(settings)))() : undefined;
  const lunaKey = member.provider === 'luna' ? (deps.resolveLunaKey ?? resolveLunaApiKey)()?.trim() : undefined;
  if (member.provider === 'jev') return deps.nativeJudge({ ...input, images: undefined, audio: undefined, model: member.model });
  if (member.provider === 'luna') return lunaKey ? judgeLuna(input, lunaKey, { fetch: deps.fetch, now: deps.now }) : null;
  return connection ? judgeClef(input, { ...connection, model: member.model as ClefConnection['model'] }, { fetch: deps.fetch, now: deps.now }) : null;
}

/** v2 guarda o porquê legível; v1 mantém o rótulo que a tela já reconhece. */
function ensembleLead(member: DecisionRoute): DecisionRoute {
  return { ...member, model: 'ensemble', reason: member.policyVersion === DECISION_ENGINE_POLICY ? member.reason : 'ensemble' };
}

async function performEnsemble(
  input: JudgeInput, deps: DecisionJudgeDeps, settings: DecisionSettings, requested: DecisionRoute[],
  /** v2 em surface reversível: falha parcial devolve quem respondeu. Juntos (v1) nunca. */
  options: { partialFallback?: boolean } = {},
): Promise<JevResult | null> {
  const blocked = requested.filter(member => isDecisionProviderBlocked(member.provider));
  const members = requested.filter(member => !blocked.includes(member));
  // Um membro com o disjuntor aberto recusa o conjunto escolhido: um provedor sozinho nunca responde por
  // ele (docs/SECURITY.md), senão o veto do conjunto some. Só o parcial reversível segue com quem restou.
  if (!members.length || (blocked.length > 0 && !options.partialFallback)) {
    return noAnswer(input, requested[0] ? ensembleLead(requested[0]) : null, 'network', NO_REQUEST_USAGE);
  }
  const lead = ensembleLead(members[0]);
  const configuration = deps.getConfigurationKey ?? decisionConfigurationKey;
  const before = configuration();
  const started = (deps.now ?? (() => performance.now()))();
  const revoked = new AbortController();
  const unsubscribe = onDecisionConfigurationChanged(() => revoked.abort());
  const currentInput = { ...input, signal: input.signal ? AbortSignal.any([input.signal, revoked.signal]) : revoked.signal };
  const receipts: DecisionUsageReceipt[] = members.map(() => ({ ...NO_REQUEST_USAGE }));
  const finishNoAnswer = (reason: JevNoAnswerReason): null => {
    const usage = aggregateUsageReceipts(receipts);
    return noAnswer(input, lead, reason, usage);
  };
  try {
    if (currentInput.signal.aborted) return finishNoAnswer('aborted');
    if (members.some(member => member.provider === 'luna') && !(deps.resolveLunaKey ?? resolveLunaApiKey)()?.trim()) {
      return finishNoAnswer('client-error');
    }
    if (members.some(member => member.provider === 'clef') && !(deps.getClefConnection ?? (() => getClefConnection(settings)))()) {
      return finishNoAnswer('client-error');
    }
    let firstFailure: JevNoAnswerReason | undefined;
    // Each member settles before the owner journals; one rejected member must not lose its peers' spend.
    const results = await Promise.all(members.map(async (member, index) => {
      let reported: DecisionUsageReceipt | undefined;
      let memberReason: JevNoAnswerReason | undefined;
      receipts[index] = { inputTokens: null, usd: null, requestCount: 0, durationMs: 0, usageIncomplete: true };
      try {
        const result = await callMember({ ...currentInput, surface: undefined,
          onUsage: receipt => { reported = receipt; receipts[index] = receipt; },
          onNoAnswer: reason => { memberReason = reason; firstFailure ??= reason; },
        }, deps, member, settings);
        if (result) {
          recordDecisionProviderSuccess(member.provider);
          const receipt = decisionResultUsage({ ...result, route: member });
          receipts[index] = reported ?? { inputTokens: receipt.inputTokens, usd: receipt.usd,
            requestCount: receipt.requestCount ?? 1, durationMs: receipt.durationMs ?? (deps.now ?? (() => performance.now()))() - started,
            usageIncomplete: Boolean(receipt.usageIncomplete) };
          return result;
        }
        recordDecisionProviderFailure(member.provider, memberReason ?? 'client-error');
        return null;
      } catch (error) {
        const reason = failureReason(error, currentInput, deps.now ?? Date.now);
        firstFailure ??= reason;
        recordDecisionProviderFailure(member.provider, reason);
        return null;
      }
    }));
    const usage = aggregateUsageReceipts(receipts);
    const answeredIndex = results.findIndex(Boolean);
    const unanswered = members.filter((_, index) => !results[index]);
    // Quem restou sozinho porque os pares estão com o disjuntor aberto não é conjunto: segue como parcial.
    if (unanswered.length > 0 || (blocked.length > 0 && members.length === 1)) {
      if (!options.partialFallback || answeredIndex < 0) return finishNoAnswer(firstFailure ?? 'client-error');
      if (currentInput.signal.aborted || configuration() !== before) return finishNoAnswer('aborted');
      // Reversível: a resposta válida de um membro não se perde porque o outro caiu (429, timeout, disjuntor aberto).
      const member = members[answeredIndex];
      const survivor = results[answeredIndex]!;
      const silent = [...blocked, ...unanswered].map(peer => peer.model).join(', ');
      const silentReason = firstFailure ?? (unanswered.length > 0 ? 'client-error' : 'network');
      const elapsedPartial = (deps.now ?? (() => performance.now()))() - started;
      return {
        ...survivor, route: { ...member, reason: `${member.reason} · parcial: ${silent} sem resposta (${silentReason})` },
        diverged: undefined, ensemblePeers: undefined,
        requestCount: usage.requestCount, durationMs: usage.durationMs ?? elapsedPartial,
        usage: { input_tokens: usage.inputTokens ?? 0, output_tokens: 0 }, usageReceipt: usage,
        ...(usage.usageIncomplete ? { usageMissing: true as const } : {}),
        ...(usage.usd === null ? {} : { estimatedUsd: usage.usd }),
      };
    }
    if (currentInput.signal.aborted || configuration() !== before) return finishNoAnswer('aborted');
    const answered = results as JevResult[];
    const combined = combineEnsembleAnswers(members.map((member, index) => ({ provider: member.provider, answers: answered[index].answers })), input.surface);
    if (!combined.ok) return finishNoAnswer('divergent');
    if (combined.diverged && input.surface) {
      recordJevDecision({
        surface: input.surface, sessionId: input.sessionId, missionId: input.missionId, model: 'ensemble',
        decision: 'diverged', diverged: true, questions: Object.keys(combined.peers), probabilities: {},
        ensemblePeers: combined.peers, inputTokens: null, usd: null, requestCount: 0, route: lead,
      });
    }
    const elapsed = (deps.now ?? (() => performance.now()))() - started;
    return {
      model: 'ensemble', answers: combined.answers, route: lead, diverged: combined.diverged, ensemblePeers: combined.peers,
      requestCount: usage.requestCount, durationMs: usage.durationMs ?? elapsed,
      usage: { input_tokens: usage.inputTokens ?? 0, output_tokens: 0 }, usageReceipt: usage,
      ...(usage.usageIncomplete ? { usageMissing: true as const } : {}),
      ...(usage.usd === null ? {} : { estimatedUsd: usage.usd }),
    };
  } catch (error) { return finishNoAnswer(failureReason(error, currentInput, deps.now ?? Date.now)); }
  finally { unsubscribe(); }
}

/**
 * Acerto pelo recibo real. Sem recibo (falha sem medição) o estimado fica:
 * custo desconhecido nunca vira zero. Nenhuma requisição = devolve a reserva.
 */
function settleReservation(
  ledger: DecisionBudgetLedger, reservation: DecisionBudgetReservation, result: JevResult | null, tracker: UsageTracker,
): number {
  if (result) {
    const usage = decisionResultUsage(result);
    return ledger.settle(reservation, usage.usd, Boolean(usage.usageIncomplete));
  }
  const usage = tracker.noAnswerUsage ?? tracker.usage;
  if (!usage) return ledger.settle(reservation, null);
  if (usage.requestCount === 0) return ledger.settle(reservation, 0);
  return ledger.settle(reservation, usage.usd, usage.usageIncomplete);
}

async function runReserved(
  input: JudgeInput, ledger: DecisionBudgetLedger, reservation: DecisionBudgetReservation | null,
  run: (input: JudgeInput) => Promise<JevResult | null>,
): Promise<JevResult | null> {
  if (!reservation) return run(input);
  const tracker: UsageTracker = {};
  const tracked: JudgeInput = { ...input,
    onUsage: receipt => { tracker.usage = receipt; input.onUsage?.(receipt); },
    // A linha `no-answer` anota o mesmo valor que o acerto cobra (reconstrução após reinício).
    budgetChargeFor: usage => decisionBudgetChargeForUsage(reservation.estimatedUsd, usage) };
  usageTrackers.set(tracked, tracker);
  let result: JevResult | null = null;
  let charged: number | undefined;
  try {
    result = await run(tracked);
  } finally {
    try { charged = settleReservation(ledger, reservation, result, tracker); }
    catch { console.warn('[decision-models] budget settle failed'); }
  }
  // A surface grava a decisão com `decisionResultUsage(result)`: o cobrado vai junto ao diário.
  return result && charged !== undefined ? { ...result, budgetChargedUsd: charged } : result;
}

function estimateRoutesUsd(input: JudgeInput, routes: readonly DecisionRoute[]): number {
  const tokens = estimateDecisionInputTokens(input);
  return routes.reduce((sum, route) => sum + estimateDecisionCostUsd(tokens, route.provider, route.model), 0);
}

/** Automático: roteador v2 + orçamento da missão. Só o Automático recusa por orçamento. */
async function performAutoDecision(
  input: JudgeInput, deps: DecisionJudgeDeps, settings: DecisionSettings, available: DecisionAvailability,
): Promise<JevResult | null> {
  const ledger = deps.budgetLedger ?? getDecisionBudgetLedger();
  const budgetUsd = missionDecisionBudgetUsd(settings);
  const missionId = input.missionId;
  let quality: DecisionQualityTable | null = null;
  try { quality = (deps.getQualityTable ?? readDecisionQualityTable)(); } catch { quality = null; }
  // Surfaces fixas no Jev (limiares calibrados) só contabilizam: classificação de fundo não as cala.
  const pinned = Boolean(input.surface && JEV_PINNED_SURFACES.has(input.surface));
  const level = missionId && !pinned ? ledger.snapshot(missionId, budgetUsd).level : 'normal';
  let plan = planAutoDecision(input, settings, available, { budgetLevel: level, quality });
  if (!plan) {
    const reason: JevNoAnswerReason = input.signal?.aborted ? 'aborted' : 'client-error';
    // Nem v2 nem v1 têm rota: a consulta ainda deixa a sua linha no diário.
    if (input.surface) recordJevNoAnswer({ surface: input.surface, model: 'unrouted', reason,
      sessionId: input.sessionId, missionId: input.missionId, requestCount: 0 });
    return noAnswer(input, null, reason, NO_REQUEST_USAGE);
  }
  let reservation: DecisionBudgetReservation | null = null;
  if (missionId) {
    reservation = ledger.reserve(missionId, plan.estimatedUsd, budgetUsd, !pinned);
    // O plano cheio não cabe: tenta o mais barato elegível antes de recusar.
    if (!reservation && level === 'normal') {
      const cheaper = planAutoDecision(input, settings, available, { budgetLevel: 'soft', quality });
      reservation = cheaper ? ledger.reserve(missionId, cheaper.estimatedUsd, budgetUsd) : null;
      if (reservation && cheaper) plan = cheaper;
    }
    if (!reservation) {
      return noAnswer(input, plan.members ? { ...plan.route, model: 'ensemble' } : plan.route, 'budget', NO_REQUEST_USAGE);
    }
  }
  const chosen = plan;
  const partialFallback = Boolean(input.surface && REVERSIBLE_ENSEMBLE_SURFACES.has(input.surface));
  return runReserved(input, ledger, reservation, tracked => chosen.members
    ? performEnsemble(tracked, deps, settings, chosen.members, { partialFallback })
    : performFailover(tracked, deps, settings, [chosen.route, ...(chosen.fallbacks ?? [])]));
}

async function performDecision(input: JudgeInput, deps: DecisionJudgeDeps): Promise<JevResult | null> {
  const settings = (deps.getSettings ?? getDecisionSettings)();
  const available = (deps.getAvailability ?? (() => getDecisionAvailability(settings)))();
  if (settings.mode === 'auto') return performAutoDecision(input, deps, settings, available);
  // Modos explícitos: a escolha do operador vence. O livro só contabiliza, nunca recusa.
  const ledger = deps.budgetLedger ?? getDecisionBudgetLedger();
  const account = (routes: readonly DecisionRoute[]): DecisionBudgetReservation | null => input.missionId
    ? ledger.reserve(input.missionId, estimateRoutesUsd(input, routes), missionDecisionBudgetUsd(settings), false) : null;
  if (settings.mode === 'together') {
    const members = ensembleMembers(input, settings, available);
    if (members) return runReserved(input, ledger, account(members), tracked => performEnsemble(tracked, deps, settings, members));
    if (input.surface && !(input.surface === 'computerTool' || input.surface === 'browserTool') || input.images?.length) {
      if (input.surface) recordJevNoAnswer({ surface: input.surface, model: 'ensemble', reason: 'client-error',
        sessionId: input.sessionId, missionId: input.missionId, requestCount: 0 });
      return noAnswer(input, null, 'client-error', NO_REQUEST_USAGE);
    }
  }
  const route = resolveDecisionRoute(input, settings, available);
  if (!route) {
    // Preserve the native client's no-key accounting without ever sending it images.
    if (settings.mode === 'jev' && !available.jev && !input.images?.length) return deps.nativeJudge({ ...input, audio: undefined });
    return noAnswer(input, null, input.signal?.aborted ? 'aborted' : 'client-error', NO_REQUEST_USAGE);
  }
  return runReserved(input, ledger, account([route]), tracked => performRoute(tracked, deps, settings, route));
}

/** `usage` ausente = a rota lançou sem reportar: o gasto é desconhecido, não zero. */
interface RouteFailure { ok: false; reason: JevNoAnswerReason; usage?: DecisionUsageReceipt }
type RouteExecution = { ok: true; result: JevResult } | RouteFailure;

/** O recibo de um resultado: o do cliente quando ele mediu um; senão o que o resultado informa. */
function resultReceipt(result: JevResult, route: DecisionRoute, elapsed: number): DecisionUsageReceipt {
  const receipt = decisionResultUsage({ ...result, route });
  return {
    inputTokens: receipt.inputTokens, usd: receipt.usd,
    requestCount: receipt.requestCount ?? result.requestCount ?? 1,
    durationMs: receipt.durationMs ?? elapsed, usageIncomplete: Boolean(receipt.usageIncomplete),
  };
}

/**
 * `now` grava o diário na hora (rota única).
 * `later` engole o aviso: a cadeia soma o recibo de cada tentativa e publica uma vez só.
 * O Jev com surface grava no próprio cliente; Clef e Luna gravam aqui.
 */
async function executeRoute(
  input: JudgeInput, deps: DecisionJudgeDeps, settings: DecisionSettings, route: DecisionRoute,
  report: 'now' | 'later',
): Promise<RouteExecution> {
  const configuration = deps.getConfigurationKey ?? decisionConfigurationKey;
  const before = configuration();
  const started = (deps.now ?? (() => performance.now()))();
  const revoked = new AbortController();
  const unsubscribe = onDecisionConfigurationChanged(() => revoked.abort());
  const currentInput = { ...input, signal: input.signal ? AbortSignal.any([input.signal, revoked.signal]) : revoked.signal };
  let failureUsage: DecisionUsageReceipt | undefined;
  let capturedReason: JevNoAnswerReason | undefined;
  try {
    if (currentInput.signal.aborted) {
      if (report === 'now') noAnswer(input, route, 'aborted', NO_REQUEST_USAGE);
      return { ok: false, reason: 'aborted', usage: NO_REQUEST_USAGE };
    }
    const watched: JudgeInput = {
      ...currentInput,
      ...(report === 'later' ? { surface: undefined } : {}),
      onUsage: receipt => {
        failureUsage = receipt;
        // F-1548: falha de Luna/Clef publica o recibo via noAnswer; só o Jev repassa direto.
        if (report === 'now' && route.provider === 'jev') input.onUsage?.(receipt);
      },
      onNoAnswer: reason => {
        capturedReason = reason;
        if (report !== 'now') return;
        if (route.provider === 'jev') {
          try { input.onNoAnswer?.(reason); }
          catch { console.warn('[decision-models] no-answer callback failed'); }
          return;
        }
        noAnswer(input, route, reason, failureUsage);
      },
    };
    const connection = route.provider === 'clef' ? (deps.getClefConnection ?? (() => getClefConnection(settings)))() : undefined;
    const lunaKey = route.provider === 'luna' ? (deps.resolveLunaKey ?? resolveLunaApiKey)()?.trim() : undefined;
    let result: JevResult | null;
    if (route.provider === 'jev') result = await deps.nativeJudge({ ...watched, audio: undefined, model: route.model });
    else if (route.provider === 'luna') {
      if (!lunaKey) {
        if (report === 'now') noAnswer(input, route, 'client-error', NO_REQUEST_USAGE);
        return { ok: false, reason: 'client-error', usage: NO_REQUEST_USAGE };
      }
      result = await judgeLuna(watched, lunaKey, { fetch: deps.fetch, now: deps.now });
    } else if (!connection) {
      if (report === 'now') noAnswer(input, route, 'client-error', NO_REQUEST_USAGE);
      return { ok: false, reason: 'client-error', usage: NO_REQUEST_USAGE };
    } else {
      result = await judgeClef(watched, { ...connection, model: route.model as ClefConnection['model'] }, { fetch: deps.fetch, now: deps.now });
    }
    // Os clientes só reportam o recibo quando enviaram algo: sem relatório = nenhuma requisição saiu.
    if (!result) return { ok: false, reason: capturedReason ?? 'client-error', usage: failureUsage ?? NO_REQUEST_USAGE };
    const elapsed = result.durationMs ?? (deps.now ?? (() => performance.now()))() - started;
    if (currentInput.signal.aborted || configuration() !== before) {
      const usage = resultReceipt(result, route, elapsed);
      if (report === 'now') noAnswer(input, route, 'aborted', usage);
      return { ok: false, reason: 'aborted', usage };
    }
    const actualRoute = { ...route, model: result.model };
    return { ok: true, result: { ...result, route: actualRoute, requestCount: result.requestCount ?? 1, durationMs: elapsed,
      ...(result.usageMissing ? {} : { estimatedUsd: decisionResultCostUsd({ ...result, route: actualRoute }) }) } };
  } catch (error) {
    const reason = failureReason(error, currentInput, deps.now ?? Date.now);
    if (report === 'now') noAnswer(input, route, reason, failureUsage);
    return { ok: false, reason, usage: failureUsage };
  } finally { unsubscribe(); }
}

async function performRoute(
  input: JudgeInput, deps: DecisionJudgeDeps, settings: DecisionSettings, route: DecisionRoute,
): Promise<JevResult | null> {
  if (isDecisionProviderBlocked(route.provider)) return noAnswer(input, route, 'network', NO_REQUEST_USAGE);
  const execution = await executeRoute(input, deps, settings, route, 'now');
  if (execution.ok) {
    recordDecisionProviderSuccess(route.provider);
    return execution.result;
  }
  recordDecisionProviderFailure(route.provider, execution.reason);
  return null;
}

/**
 * Primário, depois `fallbacks`. Abort e orçamento param a cadeia. Aberto não conta falha nova.
 * Toda tentativa gasta de verdade: o recibo de quem falhou soma ao de quem responde (ou ao da
 * falha final), e a cadeia reporta e grava o diário uma vez só.
 */
async function performFailover(
  input: JudgeInput, deps: DecisionJudgeDeps, settings: DecisionSettings, routes: readonly DecisionRoute[],
): Promise<JevResult | null> {
  const open = routes.filter(route => !isDecisionProviderBlocked(route.provider));
  if (!open.length) return noAnswer(input, routes[0] ?? null, 'network', NO_REQUEST_USAGE);
  const last = open.length - 1;
  // Sem fallback não há o que somar: a rota única segue o caminho de sempre.
  if (!last) return performRoute(input, deps, settings, open[0]);
  const failed: DecisionUsageReceipt[] = [];
  const total = (receipts: readonly DecisionUsageReceipt[]): DecisionUsageReceipt => {
    const usage = aggregateUsageReceipts(receipts);
    try { input.onUsage?.(usage); }
    catch { console.warn('[decision-models] usage callback failed'); }
    return usage;
  };
  for (let index = 0; index <= last; index++) {
    const route = open[index];
    // A última rota confere o disjuntor de novo: ele pode ter aberto durante as tentativas anteriores.
    if (index === last && isDecisionProviderBlocked(route.provider)) {
      return noAnswer(input, route, 'network', total([...failed, NO_REQUEST_USAGE]));
    }
    const execution = await executeRoute(input, deps, settings, route, 'later');
    if (execution.ok) {
      recordDecisionProviderSuccess(route.provider);
      const usage = total([...failed, resultReceipt(execution.result, route, execution.result.durationMs ?? 0)]);
      return { ...execution.result, requestCount: usage.requestCount, durationMs: usage.durationMs, usageReceipt: usage,
        ...(usage.usageIncomplete ? { usageMissing: true as const } : {}),
        ...(usage.usd === null ? { estimatedUsd: undefined } : { estimatedUsd: usage.usd }) };
    }
    failed.push(execution.usage ?? UNKNOWN_USAGE);
    const stopped = execution.reason === 'aborted' || execution.reason === 'budget';
    // Abort e orçamento de uma rota que não é a última encerram a cadeia sem mexer no disjuntor dela.
    if (index === last || !stopped) recordDecisionProviderFailure(route.provider, execution.reason);
    if (index === last || stopped) return noAnswer(input, route, execution.reason, total(failed));
  }
  return null;
}

/** Configuration and credential failures cannot escape the advisory decision boundary. */
export async function judgeDecision(input: JudgeInput, deps: DecisionJudgeDeps): Promise<JevResult | null> {
  try { return await performDecision(input, deps); }
  catch (error) { return noAnswer(input, null, failureReason(error, input, deps.now ?? Date.now)); }
}
