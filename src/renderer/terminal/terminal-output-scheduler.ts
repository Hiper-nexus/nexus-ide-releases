// Adapted from stablyai/orca @ 143c36e566483006fe54fa2716b019ec00599752
// Copyright (c) 2026 Lovecast Inc. — MIT License
// See third_party/licenses/orca-MIT.txt. Nexus changes: state machine + public
// API adapted for stable @xterm/xterm write sinks; removed e2e-config, xterm
// beta private _core refresh, scroll-intent, and pane-manager foreground
// settle helpers. Backlog warning text uses "Nexus" branding.

/**
 * Shared terminal output scheduler: per-terminal queues, foreground priority,
 * cooperative drain budgets, background backlog bounds with controlled drop,
 * and ANSI-safe chunking. Callers supply a narrow write sink (stable xterm
 * `write`) rather than ORCA pane-manager types.
 */

export type TerminalOutputSink = {
  write(data: string, callback?: () => void): void;
};

export type TerminalOutputBeforeWrite = (data: string) => void;
export type TerminalOutputParsedCallback = () => void;

export type WriteTerminalOutputOptions = {
  foreground: boolean;
  beforeWrite?: TerminalOutputBeforeWrite;
  onParsed?: TerminalOutputParsedCallback;
  onBackgroundBacklogDropped?: () => void;
  /** When false, queue even foreground floods instead of writing immediately. */
  latencySensitive?: boolean;
  coalesceForeground?: boolean;
  holdForeground?: boolean;
};

type QueueChunk = {
  data: string;
  foreground: boolean;
  onParsed?: TerminalOutputParsedCallback;
};

type QueuedWrite = {
  data: string;
  foreground: boolean;
  onParsed?: TerminalOutputParsedCallback;
};

type QueueEntry = {
  terminal: TerminalOutputSink;
  chunks: QueueChunk[];
  chunkIndex: number;
  queuedChars: number;
  beforeWrite?: TerminalOutputBeforeWrite;
  onBackgroundBacklogDropped?: () => void;
  backgroundBacklogDropped: boolean;
  highPriority: boolean;
  foregroundHold: boolean;
  foregroundHoldSafetyDelayMs: number;
  foregroundCoalesce: boolean;
  foregroundCoalesceDelayMs: number;
  foregroundHoldSafetyTimer: ReturnType<typeof setTimeout> | null;
  foregroundCoalesceTimer: ReturnType<typeof setTimeout> | null;
};

const BACKGROUND_FLUSH_DELAY_MS = 50;
const BACKGROUND_DRAIN_INTERVAL_MS = 16;
const HIGH_PRIORITY_DRAIN_INTERVAL_MS = 4;
const BACKGROUND_CHUNK_CHARS = 16 * 1024;
const MAX_WRITES_PER_DRAIN = 2;
const HIGH_PRIORITY_MAX_WRITES_PER_DRAIN = 2;
const DRAIN_TIME_BUDGET_MS = 8;
const LARGE_BACKLOG_CHARS = 512 * 1024;
const SYNC_FOREGROUND_FLUSH_CHARS = 256 * 1024;
/** Max queued chars for a background/hidden terminal before controlled drop. */
export const MAX_BACKGROUND_QUEUE_CHARS = 2 * 1024 * 1024;
const MAX_BACKGROUND_QUEUE_CHUNKS = 4096;
const FOREGROUND_COALESCE_DELAY_MS = 1000;
const FOREGROUND_HOLD_SAFETY_DELAY_MS = 250;
const LATENCY_SENSITIVE_FOREGROUND_COALESCE_DELAY_MS = 16;
const LATENCY_SENSITIVE_FOREGROUND_HOLD_SAFETY_DELAY_MS = 32;
const CURSOR_SHOW_SEQUENCE = '\x1b[?25h';
const CURSOR_HIDE_SEQUENCE = '\x1b[?25l';
const SYNCHRONIZED_OUTPUT_END_SEQUENCE = '\x1b[?2026l';
// CAN aborts a partial escape sequence before resetting style and showing the
// lossy-backlog warning — preserves ANSI integrity for subsequent bytes.
const BACKGROUND_BACKLOG_WARNING =
  '\x18\x1b[0m\r\n[Nexus skipped hidden terminal output because the backlog exceeded 2 MB.]\r\n';

