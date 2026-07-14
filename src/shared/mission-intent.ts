import { z } from 'zod';

/**
 * Intent-first mission runtime — pure domain.
 *
 * Separates "squad selected / shell open" from "work authorized".
 * See docs/superpowers/plans/2026-07-13-intent-first-mission-runtime.md.
 *
 * Note: intentionally does not import orch-types (avoids circular deps).
 */

export const missionIntentStateSchema = z.enum([
  'draft',
  'awaiting_goal',
  'intent_compiling',
  'ready_to_start',
  'awaiting_approval',
  'dispatched',
  'executing',
  'validating',
  'done',
  'blocked_user',
  'blocked_technical',
  /** Pre-migration missions; resolved via inference until rewritten. */
  'legacy',
]);
export type MissionIntentState = z.infer<typeof missionIntentStateSchema>;

export const missionIntentSourceSchema = z.enum([
  'typed',
  'voice',
  'imported-issue',
  'automation',
]);
export type MissionIntentSource = z.infer<typeof missionIntentSourceSchema>;

export const missionIntentRiskSchema = z.enum([
  'normal',
  'sensitive',
  'destructive',
]);
export type MissionIntentRisk = z.infer<typeof missionIntentRiskSchema>;

export const missionExecutionModeSchema = z.enum([
  'manual',
  'assisted',
  'autopilot',
]);
export type MissionExecutionMode = z.infer<typeof missionExecutionModeSchema>;

/**
 * Delivery lane (orthogonal to executionMode):
 * - standard: code-changing PREVC path (default)
 * - consult: read-only investigation (logs, doctor, status) — no worktrees /
 *   multi-worker expectation; completion via learnings note, not fake green
 *   without a consult-lane contract.
 */
export const missionLaneSchema = z.enum(['standard', 'consult']);
export type MissionLane = z.infer<typeof missionLaneSchema>;

export const missionContextPolicySchema = z.enum([
  'none',
  'minimal',
  'on-demand',
  'prepare-project',
]);
export type MissionContextPolicy = z.infer<typeof missionContextPolicySchema>;

export const missionIntentBudgetsSchema = z.object({
  planningTokens: z.number().int().nonnegative().max(1_000_000),
  executionTokens: z.number().int().nonnegative().max(10_000_000),
  maxWorkers: z.number().int().nonnegative().max(64),
  /** Hard cap on tool/dispatch steps for the mission (parent + children). */
  // Optional for persisted/legacy contracts; effect gates apply the runtime
  // fallback of 500 when the field is absent.
  maxSteps: z.number().int().positive().max(100_000).optional(),
});

export const missionIntentContractSchema = z.object({
  version: z.literal(1),
  source: missionIntentSourceSchema,
  goal: z.string().min(1).max(16_384),
  acceptanceCriteria: z.array(z.string().min(1).max(2_048)).max(32),
  risk: missionIntentRiskSchema,
  executionMode: missionExecutionModeSchema,
  /** Optional; missing/legacy contracts default to standard. */
  lane: missionLaneSchema.optional(),
  contextPolicy: missionContextPolicySchema,
  approvedAt: z.number().int().nonnegative().optional(),
  /** Wall-clock when execution was authorized (approve/start). SLA anchor. */
  dispatchedAt: z.number().int().nonnegative().optional(),
  intentVersion: z.number().int().positive().max(1_000_000),
  budgets: missionIntentBudgetsSchema,
  /** Tools the parent denies; children inherit and may only tighten. */
  deniedTools: z.array(z.string().min(1).max(128)).max(256).optional(),
  /** Parent task id when this contract is a child handoff attenuation. */
  parentTaskId: z.string().min(1).max(128).optional(),
  /** Steps already spent (parent + children); enforced at tool boundaries. */
  spentSteps: z.number().int().nonnegative().max(100_000).optional(),
  /** Approximate token spend tracked for budget ceilings. */
  spentTokens: z.number().int().nonnegative().max(10_000_000).optional(),
});
export type MissionIntentContract = z.infer<typeof missionIntentContractSchema>;

