import { z } from 'zod';
import type { SpawnRouteInfo } from './spawn-route';
import type { DecisionRoute } from './decision-models';
import { canonicalCliAdapterId } from './cli-adapter-id';
import type { ProjectExecutionScope } from './types';
import type {
  MissionResult,
  MissionSnapshot,
} from './mission-engine-contract';
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

export const SQUAD_AGENT_INSTRUCTIONS_MAX_CHARS = 4_096;

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
  // Migração de squads antigos: a CLI removida converge para AGY ao carregar.
  'gemini-cli': 'agy',
  'kimi-cli': 'kimi',
  'antigravity-cli': 'agy',
};

function normalizeSquadAgent(raw: unknown): unknown {
  // Some squads.json rosters may omit `cli` (workers inherit the default CLI)
  // or carry only a providerId — normalize before validating.
  if (!raw || typeof raw !== 'object') return raw;
  if ('cli' in raw && typeof raw.cli === 'string' && raw.cli.trim()) {
    return { ...raw, cli: canonicalCliAdapterId(raw.cli) };
  }

  const providerId =
    'providerId' in raw && typeof raw.providerId === 'string'
      ? raw.providerId
      : undefined;
  const mapped = providerId
    ? PROVIDER_ID_TO_CLI[providerId] ?? canonicalCliAdapterId(providerId)
    : undefined;
  return { ...raw, cli: mapped ?? 'claude' };
}

export const squadAgentObjectSchema = z.object({
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
  /**
   * Operator-owned context for this role. This is prompt context only:
   * capability and authority remain exclusively in allowedTools/allowedSkills
   * plus the main-owned execution contract.
   */
  instructions: authorityString(
    SQUAD_AGENT_INSTRUCTIONS_MAX_CHARS,
    'agent instructions',
    1,
  )
    .refine((value) => value.trim().length > 0, {
      message: 'agent instructions cannot be blank',
    })
    .optional(),
  /**
   * Explicit planning-document authority: this roster member authors the
   * mission's design / architecture / implementation plan, or gates them
   * against the Superpowers review prompts. It is the only per-agent signal
   * that unlocks the `superpowers` vocabulary, so the skill policy never has
   * to infer authorship from a squad id or an agent name. Reviewed authority,
   * at the same level as `category`: main-owned rosters declare it, and the
   * governed policy only ever reads it from a main-owned roster.
   */
  ownsPlanDocs: z.boolean().optional(),
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
  /**
   * Nome da persona associada a este agente-folha. O persona-store resolve
   * o name → system-prompt no momento do spawn. Ausente = sem injeção de
   * persona. Completamente independente da persona de voz (voice-ipc.ts).
   */
  persona: authorityString(128, 'agent persona').optional(),
});

export const strictSquadAgentSchema = z.preprocess(
  normalizeSquadAgent,
  squadAgentObjectSchema.strict(),
);

export const squadAgentSchema = z.preprocess(
  normalizeSquadAgent,
  squadAgentObjectSchema,
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

/**
 * Internal durable storage row owned by the main process. Product UI consumes
 * {@link MissionSnapshot}; it must never consume `Mission` directly.
 */
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
  /** Canonical, main-verified completion payload shown by the product UI. */
  result?: MissionResult;
  /**
   * F-1166: dicas consultivas do motor de decisão (kickoff, triagem de
   * revisão, recuperação, conclusão). Só leitura, anexadas pelo Main ao ler a
   * missão; ausente em missões antigas. Nunca autoridade.
   */
  decisionHints?: MissionDecisionHints;
  /** Durably set when this process kicks off the mission. Absent for rows
   *  parked before boot or started by a previous process. */
  start?: number;
  createdAt: number;
  updatedAt: number;
}

/** Recibo comum de uma dica consultiva: rota, custo e quando. */
export interface MissionDecisionHintReceipt {
  readonly at: number;
  readonly model: string;
  readonly route?: DecisionRoute;
  /** Custo medido; null = desconhecido (o cobrado do orçamento fica em budgetChargedUsd). */
  readonly usd: number | null;
  readonly budgetChargedUsd?: number;
  readonly probabilities: Readonly<Record<string, number>>;
}

export interface MissionKickoffHint extends MissionDecisionHintReceipt {
  readonly origin: 'conventional' | 'pane';
  /** 0 trivial … 3 grande. */
  readonly complexity: number;
  readonly complexityLevel: 'trivial' | 'small' | 'medium' | 'large';
  /** Workers sugeridos, sempre dentro de maxWorkers. */
  readonly workers: number;
  readonly maxWorkers: number;
  readonly lane: 'standard' | 'consult' | 'plan' | 'ops';
  readonly laneConfidence: number;
}

export interface MissionReviewTriageHint extends MissionDecisionHintReceipt {
  readonly handoffId: string;
  readonly regressionRisk: number;
  readonly recommendIndependentReview: boolean;
}

/**
 * Classe categórica da queda. NUNCA o texto do detector: ecoado (whoami,
 * mission_get), ele casaria de novo no PTY do worker religado (F-520).
 */