const queuedByTerminal = new Map<TerminalOutputSink, QueueEntry>();
let drainTimer: ReturnType<typeof setTimeout> | null = null;
let drainTimerDelayMs: number | null = null;

export type TerminalOutputSchedulerDebugSnapshot = {
  backgroundEnqueueCount: number;
  deferredForegroundEnqueueCount: number;
  foregroundWriteCount: number;
  backgroundWriteCount: number;
  deferredForegroundWriteCount: number;
  flushWriteCount: number;
  scheduledDrainCount: number;
  queuedTerminalCount: number;
  queuedChars: number;
  peakQueuedTerminalCount: number;
  peakQueuedChars: number;
  peakQueuedCharsByTerminal: number;
  droppedBacklogCount: number;
  drainWrites: number[];
};

const debugState: TerminalOutputSchedulerDebugSnapshot = {
  backgroundEnqueueCount: 0,
  deferredForegroundEnqueueCount: 0,
  foregroundWriteCount: 0,
  backgroundWriteCount: 0,
  deferredForegroundWriteCount: 0,
  flushWriteCount: 0,
  scheduledDrainCount: 0,
  queuedTerminalCount: 0,
  queuedChars: 0,
  peakQueuedTerminalCount: 0,
  peakQueuedChars: 0,
  peakQueuedCharsByTerminal: 0,
  droppedBacklogCount: 0,
  drainWrites: [],
};

let debugEnabled = false;

/** Enable/disable diagnostic counters (tests and multipane benchmarks). */
export function setTerminalOutputSchedulerDebug(enabled: boolean): void {
  debugEnabled = enabled;
  if (!enabled) {
    resetTerminalOutputSchedulerDebug();
  }
}

export function resetTerminalOutputSchedulerDebug(): void {
  debugState.backgroundEnqueueCount = 0;
  debugState.deferredForegroundEnqueueCount = 0;
  debugState.foregroundWriteCount = 0;
  debugState.backgroundWriteCount = 0;
  debugState.deferredForegroundWriteCount = 0;
  debugState.flushWriteCount = 0;
  debugState.scheduledDrainCount = 0;
  debugState.queuedTerminalCount = 0;
  debugState.queuedChars = 0;
  debugState.peakQueuedTerminalCount = 0;
  debugState.peakQueuedChars = 0;
  debugState.peakQueuedCharsByTerminal = 0;
  debugState.droppedBacklogCount = 0;
  debugState.drainWrites = [];
}

function readQueueDebugSnapshot(): {
  queuedTerminalCount: number;
  queuedChars: number;
  queuedCharsByTerminal: number;
} {
  let queuedChars = 0;
  let queuedCharsByTerminal = 0;
  for (const entry of queuedByTerminal.values()) {
    queuedChars += entry.queuedChars;
    queuedCharsByTerminal = Math.max(queuedCharsByTerminal, entry.queuedChars);
  }
  return {
    queuedTerminalCount: queuedByTerminal.size,
    queuedChars,
    queuedCharsByTerminal,
  };
}

function recordQueueDebugPressure(): void {
  if (!debugEnabled) return;
  const current = readQueueDebugSnapshot();
  debugState.queuedTerminalCount = current.queuedTerminalCount;
  debugState.queuedChars = current.queuedChars;
  debugState.peakQueuedTerminalCount = Math.max(
    debugState.peakQueuedTerminalCount,
    current.queuedTerminalCount,
  );
  debugState.peakQueuedChars = Math.max(
    debugState.peakQueuedChars,
    current.queuedChars,
  );
  debugState.peakQueuedCharsByTerminal = Math.max(
    debugState.peakQueuedCharsByTerminal,
    current.queuedCharsByTerminal,
  );
}

export function getTerminalOutputSchedulerDebugSnapshot(): TerminalOutputSchedulerDebugSnapshot {
  recordQueueDebugPressure();
  return {
    ...debugState,
    drainWrites: [...debugState.drainWrites],
  };
}