/** States where automatic recovery / stall supervisors must stay silent. */
export const NON_SUPERVISABLE_INTENT_STATES: ReadonlySet<MissionIntentState> =
  new Set([
    'draft',
    'awaiting_goal',
    'intent_compiling',
    'ready_to_start',
    'awaiting_approval',
    'blocked_user',
    'done',
  ]);

/** Only these states may enter automatic recovery policy. */
export const RECOVERY_ELIGIBLE_INTENT_STATES: ReadonlySet<MissionIntentState> =
  new Set(['dispatched', 'executing', 'validating', 'blocked_technical']);

export function isRecoveryEligibleIntentState(
  state: MissionIntentState | undefined | null,
): boolean {
  if (!state || state === 'legacy') return false;
  return RECOVERY_ELIGIBLE_INTENT_STATES.has(state);
}

export function isHumanWaitIntentState(
  state: MissionIntentState | undefined | null,
): boolean {
  if (!state) return false;
  return NON_SUPERVISABLE_INTENT_STATES.has(state);
}

/**
 * Bootstrap/delegation effects require an authorized intent.
 * `prepare-project` is the only pre-dispatch context exception (explicit UX).
 */
/**
 * Tools permitted under explicit "Preparar projeto" before a real goal exists.
 * Freeze/draft-apply/commit remain denied until dispatch.
 */
export const PREPARE_PROJECT_BOOTSTRAP_TOOLS: ReadonlySet<string> = new Set([
  'context_doctor',
  'code_map_refresh',
  'context_scaffold',
  'nexus_context_doctor',
  'nexus_code_map_refresh',
  'nexus_context_scaffold',
]);

/** Placeholder goal used only while warming context — never approvable as a mission. */
export const PREPARE_PROJECT_PLACEHOLDER_GOAL =
  'Preparar contexto do projeto';

export function isPrepareProjectPlaceholderGoal(goal: string | undefined | null): boolean {
  return (goal?.trim() ?? '') === PREPARE_PROJECT_PLACEHOLDER_GOAL;
}

export function canRunBootstrapEffects(
  state: MissionIntentState | undefined | null,
  contract: MissionIntentContract | null | undefined,
  toolName?: string,
): boolean {
  if (isRecoveryEligibleIntentState(state)) return true;
  if (
    state === 'ready_to_start' ||
    state === 'awaiting_approval' ||
    state === 'intent_compiling'
  ) {
    return false;
  }
  if (
    (state === 'awaiting_goal' || state === 'draft') &&
    contract?.contextPolicy === 'prepare-project'
  ) {
    if (!toolName) return true;
    const canonical = toolName.replace(/^nexus_/, '');
    return (
      PREPARE_PROJECT_BOOTSTRAP_TOOLS.has(toolName) ||
      PREPARE_PROJECT_BOOTSTRAP_TOOLS.has(canonical)
    );
  }
  return false;
}

export function canDispatchWorkers(
  state: MissionIntentState | undefined | null,
): boolean {
  return (
    state === 'dispatched' ||
    state === 'executing' ||
    state === 'validating'
  );
}

export interface IntentTransitionInput {
  readonly from: MissionIntentState;
  readonly event:
    | 'select_squad'
    | 'submit_goal'
    | 'compile_ok'
    | 'compile_ambiguous'
    | 'needs_approval'
    | 'approve'
    | 'start'
    | 'begin_execution'
    | 'begin_validation'
    | 'complete'
    | 'block_user'
    | 'block_technical'
    | 'user_resume';
}

export type IntentTransitionResult =
  | { readonly ok: true; readonly to: MissionIntentState }
  | { readonly ok: false; readonly reason: string };

const TRANSITIONS: Readonly<
  Record<string, Partial<Record<IntentTransitionInput['event'], MissionIntentState>>>
