/**
 * F-1166: surfaces CONSULTIVAS de fase da missão, comuns à convencional e ao
 * "+ Pane": missionKickoff, reviewTriage, recoveryAdvice, completionCheck.
 *
 * Doutrina: nunca bloqueiam. Os `schedule*` voltam na hora (o judge roda fora
 * do caminho crítico); prazo curto, sem retry; toggle desligado, sem
 * credencial, orçamento esgotado, timeout, erro ou resposta inválida = nenhuma
 * dica. Cada consulta passa o missionId (consome o orçamento da missão) e a
 * dica registra rota e custo. O que vai ao modelo é redigido e limitado.
 */
import { createHash } from 'node:crypto';
import type {
  MissionCompletionHint, MissionDecisionHintReceipt, MissionKickoffHint, MissionRecoveryHint, MissionReviewTriageHint,
  RecoveryTriggerClass,
} from '../../shared/orch-types';
import { missionDecisionBudgetUsd } from '../../shared/decision-models';
import { neutralizeLimitSignals } from '../../shared/limit-signal-patterns';
import { getDecisionBudgetLedger, type DecisionBudgetLevel } from '../decision-models/decision-budget';
import { capText, redactSecrets } from '../decision-models/decision-redaction';
import { decisionResultUsage } from '../decision-models/decision-usage';
import { getDecisionSettings, hasDecisionCredential } from '../decision-models/decision-availability';
import { judge, type JevAnswer, type JevQuestion, type JevResult } from '../jev/jev-client';
import { isJevSurfaceEnabled, type JevSurface } from '../jev/jev-autopilot';
import { jevAnswerProbabilities, recordJevDecision } from '../jev/jev-decision-log';
import {
  getMissionDecisionHints, recordCompletionHint, recordKickoffHint, recordMissionFinalized, recordRecoveryHint,
  recordReviewTriageHint, reviewTriageHintFor,
} from './mission-decision-hints';

export type AdvisorySurface = Extract<JevSurface, 'missionKickoff' | 'reviewTriage' | 'recoveryAdvice' | 'completionCheck'>;

export const ADVISORY_TIMEOUT_MS = 8_000;
export const REVIEW_RISK_THRESHOLD = 0.6;
export const COMPLETION_COVERAGE_THRESHOLD = 0.5;
const MAX_TEXT = 1_500;
const MAX_FILES = 40;
const MAX_HANDOFFS = 20;
const MAX_CRITERIA = 12;

