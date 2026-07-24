import type {
  MissionPaneAuthoritySeal,
  OrchPaneSpawnRequest,
  OrchPaneSpawnResult,
  PaneRegistryEntry,
  PaneSnapshot,
} from "../../shared/orch-types";
import type { ProjectExecutionScope } from "../../shared/types";
import { getAdapter, isAdapterInstalled } from "../adapters/adapter-registry";
import {
  isFileAuthAdapter,
  trackManagedSession,
} from "../adapters/managed-credentials";
import { prepareProviderSpawn } from "../persistence/provider-config-store";
import {
  getAgentSessionInfo,
  getSessionState,
  spawnMainOwnedAgentSession,
} from "../pty/pty-manager";
import {
  requiresReadOnlyNativeAuthority,
  supportsEnforceableReadOnlyNativeAuthority,
} from "../pty/autonomous-cli-policy";
import { canListPane, type CallerCtx, type PaneAuthzInfo } from "./pane-authz";
import { sameProjectScope } from "./project-scoped-broadcast";
import type { BoundSpawnAuthority } from "./spawn-authority";
import { makeId } from "./store-util";
import { resolveCwdForScope } from "./workspace-path";

export interface PaneOrchMeta {
  missionId?: string;
  contextRevision?: string;
  agentName?: string;
  workerIncarnationId?: string;
  /** Skill-gate allowlists for the agent behind this pane (null = open). */
  allowedTools?: string[] | null;
  allowedSkills?: string[] | null;
  role?: "orchestrator" | "worker";
  scope?: Readonly<ProjectExecutionScope>;
  executionScope?: Readonly<ProjectExecutionScope>;
  readOnly?: boolean;
  /** Provider-native confinement, separate from Nexus MCP authority. */
  nativeReadOnly?: boolean;
  /** Exact approved revision seal retained with the physical process. */
  authoritySeal?: MissionPaneAuthoritySeal;
}

export interface PaneSpawnOptions {
  adapterId: string;
  model?: string;
  /** Exact main-selected vault account for this pane. */
  accountId?: string;
  /** Per-spawn reasoning effort (task-router decision). */
  effort?: string;
  cwd?: string;
  title?: string;
  missionId?: string;
  contextRevision?: string;
  agentName?: string;
  workerIncarnationId?: string;
  allowedTools?: string[] | null;
  allowedSkills?: string[] | null;
  role?: "orchestrator" | "worker";
  scope: Readonly<ProjectExecutionScope>;
  executionScope?: Readonly<ProjectExecutionScope>;
  readOnly?: boolean;
  /** Confine provider-native writes while retaining audited Nexus delegation. */
  nativeReadOnly?: boolean;
  /** Exact approved revision seal retained by the physical PTY. */
  authoritySeal?: MissionPaneAuthoritySeal;
}

export interface MainOwnedPane {
  entry: PaneRegistryEntry;
  meta: PaneOrchMeta;
}

export interface PendingMainOwnedSpawn {
  claimed: boolean;
  claimedSessionId: string | null;
  meta: PaneOrchMeta;
  requestedCwd?: string;
  request: OrchPaneSpawnRequest;
}

export interface MainOwnedPaneHooks {
  attachSessionScope(
    sessionId: string,
    scope: Readonly<ProjectExecutionScope>,
  ): void;
  panesChanged(): void;
}

const panes = new Map<string, MainOwnedPane>();

export function getMainOwnedPane(paneId: string): MainOwnedPane | undefined {
  return panes.get(paneId);
}

export function setMainOwnedPane(paneId: string, pane: MainOwnedPane): void {
  panes.set(paneId, pane);
}

export function deleteMainOwnedPane(paneId: string): boolean {
  return panes.delete(paneId);
}

export function mainOwnedPaneValues(): MainOwnedPane[] {
  return [...panes.values()];
}

export function hasMainOwnedPaneReference(reference: string): boolean {
  return [...panes.values()].some(
    ({ entry }) => entry.paneId === reference || entry.sessionId === reference,
  );
}

export function hasMainOwnedPaneSession(sessionId: string): boolean {
  return [...panes.values()].some(({ entry }) => entry.sessionId === sessionId);
}