export type RecoveryTriggerClass = 'rate-limit' | 'quota' | 'auth' | 'transient' | 'model-rejected' | 'unknown';

export interface MissionRecoveryHint extends MissionDecisionHintReceipt {
  readonly triggerClass: RecoveryTriggerClass;
  readonly paneId?: string;
  readonly adapterId?: string;
  readonly advice: 'retry-same-cli' | 'switch-cli' | 'escalate-orchestrator';
  readonly confidence: number;
}

export interface MissionCompletionHint extends MissionDecisionHintReceipt {
  /** Probabilidade de os handoffs cobrirem o objetivo. */
  readonly coverage: number;
  readonly warning: boolean;
  readonly handoffCount: number;
  /** Assinatura dos handoffs de sucesso julgados: igual = a dica ainda vale. */
  readonly signature: string;
  /** Consultas já feitas nesta missão (teto 3). */
  readonly consultations: number;
  /** Critério de aceite que parece faltar (texto do operador, neutralizado). */
  readonly missing?: string;
  /** Auditoria na conclusão: reaproveitou a dica (mesma assinatura) ou não. */
  readonly finalAudit?: { readonly at: number; readonly reused: boolean };
}

export interface MissionDecisionHints {
  readonly kickoff?: MissionKickoffHint;
  readonly reviewTriage?: readonly MissionReviewTriageHint[];
  readonly recovery?: readonly MissionRecoveryHint[];
  readonly completion?: MissionCompletionHint;
  /** Quando a missão concluiu (auditoria final): base da limpeza no boot. */
  readonly finalizedAt?: number;
}

export type MissionOperatorCompleteResult =
  | {
      readonly ok: true;
      readonly mission?: Mission;
    }
  | {
      readonly ok: false;
      readonly mission?: Mission;
      readonly cancelled?: boolean;
      readonly error?: string;
    };

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
export const missionPatchSchema = z
  .object({
    title: z.string().min(1).max(512).optional(),
    description: z.string().max(65_536).optional(),
    status: missionStatusSchema.optional(),
    milestones: z.array(missionMilestoneInputSchema).max(256).optional(),
    intentState: missionIntentStateSchema.optional(),
    intentContract: missionIntentContractSchema.nullable().optional(),
    intentVersion: z.number().int().nonnegative().max(1_000_000).optional(),
    start: z.number().int().nonnegative().optional(),
  })
  .strict();
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
  readonly source:
    | 'http-mcp'
    | 'acp-stdio'
    | 'pty-stream'
    | 'mission-shim'
    | 'omp-rpc-stdio';
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
  /**
   * Workspace handoff only (missionId absent): the Main-proven parent session
   * that received the notification. Durable read-by-id authority after the
   * helper pane is auto-closed and leaves the live registry.
   */
  workspaceRecipientSessionId?: string;
  /** Main-issued generation nonce for the exact physical worker process. */
  workerIncarnationId?: string;
  fromAgent?: string;
  /** Main-owned physical session attribution persisted at submission; never reporter input. */
  readonly routeAttribution?: { readonly adapterId: string; readonly model?: string };
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
 * Zero-LLM activity summary of one pane (ADE harvest): the first user
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

export interface VisualTaskRequirement { readonly since: number; readonly id: string }

