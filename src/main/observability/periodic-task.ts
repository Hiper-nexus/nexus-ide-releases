import { performance } from 'node:perf_hooks';

/** Cooperative CPU budget. Cancellation never detaches a physical IO flight. */
export interface PeriodicTaskContext {
  readonly signal: AbortSignal;
  checkpoint(): Promise<void>;
  wait<T>(promise: Promise<T>): Promise<T>;
  assertCurrent(): void;
}

export interface PeriodicTaskOptions {
  readonly timeoutMs?: number;
  readonly sliceMs?: number;
  readonly signal?: AbortSignal;
  readonly cadenceMs?: number;
}

/** Adapts an existing timer; keeps that timer's cadence and owns its real flight. */
export function periodicCallback(
  id: string,
  run: (context: PeriodicTaskContext) => void | Promise<void>,
  options: PeriodicTaskOptions = {},
): () => void {
  return () => { void runPeriodicTask(id, run, options).catch(() => {
    // No exception text: tasks may carry credentials or file contents.
    if (!options.signal?.aborted) console.warn(`[periodic] ${publicName(id)} did not complete`);
  }); };
}

export interface PeriodicTaskDiagnostic {
  readonly name: string;
  readonly owner: 'main';
  readonly cadenceMs: number | null;
  readonly budgetMs: number;
  readonly instances: number;
  readonly running: number;
  readonly lastStartedAt: number;
  readonly lastCompletedAt: number | null;
  readonly lastYieldAt: number | null;
  readonly sliceMsMax: number;
  readonly steps: number;
  readonly skippedTicks: number;
  readonly waitingIo: number;
  readonly stopped: boolean;
}

interface TaskState {
  readonly name: string;
  readonly controller: AbortController;
  flight: Promise<void> | null;
  diagnostic: PeriodicTaskDiagnostic;
}

/** A slow report plus the same-name runs folded into it since the previous report. */
export interface PeriodicTaskSlowReport extends PeriodicTaskDiagnostic {
  readonly suppressed: number;
  readonly suppressedMaxSliceMs: number;
}

const states = new Map<string, TaskState>();
const MAX_IDLE_HISTORY = 64;
/**
 * Every task that starts in the same tick measures the same event-loop stall
 * (one worker shim per agent made 7 identical rows per tick). One report per
 * task name per window; the rest is only counted. The event-loop monitor
 * already carries the loop-level truth, so a minute is enough: at 5 s the
 * `periodic-task-slow` rows were 95% of the rotated trace (~7 days).
 */
export const SLOW_REPORT_MIN_INTERVAL_MS = 60_000;
const slowReportWindows = new Map<string, { lastAt: number; suppressed: number; suppressedMaxSliceMs: number }>();
let slowSink: ((report: PeriodicTaskSlowReport) => void) | null = null;

/** Sink must be nonrecursive and nonblocking. No error text or instance IDs. */
export function configurePeriodicTaskSlowSink(sink: typeof slowSink): void {
  slowSink = sink;
  slowReportWindows.clear();
}

function reportSlowRun(diagnostic: PeriodicTaskDiagnostic): void {
  const now = Date.now();
  const window = slowReportWindows.get(diagnostic.name);
  if (window && now - window.lastAt < SLOW_REPORT_MIN_INTERVAL_MS) {
    window.suppressed += 1;
    window.suppressedMaxSliceMs = Math.max(window.suppressedMaxSliceMs, diagnostic.sliceMsMax);
    return;
  }
  slowReportWindows.set(diagnostic.name, { lastAt: now, suppressed: 0, suppressedMaxSliceMs: 0 });
  try {
    slowSink?.(Object.freeze({
      ...diagnostic,
      suppressed: window?.suppressed ?? 0,
      suppressedMaxSliceMs: window?.suppressedMaxSliceMs ?? 0,
    }));
  } catch { /* Diagnostics are isolated. */ }
}

