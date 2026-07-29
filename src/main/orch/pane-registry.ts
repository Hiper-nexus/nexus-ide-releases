import type { WebContents } from "electron";
import type {
  OrchPaneSpawnRequest,
  OrchPaneSpawnResult,
  BrowserPaneOpenRequest,
  BrowserPaneOpenResult,
  PaneRegistryEntry,
  MissionPaneRecoveryRequest,
  MissionPaneRecoveryResult,
  MissionPanePresentationRequest,
  MissionPaneAuthoritySeal,
  MissionPaneSpec,
  PaneAttemptCleanupRequest,
  PaneSnapshot,
} from "../../shared/orch-types";
import { ORCH_CHANNELS } from "../../shared/orch-channels";
import { DEV_SERVER_CHANNELS } from "../../shared/channels";
import {
  detachOwnedMissionAgentSession,
  getAgentSessionInfo,
  getSessionState,
  isSessionOwnedBy,
  listAgentSessionsForPane,
  orchTerminateSession,
  tapSessionData,
  tapSessionExit,
  tapSessionState,
} from "../pty/pty-manager";
import {
  getRendererWorkspaceScope,
  onRendererWorkspaceScopeChange,
  requireLiveRendererWorkspaceScope,
} from "../persistence/renderer-workspace-scope";
import { sameProjectScope } from "./project-scoped-broadcast";
import { canListPane, type CallerCtx, type PaneAuthzInfo } from "./pane-authz";
import { makeId } from "./store-util";
import type { ProjectExecutionScope } from "../../shared/types";
import {
  deleteMainOwnedPane,
  fallbackPendingSpawnToMain as fallbackPendingSpawnToMainRuntime,
  findMainOwnedPaneAuthz,
  findMainOwnedPaneEntries,
  findMainOwnedRuntimeAuthority,
  getMainOwnedPane,
  hasMainOwnedPaneReference,
  hasMainOwnedPaneSession,
  listMainOwnedPaneSnapshots,
  mainOwnedPaneValues,
  listVisibleMainOwnedPaneSnapshots,
  retainClaimedPendingSpawn as retainClaimedPendingSpawnRuntime,
  setMainOwnedPane,
  spawnMainOwnedMissionPane as spawnMainOwnedMissionPaneRuntime,
  type MainOwnedPane,
  type MainOwnedPaneHooks,
  type PaneOrchMeta,
  type PaneSpawnOptions as MainOwnedPaneSpawnOptions,
} from "./main-owned-pane-runtime";
import {
  paneSessionStateForEntry,
  recordPaneSessionData,
  recordPaneSessionExit,
  recordPaneSessionState,
} from "./pane-session-output";
export {
  readSessionOutput,
  sessionOutputExitedAt,
  stripAnsi,
  waitForIdle,
} from "./pane-session-output";
import {
  createDevServerScanner,
  type DevServerEntry,
} from "./dev-server-registry";
import { getProjectDomainStores } from "./project-domain-store-registry";
import { listSquads } from "./squad-store";
import {
  resolveMissionPaneAuthoritySeal,
  sameMissionPaneAuthoritySeal,
} from "./mission-pane-authority";
import { isAutomatedReviewerCompositionPane } from "./mission-pane-store";

/**
 * Main-process mirror of the renderer's pane grid plus per-session output ring
 * buffers. This is what the embedded MCP server reads (`nexus_pane_list`,
 * `nexus_pane_read`) and how it creates panes. The renderer owns only visual
 * layout; physical mission PTYs can be main-owned and later adopted into that
 * layout without restarting the provider process.
 */

// CLI cold starts can legitimately include login/profile discovery and MCP
// bootstrap. Thirty seconds was shorter than real Claude/GLM startup on a
// busy machine and turned a healthy late spawn into a retry storm.
const SPAWN_TIMEOUT_MS = 90_000;
const RECOVERY_TIMEOUT_MS = 90_000;

type OrchMeta = PaneOrchMeta;

interface RegisteredPane {
  entry: PaneRegistryEntry;
  owner: WebContents;
}

let panes: RegisteredPane[] = [];
const scopeBySession = new Map<string, Readonly<ProjectExecutionScope>>();
const orchMetaByPane = new Map<string, OrchMeta>();

function paneMetaKey(owner: WebContents, paneId: string): string {
  return `${owner.id}:${paneId}`;
}

interface PendingSpawn {
  resolve: (result: OrchPaneSpawnResult) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Main-only first turn; deliberately absent from the renderer request. */
  initialPrompt?: string;
  meta: OrchMeta;
  requestedCwd?: string;
  owner: WebContents;
  claimed: boolean;
  claimedSessionId: string | null;
  request: OrchPaneSpawnRequest;
  lastSentAt: number;
  attempts: number;
  settled: boolean;
  abortCleanup?: () => void;
}
const pendingSpawns = new Map<string, PendingSpawn>();

interface PendingBrowserOpen {
  resolve: (result: BrowserPaneOpenResult) => void;
  timer: ReturnType<typeof setTimeout>;
  meta: OrchMeta;
  owner: WebContents;
  paneId: string;
}
const pendingBrowserOpens = new Map<string, PendingBrowserOpen>();

interface ExpiredBrowserOpen {
  owner: WebContents;
  paneId: string;
  timer: ReturnType<typeof setTimeout>;
}
const expiredBrowserOpens = new Map<string, ExpiredBrowserOpen>();