function scheduleDrain(delayMs: number): void {
  if (drainTimer !== null) {
    if (drainTimerDelayMs !== null && drainTimerDelayMs <= delayMs) {
      return;
    }
    clearTimeout(drainTimer);
    drainTimer = null;
    drainTimerDelayMs = null;
  }
  if (queuedByTerminal.size === 0) {
    return;
  }
  if (debugEnabled) {
    debugState.scheduledDrainCount++;
  }
  drainTimer = setTimeout(drainQueuedOutput, delayMs);
  drainTimerDelayMs = delayMs;
}

function createQueueEntry(
  terminal: TerminalOutputSink,
  options: WriteTerminalOutputOptions,
): QueueEntry {
  return {
    terminal,
    chunks: [],
    chunkIndex: 0,
    queuedChars: 0,
    beforeWrite: options.beforeWrite,
    onBackgroundBacklogDropped: options.onBackgroundBacklogDropped,
    backgroundBacklogDropped: false,
    highPriority: true,
    foregroundHold: false,
    foregroundHoldSafetyDelayMs: FOREGROUND_HOLD_SAFETY_DELAY_MS,
    foregroundCoalesce: false,
    foregroundCoalesceDelayMs: FOREGROUND_COALESCE_DELAY_MS,
    foregroundHoldSafetyTimer: null,
    foregroundCoalesceTimer: null,
  };
}

function clearForegroundHoldSafety(entry: QueueEntry): void {
  if (entry.foregroundHoldSafetyTimer === null) return;
  clearTimeout(entry.foregroundHoldSafetyTimer);
  entry.foregroundHoldSafetyTimer = null;
  entry.foregroundHoldSafetyDelayMs = FOREGROUND_HOLD_SAFETY_DELAY_MS;
}

function clearForegroundCoalesce(entry: QueueEntry): void {
  if (entry.foregroundCoalesceTimer !== null) {
    clearTimeout(entry.foregroundCoalesceTimer);
    entry.foregroundCoalesceTimer = null;
  }
  entry.foregroundCoalesce = false;
  entry.foregroundCoalesceDelayMs = FOREGROUND_COALESCE_DELAY_MS;
}

function scheduleForegroundHoldSafety(entry: QueueEntry): void {
  clearForegroundHoldSafety(entry);
  entry.foregroundHoldSafetyTimer = setTimeout(() => {
    entry.foregroundHoldSafetyTimer = null;
    entry.foregroundHold = false;
    clearForegroundCoalesce(entry);
    if (queuedByTerminal.has(entry.terminal)) {
      scheduleDrain(0);
    }
  }, entry.foregroundHoldSafetyDelayMs);
}

function scheduleForegroundCoalesceRelease(
  entry: QueueEntry,
  options?: { rescheduleEarlier?: boolean },
): void {
  if (entry.foregroundCoalesceTimer !== null) {
    if (options?.rescheduleEarlier !== true) {
      entry.foregroundCoalesce = true;
      return;
    }
    clearTimeout(entry.foregroundCoalesceTimer);
    entry.foregroundCoalesceTimer = null;
  }
  entry.foregroundCoalesce = true;
  entry.foregroundCoalesceTimer = setTimeout(() => {
    entry.foregroundCoalesceTimer = null;
    entry.foregroundCoalesce = false;
    if (queuedByTerminal.has(entry.terminal)) {
      scheduleDrain(0);
    }
  }, entry.foregroundCoalesceDelayMs);
}

function isEntryDrainable(entry: QueueEntry): boolean {
  return !entry.foregroundHold && !entry.foregroundCoalesce;
}

