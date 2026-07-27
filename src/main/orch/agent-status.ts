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
import {
  getAgentSessionInfo,
  getSessionState,
  publishSessionActivityState,
} from '../pty/pty-manager';

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
  statusTaps.clear();
  turnStartTaps.clear();
}