export interface MissionPaneSpec {
  /** Main-derived requirement retained across exact resume. */
  visualTask?: VisualTaskRequirement;
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
  /**
   * F-231: pane aberto pelo operador DENTRO da missão ("+ Pane" na aba da
   * missão). Participa como worker (Quadro, nexus_pane_list, handoff) mas
   * nunca é fechado pela máquina da missão — no fim volta à mão do operador.
   */
  operatorOpened?: boolean;
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
  | 'spawning' | 'busy' | 'idle' | 'exited' | 'hibernated' | 'unknown'
  /** 0.76.45: estacionado pelo guardian — CLI encerrado, pane e scrollback ficam; acordar = spawn com resume. */
  | 'parked';

/** One pane as mirrored into the main-process registry by the renderer. */
export interface PaneRegistryEntry {
  paneId: string;
  sessionId: string | null;
  /**
   * Número humano curto do pane, o que o operador fala ("manda no pane 7").
   * É ADIÇÃO: `paneId` continua sendo a identidade e a chave do protocolo, e
   * toda ferramenta que aceita o número também aceita o id. Ausente enquanto o
   * renderer ainda não sincronizou o pane recém-criado.
   */
  paneNumber?: number;
  title: string;
  kind: 'shell' | 'cli-agent' | 'browser';
  adapterId?: string;
  model?: string;
  accountId?: string;
  state?: PaneRuntimeState;
  /** Aba do renderer: só desempata a missão da aba, nunca concede nada. */
  tabKey?: string;
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
  /** F-231: worker de missão aberto pelo operador ("+ Pane" na aba da missão). */
  operatorOpened?: boolean;
  /** 0.76.45: quando estacionado, o instante (ms) e a sessão encerrada que o resume reabre. */
  parkedAt?: number;
  parkedSessionId?: string;
  /**
   * F-1272: sessão one-shot (agy --print / opencode run) com a raiz viva.
   * Tela muda não é ociosidade nessas CLIs: consumidores de "pane idle"
   * (watchdog, reuso de helper, cleanup/park, conclusão civil) tratam como ativo.
   */
  oneShotAlive?: boolean;
}

/**
 * A4: motivo FECHADO da recusa do restore. Um booleano apagava a diferença
 * entre "a missão parou numa pergunta", "o runtime foi encerrado", "o selo
 * envelheceu", "a conversa está voando para outro pane" e "o pane saiu da
 * composição" — e o pane retido acabava com o mesmo "use Retomar" genérico
 * para todos. Cada valor casa com UM ramo da recusa em Main; o gate escreve
 * a linha específica com a ação certa e reavalia quando a missão muda.
 */
export type MissionPaneRestoreDenialReason =
  | 'mission-blocked-question'
  | 'runtime-closed'
  | 'stale-seal'
  | 'transfer-in-flight'
  | 'spec-missing'
  | 'mission-terminal';

/**
 * Main → renderer: restore proof for one persisted mission pane.
 *
 * `sealed` is the durable runtime the renderer MUST mirror on the layout
 * pane before kicking a respawn. The persisted-authority fence compares the
 * spawn request to the Main-sealed row; a layout restored from disk can
 * carry `accountId: undefined` while Main sealed a physical account — the
 * fence then rejects as `accountId[undefined != acct-…]` and the pane dies
 * after the automatic spawn budget.
 */
export interface MissionPaneRestoreAuthority {
  authorized: boolean;
  sealed?: {
    adapterId?: string;
    model?: string;
    accountId?: string;
    effort?: string;
    cwd?: string;
  };
  /**
   * Preenchido numa recusa estruturada. Ausente = canal legado/erro de IPC —
   * o gate cai no aviso genérico, nunca inventa motivo.
   */
  reason?: MissionPaneRestoreDenialReason;
  /**
   * A2/A4: para recusas de conversa transferida, o pane que passou a carregar
   * a conversa (spec de orquestrador atual da missão). O gate usa para o
   * aviso dizer ONDE a conversa continua, não só "em outro pane".
   */
  movedToPaneId?: string;
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
  /** Origem da rota do spawn roteado (chip "Jev"/"sem Jev"); só exibição. */
  route?: SpawnRouteInfo;
  /**
   * Pane que pediu este (helper de agente do operador): o renderer herda a
   * aba dele. Só o id do pane — a sessão do pai nunca sai do Main.
   */
  parentPaneId?: string;
  /** Main-authorized public spawn may settle before a session id exists. */
  allowPending?: true;
  /** New mission workers are always fresh by default; main may request resume. */
  resume: boolean;
  resumeLatestOnly: boolean;
  restorePersistedAuthority: false;
}

/** Renderer → main: outcome of an OrchPaneSpawnRequest. */
export const orchPaneSpawnResultSchema = z.object({
  requestId: z.string().min(1).max(128),
  ok: z.boolean(),
  paneId: z.string().max(128).optional(),
  sessionId: z.string().max(128).nullable().optional(),
  pending: z.literal(true).optional(),
  error: z.string().max(1024).optional(),
  code: z.enum(['license_access_denied', 'license_agent_limit']).optional(),
  blockedReason: z.string().max(64).optional(),
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
  /**
   * F-1473: troca de conta com histórico compartilhado — o pane retoma a
   * conversa nativa e recebe esta nota; sem retomada exata, recebe `recap`.
   */
  resumeNote?: string;
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
  /** Mission of the agent that asked: the pane must belong to it to mount. */
  missionId?: string;
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

/** Legacy/general closes remain pane-id strings; session and attempt closes are sealed. */
export type PaneCloseRequest =
  | string
  | PaneAttemptCleanupRequest
  | { paneId: string; expectedSessionId: string }
  /** Aviso prévio: o main vai encerrar esta sessão para fechar o pane. */
  | { paneId: string; closingSessionId: string };

/**
 * Main → renderer (0.76.45): o guardian estacionou este pane. A sessão PTY
 * já foi encerrada pelo main; o renderer marca o pane como `parked`, mantém
 * o scrollback e oferece "Acordar" (spawn no mesmo paneId com `resume: true`
 * — o main resolve o `--resume` exato pela sessão do provider, F-567).
 */
export interface PaneParkRequest {
  paneId: string;
  sessionId: string;
  parkedAt: number;
  reason: 'idle' | 'memory-pressure';
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
  // Sem este campo o `z.object` descartaria `paneNumber` em silêncio e o Main
  // nunca veria o número que o operador está lendo na tela.
  paneNumber: z.number().int().positive().max(999999).optional(),
  title: z.string().max(512),
  kind: z.enum(['shell', 'cli-agent', 'browser']),
  adapterId: z.string().max(64).optional(),
  model: z.string().max(128).optional(),
  accountId: z.string().max(128).optional(),
  state: z
    .enum(['spawning', 'busy', 'idle', 'exited', 'hibernated', 'unknown'])
    .optional(),
  tabKey: z.string().min(1).max(256).optional(),
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