> = {
  draft: { select_squad: 'awaiting_goal' },
  awaiting_goal: {
    submit_goal: 'intent_compiling',
    // Explicit prepare-project stays in awaiting_goal until goal exists.
  },
  intent_compiling: {
    compile_ok: 'ready_to_start',
    compile_ambiguous: 'awaiting_goal',
    needs_approval: 'awaiting_approval',
  },
  ready_to_start: {
    needs_approval: 'awaiting_approval',
    start: 'dispatched',
    submit_goal: 'intent_compiling', // new user message preempts
  },
  awaiting_approval: {
    // One explicit start action durably approves, then advances through
    // ready_to_start before any runtime materialization is allowed.
    approve: 'ready_to_start',
    submit_goal: 'intent_compiling',
  },
  dispatched: {
    begin_execution: 'executing',
    block_user: 'blocked_user',
    block_technical: 'blocked_technical',
  },
  executing: {
    begin_validation: 'validating',
    complete: 'done',
    block_user: 'blocked_user',
    block_technical: 'blocked_technical',
  },
  validating: {
    complete: 'done',
    block_user: 'blocked_user',
    block_technical: 'blocked_technical',
  },
  blocked_user: {
    user_resume: 'executing',
  },
  blocked_technical: {
    begin_execution: 'executing',
    block_user: 'blocked_user',
  },
  done: {},
  legacy: {
    select_squad: 'awaiting_goal',
    submit_goal: 'intent_compiling',
    start: 'dispatched',
  },
};

export function transitionIntentState(
  input: IntentTransitionInput,
): IntentTransitionResult {
  const table = TRANSITIONS[input.from];
  if (!table) {
    return { ok: false, reason: `unknown intent state: ${input.from}` };
  }
  const to = table[input.event];
  if (!to) {
    return {
      ok: false,
      reason: `invalid transition ${input.from} --${input.event}-->`,
    };
  }
  return { ok: true, to };
}

export interface InferIntentMission {
  readonly status: string;
  readonly description: string;
  readonly intentState?: MissionIntentState;
  readonly intentContract?: MissionIntentContract;
}

export interface InferIntentContext {
  readonly mission: InferIntentMission;
  readonly taskCount: number;
  readonly workerPaneCount: number;
  readonly hasActiveOrchestrator?: boolean;
}

/**
 * Resolve effective intent state. Persisted non-legacy values win.
 * Legacy rows are inferred without inventing dispatch authorization.
 *
 * Bare `description` is NEVER a real goal — only a validated intentContract
 * with a non-placeholder goal counts. Tasks/workers still imply real work.
 */
export function resolveEffectiveIntentState(
  ctx: InferIntentContext,
): MissionIntentState {
  const stored = ctx.mission.intentState;
  if (stored && stored !== 'legacy') return stored;

  if (ctx.mission.status === 'done') return 'done';
  if (ctx.mission.status === 'failed') return 'blocked_technical';
  if (ctx.mission.status === 'blocked') return 'blocked_user';

  // Real work already in flight — never invent a goal, but do not stall recovery
  // for empty missions that only have free-text description.
  if (ctx.taskCount > 0 || ctx.workerPaneCount > 0) {
    return ctx.mission.status === 'running' ? 'executing' : 'dispatched';
  }

  const contractGoal = ctx.mission.intentContract?.goal?.trim() ?? '';
  const hasRealGoal =
    contractGoal.length > 0 && !isPrepareProjectPlaceholderGoal(contractGoal);

  if (hasRealGoal && hasApprovedDispatchContract(ctx.mission.intentContract)) {
    return ctx.mission.status === 'running' ? 'executing' : 'dispatched';
  }

  // Description-only or unapproved contract: human wait, not dispatched.
  return 'awaiting_goal';
}

/**
 * Wall-clock anchor for recovery SLAs: prefer dispatchedAt / approvedAt from
 * the contract; never mission.createdAt (arm time).
 */
export function resolveDispatchAuthorizedAt(
  mission: Pick<InferIntentMission, 'intentContract'> & {
    readonly updatedAt?: number;
  },
): number | null {
  const contract = mission.intentContract;
  if (!contract) return null;
  if (typeof contract.dispatchedAt === 'number' && contract.dispatchedAt > 0) {
    return contract.dispatchedAt;
  }
  if (typeof contract.approvedAt === 'number' && contract.approvedAt > 0) {
    return contract.approvedAt;
  }
  return null;
}

