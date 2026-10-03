/** Bounded Main diagnostics. File IO and rotation never run synchronously on the caller. */
import { join } from 'node:path';
import { TraceFileSink } from './trace-file-sink';

export const TRACE_ROTATION_BYTES = 5 * 1024 * 1024;
export const TRACE_ROTATION_GENERATIONS = 3;
const SENSITIVE_KEY_RE = /key|token|secret|password|authorization|bearer|credential/i;

/** Bounded redaction also handles cycles and excessive depth without exposing their leaves. */
export function redactSecrets(value: unknown, depth = 0, budget = { left: 256 }, seen = new WeakSet<object>()): unknown {
  if (--budget.left < 0 || depth > 6) return '[truncated]';
  if (typeof value === 'string') return value.length > 4096 ? `${value.slice(0, 4096)}[truncated]` : value;
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 64).map(item => redactSecrets(item, depth + 1, budget, seen));
  const out: Record<string, unknown> = {};
  let keys = 0;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (++keys > 64 || budget.left <= 0) { out.truncated = true; break; }
    out[key] = SENSITIVE_KEY_RE.test(key) ? '[redacted]' : redactSecrets((value as Record<string, unknown>)[key], depth + 1, budget, seen);
  }
  return out;
}

export function formatTraceLine(event: Record<string, unknown>, at: number): string {
  return `${JSON.stringify({ ...event, at })}\n`;
}
export function shouldRotate(sizeBytes: number): boolean { return sizeBytes >= TRACE_ROTATION_BYTES; }

const recent: Readonly<Record<string, string | number | boolean>>[] = [];
const sinks = new Map<string, TraceFileSink>();
let directoryOverride: string | null = null;
export function setTraceDirectory(dir: string | null): void { directoryOverride = dir; }
function resolveUserDataDir(): string | null {
  if (directoryOverride) return directoryOverride;
  try {
    const electron = require('electron') as typeof import('electron');
    return electron.app?.getPath?.('userData') ?? null;
  } catch { return null; }
}
export function getTraceFilePath(): string | null {
  const root = resolveUserDataDir();
  return root ? join(root, 'logs', 'main.trace.ndjson') : null;
}

/** Long-lived history and hang context contain labels, counters and Main IDs only. */
export function traceContextEvent(event: Record<string, unknown>, at: number): Readonly<Record<string, string | number | boolean>> {
  const kind = typeof event.kind === 'string' && /^[a-zA-Z][a-zA-Z0-9:_-]{0,95}$/.test(event.kind) ? event.kind : 'event';
  const out: Record<string, string | number | boolean> = { kind, at };
  for (const key of ['sessionId', 'paneId', 'missionId', 'taskId', 'workerId']) {
    const value = event[key];
    if (typeof value === 'string' && /^(?:[a-f0-9-]{16,64}|(?:pty|pane|session|mission|task|worker)-[a-z0-9-]{1,96})$/i.test(value)) out[key] = value;
  }
  for (const key of ['adapterId', 'phase', 'status', 'name', 'origin', 'signal']) {
    const value = event[key];
    if (typeof value === 'string' && /^[a-z][a-z0-9:_-]{0,63}$/i.test(value)) out[key] = value;
  }
  for (const key of ['durationMs', 'elapsedMs', 'windowMs', 'p50Ms', 'p99Ms', 'maxMs', 'liveAgents', 'bytes', 'count', 'code', 'exitCode', 'signal', 'pendingBytes', 'highwaterBytes', 'dropped']) {
    const value = event[key];
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return Object.freeze(out);
}
export function recentTraceContext(): readonly Readonly<Record<string, string | number | boolean>>[] { return recent.slice(); }
export function mainTraceStatus() {
  return [...sinks.values()].reduce((total, sink) => {
    const stats = sink.stats();
    return { queuedBytes: total.queuedBytes + stats.queuedBytes, dropped: total.dropped + stats.dropped, failed: total.failed || stats.failed };
  }, { queuedBytes: 0, dropped: 0, failed: false });
}
export async function flushMainTrace(): Promise<void> { await Promise.all([...sinks.values()].map(sink => sink.flush())); }

const LIFECYCLE_KIND = /^(?:(?:pty|pane|worker|agent|agent-pty|mission)-(?:spawn|exit|close|terminate|died|start|stop|created|ended|failed)|main-thread-hang|app-shutdown|exact-resume-forgotten)/;
export function trace(event: Record<string, unknown>): void {
  try {
    const at = Date.now();
    const context = traceContextEvent(event, at);
    recent.push(context);
    if (recent.length > 128) recent.shift();
    const root = resolveUserDataDir();
    if (!root) return;
    const dir = join(root, 'logs');
    let sink = sinks.get(dir);
    if (!sink) { sink = new TraceFileSink(dir); sinks.set(dir, sink); }
    sink.enqueue(formatTraceLine(redactSecrets(event) as Record<string, unknown>, at), at,
      LIFECYCLE_KIND.test(String(context.kind)) ? formatTraceLine(context, at) : undefined);
  } catch { /* Diagnostics never throw into product work. */ }
}
