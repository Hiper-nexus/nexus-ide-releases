import type { WebContents } from 'electron';
import type { PaneSessionState } from '../../shared/types';
import type {
  OrchPaneSpawnRequest,
  OrchPaneSpawnResult,
  BrowserPaneOpenRequest,
  BrowserPaneOpenResult,
  PaneRegistryEntry,
  PaneSnapshot,
} from '../../shared/orch-types';
import { ORCH_CHANNELS } from '../../shared/orch-channels';
import {
  getSessionState,
  tapSessionData,
  tapSessionExit,
  tapSessionState,
} from '../pty/pty-manager';
import { canListPane, type CallerCtx, type PaneAuthzInfo } from './pane-authz';
import { makeId } from './store-util';

/**
 * Main-process mirror of the renderer's pane grid plus per-session output ring
 * buffers. This is what the embedded MCP server reads (`nexus_pane_list`,
 * `nexus_pane_read`) and how it creates panes (`nexus_pane_spawn` → typed IPC
 * round-trip to the renderer, which owns the layout tree).
 */

const RING_BUFFER_CAP = 262_144; // 256 KB of raw output per session.
const SPAWN_TIMEOUT_MS = 30_000;

interface RingBuffer {
  chunks: string[];
  size: number;
  exited: boolean;
  /** Quando a sessão morreu — buffers encerrados expiram por TTL. */
  exitedAt?: number;
  /** Memo do stripAnsi: pane_read reprocessava 256 KB a cada chamada. */
  stripCache?: { key: string; text: string };
}

// Sessão morta ainda pode ser lida por uns minutos (handoff atrasado, tail de
// pane_wait_idle); depois o buffer expira — sem TTL, 256 KB por sessão
// encerrada acumulavam para sempre no main process.
const EXITED_BUFFER_TTL_MS = 5 * 60_000;
setInterval(() => {
  const cutoff = Date.now() - EXITED_BUFFER_TTL_MS;
  for (const [sessionId, buffer] of buffers) {
    if (buffer.exited && (buffer.exitedAt ?? 0) < cutoff) {
      buffers.delete(sessionId);
    }
  }
}, 60_000).unref();

interface OrchMeta {
  missionId?: string;
  agentName?: string;
  /** Skill-gate allowlists for the agent behind this pane (null = open). */
  allowedTools?: string[] | null;
  allowedSkills?: string[] | null;
  role?: 'orchestrator' | 'worker';
}

let panes: PaneRegistryEntry[] = [];
const buffers = new Map<string, RingBuffer>();
const sessionStates = new Map<string, PaneSessionState>();
const orchMetaByPane = new Map<string, OrchMeta>();

interface IdleWaiter {
  sessionId: string;
  resolve: (state: 'idle' | 'exited') => void;
  /** Limpo ao resolver — waits longos deixavam timers de 120-300s vivos. */
  timer?: ReturnType<typeof setTimeout>;
}
const idleWaiters = new Set<IdleWaiter>();

interface PendingSpawn {
  resolve: (result: OrchPaneSpawnResult) => void;
  timer: ReturnType<typeof setTimeout>;
  meta: OrchMeta;
}
const pendingSpawns = new Map<string, PendingSpawn>();

interface PendingBrowserOpen {
  resolve: (result: BrowserPaneOpenResult) => void;
  timer: ReturnType<typeof setTimeout>;
  meta: OrchMeta;
}
const pendingBrowserOpens = new Map<string, PendingBrowserOpen>();

let orchRenderer: WebContents | null = null;

/** The window that hosts the pane grid — target of orchestration requests. */
export function registerOrchRenderer(wc: WebContents): void {
  orchRenderer = wc;
}

export function unregisterOrchRenderer(wc: WebContents): void {
  if (orchRenderer === wc) orchRenderer = null;
  // Sem renderer não há como o spawn completar — resolver já, senão cada
  // nexus_pane_spawn pendura o orquestrador por 30s até o timeout.
  for (const [requestId, pending] of [...pendingSpawns]) {
    clearTimeout(pending.timer);
    pendingSpawns.delete(requestId);
    pending.resolve({
      requestId,
      ok: false,
      error: 'renderer window closed during spawn',
    });
  }
  for (const [requestId, pending] of [...pendingBrowserOpens]) {
    clearTimeout(pending.timer);
    pendingBrowserOpens.delete(requestId);
    pending.resolve({
      requestId,
      ok: false,
      error: 'renderer window closed during browser open',
    });
  }
}

function rendererAvailable(): boolean {
  return (
    orchRenderer !== null &&
    !orchRenderer.isDestroyed() &&
    !orchRenderer.isCrashed()
  );
}