/** Sensitive surface keywords that require plan approval. */
const SENSITIVE_GOAL_RE =
  /\b(auth|oauth|login|password|pagamento|payment|billing|pix|stripe|deploy|production|prod\b|migra[cç][aã]o|migration|drop\s+table|delete\s+from|rm\s+-rf|secret|token|api[_-]?key)\b/i;

const DESTRUCTIVE_GOAL_RE =
  /\b(apagar|deletar|destroy|wipe|format|drop\s+database|force.?push|reset\s+--hard)\b/i;

export function defaultBudgetsForRisk(
  risk: MissionIntentRisk,
): MissionIntentContract['budgets'] {
  if (risk === 'destructive') {
    return {
      planningTokens: 1_200,
      executionTokens: 8_000,
      maxWorkers: 1,
      maxSteps: 80,
    };
  }
  if (risk === 'sensitive') {
    return {
      planningTokens: 1_200,
      executionTokens: 12_000,
      maxWorkers: 2,
      maxSteps: 200,
    };
  }
  return {
    planningTokens: 1_200,
    executionTokens: 20_000,
    maxWorkers: 3,
    maxSteps: 500,
  };
}

export function classifyGoalRisk(goal: string): MissionIntentRisk {
  if (DESTRUCTIVE_GOAL_RE.test(goal)) return 'destructive';
  if (SENSITIVE_GOAL_RE.test(goal)) return 'sensitive';
  return 'normal';
}

export function compileIntentContract(input: {
  goal: string;
  source?: MissionIntentSource;
  intentVersion: number;
  executionMode?: MissionExecutionMode;
  contextPolicy?: MissionContextPolicy;
  acceptanceCriteria?: string[];
  /** Explicit delivery lane; default standard (code PREVC). */
  lane?: MissionLane;
}): MissionIntentContract {
  const goal = input.goal.trim();
  if (!goal) {
    throw new Error('intent_required: goal is empty');
  }
  const risk = classifyGoalRisk(goal);
  const criteria =
    input.acceptanceCriteria && input.acceptanceCriteria.length > 0
      ? input.acceptanceCriteria
      : [`Objetivo concluído conforme: ${goal.slice(0, 200)}`];
  const lane = input.lane ?? 'standard';
  const budgets =
    lane === 'consult'
      ? {
          planningTokens: 2_000,
          executionTokens: 4_000,
          maxWorkers: 0,
          maxSteps: 32,
        }
      : defaultBudgetsForRisk(risk);
  return missionIntentContractSchema.parse({
    version: 1,
    source: input.source ?? 'typed',
    goal,
    acceptanceCriteria: criteria,
    risk,
    // Clicking Start authorizes the bounded Nexus autopilot. Sensitive work
    // still requires approval, and every effect remains behind PREVC/budgets.
    executionMode: input.executionMode ?? 'autopilot',
    lane,
    contextPolicy: input.contextPolicy ?? 'on-demand',
    intentVersion: input.intentVersion,
    budgets,
  });
}

/** True when the mission contract is the read-only consult lane. */
export function isConsultLane(mission: {
  readonly intentContract?: { readonly lane?: MissionLane | null } | null;
}): boolean {
  return mission.intentContract?.lane === 'consult';
}

/** True when the mission has a user-approved dispatch contract. */
export function hasApprovedDispatchContract(
  contract: MissionIntentContract | null | undefined,
): boolean {
  if (!contract?.goal?.trim()) return false;
  if (isPrepareProjectPlaceholderGoal(contract.goal)) return false;
  return typeof contract.approvedAt === 'number' && contract.approvedAt > 0;
}

/**
 * Dispatch authority belongs to one exact intent revision. An approval from a
 * previous user message must never authorize the current mission state.
 */
