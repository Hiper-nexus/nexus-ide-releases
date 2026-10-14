// Typed agent-observability frames — increment 1 of the Nexus observability
// plane. Design distilled from block/buzz NIP-AO / buzz-acp observer.rs
// (Apache-2.0).
//
// Why this exists (structural motivation): the Nexus failover/stall detectors
// historically read PTY scrollback with regexes — one detector re-read its own
// continuity pack and took the whole fleet down (phantom-limit cascade,
// src/shared/failover-handoff.ts). Typed frames are the structural fix: a
// frame is produced by main-process code at the moment something happens, so
// it can never be confused with terminal output that merely *mentions* an
// error.
//
// Contract principles (distilled from buzz VISION_ACTIVITY.md):
//
// - "Never go dark." The absence of an event is itself information. Silence,
//   idle and timeout are REPRESENTABLE states — `stall_suspected` frames make
//   "nothing happened for N ms" a first-class, typed observation instead of an
//   empty void, and `session_exited` guarantees a death always produces a
//   frame even when the agent never reported a hook status.
//
// - Mutate in place. One action is one UI item, not a trail of duplicated
//   status lines. Every payload therefore carries a STABLE id the consumer can
//   key rows on: `paneId` for the pane status row, `turnId` for a turn's
//   lifecycle (turn_started → turn_ended), `callId` for pairing a tool_call
//   with its tool_result (pending → done/failed on the same row).
//
// - Verb → object → outcome. Each frame reads as a sentence: the kind is the
//   verb ("tool_call", "session_exited"), the id fields name the object
//   (session/pane/turn/call), and the payload carries the outcome
//   (`ok`, `outcome`, `status`). Honesty over guessing: unknown values are
//   explicit `null`s, never fabricated.

export const OBSERVER_FRAME_KINDS = [
  'turn_started',
  'turn_ended',
  'tool_call',
  'tool_result',
  'status_changed',
  'session_spawned',
  'session_exited',
  'stall_suspected',
  'provider_error',
] as const;
export type ObserverFrameKind = (typeof OBSERVER_FRAME_KINDS)[number];

/**
 * Mirrors AGENT_SEMANTIC_STATUSES in src/main/orch/agent-status.ts. Declared
 * independently because shared/ must not import from main/; the literals are
 * structurally identical so assignments type-check across the boundary.
 */
export const OBSERVER_SEMANTIC_STATUSES = [
  'working',
  'completed',
  'awaiting-input',
  'idle',
  'error',
] as const;
export type ObserverSemanticStatus = (typeof OBSERVER_SEMANTIC_STATUSES)[number];

/** Mirrors NotificationType in src/vendor/emdash/hooks/hooks-types.ts. */
export type ObserverNotificationType =
  | 'permission_prompt'
  | 'idle_prompt'
  | 'auth_success'
  | 'elicitation_dialog';

/**
 * Common envelope of every frame. `seq` and `at` are assigned by the bus at
 * publish time (see ObserverFrameInput); everything else is provided by the
 * emitter.
 */
export interface ObserverFrameBase {
  /**
   * Monotonic per-session sequence assigned by the bus, starting at 1.
   * Gaps at a consumer mean dropped frames (NIP-AO drop detection).
   */
  seq: number;
  /** Physical PTY session id (main-owned). */
  sessionId: string;
  /** Pane the session renders in, when known. */
  paneId?: string;
  /** Mission the session belongs to, when the session is mission-owned. */
  missionId?: string;
  /**
   * Current turn correlation id (`turn-<n>`, n = UserPromptSubmit count in
   * this physical session). Absent before the first native prompt submit.
   */
  turnId?: string;
  /** Epoch ms at which the frame was published. */
  at: number;
}

/** A native prompt submission opened a new turn. */
export interface ObserverTurnStartedPayload {
  /** Stable id for this turn's UI row (mutate-in-place with turn_ended). */
  turnId: string;
  /** 1-based UserPromptSubmit count within the physical session. */
  turnSequence: number;
  /** Main-owned successful PTY input provenance; never text or a text hash. */
  inputOrigin?: 'human' | 'system' | 'unknown';
  writer?: 'maestro' | 'supervisor' | 'failover' | 'nexus';
}

/** The provider reported the turn finished (stop hook) or failed (error). */
export interface ObserverTurnEndedPayload {
  /** Matches the turn_started frame's turnId; null when no turn was opened. */
  turnId: string | null;
  outcome: 'completed' | 'error';
}

/** The agent invoked a tool (PreToolUse-class hook). */
export interface ObserverToolCallPayload {
  /** Stable id pairing this call with its tool_result row. */
  callId: string;
  /** Tool name from the raw hook body; null when the CLI did not report one. */
  toolName: string | null;
  /** Optional tool kind or category classification (e.g. shell, read, edit, etc.) */
  toolKind?: string | null;
  /**
   * F-780: nome da skill quando a tool é `Skill` — rótulo de catálogo já
   * validado (minúsculas, padrão estrito), nunca os demais argumentos.
   */
  skillName?: string | null;
  /** Raw or structured tool invocation parameters / command */
  input?: unknown;
}

