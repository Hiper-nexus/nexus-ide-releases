// Semantic agent waits — Nexus port of Herdr's server-owned agent.wait /
// agent.prompt protocol (herdr src/api/wait.rs, Apache-2.0).
//
// Unlike the physical pane waits in pane-session-output.ts (PTY busy/idle
// quiet), these waits observe the SEMANTIC status reducer in agent-status.ts
// through its taps: event-driven snapshot + replay with no blind polling (a
// timeout timer is the only backstop). Three Herdr invariants are preserved:
//
//  - Occupant pin (wait.rs:375-383): the wait binds the exact agent resolved
//    at registration (sessionId + agentName + paneId from the main-owned
//    spawn registry). A substitute process in the same pane reports under a
//    NEW session id and never satisfies the wait; a session exit or an agent
//    swap fails the wait with agent_not_running.
//  - Prompt+wait atomicity (wait.rs:219, :302-305): promptAgentAndWait arms
//    the wait taps BEFORE the prompt crosses the transport, so a status
//    transition between "prompt accepted" and "wait registered" cannot be
//    lost. The turn-start sequence is captured pre-write as the submission
//    marker.
//  - Activity gate (wait.rs:244-290): after submission the prompt must show
//    an effect within AGENT_PROMPT_EFFECT_TIMEOUT_MS — a turn-start sequence
//    bump or a post-submission status transition — else agent_prompt_stalled.

import {
  AGENT_SEMANTIC_STATUSES,
  getAgentSemanticStatusBySession,
  getAgentTurnStartSequence,
  tapAgentSemanticStatus,
  tapAgentTurnStart,
  type AgentSemanticStatus,
  type AgentSemanticStatusEntry,
} from './agent-status';
import {
  getAgentSessionInfo,
  getSessionState,
  listAgentSessionsForPane,
  tapSessionExit,
} from '../pty/pty-manager';

/** Herdr AGENT_PROMPT_EFFECT_TIMEOUT_MS (wait.rs:20). */
export const AGENT_PROMPT_EFFECT_TIMEOUT_MS = 5_000;

export const SEMANTIC_WAIT_DEFAULT_TIMEOUT_MS = 120_000;

/** wait.rs:523-535 — idle | completed | awaiting-input when until is empty. */
export const SEMANTIC_WAIT_DEFAULT_UNTIL: readonly AgentSemanticStatus[] = [
  'idle',
  'completed',
  'awaiting-input',
];

export type SemanticWaitErrorCode =
  | 'agent_not_running'
  | 'agent_blocked'
  | 'agent_prompt_stalled'
  | 'invalid_until'
  | 'timeout';

/**
 * Wait/prompt failure with a stable machine-readable code. The message is
 * prefixed with the code so MCP stringification keeps it visible to callers
 * (same convention as `route_reservation_required: …`).
 */
export class SemanticWaitError extends Error {
  readonly code: SemanticWaitErrorCode;
  constructor(code: SemanticWaitErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'SemanticWaitError';
    this.code = code;
  }
}

export interface SemanticWaitTarget {
  readonly paneId?: string;
  readonly sessionId?: string;
}

export interface SemanticWaitMatch {
  readonly status: AgentSemanticStatus;
  readonly sessionId: string;
  readonly paneId: string;
  readonly agentName?: string;
  readonly updatedAt: number;
}

/** Evidence that a submitted prompt produced an effect on the agent. */
export interface PromptActivityEvidence {
  readonly kind: 'turn-start' | 'status-transition';
  readonly status: AgentSemanticStatus | null;
}

/** The exact agent identity a wait is bound to (wait.rs:375-383). */
export interface AgentOccupantPin {
  readonly sessionId: string;
  readonly paneId?: string;
  readonly agentName?: string;
  readonly adapterId?: string;
}

/**
 * Pin the agent occupying `sessionId` right now. Returns null when the
 * session is not a managed agent (plain terminal, or already gone).
 */
export function pinAgentOccupant(sessionId: string): AgentOccupantPin | null {
  const info = getAgentSessionInfo(sessionId);
  if (!info) return null;
  return {
    sessionId: info.sessionId,
    ...(info.paneId ? { paneId: info.paneId } : {}),
    ...(info.agentName ? { agentName: info.agentName } : {}),
    adapterId: info.adapterId,
  };
}

/**
 * A pin is alive only while the SAME session still hosts the SAME agent.
 * pty-manager removes the session from its registry before firing exit taps,
 * so a dead session fails here even when the reset-on-exit `idle` semantic
 * entry arrives first.
 */
