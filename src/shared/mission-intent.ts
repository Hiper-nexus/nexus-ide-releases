import { z } from 'zod';
import { resolveMissionBlockingIntentState } from './mission-blocking';
import {
  missionStatusForIntent as projectMissionStatusForIntent,
  type IntentMappedMissionStatus,
} from './mission-intent-projection';
import { classifyStandardMissionTopology } from './mission-topology';
import { missionRoutingAdviceSchema } from './mission-routing-advice';
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

export interface MissionStatusIntentPair {
  readonly status: IntentMappedMissionStatus;
  readonly intentState: MissionIntentState;
}

export function isMissionStatusIntentPair(
  pair: MissionStatusIntentPair,
): boolean {
  const blockingState = resolveMissionBlockingIntentState(pair);
  if (pair.status === 'blocked' || pair.status === 'failed') {
    return blockingState === pair.intentState;
  }
  return (
    blockingState === null &&
    projectMissionStatusForIntent(pair.intentState) === pair.status
  );
}

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

/**
 * Canonical maximum tool grant for a mission lane and roster role.
 * Unknown future worker categories inherit the unrestricted policy.
 */
export function missionLaneMaximumTools(
  _lane: MissionLane,
  _category: string,
): readonly string[] | null {
  // Lanes and categories do not impose a hard tool ceiling. Since F-1157 the
  // gate context restricts nothing (read-only only under the operator's
  // Hardened mode); the mission contract's deniedTools list still applies.
  return null;
}

export function missionLaneDefaultTools(
  lane: MissionLane,
  category: string,
): string[] | null {
  const maximum = missionLaneMaximumTools(lane, category);
  return maximum === null ? null : [...maximum];
}

export function clampMissionLaneTools(
  lane: MissionLane,
  category: string,
  granted: readonly string[] | null | undefined,
): string[] | null | undefined {
  const maximum = missionLaneMaximumTools(lane, category);
  if (maximum === null) {
    return granted === undefined
      ? undefined
      : granted === null
        ? null
        : [...granted];
  }
  if (lane === 'consult' || lane === 'plan' || granted == null) {
    return [...maximum];
  }
  return maximum.filter((tool) => granted.includes(tool));
}

export function missionLaneAllowsTools(
  lane: MissionLane,
  category: string,
  granted: readonly string[] | null | undefined,
): boolean {
  const maximum = missionLaneMaximumTools(lane, category);
  if (maximum === null) return true;
  if (granted == null) return false;
  return granted.every((tool) => maximum.includes(tool));
}

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
    /** Provider input. Sealed Pet snapshots point outside the checkout. */
    path: z.string().min(1).max(4_096),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().nonnegative().max(14 * 1024 * 1024),
    /** Display-only origin reviewed by the operator; never a sandbox grant. */
    sourcePath: z.string().min(1).max(4_096).optional(),
    /** Main-minted random identity embedded in the sealed artifact filename. */
    sealId: z.string().regex(/^[a-f0-9]{32,128}$/).optional(),
    /** Persisted identity of the exact sealed regular file. */
    device: z.string().regex(/^[0-9]+$/).optional(),
    inode: z.string().regex(/^[0-9]+$/).optional(),
    /** Creation-time metadata detects same-inode replacement on Linux. */
    ctimeNs: z.string().regex(/^[0-9]+$/).optional(),
    /** Modification-time metadata detects same-inode content drift. */
    mtimeNs: z.string().regex(/^[0-9]+$/).optional(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const sealedIdentityMetadata = [
      snapshot.sourcePath,
      snapshot.sealId,
      snapshot.device,
      snapshot.inode,
    ];
    const identityPresent = sealedIdentityMetadata.filter(
      (value) => value !== undefined,
    ).length;
    const sealedTimeMetadata = [snapshot.ctimeNs, snapshot.mtimeNs];
    const timePresent = sealedTimeMetadata.filter(
      (value) => value !== undefined,
    ).length;
    if (
      (identityPresent !== 0 &&
        identityPresent !== sealedIdentityMetadata.length) ||
      (timePresent !== 0 && timePresent !== sealedTimeMetadata.length)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'sealed attachment metadata must be complete',
      });
    }
  });
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
        source: z.enum([
          'http-mcp',
          'acp-stdio',
          'pty-stream',
          'mission-shim',
          'omp-rpc-stdio',
        ]),
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

export const MISSION_INTENT_GOAL_MAX_CHARS = 16_384;