export interface AdvisoryDeps {
  readonly judge?: typeof judge;
  readonly enabled?: (surface: AdvisorySurface) => boolean;
  readonly hasKey?: (surface: AdvisorySurface) => boolean;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

/**
 * Texto ao modelo: segredos redigidos e teto de tamanho (nunca diff inteiro).
 * Cabeça + cauda (F-1346): o pedido de ação de um goal longo costuma estar no
 * fim — cortando só a cauda, o kickoff respondia small/1 worker/0 escritas.
 */
function safeText(value: string | undefined, max = MAX_TEXT): string {
  return capText(redactSecrets(value ?? ''), max, { keepEnds: true });
}

interface AdvisoryOutcome { result: JevResult; receipt: MissionDecisionHintReceipt }

async function consult(
  surface: AdvisorySurface, missionId: string, state: unknown, questions: Record<string, JevQuestion>,
  decision: (answers: Record<string, JevAnswer>) => string | null, deps: AdvisoryDeps,
): Promise<AdvisoryOutcome | null> {
  try {
    if (!missionId) return null;
    if (!(deps.enabled ?? isJevSurfaceEnabled)(surface)) return null;
    if (!(deps.hasKey ?? hasDecisionCredential)(surface)) return null;
    const timeoutMs = deps.timeoutMs ?? ADVISORY_TIMEOUT_MS;
    // Sem resposta (orçamento, timeout, erro, toggle no meio): nenhuma dica.
    const result = await (deps.judge ?? judge)({
      state, questions, surface, missionId, timeoutMs, retryOnTimeout: false,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!result) return null;
    const label = decision(result.answers);
    if (!label) return null;
    const usage = decisionResultUsage(result);
    const probabilities = jevAnswerProbabilities(result.answers);
    try {
      recordJevDecision({ surface, missionId, model: result.model, questions: Object.keys(questions), probabilities,
        decision: label, ...usage });
    } catch { /* o diário nunca bloqueia */ }
    return { result, receipt: {
      at: (deps.now ?? Date.now)(), model: result.model, ...(result.route ? { route: result.route } : {}),
      usd: usage.usd ?? null, ...(typeof usage.budgetChargedUsd === 'number' ? { budgetChargedUsd: usage.budgetChargedUsd } : {}),
      probabilities,
    } };
  } catch {
    return null;
  }
}

/** Dispara fora do caminho crítico: o chamador nunca espera, nunca vê erro. */
function fireAndForget(task: () => Promise<unknown>): void {
  const run = (): void => { void task().catch(() => undefined); };
  try {
    const handle = setImmediate(run);
    handle.unref?.();
  } catch {
    run();
  }
}

function noul(answers: Record<string, JevAnswer>, id: string): number | null {
  const answer = answers[id];
  return answer?.type === 'noul' ? answer.noul : null;
}

function choice(answers: Record<string, JevAnswer>, id: string): { choice: string; confidence: number } | null {
  const answer = answers[id];
  return answer?.type === 'choice' ? { choice: answer.choice, confidence: answer.confidence } : null;
}

// ─── missionKickoff ──────────────────────────────────────────────────────────

export interface MissionKickoffFacts {
  readonly missionId: string;
  readonly origin: 'conventional' | 'pane';
  readonly goal: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly lane?: string;
  readonly risk?: string;
  readonly maxWorkers: number;
}

const COMPLEXITY_LEVELS = ['trivial', 'small', 'medium', 'large'] as const;
const LANES = ['standard', 'consult', 'plan', 'ops'] as const;
const MAX_WORKER_CHOICES = 6;

/**
 * "+ Pane" promovido sem objetivo digitado: o goal efetivo cai no título da
 * aba ("Missão · Meus terminais 3", padrão de tabMissionTitle). Consultar o
 * modelo com isso só devolve small/1 worker inútil e polui as dicas — a
 * consulta espera um objetivo real chegar.
 */
const PLACEHOLDER_TAB_GOAL =
  /^(?:missão|mission)\s*·\s*(?:meus\s+terminais|terminais)?\s*\d*\s*$|^missão da aba$/i;

/** O goal é só o nome automático da aba, sem descrição real da missão? */
export function isTabPlaceholderGoal(goal: string): boolean {
  return PLACEHOLDER_TAB_GOAL.test(goal.trim());
}

export function missionKickoffQuestions(maxWorkers: number): Record<string, JevQuestion> {
  const questions: Record<string, JevQuestion> = {
    complexity: { type: 'score', instructions: 'How complex is this mission to deliver well?',
      criteria: ['0: trivial — one quick change or answer', '1: small — one focused piece of work',
        '2: medium — several related pieces', '3: large — many pieces, cross-cutting work'] },
    lane: { type: 'choice', instructions: 'Which lane fits this mission best?', criteria: {
      standard: 'write and change code, with tests', consult: 'answer or investigate; no code changes',
      plan: 'produce a plan or document before any code', ops: 'operate, deploy or run commands' } },
  };
  const cap = Math.min(Math.max(0, Math.floor(maxWorkers)), MAX_WORKER_CHOICES);
  // Zero/um worker já é determinado pelo teto; choice exige ao menos duas opções.
  if (cap >= 2) {
    questions.workers = { type: 'choice', instructions:
      `How many parallel workers should the orchestrator open at first (at most ${cap})? More only when the pieces are independent.`,
    criteria: Object.fromEntries(Array.from({ length: cap }, (_, index) => [String(index + 1),
      index === 0 ? 'one worker: the work is sequential or small' : `${index + 1} workers on independent pieces`])) };
  }
  return questions;
}

export async function adviseMissionKickoff(facts: MissionKickoffFacts, deps: AdvisoryDeps = {}): Promise<MissionKickoffHint | null> {
  // Goal placeholder de aba não tem o que aconselhar: nada de chamada ao modelo.
  if (isTabPlaceholderGoal(facts.goal)) return null;
  const maxWorkers = Math.max(0, Math.floor(facts.maxWorkers));
  const questions = missionKickoffQuestions(maxWorkers);
  const state = {
    goal: safeText(facts.goal),
    acceptanceCriteria: (facts.acceptanceCriteria ?? []).slice(0, MAX_CRITERIA).map(item => safeText(item, 300)),
    currentLane: facts.lane ?? 'standard', risk: facts.risk ?? 'normal', maxWorkers,
  };
  const captured: { hint?: Omit<MissionKickoffHint, keyof MissionDecisionHintReceipt> } = {};
  const outcome = await consult('missionKickoff', facts.missionId, state, questions, answers => {
    const complexity = answers.complexity;
    const lane = choice(answers, 'lane');
    if (complexity?.type !== 'score' || !lane || !(LANES as readonly string[]).includes(lane.choice)) return null;
    const workersChoice = choice(answers, 'workers');
    const workers = maxWorkers === 0 ? 0
      : Math.min(maxWorkers, Math.max(1, Number.parseInt(workersChoice?.choice ?? '1', 10) || 1));
    const level = COMPLEXITY_LEVELS[Math.min(3, Math.max(0, Math.round(complexity.score)))];
    captured.hint = { origin: facts.origin, complexity: complexity.score,
      complexityLevel: level, workers, maxWorkers, lane: lane.choice as MissionKickoffHint['lane'], laneConfidence: lane.confidence };
    return `kickoff:${level}/${workers}w/${lane.choice}`;
  }, deps);
  if (!outcome || !captured.hint) return null;
  const complete: MissionKickoffHint = { ...captured.hint, ...outcome.receipt };
  recordKickoffHint(facts.missionId, complete);
  return complete;
}

const kickoffStarted = new Set<string>();

/**
 * Uma vez por missão por processo (retry de bootstrap não repete a consulta).
 * Goal ainda placeholder de aba NÃO marca a missão como consultada: quando o
 * objetivo real chegar, a próxima chamada dispara a consulta.
 */
export function scheduleMissionKickoffAdvice(facts: MissionKickoffFacts, deps: AdvisoryDeps = {}): void {
  if (!facts.missionId || kickoffStarted.has(facts.missionId)) return;
  if (isTabPlaceholderGoal(facts.goal)) return;
  kickoffStarted.add(facts.missionId);
  fireAndForget(() => adviseMissionKickoff(facts, deps));
}

// ─── reviewTriage ────────────────────────────────────────────────────────────

export interface ReviewTriageFacts {
  readonly missionId: string;
  readonly handoffId: string;
  readonly summary: string;
  readonly declaredFiles: readonly string[];
  readonly goal?: string;
  readonly lane?: string;
}

export const REVIEW_TRIAGE_QUESTIONS: Record<string, JevQuestion> = {
  regression_risk: { type: 'noul', instructions:
    'Given this code handoff (summary and touched files), how likely is it to introduce a regression that ' +
    'an independent reviewer would catch? Broad, cross-cutting, security- or data-sensitive changes with weak ' +
    'verification are high risk; small, well-tested, isolated changes are low risk.',
  criteria: { true: 'high regression risk: an independent review is worth it', false: 'low risk: the handoff can be accepted as is' } },
};

export async function adviseReviewTriage(facts: ReviewTriageFacts, deps: AdvisoryDeps = {}): Promise<MissionReviewTriageHint | null> {
  const state = {
    summary: safeText(facts.summary),
    filesTouched: facts.declaredFiles.length,
    files: facts.declaredFiles.slice(0, MAX_FILES).map(file => safeText(file, 200)),
    goal: safeText(facts.goal, 600), lane: facts.lane ?? 'standard',
  };
  const captured: { risk?: number } = {};
  const outcome = await consult('reviewTriage', facts.missionId, state, REVIEW_TRIAGE_QUESTIONS, answers => {
    const value = noul(answers, 'regression_risk');
    if (value === null) return null;
    captured.risk = value;
    return value >= REVIEW_RISK_THRESHOLD ? 'review:independent' : 'review:accept';
  }, deps);
  const risk = captured.risk;
  if (!outcome || risk === undefined) return null;
  const hint: MissionReviewTriageHint = { ...outcome.receipt, handoffId: facts.handoffId, regressionRisk: risk,
    recommendIndependentReview: risk >= REVIEW_RISK_THRESHOLD };
  recordReviewTriageHint(facts.missionId, hint);
  return hint;
}

const triaged = new Set<string>();

export function scheduleReviewTriageAdvice(facts: ReviewTriageFacts, deps: AdvisoryDeps = {}): void {
  const key = `${facts.missionId}\0${facts.handoffId}`;
  if (!facts.missionId || !facts.handoffId || triaged.has(key)) return;
  triaged.add(key);
  fireAndForget(() => adviseReviewTriage(facts, deps));
}

/** A linha que o orquestrador lê no nexus_handoff_list (o veredito do handoffReview não muda). */
export function reviewTriageContextLine(hint: MissionReviewTriageHint): string {
  const percent = Math.round(hint.regressionRisk * 100);
  return hint.recommendIndependentReview
    ? `[motor de decisão] risco de regressão ${percent}%: considere uma revisão independente antes de aceitar.`
    : `[motor de decisão] risco de regressão ${percent}%: revisão independente dispensável.`;
}

/**
 * A triagem vira UMA linha de contexto na própria linha do handoff (só a da
 * missão listada). O veredito do handoffReview não muda.
 */
export function withReviewTriageLines<T>(rows: T[], missionId: string | null): Array<T | Record<string, unknown>> {
  if (!missionId) return rows;
  return rows.map((row) => {
    try {
      const id = (row as { id?: unknown }).id;
      const rowMission = (row as { missionId?: unknown }).missionId;
      if (typeof id !== 'string' || (rowMission !== undefined && rowMission !== missionId)) return row;
      const hint = reviewTriageHintFor(missionId, id);
      return hint
        ? { ...(row as Record<string, unknown>), decisionHint: reviewTriageContextLine(hint),
          regressionRisk: hint.regressionRisk, independentReviewSuggested: hint.recommendIndependentReview }
        : row;
    } catch {
      return row;
    }
  });
}

// ─── recoveryAdvice ──────────────────────────────────────────────────────────

/**
 * F-1166 (P1 da revisão): só a CLASSE da queda sai daqui — para o modelo,
 * para a dica, para o whoami/mission_get e para a chave de dedupe. O texto
 * casado pelo limit-detector, ecoado no PTY do worker religado, dispararia
 * outro failover (F-520). A classe vem do `limitKind` do detector, nunca do texto.
 */
export function recoveryTriggerClass(input: { limitKind?: string; toModel?: string }): RecoveryTriggerClass {
  switch (input.limitKind) {
    case 'rate-limit': case 'quota': case 'auth': case 'transient': return input.limitKind;
    case 'model': return 'model-rejected';
    default: return input.toModel ? 'model-rejected' : 'unknown';
  }
}

export interface RecoveryFacts {
  readonly missionId: string;
  readonly triggerClass: RecoveryTriggerClass;
  readonly paneId?: string;
  readonly adapterId?: string;
  readonly switchingTo?: string;
}

export const RECOVERY_QUESTIONS: Record<string, JevQuestion> = {
  next_step: { type: 'choice', instructions:
    'A mission worker went down. What is the best recovery for the work it was doing?', criteria: {
      'retry-same-cli': 'transient failure (rate limit with a reset, network, crash): retry the same CLI',
      'switch-cli': 'the CLI/provider is the problem (quota exhausted, model rejected, repeated failure): switch to another CLI',
      'escalate-orchestrator': 'the task itself is the problem or needs a decision: hand it back to the orchestrator',
    } },
};

const RECOVERY_ADVICE = ['retry-same-cli', 'switch-cli', 'escalate-orchestrator'] as const;

export async function adviseRecovery(facts: RecoveryFacts, deps: AdvisoryDeps = {}): Promise<MissionRecoveryHint | null> {
  const state = { triggerClass: facts.triggerClass, adapterId: facts.adapterId ?? null, switchingTo: facts.switchingTo ?? null };
  const captured: { picked?: { choice: string; confidence: number } } = {};
  const outcome = await consult('recoveryAdvice', facts.missionId, state, RECOVERY_QUESTIONS, answers => {
    const picked = choice(answers, 'next_step');
    if (!picked || !(RECOVERY_ADVICE as readonly string[]).includes(picked.choice)) return null;
    captured.picked = picked;
    return `recovery:${picked.choice}`;
  }, deps);
  const chosen = captured.picked;
  if (!outcome || !chosen) return null;
  const hint: MissionRecoveryHint = { ...outcome.receipt, triggerClass: facts.triggerClass,
    ...(facts.paneId ? { paneId: facts.paneId } : {}), ...(facts.adapterId ? { adapterId: facts.adapterId } : {}),
    advice: chosen.choice as MissionRecoveryHint['advice'], confidence: chosen.confidence };
  recordRecoveryHint(facts.missionId, hint);
  return hint;
}

const RECOVERY_DEDUPE_MS = 60_000;
const recentRecovery = new Map<string, number>();

export function scheduleRecoveryAdvice(facts: RecoveryFacts, deps: AdvisoryDeps = {}): void {
  if (!facts.missionId) return;
  const key = `${facts.missionId}\0${facts.paneId ?? ''}\0${facts.triggerClass}`;
  const at = (deps.now ?? Date.now)();
  const last = recentRecovery.get(key);
  if (last !== undefined && at - last < RECOVERY_DEDUPE_MS) return;
  recentRecovery.set(key, at);
  if (recentRecovery.size > 500) recentRecovery.delete(recentRecovery.keys().next().value!);
  fireAndForget(() => adviseRecovery(facts, deps));
}

// ─── completionCheck ─────────────────────────────────────────────────────────

/** Handoffs que chegam juntos viram UMA consulta. */
export const COMPLETION_DEBOUNCE_MS = 30_000;
/** Teto de consultas de cobertura por missão. */
export const COMPLETION_MAX_CONSULTS = 3;

export interface CompletionFacts {
  readonly missionId: string;
  readonly goal: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly handoffs: readonly { readonly id?: string; readonly status: string; readonly summary: string }[];
}

/** Assinatura dos handoffs de SUCESSO: muda só quando chega entrega nova que conta. */
export function completionSignature(handoffs: CompletionFacts['handoffs']): string {
  const ids = handoffs.flatMap((handoff, index) => handoff.status === 'success'
    ? [handoff.id ?? `#${index}:${handoff.summary.length}`] : []).sort();
  return createHash('sha256').update(JSON.stringify(ids)).digest('hex').slice(0, 32);
}

function completionQuestions(criteria: readonly string[]): Record<string, JevQuestion> {
  const questions: Record<string, JevQuestion> = {
    covers_goal: { type: 'noul', instructions:
      'Do the delivered handoffs, taken together, cover the mission goal and its acceptance criteria?',
    criteria: { true: 'the handoffs cover the goal and criteria', false: 'something in the goal or criteria is not covered' } },
  };
  if (criteria.length > 0) {
    questions.missing = { type: 'choice', instructions: 'Which acceptance criterion looks least covered by the handoffs?',
      criteria: { none: 'nothing obvious is missing',
        ...Object.fromEntries(criteria.map((item, index) => [`c${index + 1}`, item])) } };
  }
  return questions;
}

export async function adviseCompletionCheck(
  facts: CompletionFacts, deps: AdvisoryDeps = {}, consultations = 1,
): Promise<MissionCompletionHint | null> {
  const recent = facts.handoffs.slice(-MAX_HANDOFFS);
  const criteria = (facts.acceptanceCriteria ?? []).slice(0, MAX_CRITERIA).map(item => safeText(item, 300));
  const state = {
    goal: safeText(facts.goal), acceptanceCriteria: criteria,
    handoffs: recent.map(handoff => ({ status: handoff.status, summary: safeText(handoff.summary, 500) })),
    handoffCount: facts.handoffs.length,
  };
  const captured: { coverage?: number; missing?: string } = {};
  const outcome = await consult('completionCheck', facts.missionId, state, completionQuestions(criteria), answers => {
    const value = noul(answers, 'covers_goal');
    if (value === null) return null;
    captured.coverage = value;
    const missing = choice(answers, 'missing')?.choice;
    const index = missing && /^c\d+$/.test(missing) ? Number(missing.slice(1)) - 1 : -1;
    // Texto do operador, mas vai a whoami/handoff_list: limitado e sem sinal que o detector casaria.
    if (index >= 0 && index < criteria.length) captured.missing = neutralizeLimitSignals(capText(criteria[index], 200));
    return value < COMPLETION_COVERAGE_THRESHOLD ? 'completion:warn' : 'completion:covered';
  }, deps);
  const coverage = captured.coverage;
  if (!outcome || coverage === undefined) return null;
  const hint: MissionCompletionHint = { ...outcome.receipt, coverage, warning: coverage < COMPLETION_COVERAGE_THRESHOLD,
    handoffCount: facts.handoffs.length, signature: completionSignature(facts.handoffs), consultations,
    ...(captured.missing ? { missing: captured.missing } : {}) };
  recordCompletionHint(facts.missionId, hint);
  return hint;
}

export interface CompletionScheduleDeps extends AdvisoryDeps {
  readonly debounceMs?: number;
  /** Nível do orçamento da missão; acima de 80% a cobertura não é consultada. */
  readonly budgetLevel?: (missionId: string) => DecisionBudgetLevel;
}

interface CompletionState {
  timer?: ReturnType<typeof setTimeout>;
  collect?: () => CompletionFacts | null;
  deps?: CompletionScheduleDeps;
  chain: Promise<unknown>;
  consults: number;
}
const completionStates = new Map<string, CompletionState>();

function defaultBudgetLevel(missionId: string): DecisionBudgetLevel {
  try {
    return getDecisionBudgetLedger().snapshot(missionId, missionDecisionBudgetUsd(getDecisionSettings())).level;
  } catch {
    return 'normal';
  }
}

function collectSafely(collect: (() => CompletionFacts | null) | undefined, missionId: string): CompletionFacts | null {
  try {
    const facts = collect?.() ?? null;
    // Os fatos são DESTA missão; outro id (bug do coletor) não grava nada.
    return facts && facts.missionId === missionId ? facts : null;
  } catch {
    return null;
  }
}

async function runCompletionCheck(missionId: string, state: CompletionState): Promise<MissionCompletionHint | null> {
  const deps = state.deps ?? {};
  const facts = collectSafely(state.collect, missionId);
  if (!facts) return null;
  const current = getMissionDecisionHints(missionId)?.completion;
  if (current && current.signature === completionSignature(facts.handoffs)) return current;
  const done = Math.max(state.consults, current?.consultations ?? 0);
  if (done >= COMPLETION_MAX_CONSULTS) return null;
  if ((deps.budgetLevel ?? defaultBudgetLevel)(missionId) !== 'normal') return null;
  state.consults = done + 1;
  return adviseCompletionCheck(facts, deps, done + 1);
}

/**
 * Chamado a cada handoff de sucesso: debounce de 30 s, chave (missão,
 * assinatura dos handoffs de sucesso), no máximo 3 consultas por missão, nada
 * acima de 80% do orçamento. `collect` roda já fora do caminho crítico.
 * Execuções da mesma missão ficam em fila (nunca duas consultas ao mesmo tempo).
 */
export function scheduleCompletionCheck(
  missionId: string, collect: () => CompletionFacts | null, deps: CompletionScheduleDeps = {},
): void {
  if (!missionId) return;
  const state = completionStates.get(missionId) ?? { chain: Promise.resolve(), consults: 0 };
  completionStates.set(missionId, state);
  state.collect = collect;
  state.deps = deps;
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    state.timer = undefined;
    state.chain = state.chain.then(() => runCompletionCheck(missionId, state)).catch(() => null);
  }, deps.debounceMs ?? COMPLETION_DEBOUNCE_MS);
  state.timer.unref?.();
}