export function occupantPinAlive(pin: AgentOccupantPin): boolean {
  const info = getAgentSessionInfo(pin.sessionId);
  if (!info) return false;
  if (info.agentName !== pin.agentName) return false;
  if (info.adapterId !== pin.adapterId) return false;
  if (pin.paneId !== undefined && info.paneId !== pin.paneId) return false;
  return true;
}

export function parseSemanticUntil(
  until: readonly string[] | undefined,
): readonly AgentSemanticStatus[] {
  if (!until || until.length === 0) return SEMANTIC_WAIT_DEFAULT_UNTIL;
  const valid = new Set<string>(AGENT_SEMANTIC_STATUSES);
  for (const status of until) {
    if (!valid.has(status)) {
      throw new SemanticWaitError(
        'invalid_until',
        `unknown semantic status "${status}" (valid: ${AGENT_SEMANTIC_STATUSES.join(', ')})`,
      );
    }
  }
  return until as readonly AgentSemanticStatus[];
}

function resolveSemanticSessionId(target: SemanticWaitTarget): string {
  if (target.sessionId) return target.sessionId;
  if (target.paneId) {
    const candidates = listAgentSessionsForPane(target.paneId);
    const live = candidates.filter(
      (info) => getSessionState(info.sessionId) !== null,
    );
    const chosen = live.at(-1) ?? candidates.at(-1);
    if (chosen) return chosen.sessionId;
  }
  throw new SemanticWaitError(
    'agent_not_running',
    'no managed agent session for the target',
  );
}

function semanticWaitAbortFallback(): Error {
  const error = new Error('semantic wait was aborted');
  error.name = 'AbortError';
  return error;
}

type PendingWaitOutcome = SemanticWaitMatch | PromptActivityEvidence;

interface PendingWait {
  mode: 'match' | 'activity';
  resolve: (outcome: PendingWaitOutcome) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  onTimeout: () => SemanticWaitError;
}

interface ArmedWaiterInput {
  pin: AgentOccupantPin;
  until: readonly AgentSemanticStatus[];
  /**
   * Freshness floor for prompt waits: a match must postdate submission.
   * Entries delivered through the tap after arming always qualify; store
   * snapshots qualify only when strictly newer than this timestamp.
   */
  notBefore?: number;
  /** Submission marker for the activity gate (turn-start sequence). */
  baselineTurnSequence?: number;
  signal?: AbortSignal;
}

interface ArmedSemanticWaiter {
  waitForMatch(
    timeoutMs: number,
    onTimeout: () => SemanticWaitError,
  ): Promise<SemanticWaitMatch>;
  waitForActivity(timeoutMs: number): Promise<PromptActivityEvidence>;
  activityEvidence(): PromptActivityEvidence | null;
  dispose(): void;
}

/**
 * Arm the status/turn/exit taps for one pinned occupant. Every settle path
 * probes pin liveness first, then the requested condition; the timeout path
 * probes once more before failing (wait.rs:486-511).
 */