export function initPaneRegistry(): void {
  tapSessionData((sessionId, data) => {
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
  });

  tapSessionState((sessionId, state) => {
    sessionStates.set(sessionId, state);
    if (state === 'idle') {
      for (const waiter of [...idleWaiters]) {
        if (waiter.sessionId === sessionId) {
          idleWaiters.delete(waiter);
          if (waiter.timer) clearTimeout(waiter.timer);
          waiter.resolve('idle');
        }
      }
    }
  });

  tapSessionExit((sessionId) => {
    sessionStates.delete(sessionId);
    const buffer = buffers.get(sessionId);
    if (buffer) {
      buffer.exited = true;
      buffer.exitedAt = Date.now();
    }
    for (const waiter of [...idleWaiters]) {
      if (waiter.sessionId === sessionId) {
        idleWaiters.delete(waiter);
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.resolve('exited');
      }
    }
  });
}

/** Renderer → main: replace the pane mirror (payload already zod-validated). */
let panesVersion = 0;
/** Bumped a cada sync — invalida índices derivados (ex.: pipes por sessão). */
export function getPanesVersion(): number {
  return panesVersion;
}

export function syncPanes(entries: PaneRegistryEntry[]): void {
  panesVersion += 1;
  panes = entries;
  const liveIds = new Set(entries.map((entry) => entry.paneId));
  for (const paneId of [...orchMetaByPane.keys()]) {
    if (!liveIds.has(paneId)) orchMetaByPane.delete(paneId);
  }
}

export function attachOrchMeta(paneId: string, meta: OrchMeta): void {
  orchMetaByPane.set(paneId, meta);
}

function paneState(entry: PaneRegistryEntry): PaneSnapshot['state'] {
  if (!entry.sessionId) return entry.state ?? 'unknown';
  const live = sessionStates.get(entry.sessionId) ?? getSessionState(entry.sessionId);
  if (live) return live;
  return buffers.get(entry.sessionId)?.exited ? 'exited' : entry.state ?? 'unknown';
}

function snapshotOf(entry: PaneRegistryEntry): PaneSnapshot {
  return {
    ...entry,
    state: paneState(entry),
    ...orchMetaByPane.get(entry.paneId),
  };
}

export function listPaneSnapshots(): PaneSnapshot[] {
  return panes.map(snapshotOf);
}

/** nexus_pane_list scoped to what the caller may see (SEC#5 info disclosure):
 * a worker sees only its own mission's panes, never the user's shells. */
export function listVisiblePaneSnapshots(caller: CallerCtx): PaneSnapshot[] {
  return panes
    .filter((entry) => canListPane(caller, authzInfoOf(entry)))
    .map(snapshotOf);
}

export function findPane(paneIdOrSessionId: string): PaneRegistryEntry | null {
  return (
    panes.find(
      (entry) =>
        entry.paneId === paneIdOrSessionId ||
        entry.sessionId === paneIdOrSessionId,
    ) ?? null
  );
}

function authzInfoOf(entry: PaneRegistryEntry): PaneAuthzInfo {
  const meta = orchMetaByPane.get(entry.paneId);
  return {
    paneId: entry.paneId,
    sessionId: entry.sessionId,
    kind: entry.kind,
    missionId: meta?.missionId,
    role: meta?.role,
  };
}

/** Resolve a pane (by paneId or sessionId) to the info the authz check needs. */
export function getPaneAuthzInfo(paneRef: string): PaneAuthzInfo | null {
  const pane = findPane(paneRef);
  return pane ? authzInfoOf(pane) : null;
}

// CSI sequences (colors, cursor moves), OSC sequences (titles; BEL or ST
// terminated), and remaining lone escapes, in that order.
/* eslint-disable no-control-regex */
const CSI_PATTERN = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;
const OSC_PATTERN = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ESC_PATTERN = /\x1b[@-_]/g;
const CONTROL_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
/* eslint-enable no-control-regex */

