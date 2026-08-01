// Adapted from stablyai/orca @ 0121f571e4c9929f4d299f1a339d6e72c5d58c8b
// (MIT): interactive-question latch semantics, under Nexus main authority.
// Semantic agent-status reducer — the Nexus-native half of the emdash hook
// protocol harvest (wave 1). Canonical hook events (parsed by the vendored
// emdash parsers from raw CLI hook payloads) become a per-pane semantic
// status, persist in a main-owned store, and project onto the existing
// pane lifecycle channel (publishSessionActivityState → pty:stateChange)
// that FleetChip and the toolbar already consume.
//
// Deliberate semantics (docs diverge from the Orca-derived activity mapper on
// purpose):
//  - Only `working` drives the pane's busy flag. completed / awaiting-input /
//    error / idle all publish `idle` — the pane channel has no third state,
//    and a pane waiting on the user (or finished) must not read as working.
//    The fine-grained status stays queryable here per pane for future UI.
//  - Notifications without a permission/elicitation type settle to `idle`
//    (emdash's Claude mapping already classifies non-permission notifications
//    as idle_prompt — "agent waiting / done").
//  - PTY exit without a stop hook resets the pane to `idle` (reset-on-exit),
//    so a stale `working` can never survive into a resumed pane — this kills
//    the "busy preso" class the 5-minute hook watchdog merely bounds.
//  - `session` events carry no status; they are ignored here (provider-session
//    persistence for exact resume stays with the legacy ingest path — wave 2).
//
// This channel is ADDITIVE: it never touches the skill-gate .mjs enforcement
// hooks (exit 2), never authorizes evidence, and never infers status from
// terminal output.

import type {
  CanonicalHookEvent,
  NotificationType,
} from '../../vendor/emdash/hooks/hooks-types';
import type { PaneSessionState } from '../../shared/types';
import type { ObserverFrameInput } from '../../shared/observer-frame';
import {
  getAgentSessionInfo,
  getSessionState,
  publishSessionActivityState,
} from '../pty/pty-manager';
import { publishObserverFrame } from './observer-bus';
import { detectLimit } from './limit-detector';

export const AGENT_SEMANTIC_STATUSES = [
  'working',
  'completed',
  'awaiting-input',
  'idle',
  'error',
] as const;
export type AgentSemanticStatus = (typeof AGENT_SEMANTIC_STATUSES)[number];

export interface AgentSemanticStatusEntry {
  status: AgentSemanticStatus;
  sessionId: string;
  paneId: string;
  notificationType?: NotificationType;
  message?: string;
  updatedAt: number;
}

export interface AgentStatusApplyResult {
  /** False when the event carried no status (session/ignore kinds). */
  applied: boolean;
  /** True only when the semantic status actually changed (toast/sound gate). */
  transitioned: boolean;
  entry: AgentSemanticStatusEntry | null;
}

/**
 * Optional raw gate-envelope metadata forwarded by the hook endpoint. Only
 * the additive observer-frame emission reads it (tool_call/tool_result need
 * the wire event type and tool name, which the CanonicalHookEvent — by
 * design — does not carry). Absence changes nothing in the reducer.
 */
export interface AgentStatusHookMeta {
  /** Normalized wire event type ('tool-use', 'tool-complete', …). */
  eventType?: string;
  /** Tool name extracted from the raw hook body, when present. */
  toolName?: string;
}

/**
 * Content-free proof that the provider accepted a prompt and opened a turn.
 * The sequence is main-owned and monotonic within one physical PTY session.
 */
export interface AgentTurnStartEntry {
  sessionId: string;
  paneId: string;
  sequence: number;
  observedAt: number;
}

/**
 * Pure event → status mapping. Returns null for events without status
 * content (kind session / ignore), leaving the pane untouched.
 */