function armSemanticWaiter(input: ArmedWaiterInput): ArmedSemanticWaiter {
  const { pin } = input;
  const until = new Set<AgentSemanticStatus>(input.until);
  let pending: PendingWait | null = null;
  let disposed = false;
  let deadError: SemanticWaitError | null = null;
  let activityEntry: AgentSemanticStatusEntry | null = null;
  let tappedEntry: AgentSemanticStatusEntry | null = null;

  const notRunning = () =>
    new SemanticWaitError(
      'agent_not_running',
      'agent is no longer running in the target pane',
    );

  const snapshot = (): AgentSemanticStatusEntry | null => {
    const entry = getAgentSemanticStatusBySession(pin.sessionId);
    return entry?.sessionId === pin.sessionId ? entry : null;
  };

  const toMatch = (entry: AgentSemanticStatusEntry): SemanticWaitMatch => ({
    status: entry.status,
    sessionId: entry.sessionId,
    paneId: entry.paneId,
    ...(pin.agentName ? { agentName: pin.agentName } : {}),
    updatedAt: entry.updatedAt,
  });

  const isFresh = (entry: AgentSemanticStatusEntry): boolean =>
    input.notBefore === undefined ||
    entry === tappedEntry ||
    entry.updatedAt > input.notBefore;

  const collectActivity = (): PromptActivityEvidence | null => {
    if (
      input.baselineTurnSequence !== undefined &&
      getAgentTurnStartSequence(pin.sessionId) > input.baselineTurnSequence
    ) {
      return { kind: 'turn-start', status: snapshot()?.status ?? null };
    }
    if (activityEntry) {
      return { kind: 'status-transition', status: activityEntry.status };
    }
    return null;
  };

  const settlePending = (outcome: PendingWaitOutcome): void => {
    const p = pending;
    if (!p) return;
    pending = null;
    clearTimeout(p.timer);
    p.resolve(outcome);
  };

  const rejectPending = (error: unknown): void => {
    const p = pending;
    if (!p) return;
    pending = null;
    clearTimeout(p.timer);
    p.reject(error);
  };

  // Shared probe: occupant pin first (a substitute process never satisfies
  // the wait), then the pending wait's settle condition.
  const probe = (): boolean => {
    if (deadError) {
      rejectPending(deadError);
      return true;
    }
    if (!occupantPinAlive(pin)) {
      deadError = notRunning();
      rejectPending(deadError);
      return true;
    }
    if (!pending) return false;
    if (pending.mode === 'activity') {
      const evidence = collectActivity();
      if (evidence) {
        settlePending(evidence);
        return true;
      }
      return false;
    }
    const current = snapshot();
    if (current && until.has(current.status) && isFresh(current)) {
      settlePending(toMatch(current));
      return true;
    }
    return false;
  };

  const untapStatus = tapAgentSemanticStatus((entry) => {
    // A respawned process in the same pane reports under a NEW session id and
    // is deliberately invisible to this wait.
    if (entry.sessionId !== pin.sessionId) return;
    tappedEntry = entry;
    if (input.notBefore !== undefined && entry.updatedAt >= input.notBefore) {
      // Any post-submission transition is proof the prompt had an effect.
      activityEntry = entry;
    }
    probe();
  });
  const untapTurnStart = tapAgentTurnStart((entry) => {
    if (entry.sessionId !== pin.sessionId) return;
    probe();
  });
  const untapExit = tapSessionExit((exitedSessionId) => {
    if (exitedSessionId !== pin.sessionId) return;
    deadError = notRunning();
    rejectPending(deadError);
  });
  const onAbort = () => {
    rejectPending(input.signal?.reason ?? semanticWaitAbortFallback());
  };
  input.signal?.addEventListener('abort', onAbort, { once: true });

  const start = <T extends PendingWaitOutcome>(
    mode: PendingWait['mode'],
    timeoutMs: number,
    onTimeout: () => SemanticWaitError,
  ): Promise<T> => {
    if (disposed) return Promise.reject(new Error('semantic waiter disposed'));
    if (pending) {
      return Promise.reject(
        new Error('semantic waiter already has a pending wait'),
      );
    }
    if (input.signal?.aborted) {
      return Promise.reject(input.signal.reason ?? semanticWaitAbortFallback());
    }
    return new Promise<T>((resolve, reject) => {
      pending = {
        mode,
        resolve: resolve as PendingWait['resolve'],
        reject,
        onTimeout,
        timer: setTimeout(() => {
          // Final probe before failing: a transition that landed between the
          // last tap and the deadline still counts (wait.rs:486-511).
          if (!probe()) rejectPending(onTimeout());
        }, Math.max(0, timeoutMs)),
      };
      // Snapshot AFTER the taps are armed — the replay-equivalent of Herdr's
      // initial agent_get: nothing between arming and probing is missed.
      probe();
    });
  };

  return {
    waitForMatch: (timeoutMs, onTimeout) =>
      start<SemanticWaitMatch>('match', timeoutMs, onTimeout),
    waitForActivity: (timeoutMs) =>
      start<PromptActivityEvidence>(
        'activity',
        timeoutMs,
        () =>
          new SemanticWaitError(
            'agent_prompt_stalled',
            `agent prompt produced no observed effect within ${Math.max(0, timeoutMs)} ms; ` +
              `current status is ${snapshot()?.status ?? 'unknown'}`,
          ),
      ),
    activityEvidence: () => collectActivity(),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      untapStatus();
      untapTurnStart();
      untapExit();
      input.signal?.removeEventListener('abort', onAbort);
      rejectPending(semanticWaitAbortFallback());
    },
  };
}