function publicName(id: string): string {
  const name = id.split(':', 1)[0];
  return /^[a-z][a-z0-9-]{0,63}$/.test(name) ? name : 'periodic-task';
}

function trimIdleHistory(): void {
  let idle = 0;
  for (const state of states.values()) if (!state.flight) idle++;
  for (const [id, state] of states) {
    if (idle <= MAX_IDLE_HISTORY) break;
    if (!state.flight) { states.delete(id); idle--; }
  }
}

export function runPeriodicTask(
  id: string,
  run: (context: PeriodicTaskContext) => void | Promise<void>,
  options: PeriodicTaskOptions = {},
): Promise<void> {
  const previous = states.get(id);
  if (previous?.flight) {
    previous.diagnostic = { ...previous.diagnostic, skippedTicks: previous.diagnostic.skippedTicks + 1 };
    return previous.flight;
  }
  const sliceMs = options.sliceMs ?? 20;
  if (!Number.isFinite(sliceMs) || sliceMs < 0) throw new Error('invalid periodic CPU slice');
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error('invalid periodic timeout');
  }
  const controller = new AbortController();
  const state: TaskState = {
    name: publicName(id), controller, flight: null,
    diagnostic: {
      name: publicName(id), owner: 'main', cadenceMs: options.cadenceMs ?? null,
      budgetMs: sliceMs, instances: 1, running: 1, lastStartedAt: Date.now(),
      lastCompletedAt: previous?.diagnostic.lastCompletedAt ?? null,
      lastYieldAt: null, sliceMsMax: 0, steps: 0,
      skippedTicks: previous?.diagnostic.skippedTicks ?? 0, waitingIo: 0, stopped: false,
    },
  };
  states.set(id, state);
  const waits = new Set<Promise<unknown>>();
  // A slice is CPU: the synchronous run (microtasks included) since the last
  // checkpoint or wait. A bare `await` on I/O outside `wait()` used to count
  // its whole wait as CPU (the fast-lane tick awaiting a delivery check
  // reported seconds of "slice" every run; 95% of the trace). A one-shot
  // setImmediate marks the first time the event loop ran a macrotask after
  // the slice started: only the run before that yield is CPU. Never re-armed
  // while waiting, so it cannot spin the loop.
  let sliceStartedAt = performance.now();
  let yieldedAt: number | null = null;
  let yieldProbe: ReturnType<typeof setImmediate> | null = null;
  const startSlice = () => {
    sliceStartedAt = performance.now();
    yieldedAt = null;
    if (yieldProbe === null) {
      yieldProbe = setImmediate(() => { yieldProbe = null; yieldedAt ??= performance.now(); });
    }
  };
  startSlice();
  const assertCurrent = () => {
    if (controller.signal.aborted) throw controller.signal.reason ?? new Error('periodic task aborted');
    if (states.get(id) !== state) throw new Error('periodic task superseded');
  };
  const measureSlice = () => {
    const yielded = yieldedAt !== null;
    const elapsed = Math.max(0, (yieldedAt ?? performance.now()) - sliceStartedAt);
    state.diagnostic = { ...state.diagnostic, sliceMsMax: Math.max(state.diagnostic.sliceMsMax, elapsed) };
    // After a yield the rest of the wall time was waiting: the next slice
    // starts now (the run right after resuming is not attributed).
    if (yielded) startSlice();
    return elapsed;
  };
  const context: PeriodicTaskContext = {
    signal: controller.signal,
    assertCurrent,
    async checkpoint() {
      assertCurrent();
      state.diagnostic = { ...state.diagnostic, steps: state.diagnostic.steps + 1 };
      if (measureSlice() >= sliceMs) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        assertCurrent();
        state.diagnostic = { ...state.diagnostic, lastYieldAt: Date.now() };
        startSlice();
      }
    },
    wait<T>(promise: Promise<T>): Promise<T> {
      // A supplied promise has already launched: always observe its physical
      // settlement, even if cancellation occurred immediately before this call.
      measureSlice();
      state.diagnostic = { ...state.diagnostic, waitingIo: state.diagnostic.waitingIo + 1 };
      const wait = (async () => {
        try {
          const result = await promise;
          assertCurrent();
          return result;
        } finally {
          state.diagnostic = { ...state.diagnostic, waitingIo: state.diagnostic.waitingIo - 1 };
          startSlice();
        }
      })();
      waits.add(wait);
      void wait.then(() => waits.delete(wait), () => waits.delete(wait));
      return wait;
    },
  };
  const abort = () => controller.abort(options.signal?.reason ?? new Error('periodic task aborted'));
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener('abort', abort, { once: true });
  let timeout: ReturnType<typeof setTimeout> | null = null;
  if (options.timeoutMs !== undefined) {
    timeout = setTimeout(() => {
      const error = new Error('periodic task timed out');
      error.name = 'TimeoutError';
      controller.abort(error);
    }, options.timeoutMs);
    timeout.unref?.();
  }
  // Install admission before invoking user code, including synchronous reentry.
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const flight = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  state.flight = flight;
  const settle = async (error?: unknown, failed = false) => {
    // Promise.all can reject while a sibling wait is physically pending.
    // Every registered IO flight belongs to this run, even on callback error.
    while (waits.size) await Promise.allSettled([...waits]);
    if (!failed) {
      try { assertCurrent(); } catch (currentError) { error = currentError; failed = true; }
    }
    measureSlice();
    if (yieldProbe !== null) { clearImmediate(yieldProbe); yieldProbe = null; }
    if (timeout) clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
    state.flight = null;
    state.diagnostic = { ...state.diagnostic, running: 0, lastCompletedAt: Date.now() };
    if (state.diagnostic.sliceMsMax > sliceMs && slowSink) reportSlowRun(state.diagnostic);
    trimIdleHistory();
    if (failed) reject(error); else resolve();
  };
  try {
    assertCurrent();
    Promise.resolve(run(context)).then(() => {
      void settle();
    }, (error) => { void settle(error, true); });
  } catch (error) { void settle(error, true); }
  return flight;
}

