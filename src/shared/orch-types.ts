import { z } from 'zod';
import type { ProjectExecutionScope } from './types';
import {
  missionIntentContractSchema,
  missionIntentStateSchema,
  type MissionIntentContract,
  type MissionIntentState,
} from './mission-intent';

export {
  missionIntentContractSchema,
  missionIntentStateSchema,
  type MissionIntentContract,
  type MissionIntentState,
} from './mission-intent';

/**
 * Orchestration domain types shared across main / preload / renderer and the
 * embedded MCP server. Everything is JSON-serializable.
 *
 * The Squad schema defines the squads.json shape (see docs/ARCHITECTURE.md
 * §E.1) so squads can be imported/exported 1:1.
 */

export const agentCategorySchema = z.enum([
  'orchestrator',
  'scout',
  'executor',
  'reviewer',
  'architect',
]);
export type AgentCategory = z.infer<typeof agentCategorySchema>;

const INVISIBLE_AUTHORITY_CONTROL_RE =
  /[\0-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u;

function authorityString(max: number, label: string, min = 0) {
  return z
    .string()
    .min(min)
    .max(max)
    .refine((value) => !INVISIBLE_AUTHORITY_CONTROL_RE.test(value), {
      message: `${label} contains an invisible control or bidi character`,
    });
}

/** providerId → adapter id (builtin mapping). */
const PROVIDER_ID_TO_CLI: Record<string, string> = {
  'claude-cli': 'claude',
  'codex-cli': 'codex',
  // Google's Gemini CLI slot is now served by AGY in Nexus defaults.
  'gemini-cli': 'agy',
  'kimi-cli': 'kimi',
  'antigravity-cli': 'agy',
};

export const squadAgentSchema = z.preprocess(
  // Some squads.json rosters may omit `cli` (workers inherit the default CLI)
  // or carry only a providerId — normalize before validating.
  (raw) => {
    if (raw && typeof raw === 'object' && !(raw as { cli?: unknown }).cli) {
      const agent = raw as { providerId?: string };
      const mapped = agent.providerId
        ? PROVIDER_ID_TO_CLI[agent.providerId]
        : undefined;
      return { ...raw, cli: mapped ?? 'claude' };
    }
    return raw;
  },
  z.object({
    id: authorityString(128, 'agent id', 1),
    agentName: authorityString(128, 'agent name', 1),
    category: agentCategorySchema,
    /** Adapter id (claude, codex, agy, …) that backs this agent. */
    cli: authorityString(64, 'agent cli', 1),
    providerId: authorityString(128, 'agent provider id').optional(),
    model: authorityString(128, 'agent model').optional(),
    // CLI-owned capability: new levels (for example Codex `ultra`) must not
    // require a Nexus release. Spawn validation still checks the adapter.
    effort: z
      .string()
      .min(1)
      .max(32)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    /** null/absent = unrestricted. */
    allowedSkills: z
      .array(authorityString(128, 'allowed skill'))
      .max(128)
      .nullable()
      .optional(),
    allowedTools: z
      .array(authorityString(128, 'allowed tool'))
      .max(128)
      .nullable()
      .optional(),
  }),
);
export type SquadAgent = z.infer<typeof squadAgentSchema>;

export const squadSchema = z
  .object({
    id: authorityString(128, 'squad id', 1),
    name: authorityString(256, 'squad name', 1),
    // Some exports write epoch-ms numbers here; others use ISO strings.
    createdAt: z
      .union([authorityString(64, 'squad createdAt'), z.number()])
      .transform((value) => String(value)),
    builtin: z.boolean().default(false),
    orchestratorInstructions: authorityString(
      65_536,
      'orchestrator instructions',
    ).default(''),
    /** Optional per-squad native instructions — preserved as-is. */
    nativeInstructions: authorityString(
      65_536,
      'native instructions',
    ).optional(),
    /**
     * Main-owned lineage for an immutable mission runtime snapshot.
     * Renderer/global squad writes may request a snapshot from a source id,
     * but only main validates and persists these two fields.
     */
    runtimeSourceSquadId: authorityString(
      128,
      'runtime source squad id',
      1,
    ).optional(),
    runtimeSourceSquadRevisionHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    agents: z.array(squadAgentSchema).max(32).default([]),
  })
  .superRefine((squad, ctx) => {
    const ids = new Set<string>();
    for (const [index, agent] of squad.agents.entries()) {
      if (ids.has(agent.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['agents', index, 'id'],
          message: `duplicate agent id: ${agent.id}`,
        });
      }
      ids.add(agent.id);
    }
  });