function authzInfoOf(pane: MainOwnedPane): PaneAuthzInfo {
  return {
    paneId: pane.entry.paneId,
    sessionId: pane.entry.sessionId,
    kind: pane.entry.kind,
    missionId: pane.meta.missionId,
    contextRevision: pane.meta.contextRevision,
    role: pane.meta.role,
    workerIncarnationId: pane.meta.workerIncarnationId,
    scope: pane.meta.scope,
    executionScope: pane.meta.executionScope,
  };
}

function matchesReference(pane: MainOwnedPane, reference: string): boolean {
  return pane.entry.paneId === reference || pane.entry.sessionId === reference;
}

export function findMainOwnedPaneEntries(
  reference: string,
): PaneRegistryEntry[] {
  return [...panes.values()]
    .filter((pane) => matchesReference(pane, reference))
    .map(({ entry }) => entry);
}

export function findMainOwnedPaneAuthz(reference: string): PaneAuthzInfo[] {
  return [...panes.values()]
    .filter((pane) => matchesReference(pane, reference))
    .map(authzInfoOf);
}

export function findMainOwnedRuntimeAuthority(
  sessionId: string,
): Array<Readonly<PaneAuthzInfo> & { readonly owner: null }> {
  return [...panes.values()]
    .filter(({ entry }) => entry.sessionId === sessionId)
    .map((pane) => Object.freeze({ ...authzInfoOf(pane), owner: null }));
}

export function listMainOwnedPaneSnapshots(
  paneState: (entry: PaneRegistryEntry) => PaneSnapshot["state"],
): PaneSnapshot[] {
  return [...panes.values()].map((pane) => ({
    ...pane.entry,
    state: paneState(pane.entry),
    ...pane.meta,
  }));
}

export function listVisibleMainOwnedPaneSnapshots(
  caller: CallerCtx,
  paneState: (entry: PaneRegistryEntry) => PaneSnapshot["state"],
): PaneSnapshot[] {
  return [...panes.values()]
    .filter((pane) => canListPane(caller, authzInfoOf(pane)))
    .map((pane) => ({
      ...pane.entry,
      state: paneState(pane.entry),
      ...pane.meta,
    }));
}

export function fallbackPendingSpawnToMain(
  pending: PendingMainOwnedSpawn,
  hooks: MainOwnedPaneHooks,
): OrchPaneSpawnResult | null {
  const { missionId, role } = pending.meta;
  if (
    pending.claimed ||
    !missionId ||
    (role !== "orchestrator" && role !== "worker") ||
    !pending.meta.scope
  ) {
    return null;
  }
  return spawnMainOwnedMissionPane(
    {
      adapterId: pending.request.adapterId,
      model: pending.request.model,
      accountId: pending.request.accountId,
      effort: pending.request.effort,
      cwd: pending.requestedCwd,
      title: pending.request.title,
      missionId,
      contextRevision: pending.meta.contextRevision,
      agentName: pending.meta.agentName,
      workerIncarnationId: pending.meta.workerIncarnationId,
      allowedTools: pending.meta.allowedTools,
      allowedSkills: pending.meta.allowedSkills,
      role,
      scope: pending.meta.scope,
      executionScope: pending.meta.executionScope,
      readOnly: pending.meta.readOnly,
      nativeReadOnly: pending.meta.nativeReadOnly,
    },
    hooks,
  );
}

export function retainClaimedPendingSpawn(
  requestId: string,
  pending: PendingMainOwnedSpawn,
  hooks: MainOwnedPaneHooks,
): OrchPaneSpawnResult | null {
  const sessionId = pending.claimedSessionId;
  if (!pending.claimed || !sessionId || !pending.meta.scope) return null;
  const agent = getAgentSessionInfo(sessionId);
  const paneId = agent?.paneId;
  const expectedScope = pending.meta.executionScope ?? pending.meta.scope;
  if (
    !agent ||
    !paneId ||
    agent.adapterId !== pending.request.adapterId ||
    agent.missionId !== pending.meta.missionId ||
    agent.role !== pending.meta.role ||
    agent.workerIncarnationId !== pending.meta.workerIncarnationId ||
    !sameProjectScope(agent.scope, expectedScope)
  ) {
    return null;
  }
  hooks.attachSessionScope(sessionId, pending.meta.scope);
  panes.set(paneId, {
    entry: {
      paneId,
      sessionId,
      title: pending.request.title ?? pending.meta.agentName ?? agent.adapterId,
      kind: "cli-agent",
      adapterId: agent.adapterId,
      model: agent.model ?? pending.request.model,
      accountId: agent.accountId,
      state: getSessionState(sessionId) ?? "unknown",
    },
    meta: {
      ...pending.meta,
      scope: pending.meta.scope,
      executionScope: expectedScope,
    },
  });
  hooks.panesChanged();
  return { requestId, ok: true, paneId, sessionId };
}