/** Stop admission in the caller first. Keep stores alive until this settles. */
export async function stopPeriodicTask(id: string): Promise<void> {
  const state = states.get(id);
  if (!state) return;
  state.diagnostic = { ...state.diagnostic, stopped: true };
  state.controller.abort(new Error('periodic task stopped'));
  await state.flight?.catch(() => undefined);
  if (states.get(id) === state) states.delete(id);
}

export function periodicTaskSnapshot(): {
  readonly sampledAt: number;
  readonly tasks: readonly PeriodicTaskDiagnostic[];
  readonly omittedCount: number;
} {
  const groups = new Map<string, PeriodicTaskDiagnostic>();
  for (const state of states.values()) {
    const d = state.diagnostic;
    const old = groups.get(state.name);
    groups.set(state.name, old ? {
      ...d, instances: old.instances + 1, running: old.running + d.running,
      lastStartedAt: Math.max(old.lastStartedAt, d.lastStartedAt),
      lastCompletedAt: Math.max(old.lastCompletedAt ?? 0, d.lastCompletedAt ?? 0) || null,
      lastYieldAt: Math.max(old.lastYieldAt ?? 0, d.lastYieldAt ?? 0) || null,
      sliceMsMax: Math.max(old.sliceMsMax, d.sliceMsMax), steps: old.steps + d.steps,
      skippedTicks: old.skippedTicks + d.skippedTicks, waitingIo: old.waitingIo + d.waitingIo,
      stopped: old.stopped && d.stopped,
    } : { ...d });
  }
  const tasks = [...groups.values()].sort((a, b) => b.running - a.running || a.name.localeCompare(b.name));
  return Object.freeze({ sampledAt: Date.now(), tasks: Object.freeze(tasks.slice(0, 64).map((task) => Object.freeze(task))), omittedCount: Math.max(0, tasks.length - 64) });
}