export type Squad = z.infer<typeof squadSchema>;

/** Wire format of a squads file. */
export const squadsFileSchema = z
  .object({ squads: z.array(squadSchema).max(64) })
  .superRefine((file, ctx) => {
    const ids = new Set<string>();
    for (const [index, squad] of file.squads.entries()) {
      if (ids.has(squad.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['squads', index, 'id'],
          message: `duplicate squad id: ${squad.id}`,
        });
      }
      ids.add(squad.id);
    }
  });

export const missionStatusSchema = z.enum([
  'pending',
  'running',
  'blocked',
  'done',
  'failed',
]);
export type MissionStatus = z.infer<typeof missionStatusSchema>;

/** PREVC-aligned step status (mission driver Fase B). */
export const milestoneStatusSchema = z.enum([
  'pending',
  'in-progress',
  'blocked',
  'done',
]);
export type MilestoneStatus = z.infer<typeof milestoneStatusSchema>;

export const missionMilestoneSchema = z.object({
  id: z.string().min(1).max(128),
  label: z.string().min(1).max(1024),
  status: milestoneStatusSchema,
  evidenceIds: z.array(z.string().min(1).max(256)).max(64),
});
export type MissionMilestone = z.infer<typeof missionMilestoneSchema>;

/**
 * Create/patch input: legacy plain string OR structured object.
 * Strings coerce to `{id, label, status:'pending', evidenceIds:[]}`.
 */
export const missionMilestoneInputSchema = z.union([
  z.string().min(1).max(1024),
  z.object({
    id: z.string().min(1).max(128).optional(),
    label: z.string().min(1).max(1024),
    status: milestoneStatusSchema.optional(),
    evidenceIds: z.array(z.string().min(1).max(256)).max(64).optional(),
  }),
]);
export type MissionMilestoneInput = z.input<typeof missionMilestoneInputSchema>;

/** Coerce a single legacy string or partial object into a structured milestone. */
export function normalizeMilestone(
  input: MissionMilestoneInput,
  index: number,
): MissionMilestone {
  if (typeof input === 'string') {
    return {
      id: `step-${index + 1}`,
      label: input,
      status: 'pending',
      evidenceIds: [],
    };
  }
  return {
    id: input.id ?? `step-${index + 1}`,
    label: input.label,
    status: input.status ?? 'pending',
    evidenceIds: [...(input.evidenceIds ?? [])],
  };
}

export function normalizeMilestones(
  inputs: ReadonlyArray<MissionMilestoneInput>,
): MissionMilestone[] {
  return inputs.map((item, index) => normalizeMilestone(item, index));
}

/**
 * Structural rule: `done` requires non-empty evidenceIds. Without them the
 * step is coerced off `done` (stays non-done). Trust resolution is separate
 * (`canMarkMilestoneDone` with a nexus-trusted id set).
 */
export function structuralCoerceMilestones(
  milestones: readonly MissionMilestone[],
): MissionMilestone[] {
  return milestones.map((milestone) => {
    const evidenceIds = [...milestone.evidenceIds];
    if (milestone.status === 'done' && evidenceIds.length === 0) {
      return { ...milestone, status: 'pending', evidenceIds };
    }
    return { ...milestone, evidenceIds };
  });
}

/**
 * A step may only be marked `done` when every evidenceId resolves as
 * nexus-trusted. Empty evidenceIds never qualify.
 */
export function canMarkMilestoneDone(
  milestone: Pick<MissionMilestone, 'evidenceIds'>,
  trustedEvidenceIds: ReadonlySet<string>,
): boolean {
  if (milestone.evidenceIds.length === 0) return false;
  return milestone.evidenceIds.every((id) => trustedEvidenceIds.has(id));
}

/** Project structured milestones to label strings (UI / legacy join surfaces). */
export function milestoneLabels(
  milestones: readonly MissionMilestone[],
): string[] {
  return milestones.map((milestone) => milestone.label);
}