/** Exposed for unit tests: strip transient cursor-show sequences (ANSI integrity). */
export function removeTransientCursorShowSequences(data: string): string {
  let result = '';
  let offset = 0;
  let showIndex = data.indexOf(CURSOR_SHOW_SEQUENCE);
  while (showIndex !== -1) {
    const nextHideIndex = data.indexOf(
      CURSOR_HIDE_SEQUENCE,
      showIndex + CURSOR_SHOW_SEQUENCE.length,
    );
    const nextPositionEnd = findCursorPositionSequenceEnd(
      data,
      showIndex + CURSOR_SHOW_SEQUENCE.length,
      nextHideIndex === -1 ? data.length : nextHideIndex,
    );
    if (nextHideIndex === -1) {
      if (nextPositionEnd === -1) {
        const synchronizedEndIndex = data.indexOf(
          SYNCHRONIZED_OUTPUT_END_SEQUENCE,
          showIndex + CURSOR_SHOW_SEQUENCE.length,
        );
        if (synchronizedEndIndex === -1) {
          break;
        }
        result += data.slice(offset, showIndex);
        result += data.slice(
          showIndex + CURSOR_SHOW_SEQUENCE.length,
          synchronizedEndIndex + SYNCHRONIZED_OUTPUT_END_SEQUENCE.length,
        );
        result += CURSOR_SHOW_SEQUENCE;
        offset = synchronizedEndIndex + SYNCHRONIZED_OUTPUT_END_SEQUENCE.length;
        showIndex = data.indexOf(CURSOR_SHOW_SEQUENCE, offset);
        continue;
      }
      result += data.slice(offset, showIndex);
      result += data.slice(
        showIndex + CURSOR_SHOW_SEQUENCE.length,
        nextPositionEnd,
      );
      result += CURSOR_SHOW_SEQUENCE;
      offset = nextPositionEnd;
      showIndex = data.indexOf(CURSOR_SHOW_SEQUENCE, offset);
      continue;
    }
    result += data.slice(offset, showIndex);
    offset = showIndex + CURSOR_SHOW_SEQUENCE.length;
    showIndex = data.indexOf(CURSOR_SHOW_SEQUENCE, offset);
  }
  return offset === 0 ? data : result + data.slice(offset);
}

function findCursorPositionSequenceEnd(
  data: string,
  fromIndex: number,
  toIndex = data.length,
): number {
  let offset = data.indexOf('\x1b[', fromIndex);
  while (offset !== -1 && offset < toIndex) {
    let index = offset + 2;
    while (index < toIndex) {
      const char = data[index];
      if (char === 'G' || char === 'H' || char === 'f') {
        return index + 1;
      }
      if ((char < '0' || char > '9') && char !== ';') {
        break;
      }
      index += 1;
    }
    offset = data.indexOf('\x1b[', offset + 2);
  }
  return -1;
}

function containsCursorPositionSequence(data: string): boolean {
  return findCursorPositionSequenceEnd(data, 0) !== -1;
}

function containsCursorRestore(data: string): boolean {
  const hideIndex = data.indexOf(CURSOR_HIDE_SEQUENCE);
  const showIndex = data.lastIndexOf(CURSOR_SHOW_SEQUENCE);
  return (
    hideIndex !== -1 &&
    showIndex > hideIndex &&
    containsCursorPositionSequence(data)
  );
}

function containsDrainableCursorRestore(data: string): boolean {
  const synchronizedEndIndex = data.lastIndexOf(SYNCHRONIZED_OUTPUT_END_SEQUENCE);
  if (synchronizedEndIndex === -1) {
    return containsCursorRestore(data);
  }
  return containsCursorRestore(
    data.slice(synchronizedEndIndex + SYNCHRONIZED_OUTPUT_END_SEQUENCE.length),
  );
}

function compactConsumedChunks(entry: QueueEntry): void {
  if (entry.chunkIndex === 0) return;
  if (entry.chunkIndex === entry.chunks.length) {
    entry.chunks.length = 0;
    entry.chunkIndex = 0;
    return;
  }
  if (entry.chunkIndex >= 64) {
    entry.chunks.splice(0, entry.chunkIndex);
    entry.chunkIndex = 0;
  }
}

/**
 * True when `partial` (starting at ESC) is a complete escape sequence prefix
 * that is safe to cut after. CSI needs ESC [ … final (0x40–0x7E); bare
 * `ESC [` is incomplete (`[` is the CSI introducer, not a final byte).
 */