/**
 * Conclusão: auditoria final. Mesma assinatura → reaproveita a dica (sem nova
 * consulta). Assinatura nova → no máximo uma consulta (teto e orçamento valem),
 * já sem debounce. Nunca segura a conclusão; o coletor que lança vira "sem dica".
 */
export function auditCompletionAtDone(
  missionId: string, collect: () => CompletionFacts | null, deps: CompletionScheduleDeps = {},
): void {
  if (!missionId) return;
  fireAndForget(async () => {
    const state = completionStates.get(missionId) ?? { chain: Promise.resolve(), consults: 0 };
    completionStates.set(missionId, state);
    if (state.timer) { clearTimeout(state.timer); state.timer = undefined; }
    state.collect = collect;
    state.deps = deps;
    const at = (deps.now ?? Date.now)();
    const run = state.chain.then(async () => {
      const facts = collectSafely(collect, missionId);
      const before = getMissionDecisionHints(missionId)?.completion;
      const reused = Boolean(facts && before && before.signature === completionSignature(facts.handoffs));
      if (facts && !reused) await runCompletionCheck(missionId, state);
      recordMissionFinalized(missionId, at, getMissionDecisionHints(missionId)?.completion ? reused : null);
    }).catch(() => null);
    state.chain = run;
    await run;
    // Missão encerrada: a fila terminou e nada novo entrou nela; o estado sai do mapa.
    if (completionStates.get(missionId) === state && state.chain === run && !state.timer) {
      completionStates.delete(missionId);
    }
  });
}

