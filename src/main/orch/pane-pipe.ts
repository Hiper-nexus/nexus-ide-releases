import type { Pipe, PipeMode } from '../../shared/pipe-types';
import {
  orchWriteSession,
  tapSessionData,
  tapSessionExit,
  tapSessionState,
} from '../pty/pty-manager';
import { findPane, readSessionOutput, stripAnsi } from './pane-registry';
import { ChangeHub, makeId } from './store-util';
import {
  InjectionGuard,
  PIPE_MARKER,
  canForward,
  extractCompleteLines,
  sanitizeForInjection,
} from './pane-pipe-core';

/**
 * Pane pipes runtime — the "edges que conversam" engine. Each pipe observes
 * the SOURCE pane's PTY output (via tapSessionData) and injects it into the
 * TARGET pane's PTY (via orchWriteSession), as if the source agent typed into
 * the target's terminal.
 *
 * paneId → sessionId is resolved through findPane at FORWARDING time, never
 * cached: a failover re-spawn gives the pane a new sessionId and the pipe
 * must follow it.
 *
 * Loop safety: a pipe can't target its own source (canForward), and every
 * injected line is recorded in an InjectionGuard so its terminal echo is
 * swallowed instead of re-forwarded by a reverse pipe. onIdle deliveries are
 * additionally tagged with PIPE_MARKER, which is filtered on read-back.
 */

const MAX_PIPES = 64;
/** Stream mode: queued lines flush in small batches on this cadence. */
const FLUSH_INTERVAL_MS = 150;
const MAX_LINES_PER_FLUSH = 8;
const MAX_QUEUED_LINES = 400;
/** onIdle mode: minimum gap between deliveries + tail size read from source. */
const IDLE_THROTTLE_MS = 3_000;
const IDLE_TAIL_LINES = 60;
const MAX_IDLE_DELIVERY_CHARS = 4_000;
/** Delay before the submit Enter, so TUIs register it as a keypress. */
const SUBMIT_ENTER_DELAY_MS = 150;

interface StreamState {
  /** Session the pending partial line belongs to — reset on re-spawn. */
  sessionId: string;
  rest: string;
}

const pipes = new Map<string, Pipe>();
const streamStates = new Map<string, StreamState>();
const outQueues = new Map<string, string[]>();
const flushTimers = new Map<string, ReturnType<typeof setTimeout>>();
const idleDirty = new Set<string>();
const lastIdleDeliveryAt = new Map<string, number>();
const lastIdleDeliveryText = new Map<string, string>();
const guard = new InjectionGuard();
const hub = new ChangeHub();
let tapsInstalled = false;

function clearPipeState(pipeId: string): void {
  streamStates.delete(pipeId);
  outQueues.delete(pipeId);
  const timer = flushTimers.get(pipeId);
  if (timer) clearTimeout(timer);
  flushTimers.delete(pipeId);
  idleDirty.delete(pipeId);
  lastIdleDeliveryAt.delete(pipeId);
  lastIdleDeliveryText.delete(pipeId);
}

/**
 * Resolve the live target session for a pipe, or null when the pipe can't
 * deliver right now (pane gone, no session, or it would write back into the
 * very session that produced the data).
 */
function resolveTargetSession(pipe: Pipe, sourceSessionId: string): string | null {
  const target = findPane(pipe.targetPaneId);
  if (!target || !target.sessionId) return null;
  if (target.sessionId === sourceSessionId) return null;
  return target.sessionId;
}

function scheduleFlush(pipeId: string): void {
  if (flushTimers.has(pipeId)) return;
  flushTimers.set(
    pipeId,
    setTimeout(() => {
      flushTimers.delete(pipeId);
      flushQueue(pipeId);
    }, FLUSH_INTERVAL_MS),
  );
}

function flushQueue(pipeId: string): void {
  const pipe = pipes.get(pipeId);
  const queue = outQueues.get(pipeId);
  if (!pipe || !queue || queue.length === 0) return;

  const source = findPane(pipe.sourcePaneId);
  const targetSessionId = resolveTargetSession(pipe, source?.sessionId ?? '');
  if (!targetSessionId) {
    // Target unavailable — drop this batch instead of piling up forever.
    outQueues.delete(pipeId);
    return;
  }

  const batch = queue.splice(0, MAX_LINES_PER_FLUSH);
  for (const line of batch) {
    guard.markInjected(targetSessionId, line);
    if (!orchWriteSession(targetSessionId, `${line}\r`)) {
      outQueues.delete(pipeId);
      return;
    }
  }
  if (queue.length > 0) scheduleFlush(pipeId);
  else outQueues.delete(pipeId);
}

function enqueueLine(pipeId: string, line: string): void {
  let queue = outQueues.get(pipeId);
  if (!queue) {
    queue = [];
    outQueues.set(pipeId, queue);
  }
  queue.push(line);
  // Throttle backstop: a source flooding output loses its OLDEST lines so
  // the target still receives the most recent state.
  while (queue.length > MAX_QUEUED_LINES) queue.shift();
  scheduleFlush(pipeId);
}