function isCompleteEscapePrefix(partial: string): boolean {
  if (partial.length < 2 || partial[0] !== '\x1b') {
    return false;
  }
  const intro = partial[1];
  // CSI: ESC [ params intermediates final
  if (intro === '[') {
    if (partial.length < 3) return false;
    const last = partial.charCodeAt(partial.length - 1);
    return last >= 0x40 && last <= 0x7e;
  }
  // OSC: ESC ] … BEL or ST (ESC \)
  if (intro === ']') {
    return partial.endsWith('\x07') || partial.endsWith('\x1b\\');
  }
  // Two-byte Fe escapes (not CSI/OSC introducers).
  if (partial.length === 2) {
    const code = partial.charCodeAt(1);
    return code >= 0x40 && code <= 0x5f;
  }
  const last = partial.charCodeAt(partial.length - 1);
  return last >= 0x40 && last <= 0x7e;
}

/**
 * Prefer not to cut mid CSI/OSC escape sequence. Returns an index in
 * `(0, limit]` for a partial take; if the whole limit is an incomplete
 * sequence, returns `limit` so a single giant incomplete ESC cannot stall
 * the drain forever.
 */
export function safeOutputSplitIndex(data: string, limit: number): number {
  if (limit <= 0) return 0;
  if (data.length <= limit) return data.length;
  const split = limit;
  const esc = data.lastIndexOf('\x1b', split - 1);
  if (esc === -1 || esc < split - 64) {
    return split;
  }
  const partial = data.slice(esc, split);
  if (isCompleteEscapePrefix(partial)) {
    return split;
  }
  // Incomplete escape — cut before ESC when possible.
  if (esc === 0) {
    return split;
  }
  return esc;
}

function takeQueuedChunk(entry: QueueEntry, limit: number): QueuedWrite | null {
  let remaining = limit;
  let data = '';
  let foreground: boolean | null = null;
  const parsedCallbacks: TerminalOutputParsedCallback[] = [];

  while (remaining > 0 && entry.chunkIndex < entry.chunks.length) {
    const chunk = entry.chunks[entry.chunkIndex];
    if (foreground !== null && chunk.foreground !== foreground) {
      break;
    }
    foreground ??= chunk.foreground;
    if (chunk.data.length <= remaining) {
      data += chunk.data;
      remaining -= chunk.data.length;
      entry.queuedChars -= chunk.data.length;
      entry.chunkIndex += 1;
      if (chunk.onParsed) parsedCallbacks.push(chunk.onParsed);
      continue;
    }

    const take = safeOutputSplitIndex(chunk.data, remaining);
    if (take <= 0) {
      break;
    }
    data += chunk.data.slice(0, take);
    if (chunk.onParsed) parsedCallbacks.push(chunk.onParsed);
    entry.chunks[entry.chunkIndex] = {
      ...chunk,
      data: chunk.data.slice(take),
    };
    entry.queuedChars -= take;
    remaining = 0;
  }

  compactConsumedChunks(entry);
  if (entry.queuedChars < 0) entry.queuedChars = 0;
  recordQueueDebugPressure();
  return data
    ? {
        data,
        foreground: foreground === true,
        onParsed:
          parsedCallbacks.length > 0
            ? () => {
                for (const callback of parsedCallbacks) callback();
              }
            : undefined,
      }
    : null;
}

function enqueueChunk(
  entry: QueueEntry,
  data: string,
  options?: {
    foreground?: boolean;
    onParsed?: TerminalOutputParsedCallback;
  },
): void {
  entry.chunks.push({
    data,
    foreground: options?.foreground === true,
    onParsed: options?.onParsed,
  });
  entry.queuedChars += data.length;
  recordQueueDebugPressure();
}

