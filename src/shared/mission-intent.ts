import { z } from 'zod';
import { resolveMissionBlockingIntentState } from './mission-blocking';
import { classifyStandardMissionTopology } from './mission-topology';
import {
  assertWavePackStoriesReady,
  freezeWavePackStoriesForContract,
  MAX_WAVE_PACK_STORIES,
  MISSION_ORCHESTRATION_MODES,
  wavePackStorySchema,
  wavePackTemplateIdSchema,
  type MissionOrchestrationMode,
} from './mission-wave-pack';
import type { WavePackTemplateId } from './wave-pack-templates';

export {
  missionBlockKindSchema,
  missionBlockingIntentStateSchema,
  missionBlockPatch,
  resolveMissionBlockingIntentState,
  type MissionBlockKind,
  type MissionBlockingIntentState,
  type MissionBlockPatch,
} from './mission-blocking';
export {
  missionStatusForIntent,
  type IntentMappedMissionStatus,
  type MissionIntentEventName,
  type MissionIntentEvent,
} from './mission-intent-projection';

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
 * - plan: design approach only (grok-build plan-mode idea) — writes limited to
 *   mission plan.md; no worktree/code/shell mutations until lane upgrades.
 * - ops: infra/operation work (SSH, deploy, backup, DNS, subir/pausar app) —
 *   shell/browser/media execution effects after dispatch authority, WITHOUT a
 *   frozen PREVC contract; repo code mutations (editor/file_write/git/
 *   worktree/merge/delegation) stay denied — reopen as standard for those.
 */
export const missionLaneSchema = z.enum(['standard', 'consult', 'plan', 'ops']);
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

/**
 * Exact main-owned runtime approved for the initial orchestrator.
 *
 * `readOnly=false` keeps the Main-owned mission authority available.
 * `nativeReadOnly` records the exact product policy approved with the mission:
 * true in Hardened mode, false in Autopilot where the task worktree,
 * per-session bearer and Main-owned validated merge are the promotion
 * boundary. Both bits are explicit so a persisted contract cannot silently
 * inherit a later settings default.
 */
export const missionOrchestratorRuntimeSnapshotSchema = z
  .object({
    adapterId: z.string().min(1).max(64),
    model: z.string().min(1).max(256).optional(),
    accountId: z.string().min(1).max(128).optional(),
    effort: z.string().min(1).max(64).optional(),
    readOnly: z.literal(false),
    nativeReadOnly: z.boolean(),
  })
  .strict();
export type MissionOrchestratorRuntimeSnapshot = z.infer<
  typeof missionOrchestratorRuntimeSnapshotSchema
>;

export const missionAttachmentSnapshotSchema = z
  .object({
    path: z.string().min(1).max(4_096),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().nonnegative().max(14 * 1024 * 1024),
  })
  .strict();
export type MissionAttachmentSnapshot = z.infer<
  typeof missionAttachmentSnapshotSchema
>;

/**
 * Main-owned snapshot of the exact physical handoff promoted from plan mode.
 *
 * The renderer never supplies this structure. Main selects the handoff from
 * the scoped store, verifies its physical MCP provenance, computes every
 * digest and persists the immutable payload in standard-v2. Main consumers
 * revalidate the digests before using the plan as task context.
 */
export const MAX_PROMOTED_PLAN_SUMMARY_CHARS = 32_768;
export const MAX_PROMOTED_PLAN_SUMMARY_BYTES = 32_768;