export interface Mission {
  id: string;
  title: string;
  description: string;
  status: MissionStatus;
  squadId?: string;
  /**
   * Structured step checkpoints (Fase B). Legacy string[] rows coerce on load
   * via `normalizeMilestones`. `done` requires trusted evidenceIds.
   */
  milestones: MissionMilestone[];
  /**
   * Markdown append-only de aprendizados da missão: seção "## Padrões" no topo
   * (consolidada) + entradas cronológicas. Consumido por iterações de
   * contexto-fresco (Fase C). Ver spec 2026-07-13-mission-driver-design.md.
   */
  learnings: string;
  /**
   * Intent-first lifecycle (additive). `legacy` / absent means pre-migration
   * rows — resolve via `resolveEffectiveIntentState`.
   */
  intentState?: MissionIntentState;
  /** Validated goal contract; absent until the user submits an objective. */
  intentContract?: MissionIntentContract;
  /** Monotonic intent version; new user input preempts stale compile results. */
  intentVersion?: number;
  /** Session that created the mission — receives handoffs when idle. */
  orchestratorSessionId?: string;
  /**
   * Latest main-owned routing trace, derived from the durable reservation
   * ledger. Informational in the renderer; never accepted back as authority.
   */
  latestRoute?: MissionRouteTrace;
  createdAt: number;
  updatedAt: number;
}

export type MissionRuntimeCloseResult =
  | {
      readonly ok: true;
      /** Absent when the mission row was already gone (orphan pane sweep). */
      readonly mission?: Mission;
      readonly terminatedSessionIds: readonly string[];
    }
  | {
      readonly ok: false;
      readonly mission?: Mission;
      readonly terminatedSessionIds: readonly string[];
      readonly cancelled?: boolean;
      readonly error?: string;
    };

export interface MissionRouteTrace {
  reservationId: string;
  taskPreview: string;
  tier: 'trivial' | 'easy' | 'medium' | 'hard' | 'critical';
  adapterId: string;
  model?: string;
  effort?: string;
  reason: string;
  state: 'reserved' | 'consumed' | 'expired';
  createdAt: number;
  expiresAt: number;
  consumedAt?: number;
  consumedBySession?: string;
}

/** Renderer-editable subset of a Mission. Any subset of fields may be patched. */
export const missionPatchSchema = z.object({
  title: z.string().min(1).max(512).optional(),
  description: z.string().max(65_536).optional(),
  status: missionStatusSchema.optional(),
  milestones: z.array(missionMilestoneInputSchema).max(256).optional(),
  intentState: missionIntentStateSchema.optional(),
  intentContract: missionIntentContractSchema.nullable().optional(),
  intentVersion: z.number().int().nonnegative().max(1_000_000).optional(),
}).strict();
export type MissionPatch = z.infer<typeof missionPatchSchema>;

export const handoffStatusSchema = z.enum([
  'success',
  'partial',
  'blocked',
  'failed',
  // Sintético e não terminal: o supervisor reengajou o coordenador, mas ainda
  // não há evidência suficiente para declarar a missão travada ao operador.
  'progress',
  // Sintético (nexus-watchdog): worker busy em silêncio prolongado sem
  // handoff — o orquestrador é acordado para diagnosticar o pane.
  'stalled',
]);
export type HandoffStatus = z.infer<typeof handoffStatusSchema>;

export const handoffEvidenceTrustSchema = z.enum([
  'unverified',
  'nexus-trusted',
  'stale',
]);
export type HandoffEvidenceTrust = z.infer<typeof handoffEvidenceTrustSchema>;

export const handoffDeliveryStateSchema = z.enum([
  'queued',
  'submitted',
  'acknowledged',
  'consumed',
]);
export type HandoffDeliveryState = z.infer<typeof handoffDeliveryStateSchema>;

export interface OperatorReviewAnnotation {
  readonly path: string;
  readonly line: number;
  readonly body: string;
}

export interface OperatorReviewFeedbackInput {
  readonly missionId: string;
  readonly annotations: readonly OperatorReviewAnnotation[];
}

export interface OperatorReviewFeedbackResult {
  readonly ok: true;
  readonly handoffId: string;
  readonly deliveryState: HandoffDeliveryState;
}