function sendAttemptPaneCleanup(
  owner: WebContents,
  requestId: string,
  paneId: string,
): void {
  try {
    if (owner.isDestroyed() || owner.isCrashed()) return;
    const cleanup: PaneAttemptCleanupRequest = { requestId, paneId };
    owner.send(ORCH_CHANNELS.paneCloseRequest, cleanup);
  } catch (error) {
    // WebContents can die between the liveness check and send(). Cleanup is a
    // renderer presentation hint; it must never strand the Main-owned
    // settlement/physical teardown that already revoked this request.
    console.warn(
      `[pane-registry] renderer cleanup skipped for ${paneId}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

function retainExpiredBrowserOpen(
  requestId: string,
  pending: PendingBrowserOpen,
): void {
  const previous = expiredBrowserOpens.get(requestId);
  if (previous) clearTimeout(previous.timer);
  const timer = setTimeout(() => {
    expiredBrowserOpens.delete(requestId);
  }, SPAWN_TIMEOUT_MS);
  expiredBrowserOpens.set(requestId, {
    owner: pending.owner,
    paneId: pending.paneId,
    timer,
  });
  // Request-sealed and idempotent: catches a pane already inserted before the
  // timeout without deleting a homonymous pane owned by another request.
  // A second conditional close is sent when a late acknowledgement arrives.
  sendAttemptPaneCleanup(pending.owner, requestId, pending.paneId);
}

interface PendingPaneRecovery {
  resolve: (result: MissionPaneRecoveryResult) => void;
  timer: ReturnType<typeof setTimeout>;
  owner: WebContents;
  request: MissionPaneRecoveryRequest;
  scope: Readonly<ProjectExecutionScope>;
  claimed: boolean;
  replacementSessionId: string | null;
  settled: boolean;
  resolutionSent: boolean;
}
const pendingPaneRecoveries = new Map<string, PendingPaneRecovery>();

function resolvePaneRecoveryOnce(
  pending: PendingPaneRecovery,
  result: MissionPaneRecoveryResult,
): void {
  if (pending.resolutionSent) return;
  pending.resolutionSent = true;
  pending.resolve(result);
}

async function terminateRecoveryReplacement(
  sessionId: string,
): Promise<boolean> {
  return orchTerminateSession(sessionId);
}

async function settlePaneRecoveryFailure(
  requestId: string,
  pending: PendingPaneRecovery,
  error: string,
  options: {
    readonly retainUnboundGrant?: boolean;
  } = {},
): Promise<void> {
  if (pending.settled && pending.resolutionSent && !pending.replacementSessionId) {
    return;
  }
  pending.settled = true;
  clearTimeout(pending.timer);
  // A renderer-authored result is never termination authority. Only the
  // physical session id bound synchronously by the main spawn path may be
  // revoked here; otherwise a compromised renderer could name and kill an
  // unrelated PTY session (confused deputy).
  const sessionId = pending.replacementSessionId;
  let finalError = error;
  if (sessionId) {
    const exited = await terminateRecoveryReplacement(sessionId);
    if (!exited) {
      finalError =
        `${error}; replacement physical exit was not proven`;
    }
    if (pendingPaneRecoveries.get(requestId) === pending) {
      pendingPaneRecoveries.delete(requestId);
    }
  } else if (
    !options.retainUnboundGrant &&
    pendingPaneRecoveries.get(requestId) === pending
  ) {
    pendingPaneRecoveries.delete(requestId);
  }
  resolvePaneRecoveryOnce(pending, {
    requestId,
    ok: false,
    paneId: pending.request.paneId,
    ...(sessionId ? { sessionId } : {}),
    error: finalError,
  });
}

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
  paneSyncGenerationByOwner.delete(wc.id);
  mirroredOwners.delete(wc.id);
  const removed = panes.filter((registered) => registered.owner === wc);
  const removedPaneIds = removed.map((registered) => registered.entry.paneId);
  for (const registered of removed) {
    const meta = orchMetaByPane.get(
      paneMetaKey(wc, registered.entry.paneId),
    );
    const agent = registered.entry.sessionId
      ? getAgentSessionInfo(registered.entry.sessionId)
      : null;
    const scope = meta?.scope ?? agent?.scope;
    if (scope) retainRenderedMissionPaneHeadless(registered, scope);
  }
  panes = panes.filter((registered) => registered.owner !== wc);
  for (const paneId of removedPaneIds) {
    orchMetaByPane.delete(paneMetaKey(wc, paneId));
  }
  // Sem renderer não há como o spawn completar — resolver já, senão cada
  // nexus_pane_spawn pendura o orquestrador por 30s até o timeout.
  for (const [requestId, pending] of [...pendingSpawns]) {
    if (pending.owner !== wc) continue;
    void settlePendingSpawnFailure(
      requestId,
      pending,
      "renderer window closed during spawn",
      { allowMainFallback: true },
    );
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
  for (const [requestId, expired] of [...expiredBrowserOpens]) {
    if (expired.owner !== wc) continue;
    clearTimeout(expired.timer);
    expiredBrowserOpens.delete(requestId);
  }
  for (const [requestId, pending] of [...pendingPaneRecoveries]) {
    if (pending.owner !== wc) continue;
    void settlePaneRecoveryFailure(
      requestId,
      pending,
      "renderer window closed during pane recovery",
      { retainUnboundGrant: pending.claimed },
    );
  }
}

function rendererAvailable(): boolean {
  return (
    orchRenderer !== null &&
    !orchRenderer.isDestroyed() &&
    !orchRenderer.isCrashed()
  );
}

function rendererForMission(
  missionId?: string,
  scope?: ProjectExecutionScope,
): WebContents | null {
  if (missionId) {
    const owners = new Set<WebContents>();
    for (const registered of panes) {
      const meta = orchMetaByPane.get(
        paneMetaKey(registered.owner, registered.entry.paneId),
      );
      if (
        meta?.missionId === missionId &&
        meta.role === "orchestrator" &&
        // Mission ids are not cross-project authority: a homonymous mission
        // in another workspace must never select this owner.
        (!scope || !meta.scope || sameProjectScope(meta.scope, scope)) &&
        !registered.owner.isDestroyed() &&
        !registered.owner.isCrashed()
      )
        owners.add(registered.owner);
    }
    if (owners.size === 1) return [...owners][0];
  }
  if (!rendererAvailable()) return null;
  if (!scope) return orchRenderer;
  const rendererScope = getRendererWorkspaceScope(orchRenderer!);
  return rendererScope && sameProjectScope(rendererScope, scope)
    ? orchRenderer
    : null;
}

export function initPaneRegistry(): void {
  tapSessionData((sessionId, data) => {
    recordPaneSessionData(sessionId, data);
    devServerScanner.onData(sessionId, data);
  });

  tapSessionState((sessionId, state) => {
    recordPaneSessionState(sessionId, state);
  });

  tapSessionExit((sessionId) => {
    devServerScanner.onExit(sessionId);
    scopeBySession.delete(sessionId);
    recordPaneSessionExit(sessionId);
  });
}

/**
 * Renderers that completed at least one pane sync — including an empty
 * layout. Pane absence only becomes actionable (recovery-eligible) after the
 * renderer of that workspace scope has mirrored; a bare snapshot count cannot
 * represent "mirrored but currently zero panes".
 */
const mirroredOwners = new Map<number, WebContents>();
/** Last preload/document generation observed for each stable WebContents. */
const paneSyncGenerationByOwner = new Map<number, string>();

/**
 * True once any live renderer bound to this workspace scope has synced its
 * pane layout at least once (even `syncPanes([])`).
 */
export function hasMirroredWorkspaceScope(
  scope: ProjectExecutionScope,
): boolean {
  for (const [id, owner] of mirroredOwners) {
    if (owner.isDestroyed()) {
      mirroredOwners.delete(id);
      continue;
    }
    const rendererScope = getRendererWorkspaceScope(owner);
    if (rendererScope && sameProjectScope(rendererScope, scope)) return true;
  }
  return false;
}

/** Renderer → main: replace the pane mirror (payload already zod-validated). */
let panesVersion = 0;
const mainOwnedPaneHooks: MainOwnedPaneHooks = {
  attachSessionScope,
  assertMissionAuthorityCurrent: (input) => {
    assertMissionSpawnAuthorityCurrent(input);
  },
  panesChanged: () => {
    panesVersion += 1;
  },
};
/** Bumped a cada sync — invalida índices derivados (ex.: pipes por sessão). */
export function getPanesVersion(): number {
  return panesVersion;
}

function webContentsForScopeOwner(owner: { id: number }): WebContents | null {
  const direct = owner as Partial<WebContents>;
  if (
    typeof direct.isDestroyed === "function" &&
    typeof direct.isCrashed === "function"
  ) {
    return owner as WebContents;
  }
  if (orchRenderer?.id === owner.id) return orchRenderer;
  const mirrored = mirroredOwners.get(owner.id);
  if (mirrored) return mirrored;
  return (
    panes.find((registered) => registered.owner.id === owner.id)?.owner ??
    [...pendingSpawns.values()].find(
      (pending) => pending.owner.id === owner.id,
    )?.owner ??
    [...pendingPaneRecoveries.values()].find(
      (pending) => pending.owner.id === owner.id,
    )?.owner ??
    null
  );
}

function retainRenderedMissionPaneHeadless(
  registered: RegisteredPane,
  previousScope: ProjectExecutionScope,
): boolean {
  const { entry, owner } = registered;
  const sessionId = entry.sessionId;
  const declaredMeta = orchMetaByPane.get(paneMetaKey(owner, entry.paneId));
  const agent = sessionId ? getAgentSessionInfo(sessionId) : null;
  const meta: OrchMeta | undefined =
    declaredMeta ??
    (agent?.missionId &&
    (agent.role === "orchestrator" || agent.role === "worker")
      ? {
          missionId: agent.missionId,
          agentName: agent.agentName,
          workerIncarnationId: agent.workerIncarnationId,
          role: agent.role,
          allowedTools: agent.allowedTools,
          allowedSkills: agent.allowedSkills,
          scope: agent.scope,
          executionScope: agent.scope,
          readOnly: agent.readOnly,
          nativeReadOnly: agent.nativeReadOnly,
          contextRevision: agent.authoritySeal?.contextRevision,
          authoritySeal: agent.authoritySeal
            ? Object.freeze({ ...agent.authoritySeal })
            : undefined,
        }
      : undefined);
  if (
    !sessionId ||
    !meta?.missionId ||
    (meta.role !== "orchestrator" && meta.role !== "worker") ||
    !meta.scope ||
    !sameProjectScope(meta.scope, previousScope)
  ) {
    return false;
  }
  if (meta.role === "worker") {
    try {
      assertMissionSpawnAuthorityCurrent({
        missionId: meta.missionId,
        scope: meta.scope,
        contextRevision: meta.contextRevision,
        authoritySeal: meta.authoritySeal,
      });
    } catch {
      void terminateRecoveryReplacement(sessionId);
      return true;
    }
  }
  const detached = Boolean(
    agent?.missionId === meta.missionId &&
      agent.role === meta.role &&
      sameProjectScope(agent.scope, previousScope) &&
      detachOwnedMissionAgentSession(owner, sessionId),
  );
  if (!detached) {
    void terminateRecoveryReplacement(sessionId);
    return true;
  }
  setMainOwnedPane(entry.paneId, {
    entry: { ...entry },
    meta: {
      ...meta,
      scope: Object.freeze({ ...meta.scope }),
      executionScope: meta.executionScope
        ? Object.freeze({ ...meta.executionScope })
        : meta.scope,
    },
  });
  return true;
}

/**
 * Preserve a claimed mission spawn only after renderer presentation authority
 * has been revoked. The PTY inventory must agree with the main-authored
 * pending request before transfer.
 */
function retainClaimedPendingSpawnHeadless(
  requestId: string,
  pending: PendingSpawn,
): OrchPaneSpawnResult | null {
  const sessionId = pending.claimedSessionId;
  if (!sessionId || !pending.meta.scope) return null;
  try {
    assertMissionSpawnAuthorityCurrent({
      missionId: pending.meta.missionId ?? "",
      scope: pending.meta.scope,
      contextRevision: pending.meta.contextRevision,
      authoritySeal: pending.meta.authoritySeal,
    });
  } catch {
    return null;
  }

  const retained = retainClaimedPendingSpawnRuntime(
    requestId,
    pending,
    mainOwnedPaneHooks,
  );
  if (retained?.sessionId) {
    if (detachOwnedMissionAgentSession(pending.owner, retained.sessionId)) {
      return retained;
    }
    if (retained.paneId) deleteMainOwnedPane(retained.paneId);
    return null;
  }
  return null;
}

async function settlePendingSpawnFailure(
  requestId: string,
  pending: PendingSpawn,
  error: string,
  options: {
    readonly allowMainFallback?: boolean;
    readonly retainClaimed?: boolean;
  } = {},
): Promise<void> {
  if (pending.settled) return;
  pending.settled = true;
  clearTimeout(pending.timer);
  pending.abortCleanup?.();
  pending.abortCleanup = undefined;
  if (pendingSpawns.get(requestId) === pending) {
    // Delete before any physical-exit await. A late renderer ACK cannot win
    // the race and a late bind is rejected by pty-ipc, which then tears down
    // the process it just created.
    pendingSpawns.delete(requestId);
  }

  const retained =
    options.retainClaimed === false
      ? null
      : retainClaimedPendingSpawnHeadless(requestId, pending);
  if (retained) {
    sendAttemptPaneCleanup(
      pending.owner,
      requestId,
      pending.request.paneId,
    );
    pending.resolve(retained);
    return;
  }

  if (pending.claimedSessionId) {
    const exited = await terminateRecoveryReplacement(
      pending.claimedSessionId,
    );
    sendAttemptPaneCleanup(
      pending.owner,
      requestId,
      pending.request.paneId,
    );
    pending.resolve({
      requestId,
      ok: false,
      error: exited
        ? error
        : `${error}; spawned physical session exit was not proven`,
    });
    return;
  }

  const fallback = options.allowMainFallback
    ? fallbackPendingSpawnToMainRuntime(pending, mainOwnedPaneHooks)
    : null;
  sendAttemptPaneCleanup(
    pending.owner,
    requestId,
    pending.request.paneId,
  );
  pending.resolve(
    fallback ?? {
      requestId,
      ok: false,
      error,
    },
  );
}

function handleRendererWorkspaceScopeChange(
  owner: WebContents,
  previousScope: ProjectExecutionScope,
): void {
  const removedPaneIds = new Set<string>();
  for (const registered of panes) {
    if (
      registered.owner === owner &&
      retainRenderedMissionPaneHeadless(registered, previousScope)
    ) {
      removedPaneIds.add(registered.entry.paneId);
    }
  }
  if (removedPaneIds.size > 0) {
    panes = panes.filter(
      (registered) =>
        registered.owner !== owner ||
        !removedPaneIds.has(registered.entry.paneId),
    );
    for (const paneId of removedPaneIds) {
      orchMetaByPane.delete(paneMetaKey(owner, paneId));
    }
    panesVersion += 1;
  }

  for (const [requestId, pending] of [...pendingSpawns]) {
    if (
      pending.owner !== owner ||
      !pending.meta.scope ||
      !sameProjectScope(pending.meta.scope, previousScope)
    ) {
      continue;
    }
    void settlePendingSpawnFailure(
      requestId,
      pending,
      "renderer workspace changed during pane spawn",
      { allowMainFallback: true },
    );
  }

  for (const [requestId, pending] of [...pendingBrowserOpens]) {
    if (
      pending.owner !== owner ||
      !pending.meta.scope ||
      !sameProjectScope(pending.meta.scope, previousScope)
    ) {
      continue;
    }
    clearTimeout(pending.timer);
    pendingBrowserOpens.delete(requestId);
    retainExpiredBrowserOpen(requestId, pending);
    pending.resolve({
      requestId,
      ok: false,
      error: "renderer workspace changed during browser open",
    });
  }

  for (const [requestId, pending] of [...pendingPaneRecoveries]) {
    if (
      pending.owner !== owner ||
      !sameProjectScope(pending.scope, previousScope)
    ) {
      continue;
    }
    void settlePaneRecoveryFailure(
      requestId,
      pending,
      "renderer workspace changed during pane recovery",
      { retainUnboundGrant: pending.claimed },
    );
  }
}

onRendererWorkspaceScopeChange((scopeOwner, previous, next) => {
  if (
    !previous ||
    (next && sameProjectScope(previous, next))
  ) {
    return;
  }
  const owner = webContentsForScopeOwner(scopeOwner);
  if (owner) handleRendererWorkspaceScopeChange(owner, previous);
});

function beginRendererPaneGeneration(
  owner: WebContents,
  generationId: string | undefined,
  accepted: readonly PaneRegistryEntry[],
): void {
  if (!generationId) return;
  const previous = paneSyncGenerationByOwner.get(owner.id);
  if (previous === generationId) return;
  paneSyncGenerationByOwner.set(owner.id, generationId);

  const scope = getRendererWorkspaceScope(owner);
  if (!scope) return;
  // A new preload means the previous document lost its terminal-host map even
  // when Electron reused the same WebContents (Cmd+R/HMR). Preserve only
  // mission sessions not already reattached by the incoming generation.
  const alreadyAttached = new Set(
    accepted
      .filter((entry) => entry.sessionId !== null)
      .map((entry) => entry.paneId),
  );
  for (const registered of panes) {
    if (
      registered.owner === owner &&
      !alreadyAttached.has(registered.entry.paneId)
    ) {
      retainRenderedMissionPaneHeadless(registered, scope);
    }
  }
}

type MainOwnedPanePresentationResolution =
  | {
      readonly kind: "present";
      readonly request: MissionPanePresentationRequest;
    }
  | {
      readonly kind: "skip";
    }
  | {
      readonly kind: "stale";
      readonly reason: string;
    };

const staleMainOwnedPaneRetirements = new Map<string, Promise<void>>();

function sameExactProjectScope(
  left: Readonly<ProjectExecutionScope>,
  right: Readonly<ProjectExecutionScope>,
): boolean {
  return left.version === right.version && sameProjectScope(left, right);
}

function stalePresentation(reason: string): MainOwnedPanePresentationResolution {
  return { kind: "stale", reason };
}

function resolveMainOwnedPanePresentation(
  ownerScope: ProjectExecutionScope,
  pane: MainOwnedPane,
): MainOwnedPanePresentationResolution {
  const { entry, meta } = pane;
  const sessionId = entry.sessionId;
  const missionId = meta.missionId;
  const role = meta.role;
  if (meta.transient === true) return { kind: "skip" };
  if (!meta.scope || !sameExactProjectScope(ownerScope, meta.scope)) {
    return { kind: "skip" };
  }
  if (entry.kind !== "cli-agent") {
    return stalePresentation("main-owned entry is not a CLI agent");
  }
  if (!sessionId) {
    return stalePresentation("main-owned entry has no physical session");
  }
  if (getSessionState(sessionId) === null) {
    return stalePresentation("main-owned physical session has exited");
  }
  if (!missionId || (role !== "orchestrator" && role !== "worker")) {
    return stalePresentation("main-owned entry has no mission role authority");
  }
  const agent = getAgentSessionInfo(sessionId);
  const executionScope = meta.executionScope ?? meta.scope;
  if (
    !agent ||
    agent.sessionId !== sessionId ||
    agent.paneId !== entry.paneId ||
    agent.missionId !== missionId ||
    agent.role !== role ||
    agent.adapterId !== entry.adapterId ||
    (!sameProjectScope(agent.scope, executionScope) &&
      !sameProjectScope(agent.scope, meta.scope))
  ) {
    return stalePresentation("physical PTY identity diverges from pane runtime");
  }

  let spec: MissionPaneSpec | null | undefined;
  let currentSeal: MissionPaneAuthoritySeal;
  try {
    const stores = getProjectDomainStores(meta.scope);
    const mission = stores.missions.get(missionId);
    spec = stores.missionPanes.findByPaneId(entry.paneId);
    if (!mission || mission.id !== missionId) {
      return stalePresentation("durable mission no longer exists");
    }
    if (
      !spec ||
      spec.missionId !== missionId ||
      spec.paneId !== entry.paneId ||
      spec.role !== role ||
      spec.adapterId !== entry.adapterId ||
      spec.workerIncarnationId !== meta.workerIncarnationId ||
      !spec.scope ||
      !sameExactProjectScope(meta.scope, spec.scope) ||
      isAutomatedReviewerCompositionPane(spec)
    ) {
      return stalePresentation("durable mission pane spec is stale or missing");
    }
    currentSeal = resolveCurrentMissionSpawnAuthoritySeal(meta.scope, missionId);
  } catch (error) {
    return stalePresentation(
      error instanceof Error
        ? error.message
        : "durable mission authority is unavailable",
    );
  }
  if (
    !sameMissionPaneAuthoritySeal(spec.authoritySeal, currentSeal) ||
    !sameMissionPaneAuthoritySeal(meta.authoritySeal, currentSeal) ||
    !sameMissionPaneAuthoritySeal(agent.authoritySeal, currentSeal)
  ) {
    return stalePresentation("mission pane authority seal is no longer current");
  }
  return {
    kind: "present",
    request: {
      missionId,
      paneId: entry.paneId,
      sessionId,
      role,
      pane: {
        adapterId: agent.adapterId,
        ...(agent.requestedModel ?? entry.model
          ? { model: agent.requestedModel ?? entry.model }
          : {}),
        ...(agent.accountId ? { accountId: agent.accountId } : {}),
        ...(agent.effort ? { effort: agent.effort } : {}),
        cwd: agent.cwd,
        title: entry.title,
        ...(agent.agentName ? { agentName: agent.agentName } : {}),
        role,
      },
    },
  };
}

function staleMainOwnedPaneRetirementKey(pane: MainOwnedPane): string {
  return `${pane.entry.paneId}\u0000${pane.entry.sessionId ?? ""}`;
}

function retireStaleMainOwnedPane(
  pane: MainOwnedPane,
  reason: string,
): void {
  const key = staleMainOwnedPaneRetirementKey(pane);
  if (staleMainOwnedPaneRetirements.has(key)) return;
  const { paneId, sessionId } = pane.entry;
  const retirement = (async () => {
    try {
      if (sessionId && getSessionState(sessionId) !== null) {
        const exited = await orchTerminateSession(sessionId);
        if (!exited) {
          console.warn(
            `[pane-registry] stale pane remains live pane=${paneId} ` +
              `session=${sessionId}: ${reason}`,
          );
          return;
        }
      }
      const current = getMainOwnedPane(paneId);
      if (
        current !== pane ||
        current.entry.sessionId !== sessionId
      ) {
        return;
      }
      if (deleteMainOwnedPane(paneId)) {
        mainOwnedPaneHooks.panesChanged();
      }
    } catch (error) {
      console.warn(
        `[pane-registry] stale pane retirement failed pane=${paneId} ` +
          `session=${sessionId ?? "none"}:`,
        error instanceof Error ? error.message : error,
      );
    } finally {
      staleMainOwnedPaneRetirements.delete(key);
    }
  })();
  staleMainOwnedPaneRetirements.set(key, retirement);
}

function requestMainOwnedPanePresentations(owner: WebContents): void {
  const scope = getRendererWorkspaceScope(owner);
  if (!scope || owner.isDestroyed() || owner.isCrashed()) return;
  for (const pane of mainOwnedPaneValues()) {
    const resolution = resolveMainOwnedPanePresentation(scope, pane);
    if (resolution.kind === "skip") continue;
    if (resolution.kind === "stale") {
      retireStaleMainOwnedPane(pane, resolution.reason);
      continue;
    }
    const { request } = resolution;
    try {
      owner.send(ORCH_CHANNELS.panePresentationRequest, request);
    } catch (error) {
      // Presentation is replayed by the next pane sync. The PTY remains
      // Main-owned and must never be terminated because one document vanished.
      console.warn(
        `[pane-registry] presentation skipped for ${request.paneId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}

export function syncPanes(
  entries: PaneRegistryEntry[],
  owner: WebContents,
  generationId?: string,
): void {
  panesVersion += 1;
  mirroredOwners.set(owner.id, owner);
  const paneIdCounts = new Map<string, number>();
  for (const entry of entries) {
    paneIdCounts.set(entry.paneId, (paneIdCounts.get(entry.paneId) ?? 0) + 1);
  }
  const accepted = entries.filter(
    (entry) =>
      paneIdCounts.get(entry.paneId) === 1 &&
      (!entry.sessionId ||
        isSessionOwnedBy(owner, entry.sessionId)),
  );
  beginRendererPaneGeneration(owner, generationId, accepted);
  for (const entry of accepted) {
    const detached = getMainOwnedPane(entry.paneId);
    if (
      detached &&
      entry.sessionId &&
      detached.entry.sessionId === entry.sessionId
    ) {
      deleteMainOwnedPane(entry.paneId);
    }
  }
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
  requestMainOwnedPanePresentations(owner);
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
  return paneSessionStateForEntry(entry);
}

function snapshotOf(registered: RegisteredPane): PaneSnapshot {
  const { entry, owner } = registered;
  const meta = orchMetaByPane.get(paneMetaKey(owner, entry.paneId));
  const sessionScope = entry.sessionId
    ? scopeBySession.get(entry.sessionId)
    : undefined;
  // Scope precedence is explicit: the live session binding is the authority;
  // orch meta is only a fallback. A stale meta.scope must never override it.
  const scope = sessionScope ?? meta?.scope;
  return {
    ...entry,
    state: paneState(entry),
    ...meta,
    ...(scope ? { scope } : {}),
  };
}

export function listPaneSnapshots(): PaneSnapshot[] {
  return [...panes.map(snapshotOf), ...listMainOwnedPaneSnapshots(paneState)];
}

/** nexus_pane_list scoped to what the caller may see (SEC#5 info disclosure):
 * a worker sees only its own mission's panes, never the user's shells. */
export function listVisiblePaneSnapshots(caller: CallerCtx): PaneSnapshot[] {
  const rendered = panes
    .filter((registered) => canListPane(caller, authzInfoOf(registered)))
    .map(snapshotOf);
  const detached = listVisibleMainOwnedPaneSnapshots(caller, paneState);
  return [...rendered, ...detached];
}

export function findPane(paneIdOrSessionId: string): PaneRegistryEntry | null {
  const rendered = panes
    .filter(
      ({ entry }) =>
        entry.paneId === paneIdOrSessionId ||
        entry.sessionId === paneIdOrSessionId,
    )
    .map(({ entry }) => entry);
  const detached = findMainOwnedPaneEntries(paneIdOrSessionId);
  const matches = [...rendered, ...detached];
  return matches.length === 1 ? matches[0] : null;
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
  return matches.length === 1 ? Object.freeze({ ...matches[0].entry }) : null;
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
    workerIncarnationId: meta?.workerIncarnationId,
    scope:
      meta?.scope ??
      (entry.sessionId ? scopeBySession.get(entry.sessionId) : undefined),
    executionScope: meta?.executionScope,
  };
}

/** Resolve a pane (by paneId or sessionId) to the info the authz check needs. */
export function getPaneAuthzInfo(paneRef: string): PaneAuthzInfo | null {
  const matches = [
    ...panes
      .filter(
        ({ entry }) => entry.paneId === paneRef || entry.sessionId === paneRef,
      )
      .map(authzInfoOf),
    ...findMainOwnedPaneAuthz(paneRef),
  ];
  return matches.length === 1 ? matches[0] : null;
}

export type OwnedPaneAuthzInfo = Readonly<PaneAuthzInfo> & {
  readonly owner: WebContents;
};

export type PaneRuntimeAuthority = Readonly<PaneAuthzInfo> & {
  /** Null means the physical PTY is currently main-owned/headless. */
  readonly owner: WebContents | null;
};

/** Exact runtime authority, including a renderer-independent mission pane. */
export function getPaneRuntimeAuthorityBySession(
  sessionId: string,
): PaneRuntimeAuthority | null {
  const matches: PaneRuntimeAuthority[] = [
    ...panes
      .filter(({ entry }) => entry.sessionId === sessionId)
      .map((registered) =>
        Object.freeze({
          ...authzInfoOf(registered),
          owner: registered.owner,
        }),
      ),
    ...findMainOwnedRuntimeAuthority(sessionId),
  ];
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Main-process authority for a pane/session. Duplicate renderer-controlled ids
 * are deliberately ambiguous and fail closed; callers never guess an owner.
 */
export function getOwnedPaneAuthzInfo(
  paneRef: string,
): OwnedPaneAuthzInfo | null {
  if (hasMainOwnedPaneReference(paneRef)) {
    return null;
  }
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
  if (hasMainOwnedPaneSession(sessionId)) {
    return null;
  }
  const matches = panes.filter(({ entry }) => entry.sessionId === sessionId);
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

export type PaneSpawnOptions = MainOwnedPaneSpawnOptions;

/**
 * Resolve the exact current mission/workflow/squad authority exclusively from
 * main-owned stores. Callers may carry an expected seal, but never author the
 * value that reaches a physical provider process.
 */
export function resolveCurrentMissionSpawnAuthoritySeal(
  scope: Readonly<ProjectExecutionScope>,
  missionId: string,
) {
  const mission = getProjectDomainStores(scope).missions.get(missionId);
  const squads = listSquads().filter(
    (candidate) => candidate.id === mission?.squadId,
  );
  const authoritySeal =
    mission && squads.length === 1
      ? resolveMissionPaneAuthoritySeal(scope, mission, squads[0])
      : null;
  if (!authoritySeal) {
    throw new Error(
      "mission pane authority seal is unavailable; replane and approve " +
        "the current mission revision",
    );
  }
  return Object.freeze({ ...authoritySeal });
}

/**
 * Exact pre-effect fence for a mission process. `contextRevision` is merely a
 * projection of the complete authority seal: accepting it independently
 * would let a stale intent/squad/workflow combination retain process power.
 */
export function assertMissionSpawnAuthorityCurrent(input: {
  readonly missionId: string;
  readonly scope: Readonly<ProjectExecutionScope>;
  readonly contextRevision?: string;
  readonly authoritySeal?: MissionPaneAuthoritySeal;
}): void {
  const expected = input.authoritySeal;
  if (!expected) {
    throw new Error(
      "mission pane authority seal is unavailable; replane and approve " +
        "the current mission revision",
    );
  }
  if (
    input.contextRevision !== undefined &&
    input.contextRevision !== expected.contextRevision
  ) {
    throw new Error(
      "mission pane contextRevision diverges from its main-owned authority seal",
    );
  }
  const current = resolveCurrentMissionSpawnAuthoritySeal(
    input.scope,
    input.missionId,
  );
  if (!sameMissionPaneAuthoritySeal(expected, current)) {
    throw new Error(
      "stale mission pane authority; replane and approve the current revision",
    );
  }
}

function canonicalMissionPaneSpawnOptions<T extends PaneSpawnOptions>(
  options: T,
): T {
  if (
    !options.missionId ||
    (options.role !== "orchestrator" && options.role !== "worker")
  ) {
    return options;
  }
  const current = resolveCurrentMissionSpawnAuthoritySeal(
    options.scope,
    options.missionId,
  );
  if (
    options.contextRevision !== undefined &&
    options.contextRevision !== current.contextRevision
  ) {
    throw new Error(
      "mission pane contextRevision is stale; use the current main-owned " +
        "authority seal revision",
    );
  }
  if (
    options.authoritySeal &&
    !sameMissionPaneAuthoritySeal(options.authoritySeal, current)
  ) {
    throw new Error(
      "stale mission pane authority; replane and approve the current revision",
    );
  }
  return {
    ...options,
    contextRevision: current.contextRevision,
    authoritySeal: current,
  };
}

/** Pending gate context plus the exact main-authored process request. */
export type PendingSpawnMeta = OrchMeta & {
  /** Main-only first turn; never renderer-authored or included in snapshots. */
  initialPrompt?: string;
  requestedCwd?: string;
  sealedRequest?: Readonly<OrchPaneSpawnRequest>;
};

export interface PendingRecoverySpawnMeta {
  readonly scope: Readonly<ProjectExecutionScope>;
  readonly request: Readonly<MissionPaneRecoveryRequest>;
}

function claimPendingSpawn(
  pending: PendingSpawn,
  owner: WebContents,
): PendingSpawnMeta | null {
  if (pending.owner !== owner || pending.claimed) return null;
  if (!pending.meta.scope) return null;
  try {
    requireLiveRendererWorkspaceScope(owner, pending.meta.scope);
  } catch {
    return null;
  }
  pending.claimed = true;
  return {
    ...pending.meta,
    ...(pending.initialPrompt === undefined
      ? {}
      : { initialPrompt: pending.initialPrompt }),
    authoritySeal: pending.meta.authoritySeal
      ? Object.freeze({ ...pending.meta.authoritySeal })
      : undefined,
    ...(pending.requestedCwd === undefined
      ? {}
      : { requestedCwd: pending.requestedCwd }),
    sealedRequest: Object.freeze({ ...pending.request }),
  };
}

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
  return pending ? claimPendingSpawn(pending, owner) : null;
}

/**
 * Recover the same one-shot grant when renderer presentation lost only its
 * opaque request id during a React/layout remount. Pane id is not authority:
 * Main requires one unique, still-unclaimed record for the exact owner and
 * mission, then returns the original sealed request so every renderer field
 * is canonicalized before any provider effect.
 */
export function claimPendingSpawnMetaByPane(
  input: {
    readonly paneId: string;
    readonly missionId: string;
  },
  owner: WebContents,
): PendingSpawnMeta | null {
  const matches = [...pendingSpawns.values()].filter(
    (pending) =>
      pending.owner === owner &&
      !pending.claimed &&
      pending.request.paneId === input.paneId &&
      pending.request.missionId === input.missionId &&
      pending.meta.missionId === input.missionId,
  );
  if (matches.length !== 1) return null;
  return claimPendingSpawn(matches[0], owner);
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
  if (!pending.meta.scope) return false;
  try {
    requireLiveRendererWorkspaceScope(owner, pending.meta.scope);
  } catch {
    return false;
  }
  pending.claimedSessionId = sessionId;
  return true;
}

/**
 * Pre-effect fence for renderer-hosted provider setup. Claiming a grant gives
 * the renderer metadata, not indefinite spawn authority: the main pending
 * record and workspace binding must still be live immediately before the
 * physical PTY/RPC child is created.
 */
export function assertPendingSpawnGrantActive(
  requestId: string,
  owner: WebContents,
): void {
  const pending = pendingSpawns.get(requestId);
  if (!pending || pending.owner !== owner || !pending.claimed) {
    throw new Error("orchestration pane spawn grant expired before process start");
  }
  if (!pending.meta.scope) {
    throw new Error("orchestration pane spawn grant has no workspace authority");
  }
  requireLiveRendererWorkspaceScope(owner, pending.meta.scope);
}

/**
 * Claim the one fresh persisted-pane spawn authorized by a recovery request.
 * A timed-out/settled grant is still retained as a tombstone so a renderer
 * whose provider/account preflight finishes late cannot create an orphan.
 */
export function claimPendingRecoverySpawnMeta(
  requestId: string,
  owner: WebContents,
): PendingRecoverySpawnMeta | null {
  const pending = pendingPaneRecoveries.get(requestId);
  if (!pending || pending.owner !== owner) return null;
  requireLiveRendererWorkspaceScope(owner, pending.scope);
  if (pending.settled) {
    if (!pending.claimed) pendingPaneRecoveries.delete(requestId);
    throw new Error('pane recovery spawn grant is no longer active');
  }
  if (pending.claimed) return null;
  pending.claimed = true;
  return Object.freeze({
    scope: Object.freeze({ ...pending.scope }),
    request: Object.freeze({ ...pending.request }),
  });
}

/** Bind a claimed recovery grant to its physical replacement immediately. */
export function bindPendingRecoverySpawnSession(
  requestId: string,
  owner: WebContents,
  sessionId: string,
): boolean {
  const pending = pendingPaneRecoveries.get(requestId);
  if (
    !pending ||
    pending.owner !== owner ||
    !pending.claimed ||
    pending.replacementSessionId !== null
  ) {
    return false;
  }
  pending.replacementSessionId = sessionId;
  try {
    requireLiveRendererWorkspaceScope(owner, pending.scope);
  } catch {
    pending.settled = true;
  }
  if (!pending.settled) return true;
  void settlePaneRecoveryFailure(
    requestId,
    pending,
    'pane recovery authority expired before replacement bind',
  );
  return false;
}

/** Exact pre-effect counterpart of claimPendingRecoverySpawnMeta(). */
export function assertPendingRecoverySpawnGrantActive(
  requestId: string,
  owner: WebContents,
): void {
  const pending = pendingPaneRecoveries.get(requestId);
  if (
    !pending ||
    pending.owner !== owner ||
    !pending.claimed ||
    pending.settled
  ) {
    throw new Error("pane recovery spawn grant expired before process start");
  }
  requireLiveRendererWorkspaceScope(owner, pending.scope);
}

/**
 * Main-owned proof of life for a stable pane id: does ANY registered session
 * (renderer grid or main-owned envelope) still have a live PTY? This is the
 * evidence the spawn fence trusts to allow an explicitly fresh persisted
 * spawn without a recovery grant — the renderer's word is never enough to
 * destroy a live identity.
 */
export function hasLivePaneSession(paneId: string): boolean {
  const owned = getMainOwnedPane(paneId);
  if (
    owned?.entry.sessionId &&
    getSessionState(owned.entry.sessionId) !== null
  ) {
    return true;
  }
  return panes.some(
    ({ entry }) =>
      entry.paneId === paneId &&
      typeof entry.sessionId === "string" &&
      getSessionState(entry.sessionId) !== null,
  );
}

/**
 * Create a mission pane/session. A live renderer gets first chance to present
 * it; when none exists (or it disappears before ACK), main creates/retains the
 * physical PTY and returns the same stable pane/session contract.
 */
export function spawnMainOwnedMissionPane(
  options: PaneSpawnOptions & {
    missionId: string;
    role: "orchestrator" | "worker";
  },
): OrchPaneSpawnResult {
  try {
    return spawnMainOwnedMissionPaneRuntime(
      canonicalMissionPaneSpawnOptions(options),
      mainOwnedPaneHooks,
    );
  } catch (error) {
    return {
      requestId: "",
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "mission pane authority is stale",
    };
  }
}

export function requestPaneSpawn(
  options: PaneSpawnOptions & { readonly abortSignal?: AbortSignal },
): Promise<OrchPaneSpawnResult> {
  if (options.abortSignal?.aborted) {
    return Promise.resolve({
      requestId: "",
      ok: false,
      error:
        typeof options.abortSignal.reason === "string"
          ? options.abortSignal.reason
          : "pane spawn authority was revoked",
    });
  }
  try {
    options = canonicalMissionPaneSpawnOptions(options);
  } catch (error) {
    return Promise.resolve({
      requestId: "",
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "mission pane authority is stale",
    });
  }
  if (options.transient === true) {
    if (
      !options.missionId ||
      (options.role !== "orchestrator" && options.role !== "worker")
    ) {
      return Promise.resolve({
        requestId: "",
        ok: false,
        error: "transient pane requires main-owned mission authority",
      });
    }
    // Internal verification lanes must not contend for renderer layout slots
    // or enter crash recovery. Main still owns the physical PTY and registry
    // proof, while the pane remains headless and process-local.
    return Promise.resolve(
      spawnMainOwnedMissionPane({
        ...options,
        missionId: options.missionId,
        role: options.role,
      }),
    );
  }
  const owner = rendererForMission(options.missionId, options.scope);
  if (!owner) {
    if (
      options.missionId &&
      (options.role === "orchestrator" || options.role === "worker")
    ) {
      return Promise.resolve(
        spawnMainOwnedMissionPane({
          ...options,
          missionId: options.missionId,
          role: options.role,
        }),
      );
    }
    return Promise.resolve({
      requestId: "",
      ok: false,
      error: "no renderer window available",
    });
  }
  try {
    requireLiveRendererWorkspaceScope(owner, options.scope);
  } catch {
    if (
      options.missionId &&
      (options.role === "orchestrator" || options.role === "worker")
    ) {
      return Promise.resolve(
        spawnMainOwnedMissionPane({
          ...options,
          missionId: options.missionId,
          role: options.role,
        }),
      );
    }
    return Promise.resolve({
      requestId: "",
      ok: false,
      error: "pane renderer workspace scope changed",
    });
  }
  const requestId = makeId("orchspawn");
  const paneId = makeId("pane");
  const executionScope = options.executionScope ?? options.scope;
  const requestedCwd = options.cwd ?? executionScope.rootRealPath;
  const request: OrchPaneSpawnRequest = Object.freeze({
    requestId,
    paneId,
    adapterId: options.adapterId,
    model: options.model,
    accountId: options.accountId,
    effort: options.effort,
    cwd: requestedCwd,
    title: options.title,
    missionId: options.missionId,
    transient: options.transient === true ? true : undefined,
    agentName: options.agentName,
    role: options.role,
    resume: false,
    resumeLatestOnly: false,
    restorePersistedAuthority: false,
  });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      void settlePendingSpawnFailure(
        requestId,
        pending,
        "pane spawn timed out",
        { allowMainFallback: true },
      );
    }, SPAWN_TIMEOUT_MS);
    const pending: PendingSpawn = {
      resolve,
      timer,
      owner,
      initialPrompt: options.initialPrompt,
      claimed: false,
      claimedSessionId: null,
      requestedCwd,
      request,
      lastSentAt: Date.now(),
      attempts: 1,
      settled: false,
      meta: {
        missionId: options.missionId,
        contextRevision: options.contextRevision,
        agentName: options.agentName,
        workerIncarnationId: options.workerIncarnationId,
        allowedTools: options.allowedTools,
        allowedSkills: options.allowedSkills,
        role: options.role,
        transient: options.transient === true ? true : undefined,
        scope: options.scope,
        executionScope: options.executionScope,
        readOnly: options.readOnly === true,
        nativeReadOnly: options.nativeReadOnly,
        authoritySeal: options.authoritySeal
          ? Object.freeze({ ...options.authoritySeal })
          : undefined,
      },
    };
    pendingSpawns.set(requestId, pending);
    if (options.abortSignal) {
      const onAbort = () => {
        void settlePendingSpawnFailure(
          requestId,
          pending,
          typeof options.abortSignal?.reason === "string"
            ? options.abortSignal.reason
            : "pane spawn authority was revoked",
          { retainClaimed: false },
        );
      };
      options.abortSignal.addEventListener("abort", onAbort, { once: true });
      pending.abortCleanup = () =>
        options.abortSignal?.removeEventListener("abort", onAbort);
      if (options.abortSignal.aborted) {
        onAbort();
        return;
      }
    }
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
  const owner = rendererForMission(options.missionId, options.scope);
  if (!owner) {
    return Promise.resolve({
      requestId: "",
      ok: false,
      error: "no renderer window available",
    });
  }
  try {
    requireLiveRendererWorkspaceScope(owner, options.scope);
  } catch {
    return Promise.resolve({
      requestId: "",
      ok: false,
      error: "browser renderer workspace scope changed",
    });
  }
  const requestId = makeId("browseropen");
  const paneId = makeId("browser");
  const request: BrowserPaneOpenRequest = {
    requestId,
    paneId,
    url: options.url,
    title: options.title,
  };
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingBrowserOpens.delete(requestId);
      retainExpiredBrowserOpen(requestId, pending);
      resolve({ requestId, ok: false, error: "browser open timed out" });
    }, SPAWN_TIMEOUT_MS);
    const pending: PendingBrowserOpen = {
      resolve,
      timer,
      owner,
      paneId,
      meta: {
        missionId: options.missionId,
        agentName: options.agentName,
        role: options.role,
        scope: options.scope,
      },
    };
    pendingBrowserOpens.set(requestId, pending);
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
  if (!pending.meta.scope) return false;
  try {
    requireLiveRendererWorkspaceScope(owner, pending.meta.scope);
  } catch {
    handleRendererWorkspaceScopeChange(owner, pending.meta.scope);
    return true;
  }
  if (
    result.ok &&
    (!pending.claimedSessionId ||
      result.sessionId !== pending.claimedSessionId ||
      result.paneId !== pending.request.paneId)
  ) {
    return false;
  }
  if (!result.ok) {
    void settlePendingSpawnFailure(
      result.requestId,
      pending,
      result.error ?? "renderer pane spawn failed",
    );
    return true;
  }
  clearTimeout(pending.timer);
  pending.settled = true;
  pending.abortCleanup?.();
  pending.abortCleanup = undefined;
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
  if (!pending) {
    const expired = expiredBrowserOpens.get(result.requestId);
    if (!expired || expired.owner !== owner) return false;
    clearTimeout(expired.timer);
    expiredBrowserOpens.delete(result.requestId);
    // Never trust a renderer-selected paneId on a late acknowledgement and
    // never treat our expected paneId alone as proof of ownership.
    sendAttemptPaneCleanup(owner, result.requestId, expired.paneId);
    return true;
  }
  if (pending.owner !== owner) return false;
  if (!pending.meta.scope) return false;
  try {
    requireLiveRendererWorkspaceScope(owner, pending.meta.scope);
  } catch {
    clearTimeout(pending.timer);
    pendingBrowserOpens.delete(result.requestId);
    sendAttemptPaneCleanup(owner, result.requestId, pending.paneId);
    pending.resolve({
      requestId: result.requestId,
      ok: false,
      error: "renderer workspace changed during browser open",
    });
    return true;
  }
  clearTimeout(pending.timer);
  pendingBrowserOpens.delete(result.requestId);
  if (result.ok && result.paneId !== pending.paneId) {
    sendAttemptPaneCleanup(owner, result.requestId, pending.paneId);
    pending.resolve({
      requestId: result.requestId,
      ok: false,
      error: "renderer returned a different browser pane identity",
    });
    return true;
  }
  if (result.ok) {
    attachOrchMeta(owner, pending.paneId, pending.meta);
  } else {
    // The renderer may have inserted the pane before failing a later step.
    // Cleanup remains conditional on the request seal, so a pre-existing pane
    // with the same main-minted id is preserved.
    sendAttemptPaneCleanup(owner, result.requestId, pending.paneId);
  }
  pending.resolve(result);
  return true;
}

