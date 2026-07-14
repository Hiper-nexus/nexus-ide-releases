import type { WebContents } from "electron";
import type { PaneSessionState } from "../../shared/types";
import type {
  OrchPaneSpawnRequest,
  OrchPaneSpawnResult,
  BrowserPaneOpenRequest,
  BrowserPaneOpenResult,
  PaneRegistryEntry,
  MissionPaneRecoveryRequest,
  MissionPaneRecoveryResult,
  MissionPaneSpec,
  PaneSnapshot,
} from "../../shared/orch-types";
import { ORCH_CHANNELS } from "../../shared/orch-channels";
import { DEV_SERVER_CHANNELS } from "../../shared/channels";
import {
  getSessionState,
  getOwnedAgentSessionInfo,
  isSessionOwnedBy,
  tapSessionData,
  tapSessionExit,
  tapSessionState,
} from "../pty/pty-manager";
import { requireLiveRendererWorkspaceScope } from "../persistence/renderer-workspace-scope";
import { canListPane, type CallerCtx, type PaneAuthzInfo } from "./pane-authz";
import { makeId } from "./store-util";
import type { ProjectExecutionScope } from "../../shared/types";
import {
  createDevServerScanner,
  type DevServerEntry,
} from "./dev-server-registry";

/**
 * Main-process mirror of the renderer's pane grid plus per-session output ring
 * buffers. This is what the embedded MCP server reads (`nexus_pane_list`,
 * `nexus_pane_read`) and how it creates panes (`nexus_pane_spawn` → typed IPC
 * round-trip to the renderer, which owns the layout tree).
 */

const RING_BUFFER_CAP = 262_144; // 256 KB of raw output per session.
// CLI cold starts can legitimately include login/profile discovery and MCP
// bootstrap. Thirty seconds was shorter than real Claude/GLM startup on a
// busy machine and turned a healthy late spawn into a retry storm.
const SPAWN_TIMEOUT_MS = 90_000;
const RECOVERY_TIMEOUT_MS = 90_000;

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
  contextRevision?: string;
  agentName?: string;
  /** Skill-gate allowlists for the agent behind this pane (null = open). */
  allowedTools?: string[] | null;
  allowedSkills?: string[] | null;
  role?: "orchestrator" | "worker";
  scope?: Readonly<ProjectExecutionScope>;
  executionScope?: Readonly<ProjectExecutionScope>;
  readOnly?: boolean;
}

interface RegisteredPane {
  entry: PaneRegistryEntry;
  owner: WebContents;
}

let panes: RegisteredPane[] = [];
const buffers = new Map<string, RingBuffer>();
const sessionStates = new Map<string, PaneSessionState>();
const scopeBySession = new Map<string, Readonly<ProjectExecutionScope>>();
const orchMetaByPane = new Map<string, OrchMeta>();

function paneMetaKey(owner: WebContents, paneId: string): string {
  return `${owner.id}:${paneId}`;
}

interface IdleWaiter {
  sessionId: string;
  resolve: (state: "idle" | "exited") => void;
  /** Limpo ao resolver — waits longos deixavam timers de 120-300s vivos. */
  timer?: ReturnType<typeof setTimeout>;
}
const idleWaiters = new Set<IdleWaiter>();

interface PendingSpawn {
  resolve: (result: OrchPaneSpawnResult) => void;
  timer: ReturnType<typeof setTimeout>;
  meta: OrchMeta;
  requestedCwd?: string;
  owner: WebContents;
  claimed: boolean;
  claimedSessionId: string | null;
  request: OrchPaneSpawnRequest;
  lastSentAt: number;
  attempts: number;
}
const pendingSpawns = new Map<string, PendingSpawn>();

interface PendingBrowserOpen {
  resolve: (result: BrowserPaneOpenResult) => void;
  timer: ReturnType<typeof setTimeout>;
  meta: OrchMeta;
  owner: WebContents;
}
const pendingBrowserOpens = new Map<string, PendingBrowserOpen>();

interface PendingPaneRecovery {
  resolve: (result: MissionPaneRecoveryResult) => void;
  timer: ReturnType<typeof setTimeout>;
  owner: WebContents;
  request: MissionPaneRecoveryRequest;
}
const pendingPaneRecoveries = new Map<string, PendingPaneRecovery>();

let orchRenderer: WebContents | null = null;