export interface HandoffEvidenceBinding {
  readonly missionId: string;
  readonly contextRevision: string;
  readonly contractHash: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly diffHash: string;
  readonly workflowRevision: number;
}

/**
 * Main-persisted receipt for the exact physical handoff operation that
 * created a handoff. HTTP MCP calls and Main-observed PTY stream blocks share
 * the same one-shot authority; ordinary store calls never receive it. The
 * retired stdio value remains readable only for migration.
 */
export interface HandoffMcpProvenance {
  /** Correlates the durable row with the MCP dispatch/audit invocation. */
  readonly receiptId: string;
  readonly toolCallId: string;
  readonly toolName: 'nexus_handoff_submit';
  readonly source: 'http-mcp' | 'acp-stdio' | 'pty-stream' | 'omp-rpc-stdio';
  readonly missionId: string;
  readonly sessionId: string;
  readonly workerIncarnationId?: string;
  /** SHA-256 fingerprint of the exact in-memory bearer authority. */
  readonly authoritySha256: string;
  /** Worker worktree HEAD observed before dispatch accepts/integrates it. */
  readonly worktreeHeadSha?: string;
  /** Canonical SHA-256 of the complete MCP args before summary compaction. */
  readonly rawPayloadSha256?: string;
  /** Stable physical worker-operation key; payload is intentionally excluded. */
  readonly logicalOperationKey?: string;
  readonly issuedAt: number;
}

export interface Handoff {
  id: string;
  missionId?: string;
  /** PTY session of the worker that submitted. */
  sessionId?: string;
  /** Main-issued generation nonce for the exact physical worker process. */
  workerIncarnationId?: string;
  fromAgent?: string;
  /** Main-owned provenance. Renderer/MCP payloads cannot select this value. */
  readonly authorityOrigin?: 'agent' | 'operator-confirmed';
  /** Present only when a physical agent transport emitted the durable row. */
  readonly mcpProvenance?: HandoffMcpProvenance;
  /** Reporter-supplied metadata. `success` never completes a mission. */
  status: HandoffStatus;
  readonly claimTrust: 'untrusted';
  summary: string;
  /** Reporter-supplied metadata; never interpreted as verification evidence. */
  artifacts: unknown[];
  /** IDs resolved against Nexus-owned evidence tables at submission time. */
  evidenceIds: string[];
  evidenceTrust: HandoffEvidenceTrust;
  /** Immutable Nexus-derived binding, present only for trusted evidence IDs. */
  evidenceBinding?: HandoffEvidenceBinding;
  delivered: boolean;
  deliveryState: HandoffDeliveryState;
  submittedAt?: number;
  acknowledgedAt?: number;
  consumedAt?: number;
  createdAt: number;
}

export type TodoStatus = 'todo' | 'in_progress' | 'done';

export interface TodoItem {
  id: string;
  name: string;
  status: TodoStatus;
  createdAt: number;
}

export interface TodoList {
  id: string;
  items: TodoItem[];
  updatedAt: number;
}

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed';