export function hasCurrentApprovedDispatchContract(mission: {
  readonly intentContract?: MissionIntentContract | null;
  readonly intentVersion?: number | null;
}): boolean {
  const contract = mission.intentContract;
  const intentVersion = mission.intentVersion ?? 0;
  return (
    intentVersion > 0 &&
    contract?.intentVersion === intentVersion &&
    hasApprovedDispatchContract(contract)
  );
}

/**
 * Full launch/effect authority for one mission revision. Approval alone is not
 * enough while the mission is still compiling or waiting for the user.
 */
export function hasCurrentDispatchAuthority(
  mission: InferIntentMission & {
    readonly intentVersion?: number | null;
  },
  context: {
    readonly taskCount?: number;
    readonly workerPaneCount?: number;
  } = {},
): boolean {
  const intentState = resolveEffectiveIntentState({
    mission,
    taskCount: context.taskCount ?? 0,
    workerPaneCount: context.workerPaneCount ?? 0,
  });
  return (
    canDispatchWorkers(intentState) &&
    hasCurrentApprovedDispatchContract(mission)
  );
}

/**
 * Approved contract for legacy/pet immediate-execution shells (forceLegacy /
 * pet-studio). Gives the gate a real dispatch authorization without inventing
 * a user-composed goal flow.
 */
export function synthesizeImmediateDispatchContract(input: {
  readonly title: string;
  readonly intentVersion?: number;
  readonly now?: number;
}): MissionIntentContract {
  const now = input.now ?? Date.now();
  const goal =
    input.title.trim() ||
    'Execução imediata autorizada (legado / perfil dedicado)';
  const base = compileIntentContract({
    goal,
    source: 'automation',
    intentVersion: Math.max(1, input.intentVersion ?? 1),
    executionMode: 'autopilot',
    contextPolicy: 'on-demand',
    acceptanceCriteria: [
      'Missão legada/pet despachada com orquestrador ativo',
      'Workers e bootstrap permitidos sob PREVC e effect policy',
    ],
  });
  return {
    ...base,
    approvedAt: now,
    dispatchedAt: now,
  };
}

/** Normalize tool names for deny-list comparison. */
export function canonicalDeniedToolName(toolName: string): string {
  return toolName.replace(/^nexus_/, '').toLowerCase();
}

/**
 * Child may only tighten parent denials — never remove a parent deny.
 * Returns the effective denied set for the child.
 */
export function attenuateDeniedTools(
  parentDenied: readonly string[] | undefined,
  childDenied: readonly string[] | undefined,
): string[] {
  const set = new Set<string>();
  for (const tool of parentDenied ?? []) {
    set.add(canonicalDeniedToolName(tool));
  }
  for (const tool of childDenied ?? []) {
    set.add(canonicalDeniedToolName(tool));
  }
  return [...set].sort();
}

/**
 * True when childDenied is a superset of parentDenied (child more or equally
 * restrictive). False if child would permit a tool the parent denied.
 */
export function childRespectsParentDenials(
  parentDenied: readonly string[] | undefined,
  childDenied: readonly string[] | undefined,
): boolean {
  const parent = new Set(
    (parentDenied ?? []).map(canonicalDeniedToolName),
  );
  const child = new Set((childDenied ?? []).map(canonicalDeniedToolName));
  for (const tool of parent) {
    if (!child.has(tool)) return false;
  }
  return true;
}

export function isToolDeniedByContract(
  toolName: string,
  contract: MissionIntentContract | null | undefined,
): boolean {
  const denied = contract?.deniedTools ?? [];
  if (denied.length === 0) return false;
  const canonical = canonicalDeniedToolName(toolName);
  return denied.some((item) => canonicalDeniedToolName(item) === canonical);
}

export type BudgetGateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly error: string };