function liveOwnerForSession(sessionId: string): WebContents | null {
  const matches = panes.filter(
    ({ entry, owner }) =>
      entry.sessionId === sessionId &&
      !owner.isDestroyed() &&
      !owner.isCrashed(),
  );
  return matches.length === 1 ? matches[0].owner : null;
}

// Passive PTY scanning is process-global, but each finding is sent only to
// the renderer that owns the exact session. This prevents a dev-server URL
// from leaking into another project window.
const devServerScanner = createDevServerScanner({
  paneIdOf: (sessionId) => findPane(sessionId)?.paneId ?? null,
  emit: (entry) => {
    liveOwnerForSession(entry.sessionId)?.send(
      DEV_SERVER_CHANNELS.detected,
      entry,
    );
  },
});

export function getDevServerForPane(paneRef: string): DevServerEntry | null {
  return devServerScanner.get(paneRef);
}

/** The window that hosts the pane grid — target of orchestration requests. */
export function registerOrchRenderer(wc: WebContents): void {
  orchRenderer = wc;
}

export function unregisterOrchRenderer(wc: WebContents): void {
  if (orchRenderer === wc) orchRenderer = null;
  const removedPaneIds = panes
    .filter((registered) => registered.owner === wc)
    .map((registered) => registered.entry.paneId);
  panes = panes.filter((registered) => registered.owner !== wc);
  for (const paneId of removedPaneIds) {
    orchMetaByPane.delete(paneMetaKey(wc, paneId));
  }
  // Sem renderer não há como o spawn completar — resolver já, senão cada
  // nexus_pane_spawn pendura o orquestrador por 30s até o timeout.
  for (const [requestId, pending] of [...pendingSpawns]) {
    if (pending.owner !== wc) continue;
    clearTimeout(pending.timer);
    pendingSpawns.delete(requestId);
    pending.resolve({
      requestId,
      ok: false,
      error: "renderer window closed during spawn",
    });
  }
  for (const [requestId, pending] of [...pendingBrowserOpens]) {
    if (pending.owner !== wc) continue;
    clearTimeout(pending.timer);
    pendingBrowserOpens.delete(requestId);
    pending.resolve({
      requestId,
      ok: false,
      error: "renderer window closed during browser open",
    });
  }
  for (const [requestId, pending] of [...pendingPaneRecoveries]) {
    if (pending.owner !== wc) continue;
    clearTimeout(pending.timer);
    pendingPaneRecoveries.delete(requestId);
    pending.resolve({
      requestId,
      ok: false,
      paneId: pending.request.paneId,
      error: "renderer window closed during pane recovery",
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

function rendererForMission(missionId?: string): WebContents | null {
  if (missionId) {
    const owners = new Set<WebContents>();
    for (const registered of panes) {
      const meta = orchMetaByPane.get(
        paneMetaKey(registered.owner, registered.entry.paneId),
      );
      if (
        meta?.missionId === missionId &&
        meta.role === "orchestrator" &&
        !registered.owner.isDestroyed() &&
        !registered.owner.isCrashed()
      ) owners.add(registered.owner);
    }
    if (owners.size === 1) return [...owners][0];
  }
  return rendererAvailable() ? orchRenderer : null;
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
    devServerScanner.onData(sessionId, data);
  });

  tapSessionState((sessionId, state) => {
    sessionStates.set(sessionId, state);
    if (state === "idle") {
      for (const waiter of [...idleWaiters]) {
        if (waiter.sessionId === sessionId) {
          idleWaiters.delete(waiter);
          if (waiter.timer) clearTimeout(waiter.timer);
          waiter.resolve("idle");
        }
      }
    }
  });

  tapSessionExit((sessionId) => {
    devServerScanner.onExit(sessionId);
    sessionStates.delete(sessionId);
    scopeBySession.delete(sessionId);
    const buffer = buffers.get(sessionId);
    if (buffer) {
      buffer.exited = true;
      buffer.exitedAt = Date.now();
    }
    for (const waiter of [...idleWaiters]) {
      if (waiter.sessionId === sessionId) {
        idleWaiters.delete(waiter);
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.resolve("exited");
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

export function syncPanes(
  entries: PaneRegistryEntry[],
  owner: WebContents,
): void {
  panesVersion += 1;
  const paneIdCounts = new Map<string, number>();
  for (const entry of entries) {
    paneIdCounts.set(entry.paneId, (paneIdCounts.get(entry.paneId) ?? 0) + 1);
  }
  const accepted = entries.filter(
    (entry) =>
      paneIdCounts.get(entry.paneId) === 1 &&
      (!entry.sessionId || isSessionOwnedBy(owner, entry.sessionId)),
  );
  panes = [
    ...panes.filter((registered) => registered.owner !== owner),
    ...accepted.map((entry) => ({ entry, owner })),
  ];
  const liveIds = new Set(accepted.map((entry) => entry.paneId));
  for (const key of [...orchMetaByPane.keys()]) {
    const prefix = `${owner.id}:`;
    if (key.startsWith(prefix) && !liveIds.has(key.slice(prefix.length))) {
      orchMetaByPane.delete(key);
    }
  }
  // React/HMR may remount after main emitted the one-shot spawn event. Treat
  // pane sync as the renderer-ready heartbeat and replay unclaimed requests;
  // the renderer deduplicates them by orchRequestId.
  const now = Date.now();
  for (const pending of pendingSpawns.values()) {
    if (
      pending.owner === owner &&
      !pending.claimed &&
      now - pending.lastSentAt >= 500
    ) {
      pending.lastSentAt = now;
      pending.attempts += 1;
      owner.send(ORCH_CHANNELS.paneSpawnRequest, pending.request);
    }
  }
}

export function attachOrchMeta(
  owner: WebContents,
  paneId: string,
  meta: OrchMeta,
): void {
  orchMetaByPane.set(paneMetaKey(owner, paneId), meta);
}

/** Trusted main-side binding for direct panes that have no pending OrchMeta. */
export function attachSessionScope(
  sessionId: string,
  scope: Readonly<ProjectExecutionScope>,
): void {
  scopeBySession.set(sessionId, scope);
}

function paneState(entry: PaneRegistryEntry): PaneSnapshot["state"] {
  if (!entry.sessionId) return entry.state ?? "unknown";
  const live =
    sessionStates.get(entry.sessionId) ?? getSessionState(entry.sessionId);
  if (live) return live;
  return buffers.get(entry.sessionId)?.exited
    ? "exited"
    : (entry.state ?? "unknown");
}

function snapshotOf(registered: RegisteredPane): PaneSnapshot {
  const { entry, owner } = registered;
  const meta = orchMetaByPane.get(paneMetaKey(owner, entry.paneId));
  const sessionScope = entry.sessionId
    ? scopeBySession.get(entry.sessionId)
    : undefined;
  return {
    ...entry,
    state: paneState(entry),
    ...(sessionScope ? { scope: sessionScope } : {}),
    ...meta,
  };
}

export function listPaneSnapshots(): PaneSnapshot[] {
  return panes.map(snapshotOf);
}

/** nexus_pane_list scoped to what the caller may see (SEC#5 info disclosure):
 * a worker sees only its own mission's panes, never the user's shells. */
export function listVisiblePaneSnapshots(caller: CallerCtx): PaneSnapshot[] {
  return panes
    .filter((registered) => canListPane(caller, authzInfoOf(registered)))
    .map(snapshotOf);
}

export function findPane(paneIdOrSessionId: string): PaneRegistryEntry | null {
  const matches = panes.filter(
    ({ entry }) =>
      entry.paneId === paneIdOrSessionId ||
      entry.sessionId === paneIdOrSessionId,
  );
  return matches.length === 1 ? matches[0].entry : null;
}

export function findPaneOwnedBy(
  owner: WebContents,
  paneIdOrSessionId: string,
): PaneRegistryEntry | null {
  const matches = panes.filter(
    (registered) =>
      registered.owner === owner &&
      (registered.entry.paneId === paneIdOrSessionId ||
        registered.entry.sessionId === paneIdOrSessionId),
  );
  return matches.length === 1 ? matches[0].entry : null;
}

/** Exact owner+session lookup for callers that must not mix id namespaces. */
export function findPaneBySessionOwnedBy(
  owner: WebContents,
  sessionId: string,
): Readonly<PaneRegistryEntry> | null {
  const matches = panes.filter(
    (registered) =>
      registered.owner === owner && registered.entry.sessionId === sessionId,
  );
  return matches.length === 1
    ? Object.freeze({ ...matches[0].entry })
    : null;
}

function authzInfoOf(registered: RegisteredPane): PaneAuthzInfo {
  const { entry, owner } = registered;
  const meta = orchMetaByPane.get(paneMetaKey(owner, entry.paneId));
  return {
    paneId: entry.paneId,
    sessionId: entry.sessionId,
    kind: entry.kind,
    missionId: meta?.missionId,
    contextRevision: meta?.contextRevision,
    role: meta?.role,
    scope:
      meta?.scope ??
      (entry.sessionId ? scopeBySession.get(entry.sessionId) : undefined),
    executionScope: meta?.executionScope,
  };
}

/** Resolve a pane (by paneId or sessionId) to the info the authz check needs. */
export function getPaneAuthzInfo(paneRef: string): PaneAuthzInfo | null {
  const matches = panes.filter(
    ({ entry }) => entry.paneId === paneRef || entry.sessionId === paneRef,
  );
  return matches.length === 1 ? authzInfoOf(matches[0]) : null;
}

export type OwnedPaneAuthzInfo = Readonly<PaneAuthzInfo> & {
  readonly owner: WebContents;
};

/**
 * Main-process authority for a pane/session. Duplicate renderer-controlled ids
 * are deliberately ambiguous and fail closed; callers never guess an owner.
 */
export function getOwnedPaneAuthzInfo(
  paneRef: string,
): OwnedPaneAuthzInfo | null {
  const matches = panes.filter(
    ({ entry }) => entry.paneId === paneRef || entry.sessionId === paneRef,
  );
  if (matches.length !== 1) return null;
  const registered = matches[0];
  const info = authzInfoOf(registered);
  return Object.freeze({
    ...info,
    scope: info.scope ? Object.freeze({ ...info.scope }) : undefined,
    owner: registered.owner,
  });
}

/** Exact session lookup; a renderer-controlled paneId cannot shadow it. */
export function getOwnedPaneAuthzInfoBySession(
  sessionId: string,
): OwnedPaneAuthzInfo | null {
  const matches = panes.filter(
    ({ entry }) => entry.sessionId === sessionId,
  );
  if (matches.length !== 1) return null;
  const registered = matches[0];
  const info = authzInfoOf(registered);
  return Object.freeze({
    ...info,
    scope: info.scope ? Object.freeze({ ...info.scope }) : undefined,
    owner: registered.owner,
  });
}

/** Resolve duplicate pane ids safely when the trusted WebContents is known. */
export function getPaneAuthzInfoOwnedBy(
  owner: WebContents,
  paneRef: string,
): Readonly<PaneAuthzInfo> | null {
  const matches = panes.filter(
    (registered) =>
      registered.owner === owner &&
      (registered.entry.paneId === paneRef ||
        registered.entry.sessionId === paneRef),
  );
  if (matches.length !== 1) return null;
  const info = authzInfoOf(matches[0]);
  return Object.freeze({
    ...info,
    scope: info.scope ? Object.freeze({ ...info.scope }) : undefined,
  });
}

/** Exact owner+pane lookup; a sessionId cannot collide with the pane id. */
export function getPaneAuthzInfoOwnedByPane(
  owner: WebContents,
  paneId: string,
): Readonly<PaneAuthzInfo> | null {
  const matches = panes.filter(
    (registered) =>
      registered.owner === owner && registered.entry.paneId === paneId,
  );
  if (matches.length !== 1) return null;
  const info = authzInfoOf(matches[0]);
  return Object.freeze({
    ...info,
    scope: info.scope ? Object.freeze({ ...info.scope }) : undefined,
  });
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
    .replace(OSC_PATTERN, "")
    .replace(CSI_PATTERN, "")
    .replace(ESC_PATTERN, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(CONTROL_PATTERN, "");
}

/** Read the tail of a session's output as plain text. */
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

/** Resolve when the session goes idle (or exits / times out). */
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

export interface PaneSpawnOptions {
  adapterId: string;
  model?: string;
  /** Per-spawn reasoning effort (task-router decision). */
  effort?: string;
  cwd?: string;
  title?: string;
  missionId?: string;
  contextRevision?: string;
  agentName?: string;
  allowedTools?: string[] | null;
  allowedSkills?: string[] | null;
  role?: "orchestrator" | "worker";
  scope: Readonly<ProjectExecutionScope>;
  executionScope?: Readonly<ProjectExecutionScope>;
  readOnly?: boolean;
}

/** Pending gate context consumed by the agent-spawn hook via orchRequestId. */
export type PendingSpawnMeta = OrchMeta & { requestedCwd?: string };

/**
 * Claim a pending spawn exactly once. The opaque request id is insufficient:
 * it must return through the same WebContents that received the main-process
 * spawn command, otherwise another renderer could replay/steal its authority.
 */
export function claimPendingSpawnMeta(
  requestId: string,
  owner: WebContents,
): PendingSpawnMeta | null {
  const pending = pendingSpawns.get(requestId);
  if (!pending || pending.owner !== owner || pending.claimed) return null;
  pending.claimed = true;
  return pending.requestedCwd === undefined
    ? pending.meta
    : { ...pending.meta, requestedCwd: pending.requestedCwd };
}

/** Bind the claimed orchestration request to the concrete PTY it created. */
export function bindPendingSpawnSession(
  requestId: string,
  owner: WebContents,
  sessionId: string,
): boolean {
  const pending = pendingSpawns.get(requestId);
  if (
    !pending ||
    pending.owner !== owner ||
    !pending.claimed ||
    pending.claimedSessionId !== null
  ) {
    return false;
  }
  pending.claimedSessionId = sessionId;
  return true;
}

/**
 * Ask the renderer to create a pane + session. Resolves with paneId/sessionId
 * once the renderer reports the spawn outcome, or an error on timeout.
 */
export function requestPaneSpawn(
  options: PaneSpawnOptions,
): Promise<OrchPaneSpawnResult> {
  const owner = rendererForMission(options.missionId);
  if (!owner) {
    return Promise.resolve({
      requestId: "",
      ok: false,
      error: "no renderer window available",
    });
  }
  const requestId = makeId("orchspawn");
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
      resolve({ requestId, ok: false, error: "pane spawn timed out" });
    }, SPAWN_TIMEOUT_MS);
    const pending: PendingSpawn = {
      resolve,
      timer,
      owner,
      claimed: false,
      claimedSessionId: null,
      requestedCwd: options.cwd,
      request,
      lastSentAt: Date.now(),
      attempts: 1,
      meta: {
        missionId: options.missionId,
        contextRevision: options.contextRevision,
        agentName: options.agentName,
        allowedTools: options.allowedTools,
        allowedSkills: options.allowedSkills,
        role: options.role,
        scope: options.scope,
        executionScope: options.executionScope,
        readOnly: options.readOnly === true,
      },
    };
    pendingSpawns.set(requestId, pending);
    owner.send(ORCH_CHANNELS.paneSpawnRequest, request);
  });
}

export function requestBrowserPane(options: {
  url: string;
  title?: string;
  missionId?: string;
  agentName?: string;
  role?: "orchestrator" | "worker";
  scope: Readonly<ProjectExecutionScope>;
}): Promise<BrowserPaneOpenResult> {
  if (!rendererAvailable()) {
    return Promise.resolve({
      requestId: "",
      ok: false,
      error: "no renderer window available",
    });
  }
  const owner = orchRenderer!;
  const requestId = makeId("browseropen");
  const request: BrowserPaneOpenRequest = {
    requestId,
    url: options.url,
    title: options.title,
  };
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingBrowserOpens.delete(requestId);
      resolve({ requestId, ok: false, error: "browser open timed out" });
    }, SPAWN_TIMEOUT_MS);
    pendingBrowserOpens.set(requestId, {
      resolve,
      timer,
      owner,
      meta: {
        missionId: options.missionId,
        agentName: options.agentName,
        role: options.role,
        scope: options.scope,
      },
    });
    owner.send(ORCH_CHANNELS.browserOpenRequest, request);
  });
}