export interface TaskRecord {
  id: string;
  missionId?: string;
  title: string;
  detail: string;
  status: TaskStatus;
  /**
   * Presente APENAS quando a task foi dispensada por provider indisponível
   * (waiver advisory): explica, sem consultar o dispatch, por que ela chegou a
   * `done` sem ninguém ter executado o trabalho. Ausente = status significa o
   * que aparenta.
   */
  providerWaiverReason?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Zero-LLM activity summary of one pane (Overclock harvest): the first user
 * message of the CLI's native transcript, the last significant output line
 * and when the session stopped. `source` says where `lastLine` came from —
 * the live/recent PTY tail buffer, the on-disk transcript, or nothing found.
 */
export const paneActivitySummarySchema = z.object({
  /** First real user message (transcript), capped at 140 chars. */
  title: z.string().max(1024).nullable(),
  /** Last significant line (tail preferred, transcript fallback), ≤140 chars. */
  lastLine: z.string().max(1024).nullable(),
  /** epoch ms when the session last wrote / stopped (transcript mtime). */
  stoppedAt: z.number().int().nonnegative().nullable(),
  source: z.enum(['transcript', 'tail', 'none']),
});
export type PaneActivitySummary = z.infer<typeof paneActivitySummarySchema>;

/**
 * Recorded composition of a mission: one entry per pane that took part in it
 * (orchestrator + every worker spawned with that missionId). Persisted so a
 * mission can be reopened from history with its panes restored — the CLIs
 * re-spawn with their adapter's resume flags to continue the conversations.
 */
export interface MissionPaneAuthoritySeal {
  readonly intentVersion: number;
  readonly intentContractHash: string;
  readonly contextRevision: string;
  readonly contractHash: string;
  readonly squadRevisionHash: string;
}

export interface MissionPaneSpec {
  id: string;
  missionId: string;
  adapterId: string;
  model?: string;
  accountId?: string;
  /** Reasoning effort the pane ran with (task-router decision) — restored on reopen. */
  effort?: string;
  cwd?: string;
  title: string;
  agentName?: string;
  /** Exact worker generation; absent only for legacy/manual composition rows. */
  workerIncarnationId?: string;
  role: 'orchestrator' | 'worker';
  /** Exact Nexus capability snapshot restored with this pane. */
  allowedTools?: string[] | null;
  allowedSkills?: string[] | null;
  /**
   * Nexus MCP mutation authority; persisted so recovery cannot widen it.
   * Provider-native confinement is derived independently from the trusted
   * role/source at spawn time, so a delegate-only orchestrator can still use
   * audited Nexus delegation tools.
   */
  readOnly?: boolean;
  /** Trusted main-side execution authority captured when the pane was created. */
  scope?: ProjectExecutionScope;
  /** Task worktree filesystem authority; defaults to scope for legacy panes. */
  executionScope?: ProjectExecutionScope;
  /**
   * Exact approved mission/workflow/squad revision that created this pane.
   * Missing rows are legacy history and cannot regain mission authority.
   */
  authoritySeal?: MissionPaneAuthoritySeal;
  /**
   * paneId ORIGINAL do pane no layout — a captura de session-id de resume é
   * chaveada por (cwd, paneId); sem reutilizá-lo, o reopen criava ids novos e
   * o resume direcionado nunca acertava (caía no --continue genérico, que
   * retoma a conversa MAIS RECENTE do cwd — a da outra missão).
   */
  paneId?: string;
  createdAt: number;
  /**
   * Activity summary attached on read (orch:missions.panes) — never persisted;
   * computed on demand from the pane tail/transcript with a short cache.
   */
  activity?: PaneActivitySummary | null;
}

/** Main-sealed identity returned after the first orchestrator is materialized. */
export interface MissionOrchestratorPane {
  readonly paneId: string;
  readonly sessionId: string;
  readonly adapterId: string;
  readonly model?: string;
  readonly accountId?: string;
  readonly effort?: string;
  readonly cwd: string;
  readonly title: string;
  readonly agentName: string;
  readonly role: 'orchestrator';
}

export type MissionOrchestratorBootstrapResult =
  | {
      readonly ok: true;
      readonly missionId: string;
      readonly pane: MissionOrchestratorPane;
      readonly kickoff:
        | { readonly accepted: true }
        | {
            readonly accepted: false;
            readonly reason:
              | 'boot_timeout'
              | 'timeout'
              | 'session_exited'
              | 'write_failed'
              | 'authority_lost';
            readonly detail: string;
            readonly cta: string;
            readonly retryScheduled?: boolean;
          };
      readonly reused?: boolean;
    }
  | {
      readonly ok: false;
      readonly missionId: string;
      readonly reason:
        | 'not_authorized'
        | 'review_required'
        | 'squad_missing'
        | 'preflight_failed'
        | 'spawn_failed'
        | 'materialization_failed'
        | 'provider_exited';
      readonly error: string;
      readonly cta: string;
      /**
       * Main retained the approved authority and durably scheduled another
       * attempt. Renderers must present this as recovery, not ask for a click.
       */
      readonly retryScheduled?: boolean;
      /** Fresh main-owned revision that must pass native approval before spawn. */
      readonly intentVersion?: number;
    };

export type PaneRuntimeState =
  'spawning' | 'busy' | 'idle' | 'exited' | 'hibernated' | 'unknown';

/** One pane as mirrored into the main-process registry by the renderer. */
export interface PaneRegistryEntry {
  paneId: string;
  sessionId: string | null;
  title: string;
  kind: 'shell' | 'cli-agent' | 'browser';
  adapterId?: string;
  model?: string;
  accountId?: string;
  state?: PaneRuntimeState;
}

/** Pane snapshot returned by nexus_pane_list (registry + live state). */
export interface PaneSnapshot extends PaneRegistryEntry {
  state: PaneRuntimeState;
  missionId?: string;
  agentName?: string;
  /** Exact physical generation for a governed worker pane. */
  workerIncarnationId?: string;
  role?: 'orchestrator' | 'worker';
  scope?: Readonly<ProjectExecutionScope>;
  executionScope?: Readonly<ProjectExecutionScope>;
  /** Effective Nexus MCP mutation confinement mirrored from trusted pane meta. */
  readOnly?: boolean;
  /** Provider-native filesystem/process confinement, when enforceable. */
  nativeReadOnly?: boolean;
}

/** Main → renderer: please create a pane and spawn its session. */
export interface OrchPaneSpawnRequest {
  requestId: string;
  /** Stable pane identity minted by main for this exact physical worker. */
  paneId: string;
  adapterId: string;
  model?: string;
  /** Exact vault account selected by main for this mission spawn. */
  accountId?: string;
  /** Per-spawn reasoning effort (task-router decision). */
  effort?: string;
  cwd?: string;
  title?: string;
  missionId?: string;
  /** Visible for this process only; never persist or restore after a crash. */
  transient?: true;
  /** Agente do squad que este pane representa — exibido no badge do pane. */
  agentName?: string;
  role?: 'orchestrator' | 'worker';
  /** New mission workers are always fresh; renderer may not select recovery. */
  resume: false;
  resumeLatestOnly: false;
  restorePersistedAuthority: false;
}

/** Renderer → main: outcome of an OrchPaneSpawnRequest. */
export const orchPaneSpawnResultSchema = z.object({
  requestId: z.string().min(1).max(128),
  ok: z.boolean(),
  paneId: z.string().max(128).optional(),
  sessionId: z.string().max(128).optional(),
  error: z.string().max(1024).optional(),
});
export type OrchPaneSpawnResult = z.infer<typeof orchPaneSpawnResultSchema>;

/**
 * Main → renderer presentation hint for one already-running mission PTY.
 *
 * This is not a spawn grant. The renderer may only mount the stable pane and
 * ask the PTY boundary to adopt the exact session retained by Main.
 */
export interface MissionPanePresentationRequest {
  missionId: string;
  paneId: string;
  sessionId: string;
  role: 'orchestrator' | 'worker';
  /** Physical transport backing the pane. ACP panes have no PTY to adopt. */
  transport?: 'cli-pty' | 'acp';
  pane: Pick<
    MissionPaneSpec,
    | 'adapterId'
    | 'model'
    | 'accountId'
    | 'effort'
    | 'cwd'
    | 'title'
    | 'agentName'
    | 'role'
  >;
}

/** Main → renderer: restart one stable mission pane with a fresh context. */
export interface MissionPaneRecoveryRequest {
  requestId: string;
  missionId: string;
  paneId: string;
  role: 'orchestrator' | 'worker';
  /** Last known PTY. Missing workers may no longer have a session mirror. */
  expectedSessionId?: string;
  /** Main-owned persisted spec used only to recreate a missing stable pane. */
  pane: Pick<
    MissionPaneSpec,
    | 'adapterId'
    | 'model'
    | 'accountId'
    | 'effort'
    | 'cwd'
    | 'title'
    | 'agentName'
    | 'role'
  >;
  recap: string;
}

/** Renderer → main: acknowledged fresh session for the same stable pane. */
export const missionPaneRecoveryResultSchema = z.object({
  requestId: z.string().min(1).max(128),
  ok: z.boolean(),
  paneId: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(128).optional(),
  error: z.string().max(1024).optional(),
});
export type MissionPaneRecoveryResult = z.infer<
  typeof missionPaneRecoveryResultSchema
>;

/** Main → renderer: open a browser pane in the user's layout. */
export interface BrowserPaneOpenRequest {
  requestId: string;
  /** Stable pane identity minted by main; renderer must not substitute it. */
  paneId: string;
  url: string;
  title?: string;
}

/**
 * Main → renderer cleanup for one browser-open or orchestration-spawn attempt.
 * The renderer must only close the pane when both identities still match;
 * paneId alone is not an authority token because another workspace/request may
 * legitimately own it.
 */
export interface PaneAttemptCleanupRequest {
  paneId: string;
  requestId: string;
}

/** Backward-compatible name retained for browser-open callers. */
export type BrowserPaneCleanupRequest = PaneAttemptCleanupRequest;

/** Legacy/general closes remain pane-id strings; attempt cleanup is sealed. */
export type PaneCloseRequest = string | PaneAttemptCleanupRequest;

export const browserPaneOpenResultSchema = z.object({
  requestId: z.string().min(1).max(128),
  ok: z.boolean(),
  paneId: z.string().max(128).optional(),
  error: z.string().max(1024).optional(),
});
export type BrowserPaneOpenResult = z.infer<typeof browserPaneOpenResultSchema>;

export const paneRegistryEntrySchema = z.object({
  paneId: z.string().min(1).max(128),
  sessionId: z.string().max(128).nullable(),
  title: z.string().max(512),
  kind: z.enum(['shell', 'cli-agent', 'browser']),
  adapterId: z.string().max(64).optional(),
  model: z.string().max(128).optional(),
  accountId: z.string().max(128).optional(),
  state: z
    .enum(['spawning', 'busy', 'idle', 'exited', 'hibernated', 'unknown'])
    .optional(),
});

export const panesSyncSchema = z.array(paneRegistryEntrySchema).max(256);
export const panesSyncEnvelopeSchema = z
  .object({
    /** One id per preload/document generation; never used as authority. */
    generationId: z.string().min(1).max(128),
    entries: panesSyncSchema,
  })
  .strict();

/** Renderer-facing MCP runtime info (shown in the orchestration panel). */
export interface McpRuntimeInfo {
  running: boolean;
  url: string | null;
  toolCount: number;
}

/**
 * Squads sintetizados pelo motor: fallback determinístico do modo agêntico
 * ('agentic-…') e o custom por workspace do designSquad ('custom-…'). São
 * infraestrutura de missão (a aprovação fixa o hash do roster), não rosters
 * que o usuário configurou — pickers de squad não devem listá-los, e o reuso
 * agêntico nunca deve escolhê-los.
 */
export const ENGINE_GENERATED_SQUAD_PREFIXES = Object.freeze([
  'agentic-',
  'custom-',
] as const);

export function isEngineGeneratedSquadId(id: string): boolean {
  return ENGINE_GENERATED_SQUAD_PREFIXES.some((prefix) =>
    id.startsWith(prefix),
  );
}

/**
 * Immutable launch snapshots created by main for exactly one mission flow.
 * They are deliberately outside the user-owned squad namespace: a renderer
 * may request a snapshot, but only main chooses the final UUID and persists
 * it. `agentic-runtime-*` remains eligible for the guided planner through the
 * existing `agentic-` engine prefix; `mission-runtime-*` is the manual route.
 */
export const MISSION_RUNTIME_SQUAD_ID_RE =
  /^(?:agentic|mission)-runtime-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function isMissionRuntimeSquadId(id: string): boolean {
  return MISSION_RUNTIME_SQUAD_ID_RE.test(id);
}

export type SquadSavePurpose = 'global' | 'mission-runtime';

export interface SquadSaveOptions {
  readonly purpose?: SquadSavePurpose;
  /** Guided snapshots keep the `agentic-` planner eligibility contract. */
  readonly guided?: boolean;
  /**
   * Exact catalog squad reviewed by the operator. Main resolves and validates
   * it before minting the immutable runtime identity.
   */
  readonly sourceSquadId?: string;
  /**
   * Opaque, short-lived main-owned seal for a squad designed in this wizard
   * but not saved to the reusable catalog.
   */
  readonly designDraftToken?: string;
}

export interface SquadSaveResult {
  readonly ok: boolean;
  readonly error?: string;
  /** Main-normalized immutable snapshot; present for successful saves. */
  readonly squad?: Squad;
}