/** Deny spawning another worker when maxWorkers is already met. */
export function assertWorkerBudget(
  contract: MissionIntentContract | null | undefined,
  currentWorkerCount: number,
): BudgetGateResult {
  // No contract → no intent budget ceiling (legacy mid-migration rows).
  // Enforcement applies only when an intent contract is present.
  if (!contract) return { ok: true };
  const max = contract.budgets.maxWorkers;
  if (max <= 0) {
    return {
      ok: false,
      code: 'budget_exhausted',
      error: 'budget_exhausted: maxWorkers is 0 — no workers may spawn',
    };
  }
  if (currentWorkerCount >= max) {
    return {
      ok: false,
      code: 'budget_exhausted',
      error: `budget_exhausted: maxWorkers=${max} already reached (${currentWorkerCount})`,
    };
  }
  return { ok: true };
}

/** Deny further effectful work when maxSteps or executionTokens are spent. */
export function assertStepAndTokenBudget(
  contract: MissionIntentContract | null | undefined,
): BudgetGateResult {
  if (!contract) return { ok: true };
  const maxSteps = contract.budgets.maxSteps ?? 500;
  const spentSteps = contract.spentSteps ?? 0;
  if (spentSteps >= maxSteps) {
    return {
      ok: false,
      code: 'budget_exhausted',
      error: `budget_exhausted: maxSteps=${maxSteps} reached`,
    };
  }
  const maxTokens = contract.budgets.executionTokens;
  const spentTokens = contract.spentTokens ?? 0;
  if (maxTokens > 0 && spentTokens >= maxTokens) {
    return {
      ok: false,
      code: 'budget_exhausted',
      error: `budget_exhausted: executionTokens=${maxTokens} reached`,
    };
  }
  return { ok: true };
}

/**
 * Conservative token charge per effectful tool (ledger hook — not a provider
 * bill). Used so executionTokens ceilings have teeth without requiring a
 * full usage telemetry pipeline.
 */
export function estimateEffectfulToolTokens(toolName: string): number {
  const canonical = toolName.replace(/^nexus_/, '').toLowerCase();
  if (
    canonical.includes('context_doctor') ||
    canonical.includes('code_map') ||
    canonical.includes('draft')
  ) {
    return 400;
  }
  if (
    canonical.includes('pane_spawn') ||
    canonical.includes('agent_invoke') ||
    canonical.includes('worktree')
  ) {
    return 200;
  }
  if (canonical.includes('handoff')) return 50;
  return 100;
}

/** Apply one authorized effectful tool to contract spend counters. */
export function applyEffectfulSpend(
  contract: MissionIntentContract,
  toolName: string,
): MissionIntentContract & { readonly spentSteps: number; readonly spentTokens: number } {
  const tokenDelta = estimateEffectfulToolTokens(toolName);
  return {
    ...contract,
    spentSteps: (contract.spentSteps ?? 0) + 1,
    spentTokens: (contract.spentTokens ?? 0) + tokenDelta,
    acceptanceCriteria: [...contract.acceptanceCriteria],
    budgets: { ...contract.budgets },
    deniedTools: contract.deniedTools ? [...contract.deniedTools] : undefined,
  };
}

export type EffectfulSpendReservation =
  | {
      readonly ok: true;
      readonly contract: MissionIntentContract & {
        readonly spentSteps: number;
        readonly spentTokens: number;
      };
    }
  | { readonly ok: false; readonly code: string; readonly error: string };

/** Reserve the next effect without allowing its estimated cost to overshoot. */
export function reserveEffectfulSpend(
  contract: MissionIntentContract,
  toolName: string,
): EffectfulSpendReservation {
  const current = assertStepAndTokenBudget(contract);
  if (!current.ok) return current;
  const next = applyEffectfulSpend(contract, toolName);
  const maxSteps = contract.budgets.maxSteps ?? 500;
  if (next.spentSteps > maxSteps) {
    return {
      ok: false,
      code: 'budget_exhausted',
      error: `budget_exhausted: maxSteps=${maxSteps} would be exceeded`,
    };
  }
  const maxTokens = contract.budgets.executionTokens;
  if (maxTokens > 0 && next.spentTokens > maxTokens) {
    return {
      ok: false,
      code: 'budget_exhausted',
      error: `budget_exhausted: executionTokens=${maxTokens} would be exceeded`,
    };
  }
  return { ok: true, contract: next };
}