export const promotedPlanSnapshotSchema = z
  .object({
    version: z.literal(1),
    handoffId: z.string().min(1).max(256),
    sourceIntentVersion: z.number().int().positive().max(1_000_000),
    sourceSessionId: z.string().min(1).max(256),
    sourceWorkerIncarnationId: z.string().min(1).max(256).optional(),
    handoffCreatedAt: z.number().int().nonnegative(),
    physicalReceipt: z
      .object({
        receiptId: z.string().min(1).max(256),
        toolCallId: z.string().min(1).max(256),
        source: z.enum(['http-mcp', 'acp-stdio', 'pty-stream', 'omp-rpc-stdio']),
        authoritySha256: z.string().regex(/^[a-f0-9]{64}$/),
        worktreeHeadSha: z
          .string()
          .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
          .optional(),
        issuedAt: z.number().int().nonnegative(),
      })
      .strict(),
    /** Exact agent-produced PRD/plan text, not a renderer transcription. */
    summary: z.string().min(1).max(MAX_PROMOTED_PLAN_SUMMARY_CHARS),
    /** Exact JSON artifacts attached to the physical plan handoff. */
    artifacts: z.array(z.unknown()).max(128),
    summarySha256: z.string().regex(/^[a-f0-9]{64}$/),
    artifactsSha256: z.string().regex(/^[a-f0-9]{64}$/),
    /** Digest over identity, physical provenance and exact plan payload. */
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type PromotedPlanSnapshot = z.infer<typeof promotedPlanSnapshotSchema>;

export const missionIntentContractSchema = z.object({
  version: z.literal(1),
  source: missionIntentSourceSchema,
  // PREVC's compiler canonicalizes these same human-authored fields with
  // `trim()`. Canonicalize them at the approval boundary too so a bounded
  // truncation that lands on whitespace cannot make the freshly frozen
  // contract look stale after the one native approval.
  goal: z.string().trim().min(1).max(16_384),
  acceptanceCriteria: z
    .array(z.string().trim().min(1).max(2_048))
    .max(32),
  risk: missionIntentRiskSchema,
  executionMode: missionExecutionModeSchema,
  /** Optional; missing/legacy contracts default to standard. */
  lane: missionLaneSchema.optional(),
  /**
   * Optional operator override for Livre / Pack / Guiado (Wave Pack).
   * Missing/legacy contracts leave mode selection to the pure resolver.
   */
  orchestrationMode: z.enum(MISSION_ORCHESTRATION_MODES).optional(),
  /**
   * Canonical Pack stories (Wave 2). Prefer over markdown parse of promotedPlan.
   * Capped at MAX_WAVE_PACK_STORIES (P0-9) so a real >64-story decomposition can
   * be carried on the contract and drained to exhaustion, not truncated at seal.
   */
  wavePackStories: z
    .array(wavePackStorySchema)
    .min(1)
    .max(MAX_WAVE_PACK_STORIES)
    .optional(),
  /** Declared fan-out template that seeded wavePackStories (Landing / SaaS / Fix). */
  wavePackTemplateId: wavePackTemplateIdSchema.optional(),
  contextPolicy: missionContextPolicySchema,
  approvedAt: z.number().int().nonnegative().optional(),
  /**
   * Main-owned SHA-256 receipt for the complete authority review accepted in
   * the native approval dialog. Optional only for persisted/legacy contracts.
   */
  approvalReviewSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
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
  /** True only when the current submission included the promised evidence. */
  evidenceAttached: z.boolean().optional(),
  /**
   * Canonical main-validated files staged under ~/.nexus/dropped. Paths are
   * persisted only at approval and revalidated immediately before bootstrap.
   */
  attachmentPaths: z.array(z.string().min(1).max(4_096)).max(6).optional(),
  /** Exact bytes approved for each attachment path; legacy contracts may omit. */
  attachmentSnapshots: z.array(missionAttachmentSnapshotSchema).max(6).optional(),
  /** Exact saved-squad authority approved by the operator. */
  squadRevisionHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  /** Exact provider/model/account/confinement approved before any spawn. */
  orchestratorRuntime: missionOrchestratorRuntimeSnapshotSchema.optional(),
  /**
   * Scheduled single-worker missions may attenuate the planner to one exact
   * saved-roster worker. The main planner enforces both the identity and a
   * single-task plan; prompt text alone is never authority.
   */
  requiredWorkerAgentRef: z.string().min(1).max(128).optional(),
  /**
   * Present only on a main-owned plan-vN → standard-vN+1 promotion.
   * This is the durable PRD/plan input for the new guided task graph, so the
   * standard session never depends on redelivery from the revoked plan PTY.
   */
  promotedPlan: promotedPlanSnapshotSchema.optional(),
});
export type MissionIntentContract = z.infer<typeof missionIntentContractSchema>;

/**
 * Immutable approval authority carried across bootstrap and physical panes.
 * Spend counters are a live execution ledger: sibling tools may advance them
 * without changing the operator-approved goal, limits or capabilities.
 */
export function missionIntentAuthoritySnapshot(
  contract: MissionIntentContract,
): Omit<MissionIntentContract, 'spentSteps' | 'spentTokens'> {
  const {
    spentSteps: _spentSteps,
    spentTokens: _spentTokens,
    ...authority
  } = contract;
  return authority;
}

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
  // A blocked mission is exactly where the operator needs to intervene, so a
  // new message preempts it like any other un-frozen state. Recompiling bumps
  // intentVersion, which revokes the previous approval — the mission has to be
  // approved again before any effect, so this exit never widens authority.
  blocked_user: {
    user_resume: 'executing',
    submit_goal: 'intent_compiling',
  },
  blocked_technical: {
    begin_execution: 'executing',
    block_user: 'blocked_user',
    submit_goal: 'intent_compiling',
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
  // Lifecycle terminal/demotion states always revoke an older persisted
  // dispatch state. A stale `dispatched` value must never outvote blocked or
  // failed and reopen effect authority.
  if (ctx.mission.status === 'done') return 'done';
  const blockingState = resolveMissionBlockingIntentState({
    status: ctx.mission.status,
    intentState: ctx.mission.intentState,
  });
  if (blockingState) return blockingState;

  const stored = ctx.mission.intentState;
  if (stored && stored !== 'legacy') return stored;

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
      // executionTokens é ledger (não bloqueia — ver assertStepAndTokenBudget);
      // o limite real é maxWorkers/maxSteps. Presets subidos: os antigos
      // (2 workers/200 steps) foram calibrados na era do teto de token que já
      // não existe e sufocavam missões reais (caso de campo 17/07).
      executionTokens: 200_000,
      // Risco restringe a SUPERFÍCIE DE APROVAÇÃO (modal nativo), não o
      // paralelismo: sensitive recebe o mesmo teto de workers que normal —
      // goals comuns como "corrija o login" não podem encolher a wave.
      maxWorkers: 12,
      maxSteps: 400,
    };
  }
  return {
    planningTokens: 1_200,
    executionTokens: 800_000,
    // ADEs sobem ~12 panes do mesmo LLM em fan-out; o spawn já aceita o
    // mesmo adapterId N vezes — o teto útil era 8 e engessava a paridade
    // visual/operacional. Schema permite até 64.
    maxWorkers: 12,
    maxSteps: 600,
  };
}