/** Renderer → main: outcome of a pane spawn request. */
export function resolvePaneSpawn(
  result: OrchPaneSpawnResult,
  owner: WebContents,
): boolean {
  const pending = pendingSpawns.get(result.requestId);
  if (!pending || pending.owner !== owner) return false;
  if (
    result.ok &&
    (!pending.claimedSessionId || result.sessionId !== pending.claimedSessionId)
  ) {
    return false;
  }
  clearTimeout(pending.timer);
  pendingSpawns.delete(result.requestId);
  if (result.ok && result.paneId) {
    attachOrchMeta(owner, result.paneId, pending.meta);
  }
  pending.resolve(result);
  return true;
}

export function resolveBrowserOpen(
  result: BrowserPaneOpenResult,
  owner: WebContents,
): boolean {
  const pending = pendingBrowserOpens.get(result.requestId);
  if (!pending || pending.owner !== owner) return false;
  clearTimeout(pending.timer);
  pendingBrowserOpens.delete(result.requestId);
  if (result.ok && result.paneId) {
    attachOrchMeta(owner, result.paneId, pending.meta);
  }
  pending.resolve(result);
  return true;
}

export function requestMissionPaneRecovery(options: {
  missionId: string;
  paneId: string;
  role: "orchestrator" | "worker";
  expectedSessionId?: string;
  pane: MissionPaneSpec;
  scope: ProjectExecutionScope;
  recap: string;
}): Promise<MissionPaneRecoveryResult> {
  const matches = panes.filter((registered) => {
    const meta = orchMetaByPane.get(
      paneMetaKey(registered.owner, registered.entry.paneId),
    );
    return (
      registered.entry.paneId === options.paneId &&
      registered.entry.kind === "cli-agent" &&
      (!registered.entry.sessionId ||
        registered.entry.sessionId === options.expectedSessionId) &&
      meta?.missionId === options.missionId &&
      meta.role === options.role &&
      !registered.owner.isDestroyed() &&
      !registered.owner.isCrashed()
    );
  });
  if (matches.length > 1) {
    return Promise.resolve({
      requestId: "",
      ok: false,
      paneId: options.paneId,
      error: "mission pane recovery owner is ambiguous",
    });
  }
  const owner = matches[0]?.owner ?? rendererForMission(options.missionId);
  if (!owner) {
    return Promise.resolve({
      requestId: "",
      ok: false,
      paneId: options.paneId,
      error: "mission pane renderer is unavailable",
    });
  }
  try {
    requireLiveRendererWorkspaceScope(owner, options.scope);
  } catch {
    return Promise.resolve({
      requestId: "",
      ok: false,
      paneId: options.paneId,
      error: "mission pane renderer scope changed",
    });
  }
  const requestId = makeId("panerecovery");
  const request: MissionPaneRecoveryRequest = {
    requestId,
    missionId: options.missionId,
    paneId: options.paneId,
    role: options.role,
    expectedSessionId: options.expectedSessionId,
    pane: {
      adapterId: options.pane.adapterId,
      model: options.pane.model,
      accountId: options.pane.accountId,
      effort: options.pane.effort,
      cwd: options.pane.cwd,
      title: options.pane.title,
      agentName: options.pane.agentName,
      role: options.pane.role,
    },
    recap: options.recap.slice(0, 65_536),
  };
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingPaneRecoveries.delete(requestId);
      resolve({
        requestId,
        ok: false,
        paneId: request.paneId,
        error: "pane recovery timed out",
      });
    }, RECOVERY_TIMEOUT_MS);
    pendingPaneRecoveries.set(requestId, { resolve, timer, owner, request });
    owner.send(ORCH_CHANNELS.paneRecoveryRequest, request);
  });
}