function replaceBacklogWithWarning(entry: QueueEntry): void {
  const shouldNotify = !entry.backgroundBacklogDropped;
  clearForegroundHoldSafety(entry);
  entry.chunks = [
    {
      data: BACKGROUND_BACKLOG_WARNING,
      foreground: false,
    },
  ];
  entry.chunkIndex = 0;
  entry.queuedChars = BACKGROUND_BACKLOG_WARNING.length;
  entry.backgroundBacklogDropped = true;
  entry.highPriority = true;
  entry.foregroundHold = false;
  if (debugEnabled && shouldNotify) {
    debugState.droppedBacklogCount++;
  }
  clearForegroundCoalesce(entry);
  recordQueueDebugPressure();
  if (shouldNotify) {
    entry.onBackgroundBacklogDropped?.();
  }
}

function hasQueuedChunks(entry: QueueEntry): boolean {
  return entry.chunkIndex < entry.chunks.length;
}

function hasHighPriorityBacklog(): boolean {
  for (const entry of queuedByTerminal.values()) {
    if (
      isEntryDrainable(entry) &&
      (entry.highPriority || entry.queuedChars > LARGE_BACKLOG_CHARS)
    ) {
      return true;
    }
  }
  return false;
}

function hasDrainableBacklog(): boolean {
  for (const entry of queuedByTerminal.values()) {
    if (isEntryDrainable(entry)) return true;
  }
  return false;
}

function writeSinkChunk(
  terminal: TerminalOutputSink,
  data: string,
  onParsed?: TerminalOutputParsedCallback,
): void {
  if (!onParsed) {
    terminal.write(data);
    return;
  }
  let settled = false;
  const done = (): void => {
    if (settled) return;
    settled = true;
    onParsed();
  };
  // Prefer xterm's post-parse callback when the sink accepts a 2nd argument.
  // Arity-1 sinks (or mocks that drop the callback) settle synchronously.
  terminal.write(data, done);
  if (terminal.write.length < 2) {
    done();
  }
}

function takeNextDrainableEntry(): QueueEntry | null {
  for (const entry of queuedByTerminal.values()) {
    if (!isEntryDrainable(entry)) continue;
    queuedByTerminal.delete(entry.terminal);
    return entry;
  }
  return null;
}

function writeQueuedChunk(entry: QueueEntry): 'foreground' | 'background' | null {
  const queuedWrite = takeQueuedChunk(entry, BACKGROUND_CHUNK_CHARS);
  if (!queuedWrite) return null;
  try {
    entry.beforeWrite?.(queuedWrite.data);
    writeSinkChunk(entry.terminal, queuedWrite.data, queuedWrite.onParsed);
  } catch {
    // Dispose races: drop this entry rather than crashing other panes.
    entry.chunks.length = 0;
    entry.chunkIndex = 0;
    entry.queuedChars = 0;
    clearForegroundHoldSafety(entry);
    clearForegroundCoalesce(entry);
    recordQueueDebugPressure();
    return null;
  }
  return queuedWrite.foreground ? 'foreground' : 'background';
}

function getDrainNow(): number {
  if (typeof performance !== 'undefined') {
    return performance.now();
  }
  return Date.now();
}

function drainQueuedOutput(): void {
  drainTimer = null;
  drainTimerDelayMs = null;
  let writes = 0;
  const startedAt = getDrainNow();
  const maxWrites = hasHighPriorityBacklog()
    ? HIGH_PRIORITY_MAX_WRITES_PER_DRAIN
    : MAX_WRITES_PER_DRAIN;

  while (queuedByTerminal.size > 0 && writes < maxWrites) {
    const entry = takeNextDrainableEntry();
    if (!entry) break;

    const writeKind = writeQueuedChunk(entry);
    if (writeKind) {
      writes++;
      if (debugEnabled) {
        if (writeKind === 'foreground') {
          debugState.deferredForegroundWriteCount++;
        } else {
          debugState.backgroundWriteCount++;
        }
      }
    }
    if (hasQueuedChunks(entry)) {
      queuedByTerminal.set(entry.terminal, entry);
    } else {
      entry.highPriority = false;
      clearForegroundCoalesce(entry);
      clearForegroundHoldSafety(entry);
    }
    if (writes > 0 && getDrainNow() - startedAt >= DRAIN_TIME_BUDGET_MS) {
      break;
    }
  }

  if (debugEnabled && writes > 0) {
    debugState.drainWrites.push(writes);
  }
  recordQueueDebugPressure();
  if (queuedByTerminal.size > 0 && hasDrainableBacklog()) {
    scheduleDrain(
      hasHighPriorityBacklog()
        ? HIGH_PRIORITY_DRAIN_INTERVAL_MS
        : BACKGROUND_DRAIN_INTERVAL_MS,
    );
  }
}