export function classifyGoalRisk(goal: string): MissionIntentRisk {
  if (DESTRUCTIVE_GOAL_RE.test(goal)) return 'destructive';
  if (SENSITIVE_GOAL_RE.test(goal)) return 'sensitive';
  return 'normal';
}

/**
 * Prefix of the acceptance criterion synthesized when the user provides none.
 * Prompt builders use it to avoid restating the goal a second time.
 */
export const AUTO_DERIVED_CRITERION_PREFIX = 'Objetivo concluído conforme:';
const AUTO_DERIVED_CRITERION_MAX_CHARS = 2_048;

export function isAutoDerivedCriterion(criterion: string): boolean {
  return criterion.trimStart().startsWith(AUTO_DERIVED_CRITERION_PREFIX);
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
  /** Operator override Livre / Pack / Guiado. */
  orchestrationMode?: MissionOrchestrationMode;
  /** Pack template that seeds structured stories when mode is pack. */
  wavePackTemplateId?: WavePackTemplateId;
}): MissionIntentContract {
  const goal = input.goal.trim();
  if (!goal) {
    throw new Error('intent_required: goal is empty');
  }
  const risk = classifyGoalRisk(goal);
  const criteria =
    input.acceptanceCriteria && input.acceptanceCriteria.length > 0
      ? input.acceptanceCriteria
      : [
          `${AUTO_DERIVED_CRITERION_PREFIX} ${goal
            .slice(
              0,
              AUTO_DERIVED_CRITERION_MAX_CHARS -
                AUTO_DERIVED_CRITERION_PREFIX.length -
                1,
            )
            .trimEnd()}`,
        ];
  const lane = input.lane ?? 'standard';
  const budgets =
    lane === 'consult' || lane === 'plan'
      ? {
          planningTokens: lane === 'plan' ? 8_000 : 2_000,
          executionTokens: lane === 'plan' ? 6_000 : 4_000,
          maxWorkers: 0,
          maxSteps: lane === 'plan' ? 64 : 32,
        }
      : lane === 'ops'
        ? // Ops executa direto no orquestrador (shell/browser) — delegação é
          // negada no intent gate, então workers nunca são esperados.
          { ...defaultBudgetsForRisk(risk), maxWorkers: 0 }
        : defaultBudgetsForRisk(risk);
  // Destructive floor: never stamp Pack on a destructive goal.
  let orchestrationMode = input.orchestrationMode;
  if (risk === 'destructive' && orchestrationMode === 'pack') {
    orchestrationMode = 'guided';
  }
  if (orchestrationMode === 'pack' && !input.wavePackTemplateId) {
    throw new Error(
      'wave_pack_template_required: Pack no lançamento exige template Landing/SaaS/Fix',
    );
  }
  const wavePackTemplateId =
    orchestrationMode === 'pack' ? input.wavePackTemplateId : undefined;
  const wavePackStories =
    orchestrationMode === 'pack' && wavePackTemplateId
      ? freezeWavePackStoriesForContract({ templateId: wavePackTemplateId })
      : undefined;
  if (orchestrationMode === 'pack') {
    assertWavePackStoriesReady(
      wavePackStories ?? [],
      'compileIntentContract',
    );
  }
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
    ...(orchestrationMode ? { orchestrationMode } : {}),
    ...(wavePackTemplateId ? { wavePackTemplateId } : {}),
    ...(wavePackStories && wavePackStories.length > 0
      ? { wavePackStories: [...wavePackStories] }
      : {}),
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

/** True when the mission is plan-only (design before code). */
export function isPlanLane(mission: {
  readonly intentContract?: { readonly lane?: MissionLane | null } | null;
}): boolean {
  return mission.intentContract?.lane === 'plan';
}

/**
 * Paths a plan-lane agent may write (relative, posix). Everything else is deny.
 * plan.md lives at the workspace root of the mission checkout.
 */
export const PLAN_LANE_WRITABLE_PATHS = ['plan.md', 'docs/plan.md'] as const;

export function isPlanLaneWritablePath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll('\\', '/').replace(/^\.\//, '');
  return (PLAN_LANE_WRITABLE_PATHS as readonly string[]).includes(normalized);
}

/**
 * Documentation surface — the plan-lane write fence generalized.
 *
 * The plan lane already proved the shape: when the deliverable is prose, the
 * agent must be unable to reach code at all, and the cheapest enforceable
 * boundary is the ownership path list itself. A `doc` work-kind mission
 * (guided-mission-work-graph) reuses this predicate to intersect its mutation
 * ownership, so "escreva o ADR" cannot silently become a refactor.
 *
 * Deliberately narrow: a documentation extension anywhere, or anything under a
 * documentation directory claim. `src/components/Button.md` is doc; `src` is
 * not. Ownership entries can be directory claims (`docs`) or files
 * (`README.md`), so both forms are accepted.
 */
export const DOCUMENT_WRITABLE_EXTENSIONS = [
  'md',
  'mdx',
  'markdown',
  'rst',
  'adoc',
  'asciidoc',
  'txt',
] as const;

export const DOCUMENT_WRITABLE_DIRECTORIES = [
  'doc',
  'docs',
  'documentation',
  'documentacao',
] as const;

/**
 * Names that end in a documentation extension and are NOT documents: a
 * dependency manifest or a build script the next `install`/configure run
 * EXECUTES. `.txt` has to stay writable (release notes, ADR drafts), so the
 * fence needs this deny-list to keep its promise.
 *
 * This is not hypothetical: the guided ownership catalog seeds every plan with
 * `requirements.txt`, `requirements-dev.txt` and `CMakeLists.txt`
 * unconditionally (guided-mission-ownership), so without the deny-list a doc
 * mission ("escreva o ADR do módulo X") owned a dependency pin and a build
 * script, and the ownership diff accepted a malicious pin as a documentation
 * change. Matched on the BASENAME regardless of directory: `docs/CMakeLists.txt`
 * is a real, executed CMake file too.
 */
const DOCUMENT_DENIED_BASENAME_PATTERNS: readonly RegExp[] = [
  /^cmakelists\.txt$/,
  /^conanfile\.txt$/,
  /(?:^|[-_.])requirements(?:[-_.][^/]*)?\.txt$/,
  /(?:^|[-_.])constraints(?:[-_.][^/]*)?\.txt$/,
];

export function isDocumentDeniedBasename(basename: string): boolean {
  const name = basename.trim().toLowerCase();
  return DOCUMENT_DENIED_BASENAME_PATTERNS.some((pattern) =>
    pattern.test(name),
  );
}

export function isDocumentWritablePath(relativePath: string): boolean {
  const normalized = relativePath
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
  if (!normalized) return false;
  if ((PLAN_LANE_WRITABLE_PATHS as readonly string[]).includes(normalized)) {
    return true;
  }
  const segments = normalized.split('/');
  const basename = segments[segments.length - 1] ?? '';
  // Deny before any allow: the documentation directory claim must not launder
  // a manifest that happens to live under `docs/`.
  if (isDocumentDeniedBasename(basename)) return false;
  const root = (segments[0] ?? '').toLowerCase();
  if ((DOCUMENT_WRITABLE_DIRECTORIES as readonly string[]).includes(root)) {
    return true;
  }
  const dot = basename.lastIndexOf('.');
  if (dot <= 0) return false;
  return (DOCUMENT_WRITABLE_EXTENSIONS as readonly string[]).includes(
    basename.slice(dot + 1).toLowerCase(),
  );
}

/**
 * Soft lane suggestion from goal text for the mission wizard autopilot.
 * Returns null when the goal is neutral (keep standard). Never forces a lane
 * after the operator has manually picked one (wizard owns that).
 *
 * Order: implement signals win first (never suggest a lane for code work —
 * this is also the guard that keeps "subir" from catching "subir código/PR"),
 * Explicit team fan-out stays on standard after that guard; consult has no
 * worker budget and would otherwise silently collapse the requested round.
 * Then consult (investigation), plan (design-only), and ops (infra).
 */
export function suggestMissionLaneFromGoal(goal: string): MissionLane | null {
  const g = goal.trim();
  if (g.length < 8) return null;
  const implement =
    /\b(implementar|implementa[cç][aã]o|codar|escrever\s+c[oó]digo|fix(ar)?\s|corrigir|bug|feature|refator|merge|worktree|testes?\s+e\s+c[oó]digo)\b/i.test(
      g,
    );
  if (implement) return null;
  if (classifyStandardMissionTopology(g) === 'team-read-only-fanout') {
    return null;
  }
  const consult =
    /\b(consultar|consulta\b|somente\s+leitura|read-?only|ler\s+logs?|status\s+de|investigar|investigue|diagn[oó]stico|diagnosticar|doctor|o\s+que\s+est[aá]\s+acontecendo|analis(?:e|a|ar|em)|an[aá]lise|analy(?:ze|sis)|audit(?:e|ar|oria)?\b|mapea(?:r|m)|mapeie|entend(?:er|a)|explique|explicar|avali(?:e|ar)|como\s+funciona|por\s*que\s+(?:o|a|isso|ele|ela)\b)\b/i.test(
      g,
    );
  if (consult) return 'consult';
  const plan =
    /\b(planejar|planejamento|plano\s+de|arquitet(ura|ar)|desenhar|design\s+(da|do|de|system)|escrever\s+(o\s+)?prd|especificar\s+abordagem|documentar\s+arquitetura|s[oó]\s+o\s+plano|sem\s+c[oó]digo)\b/i.test(
      g,
    );
  if (plan) return 'plan';
  const ops =
    /\b(deploy|backups?|ssh|vps|servidor(es)?|landing\s*page|dns|subir|pausar|migrar|restart(ar)?|publicar)\b/i.test(
      g,
    );
  if (ops) return 'ops';
  return null;
}

/** Minimum durable learning size for consult-lane done (not code PREVC green). */
export const CONSULT_DONE_MIN_LEARNING_CHARS = 40;

/**
 * Consult-lane done is allowed only with a durable learning note (existing
 * learnings and/or the status note), never as a silent green shortcut.
 */
export function canCompleteConsultLane(input: {
  readonly learnings?: string | null;
  readonly note?: string | null;
}): boolean {
  const learnings = input.learnings?.trim() ?? '';
  const note = input.note?.trim() ?? '';
  const combined =
    learnings.length > 0 && note.length > 0
      ? learnings.length + 2 + note.length
      : learnings.length + note.length;
  return combined >= CONSULT_DONE_MIN_LEARNING_CHARS;
}

/**
 * Ops-lane done mirrors consult-lane: allowed only with a durable note of what
 * was executed (learnings and/or the status note), never a silent green
 * shortcut — ops completion is not code PREVC green either.
 */
export function canCompleteOpsLane(input: {
  readonly learnings?: string | null;
  readonly note?: string | null;
}): boolean {
  return canCompleteConsultLane(input);
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
    mission.status === 'running' &&
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
  readonly goal?: string;
  readonly intentVersion?: number;
  readonly now?: number;
  /** Dedicated single-session authority profile; never inherits PREVC workers. */
  readonly profile?: 'standard' | 'pet-studio';
}): MissionIntentContract {
  const now = input.now ?? Date.now();
  const goal =
    input.goal?.trim() ||
    input.title.trim() ||
    'Execução imediata autorizada (legado / perfil dedicado)';
  const petStudio = input.profile === 'pet-studio';
  const base = compileIntentContract({
    goal,
    source: 'automation',
    intentVersion: Math.max(1, input.intentVersion ?? 1),
    executionMode: 'autopilot',
    contextPolicy: 'on-demand',
    acceptanceCriteria: petStudio
      ? [
          'Sessão Codex única iniciou com objetivo e imagem autorizados',
          'Pacote final passou geração, montagem e QA da skill nexus-pet-studio',
          'Handoff final contém caminho do pacote, manifesto e evidências verificáveis',
        ]
      : [
          'Missão legada despachada com orquestrador ativo',
          'Workers e bootstrap permitidos sob PREVC e effect policy',
        ],
  });
  return {
    ...base,
    ...(petStudio
      ? {
          budgets: { ...base.budgets, maxWorkers: 0 },
          deniedTools: [
            'route_task',
            'pane_spawn',
            'task',
            'worktree_create',
            'worktree_merge',
            'mission_freeze_contract',
          ],
        }
      : {}),
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

/**
 * Steps/tokens são LEDGER, não teto. O contrato ainda registra spentSteps e
 * spentTokens (estimativa sintética — nunca a conta real do provider), mas
 * nenhum dos dois bloqueia trabalho: caso de campo 17/07 — missão real
 * travava com "12k tokens esgotados" ainda no bootstrap obrigatório, porque
 * doctor/draft cobram 400 "tokens" fictícios por chamada. Runaway continua
 * protegido pelo mission driver (maxIterations/maxWallClock), pelo PREVC e
 * por maxWorkers — que são limites reais, não contadores inventados.
 */
export function assertStepAndTokenBudget(
  _contract: MissionIntentContract | null | undefined,
): BudgetGateResult {
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
    attachmentPaths: contract.attachmentPaths
      ? [...contract.attachmentPaths]
      : undefined,
    attachmentSnapshots: contract.attachmentSnapshots
      ? contract.attachmentSnapshots.map((snapshot) => ({ ...snapshot }))
      : undefined,
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

/**
 * Registra o próximo efeito no ledger. Nunca nega: os contadores existem para
 * auditoria/telemetria da missão, não como teto (ver assertStepAndTokenBudget).
 */
export function reserveEffectfulSpend(
  contract: MissionIntentContract,
  toolName: string,
): EffectfulSpendReservation {
  return { ok: true, contract: applyEffectfulSpend(contract, toolName) };
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