/**
 * Create a physical mission PTY owned by main. Presentation can be adopted by
 * a renderer later without changing pane/session identity.
 */
export function spawnMainOwnedMissionPane(
  options: PaneSpawnOptions & {
    missionId: string;
    role: "orchestrator" | "worker";
  },
  hooks: MainOwnedPaneHooks,
): OrchPaneSpawnResult {
  const requestId = makeId("orchspawn");
  const paneId = makeId("pane");
  const adapter = getAdapter(options.adapterId);
  if (!adapter) {
    return {
      requestId,
      ok: false,
      error: `unknown adapter: ${options.adapterId}`,
    };
  }
  if (adapter.kind !== "cli-pty") {
    return {
      requestId,
      ok: false,
      error:
        `adapter ${options.adapterId} has no main-owned PTY transport ` +
        "(RPC mission workers use the dedicated OMP lane)",
    };
  }
  const nativeReadOnly = requiresReadOnlyNativeAuthority({
    source: "pending",
    role: options.role,
    contextRevision: options.contextRevision,
    readOnly: options.readOnly,
    nativeReadOnly: options.nativeReadOnly,
  });
  if (nativeReadOnly && !supportsEnforceableReadOnlyNativeAuthority(adapter)) {
    return {
      requestId,
      ok: false,
      error:
        `adapter ${adapter.id} cannot enforce native read-only authority; ` +
        "orchestrator spawn refused before provider preparation",
    };
  }
  const prepared = prepareProviderSpawn(adapter.id, {
    effort: options.effort,
    accountId: options.accountId,
    model: options.model,
  });
  if (!prepared.ok) return { requestId, ok: false, error: prepared.error };
  if (!prepared.overrides.binPath && !isAdapterInstalled(adapter.id)) {
    return {
      requestId,
      ok: false,
      error: `${adapter.label} not found. Install: ${adapter.install.command}`,
    };
  }
  const executionScope = options.executionScope ?? options.scope;
  const cwd = resolveCwdForScope(executionScope, options.cwd);
  const context = Object.freeze({
    missionId: options.missionId,
    contextRevision: options.contextRevision,
    agentName: options.agentName,
    workerIncarnationId: options.workerIncarnationId,
    allowedTools: options.allowedTools,
    allowedSkills: options.allowedSkills,
    role: options.role,
    scope: options.scope,
    executionScope,
    readOnly: options.readOnly === true,
    nativeReadOnly,
    authoritySeal: options.authoritySeal,
  });
  const authority: BoundSpawnAuthority = Object.freeze({
    source: "pending",
    context,
    scope: executionScope,
    coordinationScope: options.scope,
    cwd,
  });
  try {
    const { sessionId } = spawnMainOwnedAgentSession(
      {
        kind: "cli-agent",
        cols: 120,
        rows: 36,
        paneId,
        adapterId: adapter.id,
        model: options.model,
        accountId: options.accountId,
        effort: options.effort,
        cwd,
        missionId: options.missionId,
      },
      adapter,
      prepared.overrides,
      authority,
    );
    if (options.accountId && isFileAuthAdapter(adapter.id)) {
      trackManagedSession(sessionId, adapter.id, options.accountId);
    }
    hooks.attachSessionScope(sessionId, options.scope);
    panes.set(paneId, {
      entry: {
        paneId,
        sessionId,
        title: options.title ?? options.agentName ?? adapter.label,
        kind: "cli-agent",
        adapterId: adapter.id,
        model: options.model,
        accountId: options.accountId,
        state: getSessionState(sessionId) ?? "spawning",
      },
      meta: { ...context, scope: options.scope, executionScope },
    });
    hooks.panesChanged();
    return { requestId, ok: true, paneId, sessionId };
  } catch (error) {
    return {
      requestId,
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "main-owned mission pane spawn failed",
    };
  }
}