export const missionProjectContextPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_096)
  .refine((value) => {
    if (
      value.includes('\0') ||
      value.startsWith('/') ||
      value.startsWith('\\') ||
      value === '~' ||
      value.startsWith('~/') ||
      value.startsWith('~\\') ||
      /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)
    ) {
      return false;
    }
    return value
      .replaceAll('\\', '/')
      .split('/')
      .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
  }, 'context path must be project-relative')
  .transform((value) => value.replaceAll('\\', '/'));

/** Main-issued workspace choice, included in the reviewed authority. Never a filesystem path. */
export const missionWorkspaceBindingSchema = z.object({
  version: z.literal(1),
  spaceId: z.string().regex(/^space-[a-z0-9-]{1,120}$/).optional(),
  adoptedPaneId: z.string().min(1).max(128).optional(),
  /**
   * Aba do renderer que criou a missão leve no checkout principal (sem
   * `spaceId`): persistida para "uma missão por aba" sobreviver ao reinício
   * do Main. Chave opaca do renderer, nunca um caminho.
   */
  tabKey: z.string().min(1).max(256).optional(),
}).strict().refine(value => Boolean(value.spaceId || value.adoptedPaneId), 'workspace binding is empty');
export type MissionWorkspaceBinding = z.infer<typeof missionWorkspaceBindingSchema>;