/** Strip ANSI escapes and normalize line endings for tool consumption. */
export function stripAnsi(raw: string): string {
  return raw
    .replace(OSC_PATTERN, '')
    .replace(CSI_PATTERN, '')
    .replace(ESC_PATTERN, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(CONTROL_PATTERN, '');
}

/** Read the tail of a session's output as plain text. */
export function readSessionOutput(sessionId: string, lines = 200): string {
  const buffer = buffers.get(sessionId);
  if (!buffer) return '';
  const key = `${buffer.chunks.length}:${buffer.size}`;
  if (buffer.stripCache?.key !== key) {
    buffer.stripCache = { key, text: stripAnsi(buffer.chunks.join('')) };
  }
  const allLines = buffer.stripCache.text.split('\n');
  return allLines.slice(Math.max(0, allLines.length - lines)).join('\n');
}

/** Resolve when the session goes idle (or exits / times out). */
export function waitForIdle(
  sessionId: string,
  timeoutMs = 120_000,
): Promise<'idle' | 'exited' | 'timeout'> {
  const current = sessionStates.get(sessionId) ?? getSessionState(sessionId);
  if (current === 'idle') return Promise.resolve('idle');
  if (current === null || current === undefined) {
    return Promise.resolve(buffers.get(sessionId)?.exited ? 'exited' : 'timeout');
  }
  return new Promise((resolve) => {
    const waiter: IdleWaiter = { sessionId, resolve };
    idleWaiters.add(waiter);
    waiter.timer = setTimeout(() => {
      if (idleWaiters.delete(waiter)) resolve('timeout');
    }, timeoutMs);
  });
}

export interface PaneSpawnOptions {
  adapterId: string;
  model?: string;
  /** Per-spawn reasoning effort (task-router decision). */
  effort?: string;
  cwd?: string;
  title?: string;
  missionId?: string;
  agentName?: string;
  allowedTools?: string[] | null;
  allowedSkills?: string[] | null;
  role?: 'orchestrator' | 'worker';
}

/** Pending gate context consumed by the agent-spawn hook via orchRequestId. */
export type PendingSpawnMeta = OrchMeta;

export function getPendingSpawnMeta(requestId: string): PendingSpawnMeta | null {
  return pendingSpawns.get(requestId)?.meta ?? null;
}

/**
 * Ask the renderer to create a pane + session. Resolves with paneId/sessionId
 * once the renderer reports the spawn outcome, or an error on timeout.
 */
export function requestPaneSpawn(
  options: PaneSpawnOptions,
): Promise<OrchPaneSpawnResult> {
  if (!rendererAvailable()) {
    return Promise.resolve({
      requestId: '',
      ok: false,
      error: 'no renderer window available',
    });
  }
  const requestId = makeId('orchspawn');
  const request: OrchPaneSpawnRequest = {
    requestId,
    adapterId: options.adapterId,
    model: options.model,
    effort: options.effort,
    cwd: options.cwd,
    title: options.title,
    missionId: options.missionId,
    agentName: options.agentName,
    role: options.role,
  };
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingSpawns.delete(requestId);
      resolve({ requestId, ok: false, error: 'pane spawn timed out' });
    }, SPAWN_TIMEOUT_MS);
    pendingSpawns.set(requestId, {
      resolve,
      timer,
      meta: {
        missionId: options.missionId,
        agentName: options.agentName,
        allowedTools: options.allowedTools,
        allowedSkills: options.allowedSkills,
        role: options.role,
      },
    });
    orchRenderer!.send(ORCH_CHANNELS.paneSpawnRequest, request);
  });
}

export function requestBrowserPane(options: {
  url: string;
  title?: string;
  missionId?: string;
  agentName?: string;
  role?: 'orchestrator' | 'worker';
}): Promise<BrowserPaneOpenResult> {
  if (!rendererAvailable()) {
    return Promise.resolve({
      requestId: '',
      ok: false,
      error: 'no renderer window available',
    });
  }
  const requestId = makeId('browseropen');
  const request: BrowserPaneOpenRequest = {
    requestId,
    url: options.url,
    title: options.title,
  };
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingBrowserOpens.delete(requestId);
      resolve({ requestId, ok: false, error: 'browser open timed out' });
    }, SPAWN_TIMEOUT_MS);
    pendingBrowserOpens.set(requestId, {
      resolve,
      timer,
      meta: {
        missionId: options.missionId,
        agentName: options.agentName,
        role: options.role,
      },
    });
    orchRenderer!.send(ORCH_CHANNELS.browserOpenRequest, request);
  });
}

/** Renderer → main: outcome of a pane spawn request. */
export function resolvePaneSpawn(result: OrchPaneSpawnResult): void {
  const pending = pendingSpawns.get(result.requestId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingSpawns.delete(result.requestId);
  if (result.ok && result.paneId) {
    attachOrchMeta(result.paneId, pending.meta);
  }
  pending.resolve(result);
}

export function resolveBrowserOpen(result: BrowserPaneOpenResult): void {
  const pending = pendingBrowserOpens.get(result.requestId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingBrowserOpens.delete(result.requestId);
  if (result.ok && result.paneId) {
    attachOrchMeta(result.paneId, pending.meta);
  }
  pending.resolve(result);
}

/** Ask the renderer to close a pane (layout collapse + session kill). */
export function requestPaneClose(paneId: string): boolean {
  if (!rendererAvailable()) return false;
  orchRenderer!.send(ORCH_CHANNELS.paneCloseRequest, paneId);
  return true;
}
