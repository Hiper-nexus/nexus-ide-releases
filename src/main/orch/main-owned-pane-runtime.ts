import type {
  MissionPaneAuthoritySeal,
  OrchPaneSpawnRequest,
  OrchPaneSpawnResult,
  PaneRegistryEntry,
  PaneSnapshot,
} from "../../shared/orch-types";
import type { ProjectExecutionScope } from "../../shared/types";
import {
  getAdapter,
  isAdapterInstalled,
  isBuiltinAdapter,
  resolveAdapterBinary,
} from "../adapters/adapter-registry";
import {
  isFileAuthAdapter,
  trackManagedSession,
} from "../adapters/managed-credentials";
import { recordAccountChoiceReceipt } from "../persistence/account-choice-receipts";
import {
  resolveRotatingAuthFile,
  ROTATING_REFRESH_SPAWN_ADAPTERS,
  waitForRotatingAuthSpawnGate,
} from "../adapters/managed-auth-spawn-gate";
import {
  acquireCliSpawnPermit,
  prepareProviderSpawn,
  prepareProviderSpawnAuthoritative,
  type ProviderSpawnPreparation,
} from "../persistence/provider-config-store";
import {
  getAgentSessionInfo,
  getSessionState,
  spawnMainOwnedAgentSession,
} from "../pty/pty-manager";
import {
  isMissionBoundCodexWorkspaceAuthority,
  requiresReadOnlyNativeAuthority,
  supportsEnforceableReadOnlyNativeAuthority,
  supportsEnforceableWorkspaceWriteNativeAuthority,
} from "../pty/autonomous-cli-policy";
import {
  requiresSpawnGate,
  shouldUseEphemeralHome,
} from "./spawn-home-policy";
import { assertTrustedNativeConfinementBinary } from "../pty/trusted-native-cli-binary";
import { canListPane, type CallerCtx, type PaneAuthzInfo } from "./pane-authz";
import { sameProjectScope } from "./project-scoped-broadcast";
import type { BoundSpawnAuthority } from "./spawn-authority";
import { makeId } from "./store-util";
import { resolveCwdForScope } from "./workspace-path";
import { sameMissionPaneAuthoritySeal } from "./mission-pane-authority";
import { getOrchSettings } from "../persistence/settings-store";
import { isOperatorChoicePolicy } from "../../shared/squad-cli-policy";
import { spawnMainOwnedAcpMissionPane } from "./acp-mission-spawn";
import { issueAgentIdentityBestEffort } from "./agent-identity-spawn";

export interface PaneOrchMeta {
  /** Main-authored spawner for missionless operator handoffs. */
  operatorParentSessionId?: string;
  missionId?: string;
  contextRevision?: string;
  agentName?: string;
  workerIncarnationId?: string;
  /** Skill-gate allowlists for the agent behind this pane (null = open). */
  allowedTools?: string[] | null;
  allowedSkills?: string[] | null;
  role?: "orchestrator" | "worker";
  /** Process-local verification lanes remain headless across renderer reloads. */
  transient?: true;
  scope?: Readonly<ProjectExecutionScope>;
  executionScope?: Readonly<ProjectExecutionScope>;
  readOnly?: boolean;
  /** Provider-native confinement, separate from Nexus MCP authority. */
  nativeReadOnly?: boolean;
  /**
   * Modo concorrente OPT-IN: este worker exige worktree fisicamente distinta.
   *
   * Ausente (padrão) = caminho SIMPLES: o worker roda no próprio workspace com
   * cwd herdado, como no modelo. O isolamento existe para proteger
   * ESCRITORES CONCORRENTES entre si; cobrá-lo de toda missão transformava um
   * requisito de fan-out largo em porta trancada — inclusive para revisores
   * read-only, que não escrevem nada. Ver
   * docs/analysis/2026-08-06-refatoracao-execucao-simples.md.
   */
  isolatedWriter?: boolean;
  /** Exact approved revision seal retained with the physical process. */
  authoritySeal?: MissionPaneAuthoritySeal;
}