/**
 * Route terminal PTY output through the shared scheduler.
 * Foreground writes prefer immediate delivery; background panes queue and
 * share a cooperative drain so one flood cannot pin the renderer.
 */
export function writeTerminalOutput(
  terminal: TerminalOutputSink,
  data: string,
  options: WriteTerminalOutputOptions,
): void {
  if (!data) return;

  if (options.foreground) {
    const entry = queuedByTerminal.get(terminal);
    if (entry?.highPriority || options.coalesceForeground || options.holdForeground) {
      const queued = entry ?? createQueueEntry(terminal, options);
      queued.beforeWrite = options.beforeWrite;
      queued.onBackgroundBacklogDropped = options.onBackgroundBacklogDropped;
      queued.highPriority = true;
      queuedByTerminal.set(terminal, queued);
      enqueueChunk(queued, data, {
        foreground: true,
        onParsed: options.onParsed,
      });
      if (debugEnabled) {
        debugState.foregroundWriteCount++;
        debugState.deferredForegroundEnqueueCount++;
      }
      if (options.holdForeground) {
        if (options.latencySensitive === true) {
          queued.foregroundHoldSafetyDelayMs = Math.min(
            queued.foregroundHoldSafetyDelayMs,
            LATENCY_SENSITIVE_FOREGROUND_HOLD_SAFETY_DELAY_MS,
          );
        } else if (!queued.foregroundHold) {
          queued.foregroundHoldSafetyDelayMs = FOREGROUND_HOLD_SAFETY_DELAY_MS;
        }
        queued.foregroundHold = true;
        clearForegroundCoalesce(queued);
        scheduleForegroundHoldSafety(queued);
        return;
      }
      if (options.coalesceForeground || queued.foregroundCoalesce) {
        queued.foregroundHold = false;
        clearForegroundHoldSafety(queued);
        const latencySensitive = options.latencySensitive === true;
        if (latencySensitive) {
          queued.foregroundCoalesceDelayMs = Math.min(
            queued.foregroundCoalesceDelayMs,
            LATENCY_SENSITIVE_FOREGROUND_COALESCE_DELAY_MS,
          );
        }
        if (containsDrainableCursorRestore(data) || latencySensitive) {
          clearForegroundCoalesce(queued);
          scheduleDrain(0);
          return;
        }
        scheduleForegroundCoalesceRelease(queued, {
          rescheduleEarlier: latencySensitive,
        });
        return;
      }
      queued.foregroundHold = false;
      clearForegroundCoalesce(queued);
      clearForegroundHoldSafety(queued);
      scheduleDrain(0);
      return;
    }
    if (entry && entry.queuedChars > SYNC_FOREGROUND_FLUSH_CHARS) {
      entry.beforeWrite = options.beforeWrite;
      entry.highPriority = true;
      enqueueChunk(entry, data, {
        foreground: true,
        onParsed: options.onParsed,
      });
      if (debugEnabled) {
        debugState.foregroundWriteCount++;
        debugState.deferredForegroundEnqueueCount++;
      }
      scheduleDrain(0);
      return;
    }
    if (options.latencySensitive === false) {
      let queued = entry;
      if (!queued) {
        queued = createQueueEntry(terminal, options);
        queuedByTerminal.set(terminal, queued);
      } else {
        queued.beforeWrite = options.beforeWrite;
        queued.onBackgroundBacklogDropped = options.onBackgroundBacklogDropped;
        queued.highPriority = true;
      }
      enqueueChunk(queued, data, {
        foreground: true,
        onParsed: options.onParsed,
      });
      if (debugEnabled) {
        debugState.foregroundWriteCount++;
        debugState.deferredForegroundEnqueueCount++;
      }
      scheduleDrain(0);
      return;
    }
    flushTerminalOutput(terminal);
    if (debugEnabled) {
      debugState.foregroundWriteCount++;
    }
    options.beforeWrite?.(data);
    writeSinkChunk(terminal, data, options.onParsed);
    return;
  }

  let bgEntry = queuedByTerminal.get(terminal);
  if (!bgEntry) {
    bgEntry = createQueueEntry(terminal, options);
    bgEntry.highPriority = false;
    queuedByTerminal.set(terminal, bgEntry);
  } else {
    bgEntry.beforeWrite = options.beforeWrite;
    bgEntry.onBackgroundBacklogDropped = options.onBackgroundBacklogDropped;
  }
  enqueueChunk(bgEntry, data, { onParsed: options.onParsed });
  if (
    bgEntry.queuedChars > MAX_BACKGROUND_QUEUE_CHARS ||
    bgEntry.chunks.length - bgEntry.chunkIndex > MAX_BACKGROUND_QUEUE_CHUNKS
  ) {
    replaceBacklogWithWarning(bgEntry);
  }
  if (debugEnabled) {
    debugState.backgroundEnqueueCount++;
  }
  scheduleDrain(
    bgEntry.highPriority || bgEntry.queuedChars > LARGE_BACKLOG_CHARS
      ? 0
      : BACKGROUND_FLUSH_DELAY_MS,
  );
}