/**
 * Pure spawn-side policy: maxWorkers + parent deny attenuation on allowlist.
 */
export function applyWorkerSpawnPolicy(input: {
  readonly contract: MissionIntentContract | null | undefined;
  readonly currentWorkerCount: number;
  readonly allowedTools: readonly string[] | null | undefined;
}): BudgetGateResult & { readonly allowedTools?: string[] } {
  const budget = assertWorkerBudget(input.contract, input.currentWorkerCount);
  if (!budget.ok) return budget;
  const denied = input.contract?.deniedTools;
  if (!denied?.length || !input.allowedTools?.length) {
    return { ok: true };
  }
  const effectiveDenied = new Set(attenuateDeniedTools(denied, []));
  return {
    ok: true,
    allowedTools: input.allowedTools.filter(
      (tool) => !effectiveDenied.has(canonicalDeniedToolName(tool)),
    ),
  };
}

/**
 * Handoff submit is allowed only for authenticated mission-bound agents.
 * System recovery uses a reserved fromAgent and is checked separately.
 */
export function canSubmitMissionHandoff(input: {
  readonly role: string | undefined | null;
  readonly missionId: string | undefined | null;
  readonly sessionId: string | undefined | null;
  readonly intentState: MissionIntentState | undefined | null;
}): BudgetGateResult {
  if (!input.missionId) {
    return {
      ok: false,
      code: 'handoff_origin',
      error: 'handoff_origin: mission binding required',
    };
  }
  if (!input.sessionId) {
    return {
      ok: false,
      code: 'handoff_origin',
      error: 'handoff_origin: session binding required',
    };
  }
  if (input.role !== 'worker' && input.role !== 'orchestrator') {
    return {
      ok: false,
      code: 'handoff_origin',
      error: 'handoff_origin: only worker/orchestrator roles may submit handoffs',
    };
  }
  if (!input.intentState) {
    return {
      ok: false,
      code: 'handoff_origin',
      error: 'handoff_origin: mission authority unavailable',
    };
  }
  // Pre-dispatch: no agent handoffs (no work authorized).
  if (
    input.intentState &&
    input.intentState !== 'legacy' &&
    !canDispatchWorkers(input.intentState) &&
    input.intentState !== 'blocked_technical'
  ) {
    return {
      ok: false,
      code: 'dispatch_required',
      error: 'dispatch_required: handoffs only after mission dispatch',
    };
  }
  return { ok: true };
}

/** Idempotency key for system recovery handoffs (stage-scoped). */
export function recoveryHandoffIdempotencyKey(
  missionId: string,
  stage: 1 | 2,
): string {
  return `recovery:${missionId}:stage_${stage}`;
}

export type IntentMappedMissionStatus =
  | 'pending'
  | 'running'
  | 'blocked'
  | 'done'
  | 'failed';

export function missionStatusForIntent(
  intent: MissionIntentState,
): IntentMappedMissionStatus | null {
  switch (intent) {
    case 'done':
      return 'done';
    case 'blocked_user':
    case 'blocked_technical':
      return 'blocked';
    case 'dispatched':
    case 'executing':
    case 'validating':
      return 'running';
    case 'draft':
    case 'awaiting_goal':
    case 'intent_compiling':
    case 'ready_to_start':
    case 'awaiting_approval':
      return 'pending';
    default:
      return null;
  }
}

export type MissionIntentEventName =
  | 'squad_selected'
  | 'goal_submitted'
  | 'intent_compiled'
  | 'plan_approved'
  | 'task_dispatched'
  | 'worker_started'
  | 'automatic_recovery'
  | 'intent_gate_denied'
  | 'prepare_project';

export interface MissionIntentEvent {
  readonly name: MissionIntentEventName;
  readonly at: number;
  readonly missionId?: string;
  readonly squadId?: string;
  readonly intentState?: MissionIntentState;
  readonly intentVersion?: number;
  readonly reason?: string;
  readonly meta?: Readonly<Record<string, string | number | boolean | null>>;
}