export interface PaneSpawnOptions {
  /**
   * 0.76.45: retomar a conversa de um pane ANTIGO (estacionado/fechado) no
   * pane novo — o registro de sessão do provider é copiado para o paneId
   * novo antes do spawn, e `resume: true` resolve o `--resume` exato.
   */
  readonly resumeFromPaneId?: string;
  /** Main-authored spawner; never copied into the renderer request. */
  operatorParentSessionId?: string;
  adapterId: string;
  model?: string;
  /**
   * Main-authored first turn passed directly to providers whose booting TUI
   * cannot reliably accept pasted input. It is never sent to the renderer or
   * retained in pane snapshots.
   */
  initialPrompt?: string;
  /** Exact main-selected vault account for this pane. */
  accountId?: string;
  /** Per-spawn reasoning effort (task-router decision). */
  effort?: string;
  cwd?: string;
  title?: string;
  missionId?: string;
  /** Renderer presentation is process-local and must not survive restart. */
  transient?: true;
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
  /**
   * Selado no despacho. `same_checkout` (padrão Bridge do caminho
   * simples) escreve no workspace de coordenação — NÃO exige worktree
   * distinta. `isolated_worktree` é o fan-out multi-escritor.
   */
  executionMode?: "same_checkout" | "isolated_worktree" | "read_only";
  /**
   * Opt-in: este worker exige worktree fisicamente distinta (concorrência).
   * Ausente = caminho simples no mesmo checkout (comentário em PaneOrchMeta).
   */
  isolatedWriter?: boolean;
  /** Exact approved revision seal retained by the physical PTY. */
  authoritySeal?: MissionPaneAuthoritySeal;
  /**
   * Resume a CLOSED worker with its context intact. Triggers
   * --resume <sessionId> (or equivalent) via pty-manager resume logic.
   * Accepts boolean (resume mode on) or a task/pane id string.
   */
  resume?: boolean | string;
  /** Only consider the latest session (no exact-session resume lookup). */
  resumeLatestOnly?: boolean;
}

export interface MainOwnedPane {
  entry: PaneRegistryEntry;
  meta: PaneOrchMeta;
}

export interface PendingMainOwnedSpawn {
  claimed: boolean;
  claimedSessionId: string | null;
  initialPrompt?: string;
  meta: PaneOrchMeta;
  requestedCwd?: string;
  request: OrchPaneSpawnRequest;
}

