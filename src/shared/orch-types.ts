import { z } from 'zod';

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
  'gemini-cli': 'gemini',
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
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
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

export interface Mission {
  id: string;
  title: string;
  description: string;
  status: MissionStatus;
  squadId?: string;
  milestones: string[];
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
  milestones: z.array(z.string().max(1024)).max(256).optional(),
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

export interface Handoff {
  id: string;
  missionId?: string;
  /** PTY session of the worker that submitted. */
  sessionId?: string;
  fromAgent?: string;
  status: HandoffStatus;
  summary: string;
  artifacts: unknown[];
  delivered: boolean;
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
  /** Reasoning effort the pane ran with (task-router decision) — restored on reopen. */
  effort?: string;
  cwd?: string;
  title: string;
  agentName?: string;
  role: 'orchestrator' | 'worker';
  createdAt: number;
}

/** One pane as mirrored into the main-process registry by the renderer. */
export interface PaneRegistryEntry {
  paneId: string;
  sessionId: string | null;
  title: string;
  kind: 'shell' | 'cli-agent';
  adapterId?: string;
  model?: string;
}

/** Pane snapshot returned by nexus_pane_list (registry + live state). */
export interface PaneSnapshot extends PaneRegistryEntry {
  state: 'spawning' | 'busy' | 'idle' | 'exited' | 'unknown';
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

export const paneRegistryEntrySchema = z.object({
  paneId: z.string().min(1).max(128),
  sessionId: z.string().max(128).nullable(),
  title: z.string().max(512),
  kind: z.enum(['shell', 'cli-agent']),
  adapterId: z.string().max(64).optional(),
  model: z.string().max(128).optional(),
});

export const panesSyncSchema = z.array(paneRegistryEntrySchema).max(256);

/** Renderer-facing MCP runtime info (shown in the orchestration panel). */
export interface McpRuntimeInfo {
  running: boolean;
  url: string | null;
  toolCount: number;
}