export function semanticStatusForEvent(
  event: CanonicalHookEvent,
): AgentSemanticStatus | null {
  if (event.kind !== 'status') return null;
  switch (event.type) {
    case 'start':
      return 'working';
    case 'stop':
      return 'completed';
    case 'error':
      return 'error';
    case 'notification':
      if (
        event.notificationType === 'permission_prompt' ||
        event.notificationType === 'elicitation_dialog'
      ) {
        return 'awaiting-input';
      }
      // idle_prompt, auth_success and untyped notifications all mean the turn
      // is no longer producing work (see module header).
      return 'idle';
  }
}

/**
 * Pane-channel projection: `working` is the only status that pins busy.
 * Everything else releases the pane to idle immediately instead of waiting
 * for the output-quiet timeout.
 */
export function paneStateForStatus(status: AgentSemanticStatus): PaneSessionState {
  return status === 'working' ? 'busy' : 'idle';
}

// ---------------------------------------------------------------------------
// Main-owned per-pane store (session live status; not persisted to disk).
// ---------------------------------------------------------------------------

const statusByPane = new Map<string, AgentSemanticStatusEntry>();
/** sessionId → paneId learned while applying events (exit-time resolution). */
const paneBySession = new Map<string, string>();
/** Explicit UserPromptSubmit count, scoped to the physical PTY session. */
const turnStartSequenceBySession = new Map<string, number>();

export type AgentSemanticStatusTap = (entry: AgentSemanticStatusEntry) => void;
const statusTaps = new Set<AgentSemanticStatusTap>();
export type AgentTurnStartTap = (entry: AgentTurnStartEntry) => void;
const turnStartTaps = new Set<AgentTurnStartTap>();

/**
 * Transition-only tap — fires exclusively when a pane's semantic status
 * CHANGES (working → awaiting-input, …), never on hook re-asserts. This is
 * the sound/toast attach point: subscribers cannot be stormed by a tool loop.
 */
export function tapAgentSemanticStatus(cb: AgentSemanticStatusTap): () => void {
  statusTaps.add(cb);
  return () => statusTaps.delete(cb);
}

/**
 * Event-level UserPromptSubmit tap. Unlike the transition-only status tap,
 * every native submission fires even when the pane was already `working`.
 */
export function tapAgentTurnStart(cb: AgentTurnStartTap): () => void {
  turnStartTaps.add(cb);
  return () => turnStartTaps.delete(cb);
}

export function getAgentTurnStartSequence(sessionId: string): number {
  return turnStartSequenceBySession.get(sessionId) ?? 0;
}

export function getAgentSemanticStatus(
  paneId: string,
): AgentSemanticStatusEntry | null {
  return statusByPane.get(paneId) ?? null;
}

export function getAgentSemanticStatusBySession(
  sessionId: string,
): AgentSemanticStatusEntry | null {
  const paneId = paneBySession.get(sessionId);
  const entry = paneId ? statusByPane.get(paneId) : undefined;
  return entry?.sessionId === sessionId ? entry : null;
}

/**
 * PTY `idle` is only a visual/transport state. It is safe to inject input only
 * when no main-owned permission/question latch is active. A session without
 * native status events keeps the legacy quiet-PTY fallback.
 */
export function isSessionInjectableIdle(sessionId: string): boolean {
  if (getSessionState(sessionId) !== 'idle') return false;
  const semantic = getAgentSemanticStatusBySession(sessionId)?.status;
  return semantic === undefined || semantic === 'idle' || semantic === 'completed';
}

function resolvePaneId(sessionId: string): string {
  const owned = getAgentSessionInfo(sessionId);
  if (owned?.paneId) return owned.paneId;
  return paneBySession.get(sessionId) ?? sessionId;
}

// ---------------------------------------------------------------------------
// Observer-frame emission (additive observability plane).
// Design distilled from block/buzz NIP-AO / buzz-acp observer.rs (Apache-2.0).
// Applied hook events additionally flow as typed ObserverFrames into the
// in-process bus so detectors/UI can consume structure instead of regexing
// scrollback. Emission is a TOTAL side channel: any failure here is contained
// and can never alter the reducer result or break the gate endpoint.
// ---------------------------------------------------------------------------

