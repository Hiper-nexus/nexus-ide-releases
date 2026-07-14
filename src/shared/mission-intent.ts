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
});

export const missionIntentContractSchema = z.object({
  version: z.literal(1),
  source: missionIntentSourceSchema,
  goal: z.string().min(1).max(16_384),
  acceptanceCriteria: z.array(z.string().min(1).max(2_048)).max(32),
  risk: missionIntentRiskSchema,
  executionMode: missionExecutionModeSchema,
  contextPolicy: missionContextPolicySchema,
  approvedAt: z.number().int().nonnegative().optional(),
  intentVersion: z.number().int().positive().max(1_000_000),
  budgets: missionIntentBudgetsSchema,
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
    approve: 'dispatched',
    submit_goal: 'intent_compiling',
  },
  dispatched: {
    begin_execution: 'executing',
    block_user: 'blocked_user',
    block_technical: 'blocked_technical',
    submit_goal: 'intent_compiling',
  },
  executing: {
    begin_validation: 'validating',
    complete: 'done',
    block_user: 'blocked_user',
    block_technical: 'blocked_technical',
    submit_goal: 'intent_compiling',
  },
  validating: {
    complete: 'done',
    block_user: 'blocked_user',
    block_technical: 'blocked_technical',
  },
  blocked_user: {
    user_resume: 'executing',
    submit_goal: 'intent_compiling',
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
 */
export function resolveEffectiveIntentState(
  ctx: InferIntentContext,
): MissionIntentState {
  const stored = ctx.mission.intentState;
  if (stored && stored !== 'legacy') return stored;

  if (ctx.mission.status === 'done') return 'done';
  if (ctx.mission.status === 'failed') return 'blocked_technical';
  if (ctx.mission.status === 'blocked') return 'blocked_user';

  if (ctx.taskCount > 0 || ctx.workerPaneCount > 0) {
    return ctx.mission.status === 'running' ? 'executing' : 'dispatched';
  }

  const hasGoal =
    Boolean(ctx.mission.intentContract?.goal?.trim()) ||
    ctx.mission.description.trim().length > 0;
  if (hasGoal && ctx.mission.status === 'running') return 'executing';
  if (hasGoal) return 'dispatched';

  // No goal, no tasks, no workers — waiting is normal, not a stall.
  return 'awaiting_goal';
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
    return { planningTokens: 1_200, executionTokens: 8_000, maxWorkers: 1 };
  }
  if (risk === 'sensitive') {
    return { planningTokens: 1_200, executionTokens: 12_000, maxWorkers: 2 };
  }
  return { planningTokens: 1_200, executionTokens: 20_000, maxWorkers: 3 };
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
  return missionIntentContractSchema.parse({
    version: 1,
    source: input.source ?? 'typed',
    goal,
    acceptanceCriteria: criteria,
    risk,
    executionMode: input.executionMode ?? 'assisted',
    contextPolicy: input.contextPolicy ?? 'on-demand',
    intentVersion: input.intentVersion,
    budgets: defaultBudgetsForRisk(risk),
  });
}

/** True when the mission has a user-approved dispatch contract. */
export function hasApprovedDispatchContract(
  contract: MissionIntentContract | null | undefined,
): boolean {
  if (!contract?.goal?.trim()) return false;
  if (isPrepareProjectPlaceholderGoal(contract.goal)) return false;
  return typeof contract.approvedAt === 'number' && contract.approvedAt > 0;
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