/** Drain all queued output for a terminal (or up to maxChars). */
export function flushTerminalOutput(
  terminal: TerminalOutputSink,
  options?: { maxChars?: number },
): void {
  const entry = queuedByTerminal.get(terminal);
  if (!entry) return;
  queuedByTerminal.delete(terminal);
  if (!isEntryDrainable(entry)) {
    queuedByTerminal.set(terminal, entry);
    return;
  }

  let flushedChars = 0;
  let queuedWrite = takeQueuedChunk(entry, BACKGROUND_CHUNK_CHARS);
  while (queuedWrite) {
    flushedChars += queuedWrite.data.length;
    if (debugEnabled) {
      debugState.flushWriteCount++;
    }
    try {
      entry.beforeWrite?.(queuedWrite.data);
      writeSinkChunk(terminal, queuedWrite.data, queuedWrite.onParsed);
    } catch {
      clearForegroundHoldSafety(entry);
      clearForegroundCoalesce(entry);
      recordQueueDebugPressure();
      return;
    }
    if (options?.maxChars !== undefined && flushedChars >= options.maxChars) {
      break;
    }
    queuedWrite = takeQueuedChunk(entry, BACKGROUND_CHUNK_CHARS);
  }
  if (hasQueuedChunks(entry)) {
    entry.highPriority = true;
    queuedByTerminal.set(terminal, entry);
    scheduleDrain(0);
  } else {
    entry.highPriority = false;
    clearForegroundCoalesce(entry);
    clearForegroundHoldSafety(entry);
  }
  recordQueueDebugPressure();
}

/** Drop queued output for a disposed terminal. */
export function discardTerminalOutput(terminal: TerminalOutputSink): void {
  const entry = queuedByTerminal.get(terminal);
  if (entry) {
    clearForegroundHoldSafety(entry);
    clearForegroundCoalesce(entry);
  }
  queuedByTerminal.delete(terminal);
  recordQueueDebugPressure();
}

/** Queued char count for a sink (tests / benchmarks). */
export function getQueuedChars(terminal: TerminalOutputSink): number {
  return queuedByTerminal.get(terminal)?.queuedChars ?? 0;
}

/** Reset all module state (tests only). */
export function resetTerminalOutputSchedulerForTests(): void {
  if (drainTimer !== null) {
    clearTimeout(drainTimer);
    drainTimer = null;
    drainTimerDelayMs = null;
  }
  for (const entry of queuedByTerminal.values()) {
    clearForegroundHoldSafety(entry);
    clearForegroundCoalesce(entry);
  }
  queuedByTerminal.clear();
  resetTerminalOutputSchedulerDebug();
}
