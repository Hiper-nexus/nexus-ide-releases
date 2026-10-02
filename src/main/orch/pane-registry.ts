import { assertLicensedAgentCapacity } from '../license-enforcement';
import { licenseFailure } from '../../shared/license-errors';
import type { WebContents } from "electron";
import { parentPaneIdFor } from "./operator-spawn-route";
import { emitAppEvent } from '../connectors/app-events';
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
  PaneParkRequest,
} from "../../shared/orch-types";
import { ORCH_CHANNELS } from "../../shared/orch-channels";
import { copyProviderPaneSession } from "../persistence/provider-session-store";
import { currentMimoSessionOwnerKey } from "../adapters/mimo-session-owner";
import { providerAuthStrategy, resolveRuntimeApiKey } from "../persistence/provider-config-store";
import { DEV_SERVER_CHANNELS, PTY_CHANNELS } from "../../shared/channels";
import {
  detachOwnedMissionAgentSession,
  getAgentSessionInfo,
  getSessionState,
  isSessionOwnedBy,
  isSessionDetached,
  listAgentSessionsForPane,
  orchTerminateSession,
  reattachDetachedMissionAgentSession,
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
import { getContextBySession } from './gate';
import { canListPane, sameExactPaneScope, type CallerCtx, type PaneAuthzInfo } from "./pane-authz";
import { parsePaneNumberRef } from "../../shared/pane-number";
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
  spawnMainOwnedMissionPaneAsync as spawnMainOwnedMissionPaneRuntimeAsync,
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
  newOutputSince,
  readSessionOutput,
  sessionOutputExitedAt,
  stripAnsi,
  waitForIdle,
  waitForNextIdle,
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
import { getOrchSettings } from "../persistence/settings-store";
import { getAcpDriverSession } from "../acp/acp-harness-driver";
import { issueAgentIdentityBestEffort } from "./agent-identity-spawn";
import {
  shouldTripWorkerMortalityBreaker,
  workerMortalityBreakerMessage,
  workerMortalityCount,
} from "./worker-mortality";
import {
  writerCircuitBlocksSeat,
  writerCircuitBreakEvent,
  writerCircuitBreakMessage,
  writerCircuitBreakers,
} from "./writer-circuit-break";
import { trace } from "../observability/main-trace";
import {
  ORCH_SPAWN_GRANT_TTL_MS,
  ORCH_SPAWN_GRANT_TOMBSTONE_TTL_MS,
} from "./orch-spawn-grant-recovery";

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
const SPAWN_TIMEOUT_MS = ORCH_SPAWN_GRANT_TTL_MS;
const RECOVERY_TIMEOUT_MS = 90_000;

/** Internal opt-in used only by the public MCP pane spawn transaction. */
export const PENDING_SPAWN_RESULT = Symbol("pending-pane-spawn-result");

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

/**
 * Navegador de um projeto que saiu da tela (o operador trocou de workspace).
 * O browser-manager mantém a vista viva e escondida; aqui ela segue
 * endereçável pelo id para o agente do projeto dela (F-168). Sai quando o
 * renderer volta a espelhá-la, quando a vista é destruída ou com a janela.
 */
interface ParkedBrowserPane {
  entry: PaneRegistryEntry;
  owner: WebContents;
  scope: Readonly<ProjectExecutionScope>;
}
const parkedBrowserPanes = new Map<string, ParkedBrowserPane>();
/** Afastados que o agente fechou: o layout salvo do projeto ainda os traz. */
const closedParkedBrowserPanes = new Set<string>();
type ParkedBrowserCloser = (
  owner: WebContents,
  paneId: string,
  scope: Readonly<ProjectExecutionScope>,
) => void;
let parkedBrowserCloser: ParkedBrowserCloser | null = null;

/** O browser-manager encerra a vista (sem import circular). */
export function registerParkedBrowserCloser(closer: ParkedBrowserCloser): void {
  parkedBrowserCloser = closer;
}

/** A vista foi destruída: o navegador afastado deixa de ser endereçável. */
export function forgetParkedBrowserPane(
  owner: WebContents,
  paneId: string,
  scope: Readonly<ProjectExecutionScope>,
): void {
  const key = paneMetaKey(owner, paneId);
  const parked = parkedBrowserPanes.get(key);
  if (!parked || !sameProjectScope(parked.scope, scope)) return;
  parkedBrowserPanes.delete(key);
  orchMetaByPane.delete(key);
  panesVersion += 1;
}

export function wasParkedBrowserClosed(
  owner: WebContents,
  paneId: string,
): boolean {
  return closedParkedBrowserPanes.has(paneMetaKey(owner, paneId));
}

function parkedBrowserPanesById(paneId: string): ParkedBrowserPane[] {
  return [...parkedBrowserPanes.values()].filter(
    (parked) => parked.entry.paneId === paneId,
  );
}

function parkedBrowserAuthzInfo(parked: ParkedBrowserPane): PaneAuthzInfo {
  return { ...authzInfoOf(parked), scope: parked.scope };
}

function parkedBrowserSnapshot(parked: ParkedBrowserPane): PaneSnapshot {
  // O número do header é da tela que saiu; na janela atual ele já pode ser
  // de outro pane. Afastado, o navegador é endereçado só pelo id.
  const { paneNumber: _paneNumber, ...snapshot } = snapshotOf(parked);
  return { ...snapshot, scope: parked.scope };
}

function parkBrowserPanesOfPreviousWorkspace(
  owner: WebContents,
  previousScope: ProjectExecutionScope,
): void {
  const parkedIds = new Set<string>();
  for (const registered of panes) {
    if (registered.owner !== owner || registered.entry.kind !== "browser") {
      continue;
    }
    const key = paneMetaKey(owner, registered.entry.paneId);
    const meta = orchMetaByPane.get(key);
    parkedBrowserPanes.set(key, {
      entry: { ...registered.entry },
      owner,
      scope: Object.freeze({ ...(meta?.scope ?? previousScope) }),
    });
    parkedIds.add(registered.entry.paneId);
  }
  if (parkedIds.size === 0) return;
  panes = panes.filter(
    (registered) =>
      registered.owner !== owner || !parkedIds.has(registered.entry.paneId),
  );
  panesVersion += 1;
}

function closeParkedBrowserPane(parked: ParkedBrowserPane): boolean {
  const key = paneMetaKey(parked.owner, parked.entry.paneId);
  if (parkedBrowserPanes.get(key) !== parked) return false;
  parkedBrowserPanes.delete(key);
  orchMetaByPane.delete(key);
  closedParkedBrowserPanes.add(key);
  panesVersion += 1;
  parkedBrowserCloser?.(parked.owner, parked.entry.paneId, parked.scope);
  return true;
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
  pendingResultSent: boolean;
  allowPendingResult: boolean;
  abortSignal?: AbortSignal;
  abortCleanup?: () => void;
}
const pendingSpawns = new Map<string, PendingSpawn>();
const pendingSpawnResults = new WeakMap<AbortSignal, OrchPaneSpawnResult>();

/**
 * `spawnPaneAndMaybePrompt` predates the pending spawn ACK and still expects
 * a session id. Keep the compatibility seam local to this registry: the MCP
 * pane tool consumes the already-resolved pending result and returns it to the
 * caller, while the main pending record remains alive for the late PTY bind.
 */
export function takePendingPaneSpawnResult(
  signal: AbortSignal | undefined,
): OrchPaneSpawnResult | null {
  if (!signal) return null;
  const result = pendingSpawnResults.get(signal) ?? null;
  if (result) pendingSpawnResults.delete(signal);
  return result;
}

interface OrchSpawnGrantTombstone {
  readonly requestId: string;
  readonly owner: WebContents;
  readonly request: Readonly<OrchPaneSpawnRequest>;
  readonly meta: OrchMeta;
  readonly requestedCwd?: string;
  readonly initialPrompt?: string;
  readonly sessionId: string | null;
  readonly kind: "consumed" | "expired";
  readonly createdAt: number;
}
const orchSpawnGrantTombstones = new Map<string, OrchSpawnGrantTombstone>();

function pruneOrchSpawnGrantTombstones(now: number = Date.now()): void {
  for (const [id, tomb] of orchSpawnGrantTombstones) {
    if (
      tomb.createdAt + ORCH_SPAWN_GRANT_TOMBSTONE_TTL_MS <= now ||
      tomb.owner.isDestroyed()
    ) {
      orchSpawnGrantTombstones.delete(id);
    }
  }
}

function rememberOrchSpawnGrantTombstone(
  requestId: string,
  pending: PendingSpawn,
  kind: "consumed" | "expired",
): void {
  pruneOrchSpawnGrantTombstones();
  orchSpawnGrantTombstones.set(requestId, {
    requestId,
    owner: pending.owner,
    request: pending.request,
    meta: pending.meta,
    requestedCwd: pending.requestedCwd,
    initialPrompt: pending.initialPrompt,
    sessionId: pending.claimedSessionId,
    kind,
    createdAt: Date.now(),
  });
}

function liveSessionIdForPane(paneId: string): string | null {
  const owned = getMainOwnedPane(paneId);
  if (
    owned?.entry.sessionId &&
    getSessionState(owned.entry.sessionId) !== null
  ) {
    return owned.entry.sessionId;
  }
  for (const registered of panes) {
    if (
      registered.entry.paneId === paneId &&
      typeof registered.entry.sessionId === "string" &&
      getSessionState(registered.entry.sessionId) !== null
    ) {
      return registered.entry.sessionId;
    }
  }
  return listAgentSessionsForPane(paneId)[0]?.sessionId ?? null;
}

/**
 * Sessão física que o Main vinculou a UMA tentativa de spawn (requestId). A
 * entrega adiada de um brief segue esta identidade, nunca o paneId: um pane
 * reciclado (resume/remint) mantém o id mas é outra sessão.
 */
export function pendingSpawnAttemptSession(
  requestId: string,
):
  | { readonly state: "waiting" }
  | { readonly state: "bound"; readonly sessionId: string }
  | { readonly state: "gone" } {
  // A primeira vinculação vence: um remint com o mesmo requestId não troca o
  // destinatário da entrega que já estava amarrada.
  const tomb = orchSpawnGrantTombstones.get(requestId);
  if (tomb?.sessionId) return { state: "bound", sessionId: tomb.sessionId };
  const pending = pendingSpawns.get(requestId);
  if (!pending || pending.settled) return { state: "gone" };
  return pending.claimedSessionId
    ? { state: "bound", sessionId: pending.claimedSessionId }
    : { state: "waiting" };
}

export function hasOrchSpawnGrantTombstone(
  requestId: string,
  owner: WebContents,
): boolean {
  pruneOrchSpawnGrantTombstones();
  const tomb = orchSpawnGrantTombstones.get(requestId);
  return Boolean(tomb && tomb.owner === owner);
}

export function lookupAlreadySpawnedOrchGrant(
  requestId: string,
  owner: WebContents,
  paneId?: string,
): { readonly sessionId: string; readonly paneId: string } | null {
  pruneOrchSpawnGrantTombstones();
  const tomb = orchSpawnGrantTombstones.get(requestId);
  if (tomb && tomb.owner === owner && tomb.sessionId) {
    if (getSessionState(tomb.sessionId) !== null) {
      return { sessionId: tomb.sessionId, paneId: tomb.request.paneId };
    }
  }
  const targetPane = paneId ?? tomb?.request.paneId;
  if (!targetPane) return null;
  if (tomb && tomb.owner !== owner) return null;
  const sessionId = liveSessionIdForPane(targetPane);
  return sessionId ? { sessionId, paneId: targetPane } : null;
}

function armPendingSpawnTimer(requestId: string, pending: PendingSpawn): void {
  clearTimeout(pending.timer);
  pending.timer = setTimeout(() => {
    void settlePendingSpawnFailure(
      requestId,
      pending,
      "pane spawn timed out",
      { allowMainFallback: true },
    );
  }, SPAWN_TIMEOUT_MS);
  pending.lastSentAt = Date.now();
}

export function refreshPendingOrchSpawnGrantsForMission(
  missionId: string,
): void {
  for (const [id, pending] of pendingSpawns) {
    if (pending.settled) continue;
    if (
      pending.meta.missionId !== missionId &&
      pending.request.missionId !== missionId
    ) {
      continue;
    }
    armPendingSpawnTimer(id, pending);
  }
}

/**
 * Recreate a consumed/expired orchspawn grant so a remount can finish
 * spawning on a still-running civilian mission. Same request id so the
 * renderer does not need a new token.
 */
export function remintOrchSpawnGrant(
  requestId: string,
  owner: WebContents,
): PendingSpawnMeta | null {
  pruneOrchSpawnGrantTombstones();
  const existing = pendingSpawns.get(requestId);
  if (existing && existing.owner === owner && !existing.settled) {
    if (existing.claimed) return null;
    return claimPendingSpawn(existing, owner);
  }
  const tomb = orchSpawnGrantTombstones.get(requestId);
  if (!tomb || tomb.owner !== owner) return null;
  if (tomb.meta.scope) {
    try {
      requireLiveRendererWorkspaceScope(owner, tomb.meta.scope);
    } catch {
      return null;
    }
  }
  const pending: PendingSpawn = {
    resolve: () => {},
    timer: setTimeout(() => undefined, SPAWN_TIMEOUT_MS),
    owner,
    initialPrompt: tomb.initialPrompt,
    claimed: false,
    claimedSessionId: null,
    requestedCwd: tomb.requestedCwd,
    request: tomb.request,
    lastSentAt: Date.now(),
    attempts: 1,
    settled: false,
    pendingResultSent: false,
    allowPendingResult: false,
    meta: tomb.meta,
  };
  armPendingSpawnTimer(requestId, pending);
  pendingSpawns.set(requestId, pending);
  return claimPendingSpawn(pending, owner);
}

interface PendingBrowserOpen {
  resolve: (result: BrowserPaneOpenResult) => void;
  timer: ReturnType<typeof setTimeout>;
  meta: OrchMeta;
  owner: WebContents;
  paneId: string;
}
const pendingBrowserOpens = new Map<string, PendingBrowserOpen>();

/** Browser origin is recorded in Main before the renderer creates the view. */
export function isAgentRequestedBrowser(owner: WebContents, paneId: string): boolean {
  return [...pendingBrowserOpens.values()].some((pending) => pending.owner === owner && pending.paneId === paneId) ||
    orchMetaByPane.has(paneMetaKey(owner, paneId));
}

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
  return terminateOwnedMissionSession(sessionId);
}