const OBSERVER_TOOL_CALL_PHASES = new Set(['tool-use']);
const OBSERVER_TOOL_RESULT_PHASES = new Set(['tool-complete', 'tool-use-failure']);
/** Bound for calls whose results never arrive (crash mid-tool); oldest drops. */
const OBSERVER_OPEN_TOOL_CALLS_MAX = 64;

interface ObserverToolCallState {
  nextCallSequence: number;
  open: { callId: string; toolName: string | null }[];
}
const observerToolCallsBySession = new Map<string, ObserverToolCallState>();

/** `turn-<n>` correlation id for the session's current turn, if one opened. */
function observerTurnId(sessionId: string): string | undefined {
  const sequence = turnStartSequenceBySession.get(sessionId);
  return sequence !== undefined && sequence > 0 ? `turn-${sequence}` : undefined;
}

/** Shared identity fields for every frame of one session at one instant. */
function observerFrameScope(
  sessionId: string,
  paneId: string | undefined,
): Pick<ObserverFrameInput, 'sessionId' | 'paneId' | 'missionId' | 'turnId'> {
  let missionId: string | undefined;
  try {
    missionId = getAgentSessionInfo(sessionId)?.missionId;
  } catch {
    // Attribution is best-effort; a registry failure drops missionId only.
    missionId = undefined;
  }
  return { sessionId, paneId, missionId, turnId: observerTurnId(sessionId) };
}

function openObserverToolCall(
  sessionId: string,
  toolName: string | null,
): string {
  let state = observerToolCallsBySession.get(sessionId);
  if (!state) {
    state = { nextCallSequence: 1, open: [] };
    observerToolCallsBySession.set(sessionId, state);
  }
  const callId = `call-${state.nextCallSequence}`;
  state.nextCallSequence += 1;
  state.open.push({ callId, toolName });
  if (state.open.length > OBSERVER_OPEN_TOOL_CALLS_MAX) state.open.shift();
  return callId;
}

/**
 * Pair a tool result with its open call. Named results match the most recent
 * open call of the same tool. Unnamed results match only when exactly one
 * call is open — with parallel calls in flight, attribution would be a guess,
 * and the contract is honesty over guessing (callId: null).
 */
function takeObserverToolCall(
  sessionId: string,
  toolName: string | null,
): string | null {
  const state = observerToolCallsBySession.get(sessionId);
  if (!state || state.open.length === 0) return null;
  if (toolName === null) {
    if (state.open.length !== 1) return null;
    const only = state.open.pop();
    return only?.callId ?? null;
  }
  for (let i = state.open.length - 1; i >= 0; i--) {
    if (state.open[i]?.toolName === toolName) {
      const [taken] = state.open.splice(i, 1);
      return taken?.callId ?? null;
    }
  }
  return null;
}

/**
 * Publish the frames one applied hook event implies. Frame order within the
 * event: turn_started (turn opens) → tool_call/tool_result (the action) →
 * status_changed (always) → turn_ended (turn closes). Total function.
 */