export interface SemanticWaitOptions {
  /** Statuses that settle the wait; default idle/completed/awaiting-input. */
  until?: readonly string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Event-driven wait for a managed agent's semantic status. Resolves on the
 * first matching status (initial snapshot or a later transition), rejects
 * with agent_not_running when the pinned occupant dies or is substituted, and
 * with timeout after a final probe at the deadline.
 */
export async function waitForSemanticStatus(
  target: SemanticWaitTarget,
  options: SemanticWaitOptions = {},
): Promise<SemanticWaitMatch> {
  const until = parseSemanticUntil(options.until);
  const timeoutMs = options.timeoutMs ?? SEMANTIC_WAIT_DEFAULT_TIMEOUT_MS;
  const sessionId = resolveSemanticSessionId(target);
  const pin = pinAgentOccupant(sessionId);
  if (!pin) {
    throw new SemanticWaitError(
      'agent_not_running',
      'no managed agent session for the target',
    );
  }
  const waiter = armSemanticWaiter({ pin, until, signal: options.signal });
  try {
    return await waiter.waitForMatch(
      timeoutMs,
      () =>
        new SemanticWaitError(
          'timeout',
          `timed out waiting for agent status ` +
            `(current: ${snapshotStatus(pin) ?? 'unknown'})`,
        ),
    );
  } finally {
    waiter.dispose();
  }
}

function snapshotStatus(pin: AgentOccupantPin): AgentSemanticStatus | null {
  const entry = getAgentSemanticStatusBySession(pin.sessionId);
  return entry?.sessionId === pin.sessionId ? entry.status : null;
}

export interface AgentPromptInput {
  sessionId: string;
  text: string;
  /** The existing pane write path (tool-util injectPrompt at the tool layer). */
  write: (sessionId: string, text: string) => Promise<void>;
  /** Omit for fire-and-forget: only submission is confirmed. */
  wait?: {
    until?: readonly string[];
    timeoutMs?: number;
  };
  signal?: AbortSignal;
}

export interface AgentPromptResult {
  submitted: true;
  sessionId: string;
  paneId?: string;
  agentName?: string;
  submittedAt: number;
  /** Turn-start sequence captured BEFORE the write (submission marker). */
  turnSequenceBefore: number;
  activity?: PromptActivityEvidence;
  match?: SemanticWaitMatch;
}

/**
 * Atomic prompt+wait (wait.rs:177-322). Order matters:
 *
 *  1. Pin the occupant and refuse agent_blocked WITHOUT writing when the
 *     agent already awaits interactive input (permission/question dialog).
 *  2. Capture the turn-start sequence and arm the wait taps.
 *  3. Write the prompt through the caller-provided transport.
 *  4. Activity gate: within AGENT_PROMPT_EFFECT_TIMEOUT_MS the prompt must
 *     produce a turn-start bump or a post-submission status transition, else
 *     agent_prompt_stalled.
 *  5. Wait for the `until` statuses, fresh-after-submission only, so a stale
 *     pre-prompt `idle` can never satisfy the wait.
 */
export async function promptAgentAndWait(
  input: AgentPromptInput,
): Promise<AgentPromptResult> {
  const pin = pinAgentOccupant(input.sessionId);
  if (!pin) {
    throw new SemanticWaitError(
      'agent_not_running',
      'no managed agent session for the target pane',
    );
  }
  const before = getAgentSemanticStatusBySession(pin.sessionId);
  if (before?.sessionId === pin.sessionId && before.status === 'awaiting-input') {
    // wait.rs agent_blocked: fail immediately, no input written, no wait armed.
    throw new SemanticWaitError(
      'agent_blocked',
      'agent is awaiting interactive input; answer its dialog before sending a new prompt',
    );
  }
  const turnSequenceBefore = getAgentTurnStartSequence(pin.sessionId);
  const submittedAt = Date.now();
  const until = parseSemanticUntil(input.wait?.until);
  const waiter = armSemanticWaiter({
    pin,
    until,
    notBefore: submittedAt,
    baselineTurnSequence: turnSequenceBefore,
    signal: input.signal,
  });
  try {
    await input.write(pin.sessionId, input.text);
    const result: AgentPromptResult = {
      submitted: true,
      sessionId: pin.sessionId,
      ...(pin.paneId ? { paneId: pin.paneId } : {}),
      ...(pin.agentName ? { agentName: pin.agentName } : {}),
      submittedAt,
      turnSequenceBefore,
    };
    if (!input.wait) return result;
    const deadline =
      submittedAt + (input.wait.timeoutMs ?? SEMANTIC_WAIT_DEFAULT_TIMEOUT_MS);
    const remainingMs = () => Math.max(0, deadline - Date.now());
    result.activity =
      waiter.activityEvidence() ??
      (await waiter.waitForActivity(
        Math.min(AGENT_PROMPT_EFFECT_TIMEOUT_MS, remainingMs()),
      ));
    result.match = await waiter.waitForMatch(
      remainingMs(),
      () =>
        new SemanticWaitError(
          'timeout',
          `timed out waiting for agent status after prompt ` +
            `(current: ${snapshotStatus(pin) ?? 'unknown'})`,
        ),
    );
    return result;
  } finally {
    waiter.dispose();
  }
}