/**
 * Main-owned mission panes may be PTYs or ACP subprocesses. Keeping the
 * physical-exit proof in one helper prevents an ACP pane from being removed
 * from the registry while its child process is still alive.
 */
async function terminateOwnedMissionSession(
  sessionId: string,
  origin = "pane-registry:owned-mission-session",
): Promise<boolean> {
  const acp = getAcpDriverSession(sessionId);
  if (acp) {
    try {
      await acp.shutdown();
      return getAcpDriverSession(sessionId) === null;
    } catch {
      return false;
    }
  }
  if (getSessionState(sessionId) === null) return true;
  return orchTerminateSession(sessionId, { origin });
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

interface BrowserOriginBinding {
  readonly owner: WebContents;
  readonly info: PaneAuthzInfo;
  readonly physicalIdentity: string;
  readonly physicalAuthority: string;
  readonly promotedOperatorHand: boolean;
  readonly operatorOpened: boolean;
}
// A layout is a presentation, not the lifetime of its live Main session.
// Retain the proven origin when a workspace parks that presentation.
const browserOriginBySession = new Map<string, BrowserOriginBinding>();

function browserPhysicalIdentity(agent: Pick<NonNullable<ReturnType<typeof getAgentSessionInfo>>,
  'sessionId' | 'paneId' | 'adapterId' | 'accountId' | 'scope'>): string {
  const scope = agent.scope;
  return JSON.stringify([agent.sessionId, agent.paneId, agent.adapterId, agent.accountId,
    scope?.version, scope?.installationId, scope?.projectId, scope?.checkoutId,
    scope?.rootRealPath, scope?.identitySource]);
}

function browserPhysicalAuthority(agent: Pick<NonNullable<ReturnType<typeof getAgentSessionInfo>>,
  'missionId' | 'role' | 'workerIncarnationId'>): string {
  return JSON.stringify([agent.missionId, agent.role, agent.workerIncarnationId]);
}

function rememberBrowserOrigin(owner: WebContents, info: PaneAuthzInfo): void {
  const sessionId = info.sessionId;
  if (!sessionId || !info.scope || owner.isDestroyed() || owner.isCrashed()) return;
  const acp = getAcpDriverSession(sessionId);
  const agent = acp?.agent ?? getAgentSessionInfo(sessionId);
  if (!agent || agent.sessionId !== sessionId || agent.paneId !== info.paneId ||
      agent.missionId !== info.missionId || agent.role !== (info.role ?? 'user') ||
      agent.workerIncarnationId !== info.workerIncarnationId) return;
  if (!acp && (getSessionState(sessionId) === null || !isSessionOwnedBy(owner, sessionId))) return;
  const physicalIdentity = browserPhysicalIdentity(agent);
  const previous = browserOriginBySession.get(sessionId);
  // Another grid receiving an ACP presentation cannot replace its origin.
  // PTY ownership may move only through Main's physical reattachment path.
  if (previous && (previous.physicalIdentity !== physicalIdentity ||
      (previous.owner !== owner && (acp || isSessionOwnedBy(previous.owner, sessionId))))) return;
  browserOriginBySession.set(sessionId, {
    owner, physicalIdentity, physicalAuthority: browserPhysicalAuthority(agent),
    operatorOpened: agent.operatorOpened === true,
    promotedOperatorHand: (() => {
      const context = getContextBySession(sessionId);
      return context?.sessionId === sessionId && context.promotedFromUserSession === true &&
        context.role === 'orchestrator' && context.missionId === info.missionId &&
        sameExactPaneScope(context.scope, info.scope!);
    })(),
    info: { ...info, scope: Object.freeze({ ...info.scope }),
      executionScope: info.executionScope ? Object.freeze({ ...info.executionScope }) : undefined },
  });
}

function browserOriginInfo(binding: BrowserOriginBinding): PaneAuthzInfo {
  const { info, owner } = binding;
  const sessionId = info.sessionId;
  if (!sessionId || !(binding.promotedOperatorHand || binding.operatorOpened) || getAcpDriverSession(sessionId) ||
      (!isSessionOwnedBy(owner, sessionId) && !(binding.operatorOpened && isSessionDetached(sessionId)))) return info;
  const context = getContextBySession(sessionId);
  // Main's gate may return an adopted or operator-opened pane to user while its
  // presentation is parked, before the PTY metadata is returned. A detached
  // operator-opened pane still needs its unique Main runtime validated below;
  // a PTY adopted by another renderer cannot follow the captured origin.
  if (!context || context.sessionId !== sessionId || context.role !== 'user' ||
      context.missionId || context.workerIncarnationId || !info.scope ||
      !sameExactPaneScope(context.scope, info.scope) ||
      !sameExactPaneScope(context.executionScope ?? context.scope, info.executionScope ?? info.scope)) return info;
  return { ...info, role: undefined, missionId: undefined, workerIncarnationId: undefined };
}

function liveBrowserOrigin(binding: BrowserOriginBinding): boolean {
  const { owner } = binding;
  const info = browserOriginInfo(binding);
  const sessionId = info.sessionId;
  if (!sessionId || owner.isDestroyed() || owner.isCrashed()) return false;
  const acp = getAcpDriverSession(sessionId);
  const agent = acp?.agent ?? getAgentSessionInfo(sessionId);
  if (!agent || browserPhysicalIdentity(agent) !== binding.physicalIdentity) return false;
  const authority = browserPhysicalAuthority(agent);
  if (authority !== binding.physicalAuthority &&
      !(info !== binding.info && authority === browserPhysicalAuthority({ role: 'user' }))) return false;
  if (!acp && getSessionState(sessionId) === null) return false;
  if (!acp && isSessionOwnedBy(owner, sessionId)) return true;
  // Detached mission PTYs and ACP have a unique Main-owned runtime. Its
  // authority must still describe the exact session captured at presentation.
  const authorities = findMainOwnedRuntimeAuthority(sessionId);
  const runtime = authorities.length === 1 ? authorities[0] : undefined;
  const owned = runtime ? getMainOwnedPane(runtime.paneId) : undefined;
  if (!runtime || !owned || runtime.paneId !== info.paneId ||
      owned.entry.sessionId !== sessionId || runtime.missionId !== info.missionId ||
      runtime.role !== info.role || runtime.workerIncarnationId !== info.workerIncarnationId ||
      !runtime.scope || !info.scope || !sameExactPaneScope(runtime.scope, info.scope) ||
      !sameExactPaneScope(runtime.executionScope ?? runtime.scope, info.executionScope ?? info.scope) ||
      owned.entry.adapterId !== agent.adapterId || owned.entry.accountId !== agent.accountId) return false;
  if (acp) {
    return acp.sessionId === sessionId && acp.paneId === info.paneId &&
      acp.missionId === info.missionId && acp.role === info.role &&
      sameExactPaneScope(acp.scope, agent.scope);
  }
  // Adoption may precede the new renderer's first pane sync. Only the
  // physical PTY manager can prove that no renderer has reclaimed it.
  return isSessionDetached(sessionId);
}

function liveOwnerForSession(sessionId: string): WebContents | null {
  const matches = panes.filter(
    ({ entry, owner }) =>
      entry.sessionId === sessionId &&
      !owner.isDestroyed() &&
      !owner.isCrashed(),
  );
  return matches.length === 1 ? matches[0].owner : null;
}

/** Browser authority is derived from Main's physical session ownership. */
function browserOwnerForCaller(caller: CallerCtx): WebContents | null {
  if (!caller.sessionId) return null;
  const rendered = panes.filter(({ entry }) => entry.sessionId === caller.sessionId);
  if (rendered.length > 0) {
    if (rendered.length !== 1) return null;
    const registered = rendered[0]!;
    const scope = authzInfoOf(registered).scope;
    if (!scope || !sameExactPaneScope(caller.scope, scope) ||
        getSessionState(caller.sessionId) === null ||
        !isSessionOwnedBy(registered.owner, caller.sessionId) ||
        registered.owner.isDestroyed() || registered.owner.isCrashed()) return null;
    return registered.owner;
  }
  const origin = browserOriginBySession.get(caller.sessionId);
  if (origin) {
    const info = browserOriginInfo(origin);
    return info.scope && liveBrowserOrigin(origin) && sameExactPaneScope(caller.scope, info.scope) &&
      sameExactPaneScope(caller.executionScope ?? caller.scope, info.executionScope ?? info.scope) &&
      caller.missionId === info.missionId && caller.role === (info.role ?? 'user') &&
      caller.workerIncarnationId === info.workerIncarnationId ? origin.owner : null;
  }
  // A headless worker has no renderer owner. Only its unique live mission
  // orchestrator can supply one; never use the most recently registered grid.
  const headless = findMainOwnedRuntimeAuthority(caller.sessionId);
  const authority = headless.length === 1 ? headless[0] : undefined;
  if (!authority || !caller.missionId ||
      authority.missionId !== caller.missionId || authority.role !== caller.role ||
      caller.workerIncarnationId !== authority.workerIncarnationId ||
      !authority.scope || !sameExactPaneScope(caller.scope, authority.scope)) return null;
  const acp = getAcpDriverSession(caller.sessionId);
  if (acp) {
    // ACP sessions have no PTY state or renderer owner. Prove their live
    // Main-owned identity before deriving the mission's presentation owner.
    const owned = getMainOwnedPane(authority.paneId);
    const agent = acp.agent;
    if (!owned || owned.entry.sessionId !== caller.sessionId ||
        acp.sessionId !== caller.sessionId || acp.paneId !== authority.paneId ||
        acp.missionId !== caller.missionId || acp.role !== caller.role ||
        agent.sessionId !== caller.sessionId || agent.paneId !== authority.paneId ||
        agent.missionId !== caller.missionId || agent.role !== caller.role ||
        agent.adapterId !== owned.entry.adapterId || agent.accountId !== owned.entry.accountId ||
        agent.workerIncarnationId !== authority.workerIncarnationId ||
        !sameExactPaneScope(acp.scope, agent.scope) ||
        (!sameExactPaneScope(agent.scope, caller.scope) &&
          !sameExactPaneScope(agent.scope, authority.executionScope ?? authority.scope)) ||
        !sameExactPaneScope(caller.executionScope ?? caller.scope,
          authority.executionScope ?? authority.scope)) return null;
  } else if (getSessionState(caller.sessionId) === null) return null;
  const owners = new Set<WebContents>();
  for (const registered of panes) {
    const info = authzInfoOf(registered);
    if (info.role === "orchestrator" && info.missionId === caller.missionId &&
        info.scope && sameExactPaneScope(caller.scope, info.scope) &&
        info.sessionId && getSessionState(info.sessionId) !== null &&
        isSessionOwnedBy(registered.owner, info.sessionId) &&
        !registered.owner.isDestroyed() && !registered.owner.isCrashed()) {
      owners.add(registered.owner);
    }
  }
  for (const binding of browserOriginBySession.values()) {
    const info = browserOriginInfo(binding);
    if (info.role === 'orchestrator' && info.missionId === caller.missionId && info.scope &&
        sameExactPaneScope(caller.scope, info.scope) && liveBrowserOrigin(binding)) owners.add(binding.owner);
  }
  return owners.size === 1 ? [...owners][0]! : null;
}

/** Ignore any owner id carried by callers; ownership never comes from MCP args. */
export function callerWithPaneOwner(caller: CallerCtx): CallerCtx {
  return { ...caller, ownerWebContentsId: browserOwnerForCaller(caller)?.id };
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
  deadExitDeliveredByOwner.delete(wc.id);
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
  for (const [sessionId, binding] of browserOriginBySession) {
    if (binding.owner === wc) browserOriginBySession.delete(sessionId);
  }
  for (const paneId of removedPaneIds) {
    orchMetaByPane.delete(paneMetaKey(wc, paneId));
    parkedByPane.delete(paneMetaKey(wc, paneId));
    wokeAtByPane.delete(paneId);
  }
  // Metas de panes de outros projetos (retidas na troca de workspace) morrem
  // com a janela, junto dos navegadores afastados.
  for (const key of [...orchMetaByPane.keys()]) {
    if (key.startsWith(`${wc.id}:`)) orchMetaByPane.delete(key);
  }
  for (const key of [...parkedBrowserPanes.keys()]) {
    if (key.startsWith(`${wc.id}:`)) parkedBrowserPanes.delete(key);
  }
  for (const key of [...closedParkedBrowserPanes]) {
    if (key.startsWith(`${wc.id}:`)) closedParkedBrowserPanes.delete(key);
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

function rendererForMission(
  missionId?: string,
  scope?: ProjectExecutionScope,
  operatorParentSessionId?: string,
): WebContents | null {
  if (operatorParentSessionId) {
    // A helper belongs to the operator's grid, even when another window
    // opened later (including a second window of the same project).
    const owner = liveOwnerForSession(operatorParentSessionId);
    if (!owner) return null;
    try {
      requireLiveRendererWorkspaceScope(owner, scope);
      return owner;
    } catch {
      return null;
    }
  }
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
  // Auxiliary windows can register last and have no workspace/grid at all.
  // Reuse the actual layout owners, including an empty mirrored grid, and
  // revalidate their live scope instead of losing the target to that window.
  const candidates = new Set(mirroredOwners.values());
  if (orchRenderer) candidates.add(orchRenderer);
  for (const owner of [...candidates].reverse()) {
    try {
      requireLiveRendererWorkspaceScope(owner, scope);
      return owner;
    } catch {
      // A parked, closed or foreign grid cannot receive this request.
    }
  }
  return null;
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
    browserOriginBySession.delete(sessionId);
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
 * Pane que o operador (ou o runtime no mesmo documento) tirou do grid.
 * HMR/Cmd+R troca generation e retém headless; drop na MESMA generation é
 * fechamento de folha — não reapresentar, não respawnar o time inteiro.
 */
const operatorDismissedPanes = new Map<
  string,
  { readonly missionId: string; readonly role: string }
>();

export function wasOrchestratorOperatorDismissed(missionId: string): boolean {
  for (const record of operatorDismissedPanes.values()) {
    if (record.missionId === missionId && record.role === "orchestrator") {
      return true;
    }
  }
  return false;
}

export function isMissionPaneOperatorDismissed(paneId: string): boolean {
  return operatorDismissedPanes.has(paneId);
}

export function clearOperatorDismissedPanes(missionId: string): void {
  for (const [paneId, record] of operatorDismissedPanes) {
    if (record.missionId === missionId) operatorDismissedPanes.delete(paneId);
  }
}

function noteOperatorDismissedPane(
  paneId: string,
  missionId: string,
  role: string,
): void {
  operatorDismissedPanes.set(paneId, { missionId, role });
}

function retireOperatorDismissedRendererPane(
  owner: WebContents,
  registered: RegisteredPane,
): void {
  const paneId = registered.entry.paneId;
  const meta = orchMetaByPane.get(paneMetaKey(owner, paneId));
  const agent = registered.entry.sessionId
    ? getAgentSessionInfo(registered.entry.sessionId)
    : null;
  const missionId = meta?.missionId ?? agent?.missionId;
  const role = meta?.role ?? agent?.role;
  if (!missionId || (role !== "orchestrator" && role !== "worker")) return;
  noteOperatorDismissedPane(paneId, missionId, role);
  const sessionId = registered.entry.sessionId;
  if (!sessionId) return;
  void orchTerminateSession(sessionId, {
    origin: "pane-registry:operator-dismiss",
  }).catch((error) => {
    console.warn(
      `[pane-registry] operator-dismiss terminate failed pane=${paneId} ` +
        `session=${sessionId}:`,
      error instanceof Error ? error.message : error,
    );
  });
}

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
  // Pane aberto pelo operador que virou orquestrador continua do renderer:
  // não existe versão headless dele, e "reter" aqui o encerrava.
  if (agent?.source === "direct-user") return false;
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
          scope: getContextBySession(sessionId!)?.scope ?? scopeBySession.get(sessionId!) ?? agent.scope,
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
      // Selo vencido NÃO autoriza matar um agente vivo porque o operador
      // trocou de projeto (troca X → Y → X). O pane fica registrado no
      // renderer — o host é estacionado lá e o PTY segue rodando, como nos
      // panes diretos. Na volta, resolveMainOwnedPanePresentation decide.
      return false;
    }
  }
  rememberBrowserOrigin(owner, authzInfoOf(registered));
  const detached = Boolean(
    agent?.missionId === meta.missionId &&
      agent.role === meta.role &&
      sameProjectScope(agent.scope, meta.executionScope ?? meta.scope) &&
      detachOwnedMissionAgentSession(owner, sessionId),
  );
  if (!detached) {
    // Detach recusado (identidade diverge / tap indisponível): mesma regra
    // fail-safe — nunca terminar um PTY vivo por causa da troca de projeto.
    return false;
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
    rememberOrchSpawnGrantTombstone(requestId, pending, "expired");
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

  let fallback: OrchPaneSpawnResult | null = null;
  if (options.allowMainFallback) {
    try {
      fallback = await fallbackPendingSpawnToMainRuntime(
        pending,
        mainOwnedPaneHooks,
      );
    } catch (fallbackError) {
      const detail =
        fallbackError instanceof Error
          ? fallbackError.message
          : String(fallbackError);
      fallback = {
        requestId,
        ok: false,
        error: `${error}; main fallback failed: ${detail}`,
      };
    }
  }
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
  nextScope: ProjectExecutionScope | null,
): void {
  // Troca de projeto afasta os navegadores (o browser-manager esconde a
  // vista); fechar o projeto (sem próximo) os encerra como antes.
  if (nextScope) parkBrowserPanesOfPreviousWorkspace(owner, previousScope);
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
  if (owner) handleRendererWorkspaceScopeChange(owner, previous, next);
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
      /**
       * `true` só quando o PTY já morreu ou a missão durável deixou de
       * existir. Qualquer outro stale com sessão VIVA é fail-safe: o pane é
       * pulado e avisado uma vez — nunca terminado por causa de uma troca de
       * workspace do operador.
       */
      readonly retire: boolean;
    };

const staleMainOwnedPaneRetirements = new Map<string, Promise<void>>();
/**
 * Aviso único por (paneId, sessionId): o syncPanes é um heartbeat ~1 s e um
 * pane vivo classificado stale não pode inundar o console a cada sync.
 */
const staleLivePaneWarnings = new Set<string>();

function sameExactProjectScope(
  left: Readonly<ProjectExecutionScope>,
  right: Readonly<ProjectExecutionScope>,
): boolean {
  return left.version === right.version && sameProjectScope(left, right);
}

function stalePresentation(
  reason: string,
  retire: boolean,
): MainOwnedPanePresentationResolution {
  return { kind: "stale", reason, retire };
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
  if (isMissionPaneOperatorDismissed(entry.paneId)) return { kind: "skip" };
  if (!meta.scope || !sameExactProjectScope(ownerScope, meta.scope)) {
    return { kind: "skip" };
  }
  const acpSession = sessionId ? getAcpDriverSession(sessionId) : null;
  const physicalGone =
    !sessionId || (!acpSession && getSessionState(sessionId) === null);
  if (entry.kind !== "cli-agent") {
    return stalePresentation(
      "main-owned entry is not a CLI agent",
      physicalGone,
    );
  }
  if (!sessionId) {
    return stalePresentation("main-owned entry has no physical session", true);
  }
  if (physicalGone) {
    return stalePresentation("main-owned physical session has exited", true);
  }
  if (!missionId || (role !== "orchestrator" && role !== "worker")) {
    // Sem missionId não existe missão durável a proteger; papel inválido com
    // missão viva é fail-safe (pula e avisa, nunca termina o PTY vivo).
    return stalePresentation(
      "main-owned entry has no mission role authority",
      !missionId,
    );
  }
  const agent = acpSession?.agent ?? getAgentSessionInfo(sessionId);
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
    return stalePresentation(
      "physical PTY identity diverges from pane runtime",
      false,
    );
  }

  let spec: MissionPaneSpec | null | undefined;
  let currentSeal: MissionPaneAuthoritySeal;
  try {
    const stores = getProjectDomainStores(meta.scope);
    const mission = stores.missions.get(missionId);
    spec = stores.missionPanes.findByPaneId(entry.paneId);
    if (!mission || mission.id !== missionId) {
      // A missão durável deixou de existir: é a única razão de stale que ainda
      // autoriza terminar uma sessão viva (a missão é a dona dos agentes).
      return stalePresentation("durable mission no longer exists", true);
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
      return stalePresentation(
        "durable mission pane spec is stale or missing",
        false,
      );
    }
    currentSeal = resolveCurrentMissionSpawnAuthoritySeal(meta.scope, missionId);
  } catch (error) {
    return stalePresentation(
      error instanceof Error
        ? error.message
        : "durable mission authority is unavailable",
      false,
    );
  }
  if (
    !sameMissionPaneAuthoritySeal(spec.authoritySeal, currentSeal) ||
    !sameMissionPaneAuthoritySeal(meta.authoritySeal, currentSeal) ||
    !sameMissionPaneAuthoritySeal(agent.authoritySeal, currentSeal)
  ) {
    return stalePresentation(
      "mission pane authority seal is no longer current",
      false,
    );
  }
  return {
    kind: "present",
    request: {
      missionId,
      paneId: entry.paneId,
      sessionId,
      role,
      transport: acpSession ? 'acp' : 'cli-pty',
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
  presenter: WebContents,
): void {
  const key = staleMainOwnedPaneRetirementKey(pane);
  if (staleMainOwnedPaneRetirements.has(key)) return;
  const { paneId, sessionId } = pane.entry;
  const retirement = (async () => {
    try {
      if (sessionId) {
        const exited = await terminateOwnedMissionSession(sessionId);
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
      // O processo morreu headless (ex.: missão concluída com o operador
      // noutro projeto) e o exit não teve a quem ir. O xterm estacionado
      // voltou com o id morto e cada tecla virava "o main recusou a
      // digitação neste pane" (F-167). Entrega o exit ao renderer que
      // apresenta o workspace dela.
      const presenterScope = getRendererWorkspaceScope(presenter);
      if (
        sessionId &&
        !presenter.isDestroyed() &&
        !presenter.isCrashed() &&
        presenterScope &&
        pane.meta.scope &&
        sameExactProjectScope(presenterScope, pane.meta.scope)
      ) {
        presenter.send(PTY_CHANNELS.exit, { sessionId, exitCode: 0 });
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

function warnStaleMainOwnedPaneKeptLiveOnce(
  pane: MainOwnedPane,
  reason: string,
): void {
  const key = staleMainOwnedPaneRetirementKey(pane);
  if (staleLivePaneWarnings.has(key)) return;
  staleLivePaneWarnings.add(key);
  console.warn(
    `[pane-registry] stale pane kept live pane=${pane.entry.paneId} ` +
      `session=${pane.entry.sessionId ?? "none"}: ${reason}`,
  );
}

function requestMainOwnedPanePresentations(owner: WebContents): void {
  const scope = getRendererWorkspaceScope(owner);
  if (!scope || owner.isDestroyed() || owner.isCrashed()) return;
  for (const pane of mainOwnedPaneValues()) {
    const resolution = resolveMainOwnedPanePresentation(scope, pane);
    if (resolution.kind !== "stale" || resolution.retire) {
      staleLivePaneWarnings.delete(staleMainOwnedPaneRetirementKey(pane));
    }
    if (resolution.kind === "skip") continue;
    if (resolution.kind === "stale") {
      if (resolution.retire) {
        retireStaleMainOwnedPane(pane, resolution.reason, owner);
      } else {
        warnStaleMainOwnedPaneKeptLiveOnce(pane, resolution.reason);
      }
      continue;
    }
    const { request } = resolution;
    try {
      owner.send(ORCH_CHANNELS.panePresentationRequest, request);
      rememberBrowserOrigin(owner, {
        paneId: pane.entry.paneId, sessionId: pane.entry.sessionId, kind: pane.entry.kind,
        missionId: pane.meta.missionId, role: pane.meta.role,
        workerIncarnationId: pane.meta.workerIncarnationId, scope: pane.meta.scope,
        executionScope: pane.meta.executionScope ?? pane.meta.scope,
      });
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

/**
 * The renderer came back to a workspace whose mission panes were detached
 * on the way out and still holds their exact session ids. Give presentation
 * back when the id matches the headless record for that pane and the
 * renderer is in the mission's scope again; restore the pane's meta.
 */
export function reclaimDetachedMissionSession(
  owner: WebContents,
  sessionId: string,
): boolean {
  const agent = getAgentSessionInfo(sessionId);
  const paneId = agent?.paneId;
  if (!agent || !paneId || !agent.scope) return false;
  const detached = getMainOwnedPane(paneId);
  if (!detached || detached.entry.sessionId !== sessionId) return false;
  const scope = getRendererWorkspaceScope(owner);
  if (!scope || !detached.meta.scope || !sameProjectScope(detached.meta.scope, scope) ||
      !sameProjectScope(agent.scope, detached.meta.executionScope ?? detached.meta.scope)) return false;
  if (!reattachDetachedMissionAgentSession(owner, sessionId, paneId)) {
    return false;
  }
  deleteMainOwnedPane(paneId);
  orchMetaByPane.set(paneMetaKey(owner, paneId), detached.meta);
  if (!panes.some((registered) => registered.owner === owner && registered.entry.paneId === paneId)) {
    panes = [...panes, { entry: { ...detached.entry }, owner }];
    panesVersion += 1;
  }
  return true;
}

/**
 * Exit sintético entregue ao renderer por id morto que ele ainda espelha:
 * uma sessão detached (headless) não tem `wc`, então quando ela morre
 * (reconciliador, missão concluída, saída natural) o exit não vai a lugar
 * nenhum e o host estacionado segura o id para sempre — cada tecla virava
 * "o main recusou a digitação neste pane" e Reiniciar ficava inerte. Uma
 * entrega por (owner, sessionId); o id é esquecido quando o espelho para de
 * reportá-lo (uma geração antiga pode reespelhá-lo e merece um novo aviso).
 */
const deadExitDeliveredByOwner = new Map<number, Set<string>>();

function deliverDeadForeignSessionExits(
  owner: WebContents,
  entries: readonly PaneRegistryEntry[],
  reclaimed: ReadonlySet<string>,
): void {
  const reportedForeign = new Set<string>();
  for (const entry of entries) {
    const sessionId = entry.sessionId;
    if (!sessionId || reclaimed.has(sessionId)) continue;
    if (isSessionOwnedBy(owner, sessionId)) continue;
    reportedForeign.add(sessionId);
  }
  let delivered = deadExitDeliveredByOwner.get(owner.id);
  if (!delivered) {
    delivered = new Set();
    deadExitDeliveredByOwner.set(owner.id, delivered);
  }
  for (const sessionId of [...delivered]) {
    if (!reportedForeign.has(sessionId)) delivered.delete(sessionId);
  }
  for (const sessionId of reportedForeign) {
    if (delivered.has(sessionId)) continue;
    // Id vivo de OUTRA janela também é estranho ao espelho — nunca inventa
    // exit para ele; só ids comprovadamente mortos (PTY nem ACP).
    if (
      getSessionState(sessionId) !== null ||
      getAcpDriverSession(sessionId) !== null
    ) {
      continue;
    }
    try {
      owner.send(PTY_CHANNELS.exit, { sessionId, exitCode: 0 });
      delivered.add(sessionId);
    } catch {
      // Janela morrendo: não marca como entregue — se ela voltar a sincronizar
      // a próxima tentativa envia de novo.
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
  const reclaimed = new Set<string>();
  for (const entry of entries) {
    if (
      entry.sessionId &&
      paneIdCounts.get(entry.paneId) === 1 &&
      !isSessionOwnedBy(owner, entry.sessionId)
    ) {
      if (reclaimDetachedMissionSession(owner, entry.sessionId)) {
        reclaimed.add(entry.sessionId);
      }
    }
  }
  deliverDeadForeignSessionExits(owner, entries, reclaimed);
  const accepted = entries.filter(
    (entry) =>
      paneIdCounts.get(entry.paneId) === 1 &&
      (!entry.sessionId ||
        isSessionOwnedBy(owner, entry.sessionId)),
  );
  const previousGeneration = paneSyncGenerationByOwner.get(owner.id);
  const generationUnchanged =
    Boolean(generationId) && previousGeneration === generationId;
  const previousForOwner = panes.filter(
    (registered) => registered.owner === owner,
  );
  const acceptedIds = new Set(accepted.map((entry) => entry.paneId));
  const dropped = generationUnchanged
    ? previousForOwner.filter(
        (registered) => !acceptedIds.has(registered.entry.paneId),
      )
    : [];
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
  for (const registered of panes) {
    if (registered.owner === owner) rememberBrowserOrigin(owner, authzInfoOf(registered));
  }
  for (const entry of accepted) {
    const key = paneMetaKey(owner, entry.paneId);
    // O projeto voltou à tela: o navegador afastado volta ao espelho.
    parkedBrowserPanes.delete(key);
    if (closedParkedBrowserPanes.delete(key)) {
      try {
        owner.send(ORCH_CHANNELS.paneCloseRequest, entry.paneId);
      } catch {
        // Janela morrendo: o layout some com ela.
      }
    }
  }
  for (const registered of dropped) {
    retireOperatorDismissedRendererPane(owner, registered);
  }
  const liveIds = new Set(accepted.map((entry) => entry.paneId));
  const ownerScope = getRendererWorkspaceScope(owner);
  for (const [key, meta] of [...orchMetaByPane]) {
    const prefix = `${owner.id}:`;
    if (!key.startsWith(prefix) || liveIds.has(key.slice(prefix.length))) {
      continue;
    }
    // Pane de OUTRO projeto saiu do espelho porque o operador trocou de
    // workspace, não porque o fechou. Apagar a meta tirava do navegador aberto
    // pelo agente o escopo dele e, na volta, toda ferramenta caía em "pane
    // belongs to another project checkout" (F-168).
    if (ownerScope && meta.scope && !sameProjectScope(meta.scope, ownerScope)) {
      continue;
    }
    orchMetaByPane.delete(key);
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
  const registered = panes.find(pane => pane.owner === owner && pane.entry.paneId === paneId);
  if (registered) rememberBrowserOrigin(owner, authzInfoOf(registered));
}

/** A mão do operador saiu da missão (troca de coroa): some a meta dela. */
export function detachOrchMissionMeta(
  owner: WebContents,
  paneId: string,
  missionId: string,
): void {
  const key = paneMetaKey(owner, paneId);
  if (orchMetaByPane.get(key)?.missionId !== missionId) return;
  orchMetaByPane.delete(key);
  panesVersion += 1;
}

/**
 * F-231: ao devolver o worker `operatorOpened` à mão do operador, o meta
 * confiável perde o vínculo com a missão — senão a varredura de órfãos e a
 * próxima terminação ainda o enxergariam como alvo da missão encerrada.
 * Cobre os dois espelhos (renderer-registered e Main-owned).
 */
export function detachOperatorOpenedPaneMission(
  paneId: string,
  missionId: string,
): void {
  for (const [key, meta] of [...orchMetaByPane]) {
    if (meta.missionId === missionId && key.endsWith(`:${paneId}`)) {
      orchMetaByPane.delete(key);
      panesVersion += 1;
    }
  }
  const mainOwned = getMainOwnedPane(paneId);
  if (mainOwned?.meta?.missionId === missionId) {
    const { missionId: _mission, role: _role, workerIncarnationId: _worker, ...rest } = mainOwned.meta;
    setMainOwnedPane(paneId, { ...mainOwned, meta: rest });
    panesVersion += 1;
  }
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

/** 0.76.45: panes estacionados pelo guardian (chave = owner:paneId). */
const parkedByPane = new Map<string, { sessionId: string; parkedAt: number }>();

function parkedRecordFor(registered: RegisteredPane): { sessionId: string; parkedAt: number } | null {
  const key = paneMetaKey(registered.owner, registered.entry.paneId);
  const parked = parkedByPane.get(key);
  if (!parked) return null;
  // Acordou: o renderer já espelha uma sessão viva diferente da estacionada.
  const current = registered.entry.sessionId;
  if (current && current !== parked.sessionId && getSessionState(current) !== null) {
    parkedByPane.delete(key);
    wokeAtByPane.set(registered.entry.paneId, Date.now());
    return null;
  }
  return parked;
}

/** 0.76.45: quando o pane acordou pela última vez (carência do reaper). */
const wokeAtByPane = new Map<string, number>();
export function getPaneWokeAt(paneId: string): number | null {
  return wokeAtByPane.get(paneId) ?? null;
}

function forgetParkedRecords(paneId: string): void {
  for (const key of [...parkedByPane.keys()]) {
    if (key.endsWith(`:${paneId}`)) parkedByPane.delete(key);
  }
  wokeAtByPane.delete(paneId);
}

/** A aba que o renderer declarou para o pane (desempate, nunca autoridade). */
export function getRenderedPaneTabKey(
  owner: WebContents,
  paneId: string,
): string | undefined {
  return panes.find(
    (registered) => registered.owner === owner && registered.entry.paneId === paneId,
  )?.entry.tabKey;
}

function snapshotOf(registered: RegisteredPane): PaneSnapshot {
  const { entry: { tabKey: _tabKey, ...entry }, owner } = registered;
  const meta = orchMetaByPane.get(paneMetaKey(owner, entry.paneId));
  const sessionScope = entry.sessionId
    ? scopeBySession.get(entry.sessionId)
    : undefined;
  // Scope precedence is explicit: the live session binding is the authority;
  // orch meta is only a fallback. A stale meta.scope must never override it.
  const scope = sessionScope ?? meta?.scope;
  const parked = parkedRecordFor(registered);
  return {
    ...entry,
    state: parked ? "parked" : paneState(entry),
    ...meta,
    ...(scope ? { scope } : {}),
    ...(entry.sessionId && getAgentSessionInfo(entry.sessionId)
      ? { executionScope: getAgentSessionInfo(entry.sessionId)!.scope } : {}),
    ...(parked ? { parkedAt: parked.parkedAt, parkedSessionId: parked.sessionId } : {}),
  };
}

export function listPaneSnapshots(): PaneSnapshot[] {
  return [
    ...panes.map(snapshotOf),
    ...listMainOwnedPaneSnapshots(paneState),
    ...[...parkedBrowserPanes.values()].map(parkedBrowserSnapshot),
  ];
}

/** nexus_pane_list shows mission terminals and originating-window browsers;
 * a worker never sees the user's other shell panes. */
export function listVisiblePaneSnapshots(caller: CallerCtx): PaneSnapshot[] {
  caller = callerWithPaneOwner(caller);
  const rendered = panes
    .filter((registered) => canListPane(caller, authzInfoOf(registered)))
    .map(snapshotOf);
  const detached = listVisibleMainOwnedPaneSnapshots(caller, paneState);
  const parkedBrowsers = [...parkedBrowserPanes.values()]
    .filter((parked) => canListPane(caller, parkedBrowserAuthzInfo(parked)))
    .map(parkedBrowserSnapshot);
  return [...rendered, ...detached, ...parkedBrowsers];
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
  const parkedBrowsers = parkedBrowserPanesById(paneIdOrSessionId).map(
    (parked) => parked.entry,
  );
  const matches = [...rendered, ...detached, ...parkedBrowsers];
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
  const context = entry.sessionId ? getContextBySession(entry.sessionId) : null;
  const physical = entry.sessionId ? getAgentSessionInfo(entry.sessionId) : null;
  return {
    paneId: entry.paneId,
    sessionId: entry.sessionId,
    kind: entry.kind,
    ownerWebContentsId: owner.id,
    missionId: meta?.missionId,
    contextRevision: meta?.contextRevision,
    role: meta?.role,
    workerIncarnationId: meta?.workerIncarnationId,
    operatorParentSessionId: meta?.operatorParentSessionId,
    operatorOpened: meta?.operatorOpened === true || undefined,
    scope:
      context?.scope ?? meta?.scope ??
      (entry.sessionId ? scopeBySession.get(entry.sessionId) : undefined) ??
      // Navegador aberto pelo operador ("+ Browser") não tem meta: o espelho
      // só traz panes do projeto que a janela mostra. O browser-manager ainda
      // busca a vista pelo par (escopo do agente, pane) em cada ferramenta.
      (entry.kind === "browser"
        ? getRendererWorkspaceScope(owner) ?? undefined
        : undefined),
    executionScope: context ? context.executionScope ?? context.scope : physical?.scope ?? meta?.executionScope,
  };
}

/**
 * Resolve a pane to the info the authz check needs, accepting any of the three
 * forms an agent may hold: the `paneId`, the `sessionId`, or the short pane
 * NUMBER the operator reads in the header ("pane 7", "7", "#7", "pane sete").
 *
 * O número é ADIÇÃO, nunca substituição — e a ORDEM É LOAD-BEARING. Identidade
 * (paneId/sessionId) é testada primeiro porque ~2% dos ids saem só com dígitos
 * (`randomUUID().slice(0,8)`); lê-los como número entregaria trabalho a OUTRO
 * pane, que é o pior modo de falha possível aqui.
 *
 * Ambiguidade continua sendo `null`, nunca um chute: com duas janelas abertas
 * as duas numeram a partir de 1, então "pane 1" pode casar dois panes. Quem
 * chama transforma esse `null` em recusa nomeando os números válidos.
 */
export function getPaneAuthzInfo(paneRef: string): PaneAuthzInfo | null {
  const byIdentity = [
    ...panes
      .filter(
        ({ entry }) => entry.paneId === paneRef || entry.sessionId === paneRef,
      )
      .map(authzInfoOf),
    ...findMainOwnedPaneAuthz(paneRef),
    // Navegador do projeto que saiu da tela: só pelo id, nunca pelo número.
    ...parkedBrowserPanesById(paneRef).map(parkedBrowserAuthzInfo),
  ];
  if (byIdentity.length > 0) {
    return byIdentity.length === 1 ? byIdentity[0]! : null;
  }
  const wanted = parsePaneNumberRef(paneRef);
  if (wanted === null) return null;
  // Só o espelho do renderer tem número: um pane ainda de posse do Main
  // (transiente/headless) nunca esteve na tela, então o operador não tem
  // número para ele — segue endereçável pelo id, como antes.
  const byNumber = panes
    .filter(({ entry }) => entry.paneNumber === wanted)
    .map(authzInfoOf);
  return byNumber.length === 1 ? byNumber[0]! : null;
}

/**
 * Números de pane que o Main enxerga agora, em ordem. É o que uma recusa
 * precisa dizer em voz alta: "pane 9 não existe; válidos: 1, 2, 5".
 */
export function listLivePaneNumbers(): readonly number[] {
  return [
    ...new Set(
      panes
        .map(({ entry }) => entry.paneNumber)
        .filter((value): value is number => typeof value === 'number'),
    ),
  ].sort((a, b) => a - b);
}

export type OwnedPaneAuthzInfo = Readonly<PaneAuthzInfo> & {
  readonly owner: WebContents;
  /** Display identity for operator-facing diagnostics (watchdog handoffs). */
  readonly title?: string;
  readonly agentName?: string;
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
    title: registered.entry.title,
    agentName: orchMetaByPane.get(
      paneMetaKey(registered.owner, registered.entry.paneId),
    )?.agentName,
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
    title: registered.entry.title,
    agentName: orchMetaByPane.get(
      paneMetaKey(registered.owner, registered.entry.paneId),
    )?.agentName,
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
type PendingPaneSpawnOptions = PaneSpawnOptions & {
  readonly [PENDING_SPAWN_RESULT]?: true;
};

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
  // Sem squad só vale para missão livre (checado no selo).
  const authoritySeal = mission
    ? resolveMissionPaneAuthoritySeal(scope, mission, squads.length === 1 ? squads[0] : null)
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

/** Async variant — required when orch.agentTransport === 'acp'. */
export function spawnMainOwnedMissionPaneAsync(
  options: PaneSpawnOptions & {
    missionId: string;
    role: "orchestrator" | "worker";
  },
): Promise<OrchPaneSpawnResult> {
  try {
    return spawnMainOwnedMissionPaneRuntimeAsync(
      canonicalMissionPaneSpawnOptions(options),
      mainOwnedPaneHooks,
    );
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
}

/**
 * Encarnação nasce NO SPAWN para TODO worker governado. Sem ela o
 * fechamento mecânico C-194.1 recusa "não é worker de missão" e a resposta
 * curta do worker (revisores da Via Rápida, segunda onda) se PERDE — o
 * Maestro espera para sempre (gate 0.62, 19/08: 4 sessões recusadas, board
 * 3/3, missão presa). Dispatch que já traz a própria encarnação vence.
 */
function mintedWorkerIncarnationId(
  options: Pick<PaneSpawnOptions, 'role' | 'missionId' | 'workerIncarnationId'>,
): string | undefined {
  if (options.workerIncarnationId) return options.workerIncarnationId;
  if (options.role === 'worker' && options.missionId) {
    return makeId('workerinc');
  }
  return undefined;
}

export function requestPaneSpawn(
  options: PendingPaneSpawnOptions & { readonly abortSignal?: AbortSignal },
): Promise<OrchPaneSpawnResult> {
  try { assertLicensedAgentCapacity(); } catch (error) {
    const failure = licenseFailure(error);
    if (failure) return Promise.resolve({ requestId: '', ...failure });
    throw error;
  }
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
  // Circuit breaker de mortalidade (campanha 0.50, A1/A2 — doutrina Orca
  // PR #13927): adapter cujos workers morrem SEM ENTREGAR 3× na mesma missão
  // para de ganhar spawn de worker. O Maestro recebe o motivo acionável e
  // escolhe outro agente do roster. Orquestrador NUNCA é recusado por aqui;
  // prova de vida (entrega do adapter) reabre o circuito. Roda ANTES do
  // canonical: recusa rápida, sem tocar authority.
  if (options.role === "worker" && options.missionId && options.adapterId) {
    const deaths = workerMortalityCount(options.missionId, options.adapterId);
    if (shouldTripWorkerMortalityBreaker(deaths)) {
      const writerKey = {
        adapterId: options.adapterId,
        role: "worker" as const,
        missionId: options.missionId,
      };
      trace({
        kind: "writer_circuit_break",
        missionId: options.missionId,
        adapterId: options.adapterId,
        deaths,
      });
      trace(
        writerCircuitBreakEvent({
          key: writerKey,
          failures: deaths,
          action: "skip-silent",
        }),
      );
      return Promise.resolve({
        requestId: "",
        ok: false,
        error: workerMortalityBreakerMessage(options.adapterId, deaths),
      });
    }
    const writerKey = {
      adapterId: options.adapterId,
      role: options.role,
      missionId: options.missionId,
    };
    if (writerCircuitBlocksSeat(writerKey)) {
      const failures = writerCircuitBreakers.failureCount(writerKey);
      trace(
        writerCircuitBreakEvent({
          key: writerKey,
          failures,
          action: "skip-silent",
        }),
      );
      return Promise.resolve({
        requestId: "",
        ok: false,
        error: writerCircuitBreakMessage(writerKey),
      });
    }
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
  if (options.missionId && options.role) {
    // Best-effort only: vault/keyring never blocks the first PTY. Hardened
    // handoff still fails closed later when agentAttestationGate=required.
    issueAgentIdentityBestEffort({
      missionId: options.missionId,
      scope: options.scope,
      agentId: options.agentName?.trim() || options.adapterId,
    });
  }
  if (getOrchSettings().agentTransport === "acp") {
    if (
      !options.missionId ||
      (options.role !== "orchestrator" && options.role !== "worker")
    ) {
      return Promise.resolve({
        requestId: "",
        ok: false,
        error: "transporte ACP exige uma missão main-owned com role explícito",
      });
    }
    // ACP owns the physical child in Main. Never hand the request to the
    // renderer, whose normal handler would create a PTY and silently defeat
    // the selected transport.
    return spawnMainOwnedMissionPaneAsync({
      ...options,
      missionId: options.missionId,
      role: options.role,
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
    return spawnMainOwnedMissionPaneAsync({
        ...options,
        missionId: options.missionId,
        role: options.role,
      });
  }
  const owner = rendererForMission(options.missionId, options.scope, options.operatorParentSessionId);
  if (!owner) {
    if (
      options.missionId &&
      (options.role === "orchestrator" || options.role === "worker")
    ) {
      return spawnMainOwnedMissionPaneAsync({
          ...options,
          missionId: options.missionId,
          role: options.role,
        });
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
      return spawnMainOwnedMissionPaneAsync({
          ...options,
          missionId: options.missionId,
          role: options.role,
          workerIncarnationId: mintedWorkerIncarnationId(options),
        });
    }
    return Promise.resolve({
      requestId: "",
      ok: false,
      error: "pane renderer workspace scope changed",
    });
  }
  const requestId = makeId("orchspawn");
  const paneId = makeId("pane");
  // 0.76.45: acordar/retomar a conversa de um pane antigo no pane novo — o
  // lookup de resume exato é por paneId, então o registro é copiado ANTES do
  // spawn. Sem registro antigo, o spawn segue (fresh) com aviso no log.
  if (options.resumeFromPaneId && options.resumeFromPaneId !== paneId) {
    const nativeOwnerKey = options.adapterId === 'mimo-code' && !options.accountId
      ? currentMimoSessionOwnerKey(providerAuthStrategy('mimo-code', options.model) === 'api-key'
          ? resolveRuntimeApiKey('mimo-code') ?? undefined : undefined) ?? undefined
      : undefined;
    const copied = copyProviderPaneSession(
      options.scope,
      options.resumeFromPaneId,
      paneId,
      options.adapterId,
      options.accountId,
      nativeOwnerKey,
    );
    if (!copied) {
      console.warn(
        `[pane-registry] resumeFromPaneId=${options.resumeFromPaneId}: nenhuma sessão do provider gravada; o pane novo nasce sem contexto`,
      );
    }
  }
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
    ...(options.spawnRoute ? { route: options.spawnRoute } : {}),
    ...(() => {
      const parentPaneId = parentPaneIdFor(
        options.operatorParentSessionId,
        (sessionId) => findPane(sessionId)?.paneId,
      );
      return parentPaneId ? { parentPaneId } : {};
    })(),
    allowPending:
      options[PENDING_SPAWN_RESULT] === true ? true : undefined,
    resume: options.resume != null && options.resume !== false,
    resumeLatestOnly: options.resumeLatestOnly === true,
    restorePersistedAuthority: false,
  });
  return new Promise((resolve) => {
    console.info(
      `[pane-registry] spawn requested id=${requestId} mission=${options.missionId ?? "none"} role=${options.role ?? "none"} owner=${owner.id}`,
    );
    emitAppEvent('pane.spawned', {
      missionId: options.missionId?.slice(0, 128) ?? null,
      role: options.role?.slice(0, 32) ?? null,
    });
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
      pendingResultSent: false,
      allowPendingResult:
        (options as PaneSpawnOptions &
          { readonly [PENDING_SPAWN_RESULT]?: true })[
          PENDING_SPAWN_RESULT
        ] === true,
      abortSignal: options.abortSignal,
      meta: {
        missionId: options.missionId,
        contextRevision: options.contextRevision,
        agentName: options.agentName,
        workerIncarnationId: mintedWorkerIncarnationId(options),
        operatorParentSessionId: options.operatorParentSessionId,
        allowedTools: options.allowedTools,
        allowedSkills: options.allowedSkills,
        role: options.role,
        transient: options.transient === true ? true : undefined,
        scope: options.scope,
        executionScope: options.executionScope,
        readOnly: options.readOnly === true,
        nativeReadOnly: options.nativeReadOnly,
        // Writer isolado que o Nexus criou: o token herda a guarda de git.
        ...(options.isolatedWriter === true ? { isolatedWriter: true } : {}),
        ...(options.operatorOpened === true ? { operatorOpened: true } : {}),
        authoritySeal: options.authoritySeal
          ? Object.freeze({ ...options.authoritySeal })
          : undefined,
      },
    };
    pendingSpawns.set(requestId, pending);
    if (options.missionId) {
      refreshPendingOrchSpawnGrantsForMission(options.missionId);
    }
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
  /** Trusted Main gate context; never renderer or MCP argument metadata. */
  caller?: CallerCtx;
}): Promise<BrowserPaneOpenResult> {
  const owner = options.caller
    ? (sameExactPaneScope(options.caller.scope, options.scope)
      ? browserOwnerForCaller(options.caller) : null)
    : options.role === "worker" ? null : rendererForMission(options.missionId, options.scope);
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
      // O agente precisa de um caminho, não de um bloqueio mudo: os
      // navegadores que o projeto já tem seguem vivos fora da tela.
      error:
        "the Nexus window is showing another project right now, so a new " +
        "browser pane cannot open; keep using a browser pane this project " +
        "already has (nexus_pane_list, then nexus_browser_navigate), or ask " +
        "the operator to switch back to this project",
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
    // Limpeza de um spawn atrasado, não uma troca: os navegadores no espelho
    // já são do projeto atual e não podem ser afastados aqui.
    handleRendererWorkspaceScopeChange(owner, pending.meta.scope, null);
    return true;
  }
  if (result.pending === true) {
    if (
      !pending.allowPendingResult ||
      !result.ok ||
      result.paneId !== pending.request.paneId ||
      result.sessionId !== null
    ) {
      return false;
    }
    if (pending.pendingResultSent) return true;
    pending.pendingResultSent = true;
    if (pending.abortSignal) {
      pendingSpawnResults.set(pending.abortSignal, result);
    }
    attachOrchMeta(owner, result.paneId, pending.meta);
    // Keep this grant in `pendingSpawns`: the PTY may still bind its session
    // after the MCP caller has received the pending ACK.
    pending.resolve(result);
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
  rememberOrchSpawnGrantTombstone(result.requestId, pending, "consumed");
  pendingSpawns.delete(result.requestId);
  if (result.ok && result.paneId) {
    attachOrchMeta(owner, result.paneId, pending.meta);
  }
  if (!pending.pendingResultSent) pending.resolve(result);
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
    const exited = await terminateOwnedMissionSession(sessionToTerminate);
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
  // Recusas são fail-closed por design, mas silenciosas custaram duas
  // sessões de depuração do F-106 (23/08) — nomeie o motivo uma vez por chamada.
  const refuse = (reason: string): false => {
    console.warn(
      `[pane-registry] mission close recusado (${reason}) ` +
        `pane=${expected.paneId} mission=${expected.missionId} role=${expected.role ?? '?'}`,
    );
    return false;
  };
  const detached = getMainOwnedPane(expected.paneId);
  const renderedTargets = panes.filter(
    (candidate) =>
      candidate.entry.paneId === expected.paneId &&
      matchesMissionPaneCloseAuthority(authzInfoOf(candidate), expected),
  );

  if (detached) {
    if (renderedTargets.length > 0) return refuse('detached-com-alvo-renderizado');
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
      return refuse('detached-identidade-divergente');
    }
    const sessionId = detached.entry.sessionId;
    if (sessionId) {
      const exited = await terminateOwnedMissionSession(sessionId);
      if (!exited) return refuse('detached-sessao-nao-terminou');
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
      return refuse('detached-mudou-durante-termino');
    }
    if (!deleteMainOwnedPane(expected.paneId)) return refuse('detached-delete-falhou');
    panesVersion += 1;
    return true;
  }

  if (renderedTargets.length !== 1) return refuse(`alvos-renderizados=${renderedTargets.length}`);
  const target = renderedTargets[0]!;
  const owner = target.owner;
  if (owner.isDestroyed() || owner.isCrashed()) return refuse('owner-morto');
  try {
    requireLiveRendererWorkspaceScope(owner, expected.scope);
  } catch {
    return refuse('escopo-do-renderer-divergente');
  }
  const sessionId = target.entry.sessionId;
  if (sessionId) {
    announceDeliberatePaneClose(owner, expected.paneId, sessionId);
    const exited = await terminateOwnedMissionSession(sessionId);
    if (!exited) return refuse('sessao-nao-terminou');
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
    return refuse('alvo-mudou-durante-termino');
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

/**
 * 0.76.45 — estacionar em vez de fechar: encerra a sessão PTY (memória do
 * pane vai a zero) mas o pane fica no layout com o scrollback; o renderer é
 * avisado para mostrar "Dormindo" e oferecer "Acordar" (spawn no mesmo
 * paneId com resume exato). Pane main-owned (sem renderer) não tem onde
 * acordar: cai no fechamento normal. Retorna o que aconteceu.
 */
export async function requestPanePark(
  paneId: string,
  reason: PaneParkRequest["reason"],
): Promise<"parked" | "closed" | false> {
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
  if (owners.size !== 1) {
    return (await requestPaneClose(paneId)) ? "closed" : false;
  }
  const owner = [...owners][0]!;
  const registered = panes.find(
    (candidate) => candidate.owner === owner && candidate.entry.paneId === paneId,
  );
  const sessionId = registered?.entry.sessionId;
  if (!registered || !sessionId) return false;
  const exited = await terminateOwnedMissionSession(
    sessionId,
    `pane-guardian:park:${reason}`,
  );
  if (!exited) return false;
  // Reconfirma depois do await (como requestPaneClose): um respawn/close
  // concorrente no mesmo pane não pode receber um parkRequest com sessão velha.
  const current = panes.find(
    (candidate) => candidate.owner === owner && candidate.entry.paneId === paneId,
  );
  if (!current || current.entry.sessionId !== sessionId) return false;
  const parkedAt = Date.now();
  parkedByPane.set(paneMetaKey(owner, paneId), { sessionId, parkedAt });
  const request: PaneParkRequest = { paneId, sessionId, parkedAt, reason };
  if (!owner.isDestroyed()) owner.send(ORCH_CHANNELS.paneParkRequest, request);
  panesVersion += 1;
  return "parked";
}

/**
 * O exit do PTY chega ao renderer por outro canal e ANTES do closeRequest.
 * Sem este aviso o pane recém-morto oferecia "digite qualquer tecla para
 * abrir um shell"; uma tecla nessa janela trocava o pane por um shell com
 * sessão nova e o closeRequest era recusado — helper reaberto vazio.
 */
function announceDeliberatePaneClose(
  owner: WebContents,
  paneId: string,
  closingSessionId: string,
): void {
  try {
    if (owner.isDestroyed() || owner.isCrashed()) return;
    owner.send(ORCH_CHANNELS.paneCloseRequest, { paneId, closingSessionId });
  } catch {
    // Aviso de apresentação: nunca impede o término físico que vem a seguir.
  }
}

export async function requestPaneClose(
  paneId: string,
  expectedSessionId?: string,
): Promise<boolean> {
  if (!expectedSessionId) forgetParkedRecords(paneId);
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
  if (!detached && owners.size === 0 && !expectedSessionId) {
    // Navegador de projeto fora da tela: a vista encerra agora e o pane sai
    // do layout quando o projeto voltar (o renderer não o tem montado).
    const parked = parkedBrowserPanesById(paneId);
    if (parked.length === 1) return closeParkedBrowserPane(parked[0]!);
  }
  if (detached) {
    const sessionId = detached.entry.sessionId;
    if (expectedSessionId && sessionId !== expectedSessionId) return false;
    if (expectedSessionId) forgetParkedRecords(paneId);
    if (sessionId) {
      const exited = await terminateOwnedMissionSession(
        sessionId,
        "pane-close",
      );
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
  if (expectedSessionId && sessionId !== expectedSessionId) return false;
  if (expectedSessionId) forgetParkedRecords(paneId);
  const expectedScope = authzInfoOf(target).scope;
  if (expectedScope) {
    try {
      requireLiveRendererWorkspaceScope(owner, expectedScope);
    } catch {
      return false;
    }
  }
  if (sessionId) {
    announceDeliberatePaneClose(owner, paneId, sessionId);
    const exited = await terminateOwnedMissionSession(
      sessionId,
      "pane-close",
    );
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
  owner.send(
    ORCH_CHANNELS.paneCloseRequest,
    expectedSessionId ? { paneId, expectedSessionId } : paneId,
  );
  return true;
}