export async function requestMissionPaneRecovery(options: {
  missionId: string;
  paneId: string;
  role: "orchestrator" | "worker";
  expectedSessionId?: string;
  pane: MissionPaneSpec;
  scope: ProjectExecutionScope;
  recap: string;
}): Promise<MissionPaneRecoveryResult> {
  if (options.role === "worker") {
    return {
      requestId: "",
      ok: false,
      paneId: options.paneId,
      error:
        "worker pane recovery is dispatch-owned; resume or replan the blocked task",
    };
  }
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
      // Pane/mission ids repeat across projects; scope must agree when known.
      (!meta.scope || sameProjectScope(meta.scope, options.scope)) &&
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
  const owner =
    matches[0]?.owner ?? rendererForMission(options.missionId, options.scope);
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
  const currentPaneEntries = panes.filter(
    (registered) =>
      registered.owner === owner &&
      registered.entry.paneId === options.paneId,
  );
  if (currentPaneEntries.length > 1) {
    return {
      requestId: "",
      ok: false,
      paneId: options.paneId,
      error: "mission pane recovery runtime is ambiguous",
    };
  }
  const currentSessionId = currentPaneEntries[0]?.entry.sessionId;
  if (
    options.expectedSessionId &&
    currentSessionId &&
    currentSessionId !== options.expectedSessionId
  ) {
    return {
      requestId: "",
      ok: false,
      paneId: options.paneId,
      error: "mission pane session changed before physical termination",
    };
  }
  const sessionToTerminate =
    options.expectedSessionId ?? currentSessionId;
  if (sessionToTerminate) {
    const exited = getSessionState(sessionToTerminate) === null
      ? true
      : await orchTerminateSession(sessionToTerminate);
    if (!exited) {
      return {
        requestId: "",
        ok: false,
        paneId: options.paneId,
        error:
          "mission pane did not produce physical exit proof; recovery denied",
      };
    }
  }
  try {
    requireLiveRendererWorkspaceScope(owner, options.scope);
  } catch {
    return {
      requestId: "",
      ok: false,
      paneId: options.paneId,
      error: "mission pane renderer scope changed during termination",
    };
  }
  if (listAgentSessionsForPane(options.paneId).length > 0) {
    return {
      requestId: "",
      ok: false,
      paneId: options.paneId,
      error:
        "another physical mission runtime appeared during recovery; retry denied",
    };
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
    let pending!: PendingPaneRecovery;
    const timer = setTimeout(() => {
      void settlePaneRecoveryFailure(
        requestId,
        pending,
        "pane recovery timed out",
        { retainUnboundGrant: true },
      );
    }, RECOVERY_TIMEOUT_MS);
    pending = {
      resolve,
      timer,
      owner,
      request,
      scope: Object.freeze({ ...options.scope }),
      claimed: false,
      replacementSessionId: null,
      settled: false,
      resolutionSent: false,
    };
    pendingPaneRecoveries.set(requestId, pending);
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
  try {
    requireLiveRendererWorkspaceScope(owner, pending.scope);
  } catch {
    void settlePaneRecoveryFailure(
      result.requestId,
      pending,
      "mission pane renderer scope changed before recovery result",
      {
        retainUnboundGrant: pending.claimed,
      },
    );
    return true;
  }

  const replacementSessionId = pending.replacementSessionId;
  if (
    result.sessionId &&
    replacementSessionId &&
    result.sessionId !== replacementSessionId
  ) {
    return false;
  }
  if (!result.ok) {
    void settlePaneRecoveryFailure(
      result.requestId,
      pending,
      result.error ?? "pane recovery failed",
      {
        retainUnboundGrant: pending.claimed && !replacementSessionId,
      },
    );
    return true;
  }

  const previousSessionId = pending.request.expectedSessionId;
  if (
    pending.settled ||
    !result.sessionId ||
    !replacementSessionId ||
    result.sessionId !== replacementSessionId ||
    (previousSessionId && result.sessionId === previousSessionId)
  ) {
    return false;
  }
  const pane = findPaneOwnedBy(owner, result.paneId);
  if (pane?.sessionId !== result.sessionId) return false;
  const runtime = getPaneRuntimeAuthorityBySession(result.sessionId);
  if (
    runtime?.owner !== owner ||
    runtime.paneId !== pending.request.paneId ||
    runtime.missionId !== pending.request.missionId ||
    runtime.role !== pending.request.role
  ) {
    return false;
  }
  const meta = orchMetaByPane.get(paneMetaKey(owner, result.paneId));
  if (
    meta?.missionId !== pending.request.missionId ||
    meta.role !== pending.request.role ||
    (meta.scope && !sameProjectScope(meta.scope, pending.scope))
  ) {
    return false;
  }
  clearTimeout(pending.timer);
  pendingPaneRecoveries.delete(result.requestId);
  pending.settled = true;
  resolvePaneRecoveryOnce(pending, result);
  return true;
}

/**
 * Main-owned close: revoke and await the exact physical runtime first, then
 * remove main inventory / ask the renderer to collapse its visual leaf.
 */
export interface MissionPaneCloseRequest {
  readonly paneId: string;
  readonly missionId: string;
  readonly scope: Readonly<ProjectExecutionScope>;
  /** Optional exact process identity used by dispatch-owned worker cleanup. */
  readonly sessionId?: string;
  readonly role?: "orchestrator" | "worker";
  readonly workerIncarnationId?: string;
}

function matchesMissionPaneCloseAuthority(
  authority: Pick<
    PaneAuthzInfo,
    | "paneId"
    | "sessionId"
    | "missionId"
    | "role"
    | "workerIncarnationId"
    | "scope"
  >,
  expected: MissionPaneCloseRequest,
): boolean {
  return (
    authority.paneId === expected.paneId &&
    authority.missionId === expected.missionId &&
    (expected.sessionId === undefined ||
      authority.sessionId === expected.sessionId) &&
    (expected.role === undefined || authority.role === expected.role) &&
    (expected.workerIncarnationId === undefined ||
      authority.workerIncarnationId === expected.workerIncarnationId) &&
    Boolean(authority.scope && sameProjectScope(authority.scope, expected.scope))
  );
}

/**
 * Authority-sealed mission close. Selection and the final post-await commit
 * both revalidate scope + mission + pane identity; a homonymous pane in another
 * checkout can therefore never become a confused-deputy cleanup target.
 */
export async function requestMissionPaneClose(
  expected: MissionPaneCloseRequest,
): Promise<boolean> {
  const detached = getMainOwnedPane(expected.paneId);
  const renderedTargets = panes.filter(
    (candidate) =>
      candidate.entry.paneId === expected.paneId &&
      matchesMissionPaneCloseAuthority(authzInfoOf(candidate), expected),
  );

  if (detached) {
    if (renderedTargets.length > 0) return false;
    if (
      !matchesMissionPaneCloseAuthority(
        {
          paneId: detached.entry.paneId,
          sessionId: detached.entry.sessionId,
          missionId: detached.meta.missionId,
          role: detached.meta.role,
          workerIncarnationId: detached.meta.workerIncarnationId,
          scope: detached.meta.scope,
        },
        expected,
      )
    ) {
      return false;
    }
    const sessionId = detached.entry.sessionId;
    if (sessionId) {
      const exited = await orchTerminateSession(sessionId);
      if (!exited) return false;
    }
    const current = getMainOwnedPane(expected.paneId);
    if (
      current !== detached ||
      current.entry.sessionId !== sessionId ||
      !matchesMissionPaneCloseAuthority(
        {
          paneId: current.entry.paneId,
          sessionId: current.entry.sessionId,
          missionId: current.meta.missionId,
          role: current.meta.role,
          workerIncarnationId: current.meta.workerIncarnationId,
          scope: current.meta.scope,
        },
        expected,
      )
    ) {
      return false;
    }
    if (!deleteMainOwnedPane(expected.paneId)) return false;
    panesVersion += 1;
    return true;
  }

  if (renderedTargets.length !== 1) return false;
  const target = renderedTargets[0]!;
  const owner = target.owner;
  if (owner.isDestroyed() || owner.isCrashed()) return false;
  try {
    requireLiveRendererWorkspaceScope(owner, expected.scope);
  } catch {
    return false;
  }
  const sessionId = target.entry.sessionId;
  if (sessionId) {
    const exited = await orchTerminateSession(sessionId);
    if (!exited) return false;
  }
  try {
    requireLiveRendererWorkspaceScope(owner, expected.scope);
  } catch {
    // Scope-change cleanup owns the old runtime. Never send an id-only close
    // into whatever workspace the renderer now displays.
    return true;
  }
  const current = panes.filter(
    (candidate) =>
      candidate.owner === owner &&
      candidate.entry.paneId === expected.paneId,
  );
  if (
    current.length !== 1 ||
    current[0] !== target ||
    current[0]!.entry.sessionId !== sessionId ||
    !matchesMissionPaneCloseAuthority(authzInfoOf(current[0]!), expected)
  ) {
    return false;
  }
  owner.send(ORCH_CHANNELS.paneCloseRequest, expected.paneId);
  return true;
}

export interface MissionWorkerPaneRetirementRequest {
  readonly paneId: string;
  readonly sessionId: string;
  readonly missionId: string;
  readonly workerIncarnationId: string;
  readonly scope: Readonly<ProjectExecutionScope>;
}

/**
 * Dispatch-owned worker retirement. No paneId-only fallback is permitted:
 * the exact session and worker incarnation must still identify one physical
 * worker in the same mission/scope. A replay after proven exit is idempotent;
 * any live, stale or duplicate identity remains ambiguous and is never killed.
 */
export async function requestMissionWorkerPaneRetirement(
  expected: MissionWorkerPaneRetirementRequest,
): Promise<boolean> {
  const runtime = getPaneRuntimeAuthorityBySession(expected.sessionId);
  if (runtime) {
    if (
      !matchesMissionPaneCloseAuthority(runtime, {
        ...expected,
        role: "worker",
      })
    ) {
      return false;
    }
    return requestMissionPaneClose({
      ...expected,
      role: "worker",
    });
  }

  // A naturally exited PTY disappears from the physical inventory before the
  // renderer collapses its stable visual leaf. Only that exact, sessionless
  // leaf may be retired here. A replacement session, duplicate renderer
  // reference, main-owned envelope, or authority mismatch stays
  // fail-closed.
  if (getSessionState(expected.sessionId) !== null) {
    return false;
  }
  const renderedReferences = panes.filter(
    ({ entry }) =>
      entry.paneId === expected.paneId ||
      entry.sessionId === expected.sessionId,
  );
  const mainReferences = [
    ...findMainOwnedPaneAuthz(expected.paneId),
    ...findMainOwnedPaneAuthz(expected.sessionId),
  ];
  if (mainReferences.length > 0) {
    return false;
  }
  if (renderedReferences.length === 0) return true;
  if (renderedReferences.length !== 1) return false;

  const target = renderedReferences[0]!;
  if (
    target.entry.paneId !== expected.paneId ||
    target.entry.sessionId !== null ||
    target.entry.kind !== "cli-agent" ||
    !matchesMissionPaneCloseAuthority(authzInfoOf(target), {
      paneId: expected.paneId,
      missionId: expected.missionId,
      role: "worker",
      workerIncarnationId: expected.workerIncarnationId,
      scope: expected.scope,
    })
  ) {
    return false;
  }
  const owner = target.owner;
  if (owner.isDestroyed() || owner.isCrashed()) return false;
  try {
    requireLiveRendererWorkspaceScope(owner, expected.scope);
  } catch {
    return false;
  }

  // No await occurs in the natural-exit branch. Re-read every inventory at
  // the commit point anyway so this remains safe if future refactors add an
  // asynchronous proof between selection and renderer notification.
  const currentRenderedReferences = panes.filter(
    ({ entry }) =>
      entry.paneId === expected.paneId ||
      entry.sessionId === expected.sessionId,
  );
  if (
    currentRenderedReferences.length !== 1 ||
    currentRenderedReferences[0] !== target ||
    target.owner.isDestroyed() ||
    target.owner.isCrashed() ||
    !matchesMissionPaneCloseAuthority(authzInfoOf(target), {
      paneId: expected.paneId,
      missionId: expected.missionId,
      role: "worker",
      workerIncarnationId: expected.workerIncarnationId,
      scope: expected.scope,
    }) ||
    getSessionState(expected.sessionId) !== null ||
    findMainOwnedPaneAuthz(expected.paneId).length > 0 ||
    findMainOwnedPaneAuthz(expected.sessionId).length > 0
  ) {
    return false;
  }
  try {
    requireLiveRendererWorkspaceScope(owner, expected.scope);
  } catch {
    return false;
  }
  owner.send(ORCH_CHANNELS.paneCloseRequest, expected.paneId);
  return true;
}

export async function requestPaneClose(paneId: string): Promise<boolean> {
  const owners = new Set(
    panes
      .filter(
        (registered) =>
          registered.entry.paneId === paneId &&
          !registered.owner.isDestroyed() &&
          !registered.owner.isCrashed(),
      )
      .map((registered) => registered.owner),
  );
  const detached = getMainOwnedPane(paneId);
  if (detached && owners.size > 0) return false;
  if (detached) {
    const sessionId = detached.entry.sessionId;
    if (sessionId) {
      const exited = await orchTerminateSession(sessionId);
      if (!exited) return false;
    }
    const currentDetached = getMainOwnedPane(paneId);
    if (
      currentDetached !== detached ||
      currentDetached.entry.sessionId !== sessionId
    ) {
      return false;
    }
    if (!deleteMainOwnedPane(paneId)) return false;
    panesVersion += 1;
    return true;
  }
  if (owners.size !== 1) return false;
  const owner = [...owners][0]!;
  const registered = panes.filter(
    (candidate) =>
      candidate.owner === owner && candidate.entry.paneId === paneId,
  );
  if (registered.length !== 1) return false;
  const target = registered[0]!;
  const sessionId = target.entry.sessionId;
  const expectedScope = authzInfoOf(target).scope;
  if (expectedScope) {
    try {
      requireLiveRendererWorkspaceScope(owner, expectedScope);
    } catch {
      return false;
    }
  }
  if (sessionId) {
    const exited = await orchTerminateSession(sessionId);
    if (!exited) return false;
  }
  if (expectedScope) {
    try {
      requireLiveRendererWorkspaceScope(owner, expectedScope);
    } catch {
      // Scope-change listener detaches or terminates the old mission runtime;
      // never send a pane-id-only close into the renderer's new workspace.
      return true;
    }
  }
  const current = panes.filter(
    (candidate) =>
      candidate.owner === owner &&
      candidate.entry.paneId === paneId,
  );
  if (
    current.length !== 1 ||
    current[0]!.entry.sessionId !== sessionId
  ) {
    return false;
  }
  owner.send(ORCH_CHANNELS.paneCloseRequest, paneId);
  return true;
}