/** A tool finished (PostToolUse) or failed (PostToolUseFailure). */
export interface ObserverToolResultPayload {
  /**
   * callId of the matching tool_call, or null when no open call could be
   * paired deterministically (honesty over guessing).
   */
  callId: string | null;
  toolName: string | null;
  ok: boolean;
  /** Output, stderr, or response payload from the tool execution */
  content?: unknown;
}

/** The pane's semantic status row changed (or was re-asserted). */
export interface ObserverStatusChangedPayload {
  /** Stable UI id: one status row per pane (mutate-in-place). */
  paneId: string;
  status: ObserverSemanticStatus;
  /** Pane-row status before this event; null for the first observation. */
  previousStatus: ObserverSemanticStatus | null;
  /**
   * False when a hook merely re-asserted the same status (watchdog re-arm):
   * the consumer refreshes the existing row instead of appending a new one.
   */
  transitioned: boolean;
  notificationType?: ObserverNotificationType;
}

/** A new agent session came up (reserved for increment 2's spawn tap). */
export interface ObserverSessionSpawnedPayload {
  adapterId: string | null;
  role: 'orchestrator' | 'worker' | 'user' | null;
}

/** The physical session exited. Always emitted — a death never goes dark. */
export interface ObserverSessionExitedPayload {
  reason:
    | 'pty-exit'
    | 'acp-shutdown'
    | 'acp-timeout'
    | 'acp-cancel'
    | 'acp-error'
    | 'acp-peer-exited';
  /** Last semantic status observed for this session; null if none was ever reported. */
  lastStatus: ObserverSemanticStatus | null;
}

/**
 * "Never go dark": a detector observed prolonged silence. Silence is a typed,
 * representable state — not a regex match over scrollback. Reserved for the
 * detector consumers of increment 2.
 */
export interface ObserverStallSuspectedPayload {
  /** How long the session has produced no frames/output, in ms. */
  silentForMs: number;
  /** Last frame seq seen before the silence, or null when none was seen. */
  lastSeq: number | null;
  /** Which detector raised the suspicion (attribution, not free text). */
  detector: string;
}

/**
 * Provider-native failure classified at the hook boundary. This is the
 * authority-bearing alternative to scanning PTY scrollback: the message is
 * bounded evidence from a canonical provider error, never terminal prose.
 */
export interface ObserverProviderErrorPayload {
  source: 'provider-hook' | 'acp-driver';
  /** 'model': conta sadia, modelo rejeitado — o failover rotaciona o modelo do pane (F-520). */
  kind: 'quota' | 'rate-limit' | 'auth' | 'transient' | 'model';
  reason: string;
  cooldownMs: number;
  scope?: string;
  /**
   * F-1484: o provedor declarou o limite de forma estruturada (StopFailure
   * `rate_limit`), não prosa: o failover o trata como confirmado.
   */
  confirmed?: true;
  /** Adapter da sessão que declarou (o failover só confia no do próprio pane). */
  adapterId?: string;
}

/**
 * Discriminated frame union — strict per-kind payloads, zero `any`. Adding a
 * kind requires adding it to OBSERVER_FRAME_KINDS and to this union; the
 * ObserverFrameInput mapped type below picks the change up automatically.
 */
export type ObserverFrame =
  | (ObserverFrameBase & { kind: 'turn_started'; payload: ObserverTurnStartedPayload })
  | (ObserverFrameBase & { kind: 'turn_ended'; payload: ObserverTurnEndedPayload })
  | (ObserverFrameBase & { kind: 'tool_call'; payload: ObserverToolCallPayload })
  | (ObserverFrameBase & { kind: 'tool_result'; payload: ObserverToolResultPayload })
  | (ObserverFrameBase & { kind: 'status_changed'; payload: ObserverStatusChangedPayload })
  | (ObserverFrameBase & { kind: 'session_spawned'; payload: ObserverSessionSpawnedPayload })
  | (ObserverFrameBase & { kind: 'session_exited'; payload: ObserverSessionExitedPayload })
  | (ObserverFrameBase & { kind: 'stall_suspected'; payload: ObserverStallSuspectedPayload })
  | (ObserverFrameBase & { kind: 'provider_error'; payload: ObserverProviderErrorPayload });

/**
 * Frame as offered to the bus: `seq` is always bus-assigned; `at` defaults to
 * publish time but may be provided so a frame carries the same timestamp as
 * the store mutation it mirrors. The mapped form distributes Omit over each
 * union member, preserving the kind↔payload correlation a plain
 * Omit<ObserverFrame, ...> would destroy.
 */
export type ObserverFrameInput = {
  [K in ObserverFrameKind]: Omit<
    Extract<ObserverFrame, { kind: K }>,
    'seq' | 'at'
  > & { at?: number };
}[ObserverFrameKind];

export function isObserverFrameKind(value: unknown): value is ObserverFrameKind {
  return (
    typeof value === 'string' &&
    (OBSERVER_FRAME_KINDS as readonly string[]).includes(value)
  );
}
