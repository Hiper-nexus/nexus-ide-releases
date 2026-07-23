import type { PaneRegistryEntry, PaneSnapshot } from "../../shared/orch-types";
import type { PaneSessionState } from "../../shared/types";
import { getSessionState } from "../pty/pty-manager";

const RING_BUFFER_CAP = 262_144;
const EXITED_BUFFER_TTL_MS = 5 * 60_000;

interface RingBuffer {
  chunks: string[];
  size: number;
  exited: boolean;
  exitedAt?: number;
  stripCache?: { key: string; text: string };
}

interface IdleWaiter {
  sessionId: string;
  resolve: (state: "idle" | "exited") => void;
  timer?: ReturnType<typeof setTimeout>;
}

const buffers = new Map<string, RingBuffer>();
const sessionStates = new Map<string, PaneSessionState>();
const idleWaiters = new Set<IdleWaiter>();

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
    idleWaiters.delete(waiter);
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.resolve("idle");
  }
}

export function recordPaneSessionExit(sessionId: string): void {
  sessionStates.delete(sessionId);
  const buffer = buffers.get(sessionId);
  if (buffer) {
    buffer.exited = true;
    buffer.exitedAt = Date.now();
  }
  for (const waiter of [...idleWaiters]) {
    if (waiter.sessionId !== sessionId) continue;
    idleWaiters.delete(waiter);
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.resolve("exited");
  }
}

export function paneSessionStateForEntry(
  entry: PaneRegistryEntry,
): PaneSnapshot["state"] {
  if (!entry.sessionId) return entry.state ?? "unknown";
  const live =
    sessionStates.get(entry.sessionId) ?? getSessionState(entry.sessionId);
  if (live) return live;
  return buffers.get(entry.sessionId)?.exited
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
): Promise<"idle" | "exited" | "timeout"> {
  const current = sessionStates.get(sessionId) ?? getSessionState(sessionId);
  if (current === "idle") return Promise.resolve("idle");
  if (current === null || current === undefined) {
    return Promise.resolve(
      buffers.get(sessionId)?.exited ? "exited" : "timeout",
    );
  }
  return new Promise((resolve) => {
    const waiter: IdleWaiter = { sessionId, resolve };
    idleWaiters.add(waiter);
    waiter.timer = setTimeout(() => {
      if (idleWaiters.delete(waiter)) resolve("timeout");
    }, timeoutMs);
  });
}