/** Linha de nível de missão que o orquestrador lê ao listar a própria missão. */
export function completionContextLine(hint: MissionCompletionHint): string {
  const percent = Math.round(hint.coverage * 100);
  if (!hint.warning) return `[motor de decisão] cobertura do objetivo ${percent}%: os handoffs parecem cobrir o objetivo.`;
  return `[motor de decisão] cobertura do objetivo ${percent}%: ${hint.missing
    ? `parece faltar: ${hint.missing}` : 'algo do objetivo parece não ter sido entregue.'}`;
}

/** Para testes: esquece as deduplicações e os debounces. */
export function resetMissionAdvisorForTesting(): void {
  kickoffStarted.clear();
  triaged.clear();
  recentRecovery.clear();
  for (const state of completionStates.values()) if (state.timer) clearTimeout(state.timer);
  completionStates.clear();
}

/** Para testes: a missão ainda tem estado de cobertura em memória? */
export function hasCompletionStateForTesting(missionId: string): boolean {
  return completionStates.has(missionId);
}

/** Para testes: espera as consultas de cobertura em fila. */
export async function settleCompletionChecksForTesting(): Promise<void> {
  await Promise.all([...completionStates.values()].map(state => state.chain));
}

// ─── fatos a partir da missão (só os dela: nada de outra missão entra) ─────