/**
 * A raw line may hide `\r`-based redraws (progress bars). stripAnsi turns
 * lone `\r` into `\n`; the last non-empty segment is what the terminal would
 * actually show for that line.
 */
function renderedLine(rawLine: string): string {
  const segments = stripAnsi(rawLine).split('\n');
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index].trim();
    if (segment.length > 0) return segment;
  }
  return '';
}

function handleStreamChunk(pipe: Pipe, sourceSessionId: string, data: string): void {
  let state = streamStates.get(pipe.id);
  if (!state || state.sessionId !== sourceSessionId) {
    state = { sessionId: sourceSessionId, rest: '' };
    streamStates.set(pipe.id, state);
  }
  const { lines, rest } = extractCompleteLines(state.rest, data);
  state.rest = rest;

  for (const rawLine of lines) {
    const line = renderedLine(rawLine);
    if (line.length === 0) continue;
    // Never re-forward our own injections: echoes of what a pipe just typed
    // into this session, or a marker-tagged onIdle delivery.
    if (line.includes(PIPE_MARKER)) continue;
    if (guard.isEcho(sourceSessionId, line)) continue;
    enqueueLine(pipe.id, line);
  }
}

function deliverIdle(pipe: Pipe, sourceSessionId: string): void {
  const now = Date.now();
  const lastAt = lastIdleDeliveryAt.get(pipe.id) ?? 0;
  if (now - lastAt < IDLE_THROTTLE_MS) return;

  const targetSessionId = resolveTargetSession(pipe, sourceSessionId);
  if (!targetSessionId) return;

  const tail = readSessionOutput(sourceSessionId, IDLE_TAIL_LINES);
  // Drop echoes of previous pipe deliveries still sitting in the buffer.
  const text = sanitizeForInjection(
    tail
      .split('\n')
      .filter((line) => !line.includes(PIPE_MARKER))
      .join('\n'),
  ).slice(0, MAX_IDLE_DELIVERY_CHARS);
  if (text.length === 0 || text === lastIdleDeliveryText.get(pipe.id)) return;

  const message = `${PIPE_MARKER} from=${sanitizeForInjection(pipe.sourcePaneId).slice(0, 128)} ${text}`;
  guard.markInjected(targetSessionId, message);
  if (!orchWriteSession(targetSessionId, message)) return;
  // Enter arrives as a separate write so TUIs treat it as a submit keypress.
  setTimeout(() => orchWriteSession(targetSessionId, '\r'), SUBMIT_ENTER_DELAY_MS);

  lastIdleDeliveryAt.set(pipe.id, now);
  lastIdleDeliveryText.set(pipe.id, text);
}

/** Install the PTY taps. Idempotent — safe to call from multiple boot paths. */
export function initPanePipes(): void {
  if (tapsInstalled) return;
  tapsInstalled = true;

  tapSessionData((sessionId, data) => {
    if (pipes.size === 0) return;
    for (const pipe of pipes.values()) {
      const source = findPane(pipe.sourcePaneId);
      if (!source || source.sessionId !== sessionId) continue;
      if (pipe.mode === 'stream') handleStreamChunk(pipe, sessionId, data);
      else idleDirty.add(pipe.id);
    }
  });

  tapSessionState((sessionId, state) => {
    if (state !== 'idle' || pipes.size === 0) return;
    for (const pipe of pipes.values()) {
      if (pipe.mode !== 'onIdle' || !idleDirty.has(pipe.id)) continue;
      const source = findPane(pipe.sourcePaneId);
      if (!source || source.sessionId !== sessionId) continue;
      idleDirty.delete(pipe.id);
      deliverIdle(pipe, sessionId);
    }
  });

  tapSessionExit((sessionId) => {
    guard.clearSession(sessionId);
    for (const [pipeId, state] of streamStates) {
      if (state.sessionId === sessionId) streamStates.delete(pipeId);
    }
  });
}

export function listPipes(): Pipe[] {
  return [...pipes.values()];
}

/**
 * Create a pipe. Returns null when the pair is invalid (self-pipe / empty
 * ids / capacity). Adding an already-existing (source, target, mode) triple
 * returns the existing pipe instead of duplicating the forwarding.
 */
export function addPipe(
  sourcePaneId: string,
  targetPaneId: string,
  mode: PipeMode,
): Pipe | null {
  if (!canForward(sourcePaneId, targetPaneId)) return null;
  for (const existing of pipes.values()) {
    if (
      existing.sourcePaneId === sourcePaneId &&
      existing.targetPaneId === targetPaneId &&
      existing.mode === mode
    ) {
      return existing;
    }
  }
  if (pipes.size >= MAX_PIPES) return null;
  const pipe: Pipe = { id: makeId('pipe'), sourcePaneId, targetPaneId, mode };
  pipes.set(pipe.id, pipe);
  hub.emit();
  return pipe;
}

export function removePipe(id: string): boolean {
  if (!pipes.delete(id)) return false;
  clearPipeState(id);
  hub.emit();
  return true;
}

export function onPipesChange(cb: () => void): () => void {
  return hub.onChange(cb);
}