function publishHookObserverFrames(args: {
  sessionId: string;
  paneId: string;
  event: CanonicalHookEvent;
  hook: AgentStatusHookMeta | undefined;
  previousStatus: AgentSemanticStatus | null;
  entry: AgentSemanticStatusEntry;
  transitioned: boolean;
}): void {
  try {
    if (args.event.kind !== 'status') return;
    const { sessionId, paneId, event, entry } = args;
    const at = entry.updatedAt;

    if (event.type === 'start' && event.promptSubmitted === true) {
      const turnSequence = getAgentTurnStartSequence(sessionId);
      if (turnSequence > 0) {
        publishObserverFrame({
          ...observerFrameScope(sessionId, paneId),
          at,
          kind: 'turn_started',
          payload: { turnId: `turn-${turnSequence}`, turnSequence },
        });
      }
    }

    const phase = args.hook?.eventType;
    const toolName = args.hook?.toolName ?? null;
    if (phase !== undefined && OBSERVER_TOOL_CALL_PHASES.has(phase)) {
      const callId = openObserverToolCall(sessionId, toolName);
      publishObserverFrame({
        ...observerFrameScope(sessionId, paneId),
        at,
        kind: 'tool_call',
        payload: { callId, toolName },
      });
    } else if (phase !== undefined && OBSERVER_TOOL_RESULT_PHASES.has(phase)) {
      publishObserverFrame({
        ...observerFrameScope(sessionId, paneId),
        at,
        kind: 'tool_result',
        payload: {
          callId: takeObserverToolCall(sessionId, toolName),
          toolName,
          ok: phase === 'tool-complete',
        },
      });
    }

    // Canonical provider errors are authority-bearing observer input. Keep
    // the bounded classifier here, at the hook boundary, so failover and the
    // mission journal do not need to infer a limit from mixed PTY prose.
    if (event.type === 'error' && typeof event.message === 'string') {
      const hit = detectLimit(event.message);
      if (hit) {
        publishObserverFrame({
          ...observerFrameScope(sessionId, paneId),
          at,
          kind: 'provider_error',
          payload: {
            source: 'provider-hook',
            kind: hit.kind,
            reason: hit.reason,
            cooldownMs: hit.cooldownMs,
            ...(hit.scope ? { scope: hit.scope } : {}),
          },
        });
      }
    }

    publishObserverFrame({
      ...observerFrameScope(sessionId, paneId),
      at,
      kind: 'status_changed',
      payload: {
        paneId,
        status: entry.status,
        previousStatus: args.previousStatus,
        transitioned: args.transitioned,
        notificationType: entry.notificationType,
      },
    });

    if (event.type === 'stop' || event.type === 'error') {
      const scope = observerFrameScope(sessionId, paneId);
      publishObserverFrame({
        ...scope,
        at,
        kind: 'turn_ended',
        payload: {
          turnId: scope.turnId ?? null,
          outcome: event.type === 'stop' ? 'completed' : 'error',
        },
      });
    }
  } catch (err) {
    console.warn('[agent-status] observer frame emission failed (frames dropped):', err);
  }
}

/** session_exited frame — every PTY death frames, even hookless sessions. */
function publishSessionExitedObserverFrame(sessionId: string, now: number): void {
  try {
    const paneId = paneBySession.get(sessionId);
    const prev = paneId ? statusByPane.get(paneId) : undefined;
    publishObserverFrame({
      ...observerFrameScope(sessionId, paneId),
      at: now,
      kind: 'session_exited',
      payload: {
        reason: 'pty-exit',
        lastStatus: prev?.sessionId === sessionId ? prev.status : null,
      },
    });
  } catch (err) {
    console.warn('[agent-status] session_exited frame emission failed:', err);
  }
}

/**
 * Fold one canonical hook event into the pane's semantic status and project
 * it onto the pane lifecycle channel. Total function: a reducer failure must
 * never break the gate endpoint, so every failure mode degrades to
 * { applied: false } instead of throwing.
 */
