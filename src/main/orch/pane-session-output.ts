import { runPeriodicTask, stopPeriodicTask } from '../observability/periodic-task';
import { analysisClient, isPtyAnalysisEnabled } from '../pty/pty-analysis-runtime';
import type { PaneRegistryEntry, PaneSnapshot } from "../../shared/orch-types";
import type { PaneSessionState } from "../../shared/types";
import { emitAppEvent } from '../connectors/app-events';
import { getSessionState, isOneShotSessionRunning } from "../pty/pty-manager";

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

interface BusyWaiter {
  sessionId: string;
  resolve: (state: "busy" | "exited" | "timeout") => void;
  reject: (reason?: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
  abortCleanup?: () => void;
}

const buffers = new Map<string, RingBuffer>();
const sessionStates = new Map<string, PaneSessionState>();
const idleWaiters = new Set<IdleWaiter>();
const busyWaiters = new Set<BusyWaiter>();
/** Marca permanente de sessão morta — o buffer sai em 5min, a marca não. */
const exitedMarkBySession = new Map<string, number>();
const EXITED_MARK_CAP = 8_192;

/** Test-only: simula a evicção do ring após o TTL de sessão morta. */
export function __evictExitedBufferForTests(sessionId: string): void {
  buffers.delete(sessionId);
}

/**
 * F-918: panes de worker fechados por PEDIDO (orquestrador/operador via
 * `nexus_pane_close`, guardian, watchdog) não morreram sozinhos — a morte
 * deles nunca alimenta o circuit breaker de mortalidade. Marca por paneId
 * (o exit observado chega depois, pela sessão); cap FIFO como as demais.
 */
const deliberatelyClosedPanes = new Map<string, number>();
const DELIBERATE_CLOSE_CAP = 8_192;

export function markPaneDeliberatelyClosed(paneId: string): void {
  const id = paneId.trim();
  if (!id) return;
  deliberatelyClosedPanes.set(id, Date.now());
  if (deliberatelyClosedPanes.size > DELIBERATE_CLOSE_CAP) {
    const oldest = deliberatelyClosedPanes.keys().next().value;
    if (oldest !== undefined) deliberatelyClosedPanes.delete(oldest);
  }
}

/**
 * O pedido de close é fire-and-forget (IPC sem confirmação): a marca só
 * desculpa uma morte cujo exit veio logo depois do pedido. Uma CLI que segue
 * viva (close perdido) e morre sozinha mais tarde conta para o breaker.
 */
export const DELIBERATE_CLOSE_EXIT_WINDOW_MS = 120_000;

export function wasPaneDeliberatelyClosed(paneId: string, exitAt?: number): boolean {
  const markedAt = deliberatelyClosedPanes.get(paneId.trim());
  if (markedAt === undefined) return false;
  if (exitAt === undefined) return true;
  return exitAt >= markedAt - 1_000 && exitAt - markedAt <= DELIBERATE_CLOSE_EXIT_WINDOW_MS;
}

/** Quando o exit desta sessão foi observado neste processo (epoch ms). */
export function paneSessionExitObservedAt(sessionId: string): number | undefined {
  return exitedMarkBySession.get(sessionId.trim());
}

/** Test-only: limpa as marcas de fechamento deliberado entre casos. */
export function __resetDeliberatelyClosedPanesForTests(): void {
  deliberatelyClosedPanes.clear();
}

/**
 * F-918: o exit do PTY foi observado NESTE processo (tap de exit)? Depois
 * de um reinício/shutdown do app, panes mortos pelo fim do processo
 * reaparecem como `exited` no boot seguinte sem nenhum exit observado —
 * e não provam que a CLI saiu sozinha.
 */
export function wasPaneSessionExitObserved(sessionId: string): boolean {
  const id = sessionId.trim();
  if (!id) return false;
  if (exitedMarkBySession.has(id)) return true;
  return buffers.get(id)?.exited === true;
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

function settleBusyWaiter(
  waiter: BusyWaiter,
  state: "busy" | "exited" | "timeout",
): void {
  if (!busyWaiters.delete(waiter)) return;
  if (waiter.timer) clearTimeout(waiter.timer);
  waiter.abortCleanup?.();
  waiter.resolve(state);
}

// Retain dead-session output briefly for delayed handoffs, then release it.
const gcController = new AbortController();
const outputGcTimer = setInterval(() => {
  void runPeriodicTask('pane-output-gc', async (context) => {
    const cutoff = Date.now() - EXITED_BUFFER_TTL_MS;
    for (const sessionId of [...buffers.keys()]) {
      await context.checkpoint();
      const buffer = buffers.get(sessionId);
      if (buffer?.exited && (buffer.exitedAt ?? 0) < cutoff) {
        buffers.delete(sessionId);
        lastOutputAtBySession.delete(sessionId);
      }
    }
  }, { signal: gcController.signal, cadenceMs: 60_000 }).catch(() => undefined);
}, 60_000);
outputGcTimer.unref();

export async function stopPaneSessionOutputGc(): Promise<void> {
  clearInterval(outputGcTimer);
  gcController.abort(new Error('pane output GC stopped'));
  await stopPeriodicTask('pane-output-gc');
}

/** F-1381: quando o PTY de cada sessão emitiu saída pela última vez. */
const lastOutputAtBySession = new Map<string, number>();

export function paneSessionLastOutputAt(sessionId: string): number | undefined {
  return lastOutputAtBySession.get(sessionId);
}

export function recordPaneSessionData(sessionId: string, data: string): void {
  lastOutputAtBySession.set(sessionId, Date.now());
  let buffer = buffers.get(sessionId);
  if (!buffer) {
    buffer = { chunks: [], size: 0, exited: false };
    buffers.set(sessionId, buffer);
  }
  // Com a análise ligada, readSessionOutput lê o espelho do worker (a mesma
  // cauda de 256 KB, já sem ANSI): reter o texto aqui seria a segunda cópia.
  // O registro da sessão (exited/exitedAt) continua, só o texto não.
  if (isPtyAnalysisEnabled() && analysisClient.has(sessionId)) return;
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
  const effectiveState =
    isOneShotSessionRunning(sessionId) && state === "idle" ? "busy" : state;
  sessionStates.set(sessionId, effectiveState);
  if (effectiveState === "busy" || effectiveState === "spawning") {
    for (const waiter of [...busyWaiters]) {
      if (waiter.sessionId !== sessionId) continue;
      settleBusyWaiter(waiter, "busy");
    }
    return;
  }
  if (effectiveState !== "idle") return;
  for (const waiter of [...idleWaiters]) {
    if (waiter.sessionId !== sessionId) continue;
    settleIdleWaiter(waiter, "idle");
  }
}

export function recordPaneSessionExit(sessionId: string): void {
  sessionStates.delete(sessionId);
  emitAppEvent('pane.exited', { sessionId: sessionId.slice(0, 128) });
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
  for (const waiter of [...busyWaiters]) {
    if (waiter.sessionId !== sessionId) continue;
    settleBusyWaiter(waiter, "exited");
  }
}

export function paneSessionStateForEntry(
  entry: PaneRegistryEntry,
): PaneSnapshot["state"] {
  if (!entry.sessionId) return entry.state ?? "unknown";
  if (isOneShotSessionRunning(entry.sessionId)) return "busy";
  const live =
    sessionStates.get(entry.sessionId) ?? getSessionState(entry.sessionId);
  if (live) return live;
  if (buffers.get(entry.sessionId)?.exited) return "exited";
  // Sobrevive à evicção do buffer: morte de pane é permanente.
  return exitedMarkBySession.has(entry.sessionId)
    ? "exited"
    : (entry.state ?? "unknown");
}

export { stripAnsi } from '../../shared/ansi-text';
import { stripAnsi } from '../../shared/ansi-text';

/**
 * Texto NOVO de uma sessão entre duas leituras de tail (nexus_pane_ask):
 * ancora na última linha não-vazia do `before` e devolve o que veio depois
 * da sua última ocorrência no `after`. Janela que rolou além do marco (tail
 * limitado) devolve o `after` inteiro — melhor resposta com eco do que
 * resposta perdida.
 */
export function newOutputSince(before: string, after: string): string {
  const anchor = before
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .at(-1);
  if (!anchor) return after;
  const index = after.lastIndexOf(anchor);
  if (index < 0) return after;
  return after.slice(index + anchor.length).replace(/^\r?\n/, '');
}

export function readSessionOutput(sessionId: string, lines = 200): string {
  // Infinity deliberately means all retained lines. Other invalid/negative
  // requests are empty; valid positive integers preserve the public tail API.
  const requestedLines = lines === Infinity ? Number.MAX_SAFE_INTEGER
    : Number.isFinite(lines) ? Math.max(0, Math.floor(lines)) : 0;
  if (requestedLines === 0) return "";
  if (isPtyAnalysisEnabled()) {
    const text = analysisClient.text(sessionId);
    let start = text.length;
    for (let index = 0; index < requestedLines; index++) {
      // String.lastIndexOf clamps a negative fromIndex to zero. A leading LF
      // would otherwise be found forever after start reaches zero (F-953).
      if (start === 0) return text;
      const previous = text.lastIndexOf('\n', start - 1);
      if (previous < 0) return text;
      start = previous;
    }
    return text.slice(start + 1);
  }
  const buffer = buffers.get(sessionId);
  if (!buffer) return "";
  const key = `${buffer.chunks.length}:${buffer.size}`;
  if (buffer.stripCache?.key !== key) {
    buffer.stripCache = { key, text: stripAnsi(buffer.chunks.join("")) };
  }
  const allLines = buffer.stripCache.text.split("\n");
  return allLines.slice(Math.max(0, allLines.length - requestedLines)).join("\n");
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

function liveSessionState(
  sessionId: string,
): PaneSessionState | "exited" | null {
  const current = sessionStates.get(sessionId) ?? getSessionState(sessionId);
  if (current) return current;
  if (buffers.get(sessionId)?.exited || exitedMarkBySession.has(sessionId)) {
    return "exited";
  }
  return null;
}

/**
 * Espera o pane FICAR busy. Se já está busy, resolve já.
 */
export function waitUntilBusy(
  sessionId: string,
  timeoutMs = 15_000,
  signal?: AbortSignal,
): Promise<"busy" | "exited" | "timeout"> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? idleWaitAbortFallback());
  }
  const current = liveSessionState(sessionId);
  if (current === "busy" || current === "spawning") {
    return Promise.resolve("busy");
  }
  if (current === "exited") return Promise.resolve("exited");
  return new Promise((resolve, reject) => {
    const waiter: BusyWaiter = { sessionId, resolve, reject };
    busyWaiters.add(waiter);
    waiter.timer = setTimeout(() => {
      settleBusyWaiter(waiter, "timeout");
    }, timeoutMs);
    if (signal) {
      const onAbort = () => {
        if (!busyWaiters.delete(waiter)) return;
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

/**
 * Espera o FIM do turno depois de um prompt: se o pane já está busy, idle;
 * se já está idle (caso do pane_ask num worker parado), espera busy→idle
 * para não devolver a tela antiga antes da resposta.
 */
export async function waitForNextIdle(
  sessionId: string,
  timeoutMs = 120_000,
  signal?: AbortSignal,
): Promise<"idle" | "exited" | "timeout"> {
  const current = liveSessionState(sessionId);
  if (current === "busy" || current === "spawning") {
    return waitForIdle(sessionId, timeoutMs, signal);
  }
  if (current === "exited") return "exited";
  const busyBudget = Math.min(15_000, Math.max(1_000, timeoutMs));
  const started = Date.now();
  const busy = await waitUntilBusy(sessionId, busyBudget, signal);
  if (busy === "exited") return "exited";
  if (busy === "timeout") {
    // O TUI pode ter respondido tão rápido que o busy passou; colhe o idle.
    return waitForIdle(sessionId, Math.max(1, timeoutMs - (Date.now() - started)), signal);
  }
  return waitForIdle(
    sessionId,
    Math.max(1, timeoutMs - (Date.now() - started)),
    signal,
  );
}