export interface MainOwnedPaneHooks {
  attachSessionScope(
    sessionId: string,
    scope: Readonly<ProjectExecutionScope>,
  ): void;
  assertMissionAuthorityCurrent(input: {
    readonly missionId: string;
    readonly scope: Readonly<ProjectExecutionScope>;
    readonly contextRevision: string;
    readonly authoritySeal: MissionPaneAuthoritySeal;
  }): void;
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
    operatorParentSessionId: pane.meta.operatorParentSessionId,
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

export async function fallbackPendingSpawnToMain(
  pending: PendingMainOwnedSpawn,
  hooks: MainOwnedPaneHooks,
): Promise<OrchPaneSpawnResult | null> {
  const { missionId, role } = pending.meta;
  if (
    pending.claimed ||
    !missionId ||
    (role !== "orchestrator" && role !== "worker") ||
    !pending.meta.scope
  ) {
    return null;
  }
  return spawnMainOwnedMissionPaneAsync(
    {
      adapterId: pending.request.adapterId,
      model: pending.request.model,
      initialPrompt: pending.initialPrompt,
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
      authoritySeal: pending.meta.authoritySeal,
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
    !sameMissionPaneAuthoritySeal(
      agent.authoritySeal,
      pending.meta.authoritySeal,
    ) ||
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

type MissionPaneSpawnOptions = PaneSpawnOptions & {
  missionId: string;
  role: "orchestrator" | "worker";
};

/**
 * Create a physical mission PTY owned by main. Presentation can be adopted by
 * a renderer later without changing pane/session identity.
 */
export function spawnMainOwnedMissionPane(
  options: MissionPaneSpawnOptions,
  hooks: MainOwnedPaneHooks,
  authoritativePreparation?: ProviderSpawnPreparation,
): OrchPaneSpawnResult;
export function spawnMainOwnedMissionPane(
  options: MissionPaneSpawnOptions,
  hooks: MainOwnedPaneHooks,
  authoritativePreparation: ProviderSpawnPreparation | undefined,
  coordinateAuthRefresh: false,
  spawnPermitHeld: true,
): OrchPaneSpawnResult;
export function spawnMainOwnedMissionPane(
  options: MissionPaneSpawnOptions,
  hooks: MainOwnedPaneHooks,
  authoritativePreparation: ProviderSpawnPreparation | undefined,
  coordinateAuthRefresh: true,
  spawnPermitHeld?: boolean,
): OrchPaneSpawnResult | Promise<OrchPaneSpawnResult>;
export function spawnMainOwnedMissionPane(
  options: MissionPaneSpawnOptions,
  hooks: MainOwnedPaneHooks,
  authoritativePreparation?: ProviderSpawnPreparation,
  coordinateAuthRefresh = false,
  spawnPermitHeld = false,
): OrchPaneSpawnResult | Promise<OrchPaneSpawnResult> {
  const requestId = makeId("orchspawn");
  const paneId = makeId("pane");
  const operatorChoice = isOperatorChoicePolicy(
    getOrchSettings().squadCliPolicy,
  );
  const authoritySeal = options.authoritySeal;
  if (!authoritySeal) {
    if (!operatorChoice) {
      return {
        requestId,
        ok: false,
        error:
          "mission pane authority seal is unavailable; replane and approve " +
          "the current mission revision",
      };
    }
    // Autopilot libre: spawn without seal — worktree + merge remain the floor.
    console.warn(
      `[main-owned-spawn] Autopilot: missing authority seal for ` +
        `${options.missionId}; continuing`,
    );
  }
  if (
    authoritySeal &&
    options.contextRevision !== undefined &&
    options.contextRevision !== authoritySeal.contextRevision
  ) {
    if (!operatorChoice) {
      return {
        requestId,
        ok: false,
        error:
          "mission pane contextRevision diverges from its main-owned " +
          "authority seal",
      };
    }
    console.warn(
      `[main-owned-spawn] Autopilot: contextRevision drift for ` +
        `${options.missionId}; continuing with live seal`,
    );
  }
  const sealedAuthority = authoritySeal
    ? Object.freeze({ ...authoritySeal })
    : undefined;
  if (sealedAuthority) {
    try {
      hooks.assertMissionAuthorityCurrent({
        missionId: options.missionId,
        scope: options.scope,
        contextRevision: sealedAuthority.contextRevision,
        authoritySeal: sealedAuthority,
      });
    } catch (error) {
      if (!operatorChoice) {
        return {
          requestId,
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : "mission pane authority is stale",
        };
      }
      console.warn(
        `[main-owned-spawn] Autopilot: authority current check soft-failed:`,
        error,
      );
    }
  }
  options = {
    ...options,
    ...(sealedAuthority
      ? {
          contextRevision: sealedAuthority.contextRevision,
          authoritySeal: sealedAuthority,
        }
      : {}),
  };
  const adapter = getAdapter(options.adapterId);
  if (!adapter) {
    return {
      requestId,
      ok: false,
      error: `unknown adapter: ${options.adapterId}`,
    };
  }
  if (getOrchSettings().agentTransport === "acp") {
    return {
      requestId,
      ok: false,
      error:
        "transporte ACP selecionado — use spawnMainOwnedMissionPaneAsync; " +
        "nunca faz fallback silencioso para PTY",
    };
  }
  if (adapter.kind !== "cli-pty") {
    return {
      requestId,
      ok: false,
      error:
        `adapter ${options.adapterId} has no main-owned PTY transport`,
    };
  }
  if (!spawnPermitHeld) {
    return {
      requestId,
      ok: false,
      error: 'CLI mission panes require async spawn update coordination',
    };
  }
  if (adapter.id === 'claude' && authoritativePreparation === undefined) {
    return {
      requestId,
      ok: false,
      error: 'Claude mission panes require async account identity verification before provider preparation',
    };
  }
  const executionScope = options.executionScope ?? options.scope;
  const writableMissionWorkerIntent =
    options.role === "worker" &&
    Boolean(options.missionId?.trim()) &&
    options.readOnly !== true &&
    options.nativeReadOnly !== true;
  // Paridade Bridge + flip 06/08: worktree distinta SÓ no fan-out
  // isolado. Default (same_checkout / undefined) = mesmo checkout do chefe,
  // como o spawn de Builder no Bridge. Sem isto o scheduler claimava
  // a task e o spawn morria — claim sem pane, tile zumbi (HiperGO 2026-08-07).
  // Espelha tool-util.ts e PaneOrchMeta.isolatedWriter.
  const requiresDistinctWorktree =
    writableMissionWorkerIntent &&
    (options.isolatedWriter === true ||
      options.executionMode === "isolated_worktree");
  const missionBoundWritableWorker =
    !operatorChoice &&
    writableMissionWorkerIntent &&
    isMissionBoundCodexWorkspaceAuthority({
      source: "pending",
      adapterId: adapter.id,
      role: options.role,
      missionId: options.missionId,
      contextRevision: options.contextRevision,
      authoritySeal: options.authoritySeal,
      readOnly: options.readOnly,
      nativeReadOnly: options.nativeReadOnly,
    });
  if (
    requiresDistinctWorktree &&
    (!options.executionScope ||
      executionScope.rootRealPath === options.scope.rootRealPath)
  ) {
    return {
      requestId,
      ok: false,
      error:
        "mission-bound writable worker requires a physically distinct " +
        "main-owned execution worktree",
    };
  }
  if (
    !operatorChoice &&
    writableMissionWorkerIntent &&
    (adapter.id !== "codex" ||
      !isBuiltinAdapter(adapter.id) ||
      !supportsEnforceableWorkspaceWriteNativeAuthority(adapter))
  ) {
    return {
      requestId,
      ok: false,
      error:
        `adapter ${adapter.id} cannot enforce trusted workspace-write authority; ` +
        "isolated worker spawn refused before provider preparation",
    };
  }
  const nativeReadOnly =
    !operatorChoice &&
    requiresReadOnlyNativeAuthority({
      source: "pending",
      adapterId: adapter.id,
      role: options.role,
      missionId: options.missionId,
      contextRevision: options.contextRevision,
      authoritySeal: options.authoritySeal,
      readOnly: options.readOnly,
      nativeReadOnly: options.nativeReadOnly,
    });
  if (
    nativeReadOnly &&
    (!isBuiltinAdapter(adapter.id) ||
      !supportsEnforceableReadOnlyNativeAuthority(adapter))
  ) {
    return {
      requestId,
      ok: false,
      error:
        `adapter ${adapter.id} cannot enforce native read-only authority; ` +
        "orchestrator spawn refused before provider preparation",
    };
  }
  const prepared =
    authoritativePreparation ??
    prepareProviderSpawn(adapter.id, {
      effort: options.effort,
      accountId: options.accountId,
      model: options.model,
      // A decisão de credencial do Claude depende do HOME que o spawn hook vai
      // aplicar: no HOME efêmero o CLI não alcança a linhagem nativa.
      isolatedHome: shouldUseEphemeralHome(
        adapter,
        requiresSpawnGate({
          role: options.role,
          allowedTools: options.allowedTools,
          allowedSkills: options.allowedSkills,
        }),
        {
          mode: operatorChoice ? "operator-choice" : "hardened",
        },
      ),
    });
  if (!prepared.ok) return { requestId, ok: false, error: prepared.error };
  const selectedAccountId = prepared.overrides.selectedAccountId ?? options.accountId;
  if (options.accountId && selectedAccountId !== options.accountId) {
    return { requestId, ok: false, error: "selected account diverges from the authorized account pin" };
  }
  if (coordinateAuthRefresh) {
    const authFile = resolveRotatingAuthFile(adapter.id, prepared.overrides.keyEnv);
    if (authFile) {
      return waitForRotatingAuthSpawnGate({ authFile }).then(
        // Recheck Main authority after waiting, without selecting/materializing
        // again: that could switch the account or restore its stale credential.
        () => spawnMainOwnedMissionPane(options, hooks, prepared, false, spawnPermitHeld),
        (error) => ({
          requestId,
          ok: false,
          error: error instanceof Error
            ? error.message
            : "failed to coordinate Codex auth refresh",
        }),
      );
    }
  }
  let preparedOverrides = prepared.overrides;
  if (nativeReadOnly || missionBoundWritableWorker) {
    if (!preparedOverrides.binPath) {
      return {
        requestId,
        ok: false,
        error: `${adapter.label} has no canonical executable for native confinement`,
      };
    }
    try {
      // Gate only — do not replace binPath with the sealed native executable.
      // For Codex, assertTrustedNativeConfinementBinary resolves the npm
      // wrapper to the vendor Mach-O. spawnAgentSession re-qualifies against
      // live discovery and rewrites the spawn file itself; feeding that Mach-O
      // back as requestedBinPath fails "diverges from canonical discovery".
      assertTrustedNativeConfinementBinary({
        adapterId: adapter.id,
        requestedBinPath: preparedOverrides.binPath,
        canonicalBinPath: resolveAdapterBinary(adapter.id),
      });
    } catch (error) {
      return {
        requestId,
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "native confinement executable verification failed",
      };
    }
  }
  if (!preparedOverrides.binPath && !isAdapterInstalled(adapter.id)) {
    return {
      requestId,
      ok: false,
      error: `${adapter.label} not found. Install: ${adapter.install.command}`,
    };
  }
  const cwd = resolveCwdForScope(executionScope, options.cwd);
  const context = Object.freeze({
    operatorParentSessionId: options.operatorParentSessionId,
    missionId: options.missionId,
    contextRevision: options.contextRevision,
    agentName: options.agentName,
    workerIncarnationId: options.workerIncarnationId,
    allowedTools: options.allowedTools,
    allowedSkills: options.allowedSkills,
    role: options.role,
    transient: options.transient === true ? true : undefined,
    scope: options.scope,
    executionScope,
    readOnly: options.readOnly === true,
    nativeReadOnly,
    authoritySeal: options.authoritySeal,
  });
  const spawnContext = Object.freeze({
    ...context,
    ...(options.initialPrompt === undefined
      ? {}
      : { initialPrompt: options.initialPrompt }),
  });
  const authority: BoundSpawnAuthority = Object.freeze({
    source: "pending",
    context: spawnContext,
    scope: executionScope,
    coordinationScope: options.scope,
    cwd,
  });
  try {
    // Best-effort only: vault/keyring must never block the first PTY.
    issueAgentIdentityBestEffort({
      missionId: options.missionId,
      scope: options.scope,
      agentId: options.agentName ?? adapter.id,
    });
    const { sessionId } = spawnMainOwnedAgentSession(
      {
        kind: "cli-agent",
        cols: 120,
        rows: 36,
        paneId,
        adapterId: adapter.id,
        model: options.model,
        accountId: selectedAccountId,
        effort: options.effort,
        cwd,
        missionId: options.missionId,
      },
      adapter,
      preparedOverrides,
      authority,
    );
    if (selectedAccountId && isFileAuthAdapter(adapter.id)) {
      trackManagedSession(sessionId, adapter.id, selectedAccountId);
    }
    if (preparedOverrides.accountChoice) {
      recordAccountChoiceReceipt(sessionId, preparedOverrides.accountChoice);
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
        accountId: selectedAccountId,
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

/**
 * Async mission-pane spawn. Besides ACP, the PTY path uses this boundary to
 * revalidate Keychain-only AGY auth and coordinate Codex account refresh without
 * blocking Electron's main loop.
 */
export async function spawnMainOwnedMissionPaneAsync(
  options: PaneSpawnOptions & {
    missionId: string;
    role: "orchestrator" | "worker";
  },
  hooks: MainOwnedPaneHooks,
): Promise<OrchPaneSpawnResult> {
  if (getOrchSettings().agentTransport !== "acp") {
    const adapter = getAdapter(options.adapterId);
    const withPermit = async (
      run: () => OrchPaneSpawnResult | Promise<OrchPaneSpawnResult>,
    ): Promise<OrchPaneSpawnResult> => {
      const release = await acquireCliSpawnPermit(options.adapterId);
      try { return await run(); }
      finally { release(); }
    };
    if (
      adapter?.kind === "cli-pty" &&
      ROTATING_REFRESH_SPAWN_ADAPTERS.has(adapter.id)
    ) {
      // Run the normal validation and preparation before entering the wait.
      return withPermit(() => spawnMainOwnedMissionPane(options, hooks, undefined, true, true));
    }
    if (
      adapter?.kind === "cli-pty" &&
      (adapter.id === "agy" || adapter.id === "claude") &&
      (adapter.id === "claude" || !options.accountId)
    ) {
      const operatorChoice = isOperatorChoicePolicy(
        getOrchSettings().squadCliPolicy,
      );
      const prepared = await prepareProviderSpawnAuthoritative(adapter.id, {
        effort: options.effort,
        accountId: options.accountId,
        model: options.model,
        isolatedHome: shouldUseEphemeralHome(
          adapter,
          requiresSpawnGate({
            role: options.role,
            allowedTools: options.allowedTools,
            allowedSkills: options.allowedSkills,
          }),
          {
            mode: operatorChoice ? "operator-choice" : "hardened",
          },
        ),
      });
      return withPermit(() => spawnMainOwnedMissionPane(options, hooks, prepared, false, true));
    }
    return adapter?.kind === 'cli-pty'
      ? withPermit(() => spawnMainOwnedMissionPane(options, hooks, undefined, false, true))
      : spawnMainOwnedMissionPane(options, hooks);
  }
  const requestId = makeId("orchspawn");
  const authoritySeal = options.authoritySeal;
  if (!authoritySeal) {
    return {
      requestId,
      ok: false,
      error:
        "mission pane authority seal is unavailable; replane and approve " +
        "the current mission revision",
    };
  }
  const sealedAuthority = Object.freeze({ ...authoritySeal });
  try {
    hooks.assertMissionAuthorityCurrent({
      missionId: options.missionId,
      scope: options.scope,
      contextRevision: sealedAuthority.contextRevision,
      authoritySeal: sealedAuthority,
    });
  } catch (error) {
    return {
      requestId,
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "mission pane authority is stale",
    };
  }
  return spawnMainOwnedAcpMissionPane(
    {
      ...options,
      contextRevision: sealedAuthority.contextRevision,
      authoritySeal: sealedAuthority,
    },
    hooks,
    (paneId, entry, meta) => {
      panes.set(paneId, {
        entry,
        meta: {
          ...meta,
          scope: options.scope,
          executionScope: meta.executionScope ?? options.scope,
        },
      });
    },
  );
}
