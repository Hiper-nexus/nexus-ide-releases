import type { PaneRegistryEntry, PaneSnapshot } from "../../shared/orch-types";
import type { PaneSessionState } from "../../shared/types";
import { getSessionState } from "../pty/pty-manager";

const RING_BUFFER_CAP = 262_144;
const EXITED_BUFFER_TTL_MS = 30 * 60_000;

interface RingBuffer {
  chunks: string[];
  size: number;
  exited: boolean;
  exitedAt?: number;
  stripCache?: { key: string; text: string };
}

interface IdleWaiter {
  sessionId: string;
  resolve: (state: "idle" | "exited" | "timeout") => void;
  reject: (reason?: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
  abortCleanup?: () => void;
}

const buffers = new Map<string, RingBuffer>();
const sessionStates = new Map<string, PaneSessionState>();
const idleWaiters = new Set<IdleWaiter>();
/** Marca permanente de sessão morta — o buffer sai em 5min, a marca não. */
const exitedMarkBySession = new Map<string, number>();
const EXITED_MARK_CAP = 8_192;

/** Test-only: simula a evicção do ring após o TTL de sessão morta. */
export function __evictExitedBufferForTests(sessionId: string): void {
  buffers.delete(sessionId);
}

function idleWaitAbortFallback(): Error {
  const error = new Error("pane idle wait was aborted");
  error.name = "AbortError";
  return error;
}

function settleIdleWaiter(
  waiter: IdleWaiter,
  state: "idle" | "exited" | "timeout",
): void {
  if (!idleWaiters.delete(waiter)) return;
  if (waiter.timer) clearTimeout(waiter.timer);
  waiter.abortCleanup?.();
  waiter.resolve(state);
}

// Retain dead-session output briefly for delayed handoffs, then release it.
setInterval(() => {
  const cutoff = Date.now() - EXITED_BUFFER_TTL_MS;
  for (const [sessionId, buffer] of buffers) {
    if (buffer.exited && (buffer.exitedAt ?? 0) < cutoff) {
      buffers.delete(sessionId);
    }
  }
}, 60_000).unref();

export function recordPaneSessionData(sessionId: string, data: string): void {
  let buffer = buffers.get(sessionId);
  if (!buffer) {
    buffer = { chunks: [], size: 0, exited: false };
    buffers.set(sessionId, buffer);
  }
  buffer.chunks.push(data);
  buffer.size += data.length;
  while (buffer.size > RING_BUFFER_CAP && buffer.chunks.length > 1) {
    buffer.size -= buffer.chunks[0].length;
    buffer.chunks.shift();
  }
}

export function recordPaneSessionState(
  sessionId: string,
  state: PaneSessionState,
): void {
  sessionStates.set(sessionId, state);
  if (state !== "idle") return;
  for (const waiter of [...idleWaiters]) {
    if (waiter.sessionId !== sessionId) continue;
    settleIdleWaiter(waiter, "idle");
  }
}

export function recordPaneSessionExit(sessionId: string): void {
  sessionStates.delete(sessionId);
  const buffer = buffers.get(sessionId);
  if (buffer) {
    buffer.exited = true;
    buffer.exitedAt = Date.now();
  }
  // A marca de morte é INDEPENDENTE do buffer: o ring sai após
  // EXITED_BUFFER_TTL_MS (5min) e, sem ela, paneSessionStateForEntry caía de
  // volta pro último entry.state ('idle') — pane morto ressuscitava como
  // vivo no snapshot e o watcher da Via Rápida nunca via livePanes===0
  // (missão "running" pra sempre com processo nenhum). Cap FIFO: uma
  // timestamp por sessão que já existiu, nunca cresce além disto.
  exitedMarkBySession.set(sessionId, Date.now());
  if (exitedMarkBySession.size > EXITED_MARK_CAP) {
    const oldest = exitedMarkBySession.keys().next().value;
    if (oldest !== undefined) exitedMarkBySession.delete(oldest);
  }
  for (const waiter of [...idleWaiters]) {
    if (waiter.sessionId !== sessionId) continue;
    settleIdleWaiter(waiter, "exited");
  }
}

export function paneSessionStateForEntry(
  entry: PaneRegistryEntry,
): PaneSnapshot["state"] {
  if (!entry.sessionId) return entry.state ?? "unknown";
  const live =
    sessionStates.get(entry.sessionId) ?? getSessionState(entry.sessionId);
  if (live) return live;
  if (buffers.get(entry.sessionId)?.exited) return "exited";
  // Sobrevive à evicção do buffer: morte de pane é permanente.
  return exitedMarkBySession.has(entry.sessionId)
    ? "exited"
    : (entry.state ?? "unknown");
}

// CSI sequences, OSC sequences, remaining lone escapes, then control bytes.
/* eslint-disable no-control-regex */
const CSI_PATTERN = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;
const OSC_PATTERN = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ESC_PATTERN = /\x1b[@-_]/g;
const CONTROL_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
/* eslint-enable no-control-regex */

export function stripAnsi(raw: string): string {
  return raw
    .replace(OSC_PATTERN, "")
    .replace(CSI_PATTERN, "")
    .replace(ESC_PATTERN, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(CONTROL_PATTERN, "");
}

export function readSessionOutput(sessionId: string, lines = 200): string {
  const buffer = buffers.get(sessionId);
  if (!buffer) return "";
  const key = `${buffer.chunks.length}:${buffer.size}`;
  if (buffer.stripCache?.key !== key) {
    buffer.stripCache = { key, text: stripAnsi(buffer.chunks.join("")) };
  }
  const allLines = buffer.stripCache.text.split("\n");
  return allLines.slice(Math.max(0, allLines.length - lines)).join("\n");
}

export function sessionOutputExitedAt(sessionId: string): number | null {
  const buffer = buffers.get(sessionId);
  return buffer?.exited ? (buffer.exitedAt ?? null) : null;
}

export function waitForIdle(
  sessionId: string,
  timeoutMs = 120_000,
  signal?: AbortSignal,
): Promise<"idle" | "exited" | "timeout"> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? idleWaitAbortFallback());
  }
  const current = sessionStates.get(sessionId) ?? getSessionState(sessionId);
  if (current === "idle") return Promise.resolve("idle");
  if (current === null || current === undefined) {
    return Promise.resolve(
      buffers.get(sessionId)?.exited ? "exited" : "timeout",
    );
  }
  return new Promise((resolve, reject) => {
    const waiter: IdleWaiter = { sessionId, resolve, reject };
    idleWaiters.add(waiter);
    waiter.timer = setTimeout(() => {
      settleIdleWaiter(waiter, "timeout");
    }, timeoutMs);
    if (signal) {
      const onAbort = () => {
        if (!idleWaiters.delete(waiter)) return;
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.abortCleanup?.();
        waiter.reject(signal.reason ?? idleWaitAbortFallback());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      waiter.abortCleanup = () =>
        signal.removeEventListener("abort", onAbort);
      if (signal.aborted) onAbort();
    }
  });
}
