import { z } from 'zod';
import type { ProjectExecutionScope } from './types';

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
    id: z.string().min(1).max(128),
    agentName: z.string().min(1).max(128),
    category: agentCategorySchema,
    /** Adapter id (claude, codex, agy, …) that backs this agent. */
    cli: z.string().min(1).max(64),
    providerId: z.string().max(128).optional(),
    model: z.string().max(128).optional(),
    // CLI-owned capability: new levels (for example Codex `ultra`) must not
    // require a Nexus release. Spawn validation still checks the adapter.
    effort: z.string().min(1).max(32).regex(/^[A-Za-z0-9_-]+$/).optional(),
    /** null/absent = unrestricted. */
    allowedSkills: z.array(z.string().max(128)).nullable().optional(),
    allowedTools: z.array(z.string().max(128)).nullable().optional(),
  }),
);
export type SquadAgent = z.infer<typeof squadAgentSchema>;

export const squadSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(256),
  // Some exports write epoch-ms numbers here; others use ISO strings.
  createdAt: z
    .union([z.string().max(64), z.number()])
    .transform((value) => String(value)),
  builtin: z.boolean().default(false),
  orchestratorInstructions: z.string().max(65_536).default(''),
  /** Optional per-squad native instructions — preserved as-is. */
  nativeInstructions: z.string().max(65_536).optional(),
  agents: z.array(squadAgentSchema).default([]),
});
export type Squad = z.infer<typeof squadSchema>;

/** Wire format of a squads file. */
export const squadsFileSchema = z.object({ squads: z.array(squadSchema) });

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
  /** Session that created the mission — receives handoffs when idle. */
  orchestratorSessionId?: string;
  createdAt: number;
  updatedAt: number;
}

/** Renderer-editable subset of a Mission. Any subset of fields may be patched. */
export const missionPatchSchema = z.object({
  title: z.string().min(1).max(512).optional(),
  description: z.string().max(65_536).optional(),
  status: missionStatusSchema.optional(),
  milestones: z.array(missionMilestoneInputSchema).max(256).optional(),
});
export type MissionPatch = z.infer<typeof missionPatchSchema>;

export const handoffStatusSchema = z.enum([
  'success',
  'partial',
  'blocked',
  'failed',
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
export type HandoffEvidenceTrust = z.infer<
  typeof handoffEvidenceTrustSchema
>;

export const handoffDeliveryStateSchema = z.enum([
  'queued',
  'submitted',
  'acknowledged',
  'consumed',
]);
export type HandoffDeliveryState = z.infer<typeof handoffDeliveryStateSchema>;

export interface HandoffEvidenceBinding {
  readonly missionId: string;
  readonly contextRevision: string;
  readonly contractHash: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly diffHash: string;
  readonly workflowRevision: number;
}

export interface Handoff {
  id: string;
  missionId?: string;
  /** PTY session of the worker that submitted. */
  sessionId?: string;
  fromAgent?: string;
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
  createdAt: number;
  updatedAt: number;
}

/**
 * Recorded composition of a mission: one entry per pane that took part in it
 * (orchestrator + every worker spawned with that missionId). Persisted so a
 * mission can be reopened from history with its panes restored — the CLIs
 * re-spawn with their adapter's resume flags to continue the conversations.
 */
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
  role: 'orchestrator' | 'worker';
  /** Exact Nexus capability snapshot restored with this pane. */
  allowedTools?: string[] | null;
  allowedSkills?: string[] | null;
  /** Trusted main-side execution authority captured when the pane was created. */
  scope?: ProjectExecutionScope;
  /** Task worktree filesystem authority; defaults to scope for legacy panes. */
  executionScope?: ProjectExecutionScope;
  /**
   * paneId ORIGINAL do pane no layout — a captura de session-id de resume é
   * chaveada por (cwd, paneId); sem reutilizá-lo, o reopen criava ids novos e
   * o resume direcionado nunca acertava (caía no --continue genérico, que
   * retoma a conversa MAIS RECENTE do cwd — a da outra missão).
   */
  paneId?: string;
  createdAt: number;
}

export type PaneRuntimeState =
  | 'spawning'
  | 'busy'
  | 'idle'
  | 'exited'
  | 'hibernated'
  | 'unknown';

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
}

/** Main → renderer: please create a pane and spawn its session. */
export interface OrchPaneSpawnRequest {
  requestId: string;
  adapterId: string;
  model?: string;
  /** Per-spawn reasoning effort (task-router decision). */
  effort?: string;
  cwd?: string;
  title?: string;
  missionId?: string;
  /** Agente do squad que este pane representa — exibido no badge do pane. */
  agentName?: string;
  role?: 'orchestrator' | 'worker';
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

/** Main → renderer: open a browser pane in the user's layout. */
export interface BrowserPaneOpenRequest {
  requestId: string;
  url: string;
  title?: string;
}

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

/** Renderer-facing MCP runtime info (shown in the orchestration panel). */
export interface McpRuntimeInfo {
  running: boolean;
  url: string | null;
  toolCount: number;
}