type MissionLike = {
  readonly id: string;
  readonly title?: string;
  readonly description?: string;
  readonly intentContract?: {
    readonly goal?: string;
    readonly acceptanceCriteria?: readonly string[];
    readonly lane?: string;
    readonly risk?: string;
    readonly budgets?: { readonly maxWorkers?: number };
  };
};

const DEFAULT_MAX_WORKERS = 4;

export function missionKickoffFacts(mission: MissionLike, origin: MissionKickoffFacts['origin']): MissionKickoffFacts {
  const contract = mission.intentContract;
  return {
    missionId: mission.id, origin,
    goal: contract?.goal ?? mission.description ?? mission.title ?? '',
    acceptanceCriteria: contract?.acceptanceCriteria ?? [],
    lane: contract?.lane, risk: contract?.risk,
    maxWorkers: typeof contract?.budgets?.maxWorkers === 'number' ? contract.budgets.maxWorkers : DEFAULT_MAX_WORKERS,
  };
}

export function missionGoalOf(mission: MissionLike): string {
  return mission.intentContract?.goal ?? mission.description ?? mission.title ?? '';
}

/** Fatos da conclusão a partir da missão e dos handoffs DELA. */
export function completionFactsFrom(
  mission: MissionLike & { readonly intentContract?: MissionLike['intentContract'] },
  handoffs: readonly { readonly id?: string; readonly status: string; readonly summary: string }[],
): CompletionFacts {
  return {
    missionId: mission.id, goal: missionGoalOf(mission),
    acceptanceCriteria: mission.intentContract?.acceptanceCriteria ?? [],
    handoffs: handoffs.map(handoff => ({ id: handoff.id, status: handoff.status, summary: handoff.summary })),
  };
}