export function applyCanonicalHookEvent(input: {
  sessionId: string;
  event: CanonicalHookEvent;
  now?: number;
  /** Optional raw envelope metadata for observer-frame emission only. */
  hook?: AgentStatusHookMeta;
}): AgentStatusApplyResult {
  try {
    const { sessionId, event } = input;
    if (!sessionId) return { applied: false, transitioned: false, entry: null };
    const mapped = semanticStatusForEvent(event);
    if (mapped === null) return { applied: false, transitioned: false, entry: null };

    const paneId = resolvePaneId(sessionId);
    paneBySession.set(sessionId, paneId);
    const prev = statusByPane.get(paneId);
    const preserveAwaitingInput =
      prev?.sessionId === sessionId &&
      prev.status === 'awaiting-input' &&
      event.kind === 'status' &&
      event.type !== 'stop' &&
      event.type !== 'error' &&
      event.clearsAwaitingInput !== true;
    const next = preserveAwaitingInput ? 'awaiting-input' : mapped;
    const entry: AgentSemanticStatusEntry = {
      status: next,
      sessionId,
      paneId,
      notificationType:
        event.kind === 'status' && event.type === 'notification'
          ? event.notificationType
          : undefined,
      message:
        event.kind === 'status' && typeof event.message === 'string'
          ? event.message.slice(0, 280)
          : undefined,
      updatedAt: input.now ?? Date.now(),
    };
    statusByPane.set(paneId, entry);

    // Re-publish on every event (even same-status) so the hook-busy watchdog
    // re-arms while the agent keeps working; the pty layer dedupes IPC.
    publishSessionActivityState(sessionId, paneStateForStatus(next));

    // UserPromptSubmit is a provider-native turn boundary. Keep it separate
    // from generic `start` events: PreToolUse/tool completion and TUI repaint
    // may also assert working but do not prove that a prompt was submitted.
    if (
      event.kind === 'status' &&
      event.type === 'start' &&
      event.promptSubmitted === true
    ) {
      const sequence = getAgentTurnStartSequence(sessionId) + 1;
      turnStartSequenceBySession.set(sessionId, sequence);
      const turnStart: AgentTurnStartEntry = {
        sessionId,
        paneId,
        sequence,
        observedAt: entry.updatedAt,
      };
      for (const tap of turnStartTaps) {
        try {
          tap(turnStart);
        } catch (err) {
          console.warn('[agent-status] turn-start tap threw:', err);
        }
      }
    }

    const transitioned = prev?.status !== next;
    if (transitioned) {
      for (const tap of statusTaps) {
        try {
          tap(entry);
        } catch (err) {
          console.warn('[agent-status] semantic status tap threw:', err);
        }
      }
    }

    // Additive observability plane: total function, never alters the result.
    publishHookObserverFrames({
      sessionId,
      paneId,
      event,
      hook: input.hook,
      previousStatus: prev?.status ?? null,
      entry,
      transitioned,
    });

    return { applied: true, transitioned, entry };
  } catch (err) {
    console.warn('[agent-status] reducer failed (hook event dropped):', err);
    return { applied: false, transitioned: false, entry: null };
  }
}

/**
 * Reset-on-exit: a PTY that dies without delivering its stop hook leaves no
 * semantic `working` behind. Called from the orchestration exit tap.
 */
export function resetAgentStatusOnExit(sessionId: string, now = Date.now()): void {
  try {
    // "Never go dark": frame the exit BEFORE any state is dropped, so the
    // frame still carries pane/turn/status attribution. Total side channel.
    publishSessionExitedObserverFrame(sessionId, now);
    observerToolCallsBySession.delete(sessionId);

    const paneId = paneBySession.get(sessionId);
    paneBySession.delete(sessionId);
    turnStartSequenceBySession.delete(sessionId);
    if (!paneId) return;
    const prev = statusByPane.get(paneId);
    if (!prev) return;
    statusByPane.delete(paneId);
    if (prev.status === 'idle') return;
    const entry: AgentSemanticStatusEntry = {
      ...prev,
      status: 'idle',
      notificationType: undefined,
      updatedAt: now,
    };
    publishSessionActivityState(sessionId, 'idle');
    for (const tap of statusTaps) {
      try {
        tap(entry);
      } catch (err) {
        console.warn('[agent-status] semantic status tap threw:', err);
      }
    }
  } catch (err) {
    console.warn('[agent-status] reset-on-exit failed:', err);
  }
}

/** Test-only: drop all reducer state. */
export function __resetAgentStatusForTests(): void {
  statusByPane.clear();
  paneBySession.clear();
  turnStartSequenceBySession.clear();
  observerToolCallsBySession.clear();
  statusTaps.clear();
  turnStartTaps.clear();
}