export const missionIntentContractSchema = z.object({
  workspaceBinding: missionWorkspaceBindingSchema.optional(),
  version: z.literal(1),
  source: missionIntentSourceSchema,
  // PREVC's compiler canonicalizes these same human-authored fields with
  // `trim()`. Canonicalize them at the approval boundary too so a bounded
  // truncation that lands on whitespace cannot make the freshly frozen
  // contract look stale after the one native approval.
  goal: z.string().trim().min(1).max(MISSION_INTENT_GOAL_MAX_CHARS),
  acceptanceCriteria: z
    .array(z.string().trim().min(1).max(2_048))
    .max(32),
  risk: missionIntentRiskSchema,
  executionMode: missionExecutionModeSchema,
  /** Optional; missing/legacy contracts default to standard. */
  lane: missionLaneSchema.optional(),
  /** Main-validated preparation advice; does not grant tools, skills or lanes. */
  routingAdvice: missionRoutingAdviceSchema.optional(),
  /**
   * "Escolha livre de agentes" (opt-in por missão, análogo Bridge). Quando
   * true, o orquestrador pode nexus_pane_spawn QUALQUER adapter instalado +
   * modelo do catálogo sem routeReservationId e sem squad_binding, atravessando
   * os gates cerimoniais. Os guardrails que NÃO são cerimônia (containment de
   * workspace, allowlists de tools, 1 escritor por checkout, maxWorkers) seguem
   * valendo, e a escolha continua auditada no route_log. Ausente/false = o
   * comportamento atual (rota selada do roster). Nunca default silencioso.
   */
  freeAgentChoice: z.boolean().optional(),
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
  /** Operator-selected project files/references, always root-relative. */
  contextPaths: z.array(missionProjectContextPathSchema).max(64).optional(),
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
  },
  ready_to_start: {
    start: 'dispatched',
    submit_goal: 'intent_compiling', // new user message preempts
  },
  // Estado LEGADO (06/08): o gate de aprovação saiu do caminho normal — nada
  // mais ENTRA aqui (evento needs_approval removido). As transições de SAÍDA
  // ficam para linhas antigas destravarem; fromRow também solta na leitura.
  awaiting_approval: {
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
  // Modo livre de operação: o risco restringe a superfície de aprovação e as
  // ferramentas negadas, não o paralelismo. maxWorkers e maxSteps usam o teto
  // do schema para evitar que missões reais parem prematuramente. O controle de
  // paralelismo real ainda vem do catálogo/squad e do orçamento de panes vivo.
  const highCap = {
    planningTokens: 1_200,
    executionTokens: 800_000,
    maxWorkers: 64,
    maxSteps: 100_000,
  };
  if (risk === 'destructive') {
    // destructive mantém tokens menores para não incentivar planejamento longo,
    // mas workers/steps são libertos.
    return { ...highCap, planningTokens: 1_200, executionTokens: 8_000 };
  }
  if (risk === 'sensitive') {
    return { ...highCap, executionTokens: 200_000 };
  }
  return highCap;
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
  contextPaths?: string[];
  /** Explicit delivery lane; default standard (code PREVC). */
  lane?: MissionLane;
  /** Operator override Livre / Pack / Guiado. */
  orchestrationMode?: MissionOrchestrationMode;
  /** Pack template that seeds structured stories when mode is pack. */
  wavePackTemplateId?: WavePackTemplateId;
  /** "Escolha livre de agentes" — opt-in por missão (ver schema). */
  freeAgentChoice?: boolean;
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
    ...(input.contextPaths ? { contextPaths: [...input.contextPaths] } : {}),
    ...(input.freeAgentChoice ? { freeAgentChoice: true } : {}),
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
 * F-811: o pedido INTEIRO é "só sincronizar o repositório com o remoto" — e em
 * forma explícita. Duas formas, e só elas:
 *   - comando git literal: `git pull`, `git fetch`, `--ff-only`, `fast-forward`
 *     (`merge` só vale junto de `--ff-only`/`fast-forward`);
 *   - verbo de sincronização (sincronizar/atualizar/puxar/pull/fetch/sync) com
 *     objeto repositório/branch/origin/upstream/remoto.
 * Em ambas, QUALQUER palavra fora do vocabulário fechado abaixo desclassifica:
 * é isso que impede "atualize as dependências do repositório", "atualize o
 * README do repositório", "atualizar o workflow do GitHub Actions", "fetch os
 * dados da API do GitHub e mostre no dashboard" e "puxe as issues do github e
 * gere um relatório em docs/" de virarem `ops` (done sem arquivo). O custo de
 * errar para o lado conservador é só a missão ficar `standard`; o de errar para
 * o outro é uma tarefa de escrita entregar sem arquivo.
 *
 * Linear: o objetivo é cortado em 280 caracteres antes de qualquer varredura e
 * cada token é consultado em um Set (sem regex com backtracking sobre o texto).
 */
const GIT_SYNC_GOAL_MAX_CHARS = 280;
const GIT_SYNC_VERBS: ReadonlySet<string> = new Set([
  'sincronizar', 'sincronize', 'sincroniza', 'sincronizando', 'sincronizem',
  'atualizar', 'atualize', 'atualiza', 'atualizando', 'atualizem',
  'puxar', 'puxe', 'puxa', 'puxando', 'pull', 'fetch', 'sync', 'synchronize',
]);
const GIT_SYNC_OBJECTS: ReadonlySet<string> = new Set([
  'repositorio', 'repositorios', 'repo', 'repos', 'branch', 'branches',
  'origin', 'upstream', 'remoto', 'remote', 'main', 'master', 'develop',
  'git', 'github',
]);
const GIT_SYNC_NEUTRAL_WORDS: ReadonlySet<string> = new Set([
  // fazer/rodar o comando
  'faca', 'fazer', 'rode', 'rodar', 'execute', 'executar', 'run',
  // artigos, preposições, conjunções
  'o', 'a', 'os', 'as', 'um', 'uma', 'de', 'do', 'da', 'dos', 'das', 'em',
  'no', 'na', 'nos', 'nas', 'com', 'para', 'pra', 'por', 'pelo', 'pela', 'ao',
  'e', 'ou', 'que', 'se', 'me', 'meu', 'minha', 'nosso', 'nossa', 'esse',
  'essa', 'este', 'esta', 'isso', 'the', 'with', 'from', 'to', 'of', 'on',
  'and', 'my', 'our',
  // cortesia e qualificadores da própria sincronização
  'please', 'favor', 'pf', 'agora', 'apenas', 'so', 'somente', 'sem',
  'conflito', 'conflitos', 'local', 'locais', 'atual', 'principal', 'mais',
  'recente', 'recentes', 'ultimo', 'ultima', 'ultimos', 'ultimas', 'novo',
  'nova', 'novos', 'novas', 'mudancas', 'alteracoes', 'commit', 'commits',
]);
const GIT_SYNC_FAST_FORWARD: ReadonlySet<string> = new Set([
  '--ff-only', 'ff-only', 'fast-forward', 'fastforward',
]);
const GIT_SYNC_REMOTE_REF_RE = /^(?:origin|upstream)\/[a-z0-9._/-]{1,64}$/;
const GIT_SYNC_TRIM_CHARS = '"\'`()[]{}<>.,;:!?';

function trimGitSyncToken(token: string): string {
  let from = 0;
  let to = token.length;
  while (from < to && GIT_SYNC_TRIM_CHARS.includes(token[from]!)) from += 1;
  while (to > from && GIT_SYNC_TRIM_CHARS.includes(token[to - 1]!)) to -= 1;
  return token.slice(from, to);
}

export function isExplicitGitSyncGoal(goal: string): boolean {
  const text = goal.trim();
  if (text.length === 0 || text.length > GIT_SYNC_GOAL_MAX_CHARS) return false;
  const tokens = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/\s+/);
  let sawVerb = false;
  let sawObject = false;
  let sawFastForward = false;
  let sawMerge = false;
  let sawGitCommand = false;
  let previous = '';
  for (const raw of tokens) {
    const token = trimGitSyncToken(raw);
    // Pontuação solta ("—", "·", "-") é separador, não conteúdo.
    if (token.length === 0 || !/[a-z0-9]/.test(token)) continue;
    if (GIT_SYNC_VERBS.has(token)) {
      sawVerb = true;
      if (previous === 'git' && (token === 'pull' || token === 'fetch')) sawGitCommand = true;
    } else if (GIT_SYNC_OBJECTS.has(token) || GIT_SYNC_REMOTE_REF_RE.test(token)) {
      sawObject = true;
    } else if (GIT_SYNC_FAST_FORWARD.has(token)) {
      sawFastForward = true;
    } else if (token === 'merge') {
      sawMerge = true;
    } else if (!GIT_SYNC_NEUTRAL_WORDS.has(token)) {
      return false;
    }
    previous = token;
  }
  // `merge` só é transporte quando a própria frase diz que é fast-forward.
  if (sawMerge && !sawFastForward) return false;
  return sawGitCommand || sawFastForward || (sawVerb && sawObject);
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
/**
 * A lane que o objetivo pede.
 *
 * A ordem AQUI é a regra do produto, não detalhe de implementação. Sonda de
 * 89 objetivos reais (23/08) mostrou que os erros graves eram todos de
 * PRECEDÊNCIA: um sinal fraco vencia uma recusa explícita, ou um substantivo
 * de investigação vencia um verbo de conserto. A hierarquia é:
 *
 *   1. recusa explícita de ALTERAR  → consult   (a pessoa disse "não mexa")
 *   2. recusa explícita de CODAR    → plan      (a pessoa disse "só o plano")
 *   3. artefato de planejamento     → plan      (escrever um PRD é planejar)
 *   4. qualquer verbo que ESCREVE   → standard  (numa missão mista, escrever
 *                                                vence: a lane excludente
 *                                                destruiria essa metade)
 *   5. investigação                 → consult
 *   6. planejamento                 → plan
 *   7. operação                     → ops
 */
export function suggestMissionLaneFromGoal(goal: string): MissionLane | null {
  const g = goal.trim();
  if (g.length < 8) return null;

  // 0. Leque de perguntas à equipe é uma FORMA de missão, não uma lane: ele
  //    precisa da standard para abrir os panes, mesmo dizendo "sem editar".
  //    Tem que vir antes da recusa de alteração, senão a própria frase que
  //    descreve o leque o manda para somente-leitura.
  if (classifyStandardMissionTopology(g) === 'team-read-only-fanout') {
    return null;
  }

  // 1. "sem alterar nada", "não mexa", "só me diga", "somente leitura".
  //    Vence TUDO: é a pessoa proibindo a escrita com todas as letras.
  const readOnlyRefusal =
    /\b(?:sem|n[aã]o)\s+(?:alterar|mexer|mudar|modificar|editar|tocar)\b|\bn[aã]o\s+(?:mexa|altere|mude|modifique|edite|toque)\b|\b(?:s[oó]|apenas|somente)\s+(?:me\s+)?(?:diga|dize|olhe|leia|analise|revise|verifique)\b|\bsomente\s+leitura\b|\bread-?only\b/i.test(
      g,
    );
  if (readOnlyRefusal) return 'consult';

  // 2. "só o plano", "sem escrever código", "antes de implementar".
  const planOnly =
    /\b(?:sem|nao|não)\s+(?:escrever\s+)?(?:c[oó]digo|implement(?:ar|e|a)|codar|mexer\s+no\s+c[oó]digo)\b|\b(?:s[oó]|apenas|somente)\s+(?:o\s+)?(?:plano|an[aá]lise)\b|\bantes\s+de\s+implementar\b|\bn[aã]o\s+escreva\s+c[oó]digo\b/i.test(
      g,
    );
  if (planOnly) return 'plan';

  // 3. Escrever um PRD/documento de arquitetura É planejar, mesmo com verbo
  //    de escrita: a lane `plan` faz o coordenador produzir o documento sem
  //    abrir trabalhadores, que é exatamente o certo aqui.
  const planArtifact =
    /\b(?:prd|documento\s+de\s+arquitetura|plano\s+de\s+arquitetura|especifica[cç][aã]o\s+t[eé]cnica)\b/i.test(
      g,
    );
  if (planArtifact) return 'plan';

  // 3.5. SOMENTE sincronização Git em forma EXPLÍCITA ("atualiza o repositório
  //     local com o GitHub", "git pull --ff-only", "sincronizar com origin/main"):
  //     o pull/merge daqui é o TRANSPORTE da atualização, não integração de
  //     código novo — a missão não produz arquivo e o gate de entrega aceita
  //     ops com nota durável (F-785). F-811: o predicado é o TEXTO INTEIRO ser
  //     sincronização (vocabulário fechado); "atualize as dependências do
  //     repositório", "puxe as issues do github e gere um relatório" e
  //     "investigue por que o git pull falha" NÃO são ops — nesses o done sem
  //     arquivo deixava passar tarefa de escrita. Fica ANTES do passo 4 porque
  //     `merge --ff-only` é transporte ali; pedido misto segue para o 4.
  if (isExplicitGitSyncGoal(g)) return 'ops';

  // 4. Qualquer verbo que escreve. Em missão MISTA ("analise E refatore",
  //    "diagnostique E otimize"), escrever vence — a lane excludente
  //    proibiria justamente a metade que produz a entrega.
  const writes =
    /\b(implement(?:ar|e|a|em)|implementa[cç][aã]o|codar|escrever\s+c[oó]digo|cri(?:ar|e|a)|constru(?:ir|a|am)|mont(?:ar|e|a)|desenvolv(?:er|a)|refator(?:ar|e|a|ando)?|otimiz(?:ar|e|a)|adicion(?:ar|e|a)|integr(?:ar|e|a)|traduz(?:ir|a)|fix(ar)?\s|corrig(?:ir|e|em)|corrija|arrum(?:ar|e|a)|consert(?:ar|e|a)|resolv(?:er|a|e)|proteg(?:er|e)|proteja|bug|feature|merge|worktree|testes?\s+e\s+c[oó]digo)\b/i.test(
      g,
    );
  if (writes) return null;

  // 5. Investigação. Inclui as formas que o leigo usa para pedir um
  //    diagnóstico: "descubra o motivo", "meça", "onde está o gargalo".
  const consult =
    /\b(consultar|consulta\b|somente\s+leitura|read-?only|ler\s+logs?|status\s+de|investigar|investigue|diagn[oó]stico|diagnosticar|doctor|descubr(?:a|ir)|me[cç]a|medir|gargalo|motivo\s+d|causa\s+d|o\s+que\s+est[aá]\s+acontecendo|analis(?:e|a|ar|em)|an[aá]lise|analy(?:ze|sis)|audit(?:e|ar|oria)?\b|mapea(?:r|m)|mapeie|entend(?:er|a)|explique|explicar|avali(?:e|ar)|como\s+funciona|por\s*que\s+(?:o|a|isso|ele|ela)\b)\b/i.test(
      g,
    );
  if (consult) return 'consult';

  // 6. Planejamento.
  const plan =
    /\b(planejar|planejamento|plano\s+de|arquitet(ura|ar)|desenhar|design\s+(da|do|de|system)|escrever\s+(o\s+)?prd|especificar\s+abordagem|documentar\s+arquitetura|s[oó]\s+o\s+plano|sem\s+c[oó]digo)\b/i.test(
      g,
    );
  if (plan) return 'plan';
  const ops =
    // `landing page` NÃO é ops: criar uma é trabalho de produto/UI. Estava
    // aqui e fazia "crie uma landing page" virar missão de infraestrutura —
    // visível só quando o Caminho Expresso passou a consultar a lane (voo
    // 23/08). Publicar uma continua sendo ops por `publicar`/`deploy`/`subir`.
    /\b(deploy|backups?|ssh|vps|servidor(es)?|dns|subir|pausar|migrar|restart(ar)?|publi(?:car|ca|que|quem)|hosped(?:ar|e))\b/i.test(
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