export function resolveMissionPaneRecovery(
  result: MissionPaneRecoveryResult,
  owner: WebContents,
): boolean {
  const pending = pendingPaneRecoveries.get(result.requestId);
  if (!pending || pending.owner !== owner) return false;
  if (result.paneId !== pending.request.paneId) return false;
  if (result.ok) {
    const previousSessionId = pending.request.expectedSessionId;
    if (
      !result.sessionId ||
      (previousSessionId && result.sessionId === previousSessionId) ||
      !isSessionOwnedBy(owner, result.sessionId)
    ) {
      return false;
    }
    const pane = findPaneOwnedBy(owner, result.paneId);
    if (pane?.sessionId !== result.sessionId) return false;
    const meta = orchMetaByPane.get(paneMetaKey(owner, result.paneId));
    const agent = getOwnedAgentSessionInfo(owner, result.sessionId);
    if (
      meta?.missionId !== pending.request.missionId ||
      meta.role !== pending.request.role ||
      agent?.source !== "persisted-pane" ||
      agent.missionId !== pending.request.missionId ||
      agent.role !== pending.request.role ||
      agent.paneId !== pending.request.paneId
    ) {
      return false;
    }
  }
  clearTimeout(pending.timer);
  pendingPaneRecoveries.delete(result.requestId);
  pending.resolve(result);
  return true;
}

/** Ask the renderer to close a pane (layout collapse + session kill). */
export function requestPaneClose(paneId: string): boolean {
  if (!rendererAvailable()) return false;
  orchRenderer!.send(ORCH_CHANNELS.paneCloseRequest, paneId);
  return true;
}
