import { resetLicensedAccessMock } from '../__tests__/licensed-access';
beforeEach(resetLicensedAccessMock);
vi.mock('../license-access', async () => (await import('../__tests__/licensed-access')).licensedAccessMock);
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PTY_CHANNELS } from "../../shared/channels";
import type { Mission } from "../../shared/orch-types";

const ipcDeps = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    handle: vi.fn(
      (channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      },
    ),
    on: vi.fn(),
  };
});

const ptyDeps = vi.hoisted(() => ({
  adoptMainOwnedAgentSession: vi.fn((): unknown => null),
  getSessionState: vi.fn((_sessionId: string): unknown => null),
  listAgentSessionsForPane: vi.fn((): unknown[] => []),
  spawnAgentSession: vi.fn(
    (): { sessionId: string; resumeMode?: string } => ({
      sessionId: "pty-created",
    }),
  ),
  spawnSession: vi.fn(() => ({ sessionId: "shell-created" })),
  setPtyHost: vi.fn(),
  killSession: vi.fn(),
  orchKillSession: vi.fn(),
  orchTerminateSession: vi.fn(async () => true),
  writeSession: vi.fn(() => true),
}));

const dispatchDeps = vi.hoisted(() => ({
  list: vi.fn((): unknown[] => []),
  rebindRestartedWorker: vi.fn(),
}));

const authorityDeps = vi.hoisted(() => {
  const scope = {
    version: 1 as const,
    installationId: "installation-a",
    projectId: "project-a",
    checkoutId: "checkout-a",
    rootRealPath: "/workspace/a",
    identitySource: "manifest" as const,
  };
  return {
    scope,
    requireRendererWorkspaceScope: vi.fn((_owner?: unknown) => scope),
    resolveCwdForScope: vi.fn(() => "/workspace/a"),
    claimPendingSpawnMeta: vi.fn(
      (_requestId: string, _owner: unknown): unknown => null,
    ),
    claimPendingSpawnMetaByPane: vi.fn(
      (_input: unknown, _owner: unknown): unknown => null,
    ),
    claimPendingRecoverySpawnMeta: vi.fn(
      (_requestId: string, _owner: unknown): unknown => null,
    ),
    bindPendingSpawnSession: vi.fn(() => true),
    bindPendingRecoverySpawnSession: vi.fn(() => true),
    assertPendingSpawnGrantActive: vi.fn(),
    assertPendingRecoverySpawnGrantActive: vi.fn(),
    assertMissionSpawnAuthorityCurrent: vi.fn(),
    attachOrchMeta: vi.fn(),
    attachSessionScope: vi.fn(),
    hasLivePaneSession: vi.fn((_paneId: string) => false),
    findMissionPaneByPaneId: vi.fn((_paneId: string): unknown => null),
    rebindOrchestratorAuthority: vi.fn(),
    createScopedMissionPaneStore: vi.fn(),
    getMission: vi.fn((_missionId: string): unknown => null),
    createScopedMissionStore: vi.fn(),
    listSquads: vi.fn((): unknown[] => []),
  };
});

const settingsDeps = vi.hoisted(() => ({
  getOrchSettings: vi.fn(() => ({
    intentFirstMissionRuntimeV1: true,
    squadCliPolicy:
      "operator-choice" as "operator-choice" | "governed",
  })),
}));

const workflowDeps = vi.hoisted(() => ({
  contract: null as null | {
    contextRevision: string;
    contractHash: string;
  },
}));

const providerDeps = vi.hoisted(() => ({
  prepareProviderSpawn: vi.fn(),
  prepareProviderSpawnAuthoritative: vi.fn(),
  acquireCliSpawnPermit: vi.fn(async (_adapterId: string): Promise<() => void> => () => {}),
  providerReadiness: vi.fn(() => ({ ready: true, reason: "ready" })),
  providerSpawnOverrides: vi.fn(() => ({
    binPath: "/usr/local/bin/claude",
    defaultModel: null,
    extraArgs: [],
    keyEnv: {},
    suppressEnv: [],
  })),
}));

vi.mock("../adapters/managed-auth-spawn-gate", () => ({
  resolveRotatingAuthFile: () => null,
  waitForRotatingAuthSpawnGate: vi.fn(async () => "fresh"),
  ROTATING_REFRESH_SPAWN_ADAPTERS: new Set(["codex"]),
}));

vi.mock("electron", () => ({
  ipcMain: { handle: ipcDeps.handle, on: ipcDeps.on },
}));

vi.mock("./pty-manager", () => ({
  isPtySessionAdmissionSealedForShutdown: () => false,
  adoptMainOwnedAgentSession: ptyDeps.adoptMainOwnedAgentSession,
  getSessionState: ptyDeps.getSessionState,
  listAgentSessionsForPane: ptyDeps.listAgentSessionsForPane,
  killSession: ptyDeps.killSession,
  orchKillSession: ptyDeps.orchKillSession,
  orchTerminateSession: ptyDeps.orchTerminateSession,
  resizeSession: vi.fn(),
  setPtyHost: ptyDeps.setPtyHost,
  startSessionMortalityReconciler: vi.fn(),
  spawnAgentSession: ptyDeps.spawnAgentSession,
  spawnSession: ptyDeps.spawnSession,
  writeSession: ptyDeps.writeSession,
}));

vi.mock("../orch/project-domain-store-registry", () => ({
  getProjectDomainStores: () => ({
    taskDispatches: {
      list: dispatchDeps.list,
      rebindRestartedWorker: dispatchDeps.rebindRestartedWorker,
    },
  }),
}));

vi.mock("./pty-host-client", () => ({
  createRealPtyHost: () => ({ kind: "test-host" }),
}));

vi.mock("../persistence/renderer-workspace-scope", () => ({
  requireRendererWorkspaceScope: authorityDeps.requireRendererWorkspaceScope,
  // b4ff521f7: a retomada persistida revalida a aba viva antes do PTY.
  requireLiveRendererWorkspaceScope: (owner: unknown) =>
    authorityDeps.requireRendererWorkspaceScope(owner),
}));

vi.mock("../orch/workspace-path", () => ({
  resolveCwdForScope: authorityDeps.resolveCwdForScope,
  // Classe real fica fora: aqui só interessa que o `instanceof` não exploda.
  WorkspaceRootMissingError: class WorkspaceRootMissingError extends Error {},
  isMissingPathError: () => false,
}));

vi.mock("../orch/pane-registry", () => ({
  // F-572: o gate de admissão conta panes de agente vivos; vazio = sem teto.
  listPaneSnapshots: () => [],
  claimPendingSpawnMeta: authorityDeps.claimPendingSpawnMeta,
  claimPendingSpawnMetaByPane: authorityDeps.claimPendingSpawnMetaByPane,
  claimPendingRecoverySpawnMeta:
    authorityDeps.claimPendingRecoverySpawnMeta,
  bindPendingSpawnSession: authorityDeps.bindPendingSpawnSession,
  bindPendingRecoverySpawnSession:
    authorityDeps.bindPendingRecoverySpawnSession,
  assertPendingSpawnGrantActive:
    authorityDeps.assertPendingSpawnGrantActive,
  assertPendingRecoverySpawnGrantActive:
    authorityDeps.assertPendingRecoverySpawnGrantActive,
  assertMissionSpawnAuthorityCurrent:
    authorityDeps.assertMissionSpawnAuthorityCurrent,
  attachOrchMeta: authorityDeps.attachOrchMeta,
  attachSessionScope: authorityDeps.attachSessionScope,
  hasLivePaneSession: authorityDeps.hasLivePaneSession,
}));

vi.mock("../orch/mission-pane-store", () => ({
  createScopedMissionPaneStore: authorityDeps.createScopedMissionPaneStore,
}));

vi.mock("../context/context-workflow-registry", () => ({
  getContextWorkflowService: () => ({
    getMissionWorkflow: () => ({
      contract: workflowDeps.contract
        ? { contract: workflowDeps.contract }
        : null,
    }),
  }),
}));

vi.mock("../orch/mission-store", () => ({
  createScopedMissionStore: authorityDeps.createScopedMissionStore,
}));

vi.mock("../orch/squad-store", () => ({
  listSquads: authorityDeps.listSquads,
}));

vi.mock("../adapters/adapter-registry", () => ({
  getAdapter: (id: string) =>
    id === "claude"
      ? {
          id: "claude",
          kind: "cli-pty",
          label: "Claude",
          bin: "claude",
          install: { command: "npm install claude" },
          quirks: { mcpAutoload: true },
          env: { passthrough: [], ephemeralHome: false },
          control: {
            permission: {
              arg: "--permission-mode",
              modes: {},
              yolo: ["--dangerously-skip-permissions"],
              safe: ["--permission-mode", "manual"],
              default: "",
            },
          },
        }
      : null,
  isAdapterInstalled: () => true,
  getAdapterResolvedBin: () => "/usr/local/bin/claude",
  resolveAdapterBinary: () => "/usr/local/bin/claude",
}));

vi.mock("../path-resolver", () => ({
  revalidateExecutable: (binPath: string) =>
    typeof binPath === "string" && binPath.startsWith("/"),
}));

vi.mock("../persistence/provider-config-store", () => ({
  isProviderEnabled: () => true,
  prepareProviderSpawn: providerDeps.prepareProviderSpawn,
  prepareProviderSpawnAuthoritative: providerDeps.prepareProviderSpawnAuthoritative,
  acquireCliSpawnPermit: providerDeps.acquireCliSpawnPermit,
  providerReadiness: providerDeps.providerReadiness,
  providerSpawnOverrides: providerDeps.providerSpawnOverrides,
}));

vi.mock("../persistence/settings-store", () => ({
  getTerminalSettings: () => ({ shell: "/bin/zsh" }),
  getOrchSettings: settingsDeps.getOrchSettings,
}));

vi.mock("../persistence/shell-catalog", () => ({
  listAvailableShells: () => ["/bin/zsh", "/bin/bash"],
  resolveConfiguredShell: (
    requested: string | undefined,
    configured: string,
  ) => {
    if (requested && requested !== configured) {
      throw new Error("renderer shell does not match main-process settings");
    }
    return configured;
  },
}));

vi.mock("../persistence/account-store", () => ({
  getAccount: () => ({
    id: "acct-selected",
    adapterId: "claude",
    label: "Selected",
  }),
}));

import { configurePtyProjectRuntimeManager, registerPtyIpc } from "./pty-ipc";
import { createMissionPaneAuthoritySeal } from "../orch/mission-pane-authority";
import { snapshotSquadAuthority } from "../orch/squad-authority-snapshot";

const TEST_SQUAD = {
  id: "review-squad",
  name: "Review",
  createdAt: "1",
  builtin: false,
  orchestratorInstructions: "Review safely",
  agents: [
    {
      id: "maestro",
      agentName: "Maestro",
      category: "orchestrator" as const,
      cli: "claude",
    },
  ],
};

function approvedMissionForSpawn(intentVersion = 1): Mission {
  return {
    id: "mission-a",
    title: "Review",
    description: "Review",
    status: "running",
    squadId: "review-squad",
    milestones: [],
    learnings: "",
    intentState: "dispatched",
    intentVersion,
    intentContract: {
      version: 1,
      source: "typed",
      goal: "Review",
      acceptanceCriteria: ["Done"],
      risk: "normal",
      executionMode: "assisted",
      contextPolicy: "on-demand",
      intentVersion,
      approvedAt: 100,
      dispatchedAt: 100,
      budgets: {
        planningTokens: 1_200,
        executionTokens: 8_000,
        maxWorkers: 2,
      },
      squadRevisionHash: snapshotSquadAuthority(TEST_SQUAD).hash,
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

function authoritySealFor(intentVersion = 1) {
  const seal = createMissionPaneAuthoritySeal({
    mission: approvedMissionForSpawn(intentVersion),
    squad: TEST_SQUAD,
  });
  if (!seal) throw new Error("test mission authority seal was not created");
  return seal;
}

function authoritySealForWorkflow(
  contextRevision: string,
  contractHash: string,
  intentVersion = 1,
) {
  const seal = createMissionPaneAuthoritySeal({
    mission: approvedMissionForSpawn(intentVersion),
    squad: TEST_SQUAD,
    contextRevision,
    contractHash,
  });
  if (!seal) throw new Error("test workflow authority seal was not created");
  return seal;
}

describe("registerPtyIpc account fail-fast", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    providerDeps.prepareProviderSpawn.mockReset();
    providerDeps.prepareProviderSpawnAuthoritative.mockReset().mockImplementation(
      async (adapterId: string, perSpawn: unknown) =>
        providerDeps.prepareProviderSpawn(adapterId, perSpawn),
    );
    ipcDeps.handlers.clear();
    authorityDeps.requireRendererWorkspaceScope.mockReturnValue(
      authorityDeps.scope,
    );
    authorityDeps.resolveCwdForScope.mockReset();
    authorityDeps.resolveCwdForScope.mockReturnValue("/workspace/a");
    authorityDeps.claimPendingSpawnMeta.mockReturnValue(null);
    authorityDeps.claimPendingSpawnMetaByPane.mockReturnValue(null);
    authorityDeps.claimPendingRecoverySpawnMeta.mockReturnValue(null);
    authorityDeps.bindPendingSpawnSession.mockReturnValue(true);
    authorityDeps.bindPendingRecoverySpawnSession.mockReturnValue(true);
    authorityDeps.findMissionPaneByPaneId.mockReturnValue(null);
    authorityDeps.createScopedMissionPaneStore.mockReturnValue({
      findByPaneId: authorityDeps.findMissionPaneByPaneId,
      rebindOrchestratorAuthority:
        authorityDeps.rebindOrchestratorAuthority,
    });
    workflowDeps.contract = null;
    authorityDeps.getMission.mockReturnValue(null);
    authorityDeps.createScopedMissionStore.mockReturnValue({
      get: authorityDeps.getMission,
    });
    authorityDeps.listSquads.mockReturnValue([TEST_SQUAD]);
    settingsDeps.getOrchSettings.mockReturnValue({
      intentFirstMissionRuntimeV1: true,
      squadCliPolicy: "operator-choice",
    });
    ptyDeps.writeSession.mockReturnValue(true);
    ptyDeps.adoptMainOwnedAgentSession.mockReturnValue(null);
    ptyDeps.getSessionState.mockImplementation((sessionId: string) =>
      sessionId === "pty-created" ? "idle" : null,
    );
    dispatchDeps.list.mockReturnValue([]);
    dispatchDeps.rebindRestartedWorker.mockReturnValue({
      state: "running",
      sessionId: "pty-created",
    });
    configurePtyProjectRuntimeManager({} as never);
    registerPtyIpc();
  });
  it('F-1151: persisted restore installs its final deferred source fence before renderer synchronization', async () => {
    providerDeps.prepareProviderSpawn.mockReturnValue({ ok: true, overrides: {} });
    const persisted = { id: 'original-record', missionId: 'mission-a', adapterId: 'claude',
      paneId: 'original-pane', role: 'worker', workerIncarnationId: 'original-incarnation',
      cwd: '/workspace/a', scope: authorityDeps.scope, authoritySeal: authoritySealFor(), createdAt: 1 };
    authorityDeps.findMissionPaneByPaneId.mockReturnValue(persisted);
    authorityDeps.getMission.mockReturnValue(approvedMissionForSpawn());
    const result = await ipcDeps.handlers.get(PTY_CHANNELS.spawn)?.({ sender: { id: 7 } },
      { kind: 'cli-agent', adapterId: 'claude', paneId: persisted.paneId, missionId: persisted.missionId,
        cwd: persisted.cwd, cols: 100, rows: 30, resume: true });
    expect(result).toMatchObject({ ok: true });
    const call = ptyDeps.spawnAgentSession.mock.calls.at(-1) as unknown as [unknown, unknown, unknown,
      { assertDeferredSpawnCurrent?: () => void }];
    expect(call[3].assertDeferredSpawnCurrent).toBeTypeOf('function');
    authorityDeps.findMissionPaneByPaneId.mockReturnValue({ ...persisted,
      workerContinuation: { state: 'bound', childPossible: true } });
    expect(() => call[3].assertDeferredSpawnCurrent!()).toThrow(/resume_continuation_owned/);
  });

  it('F-1151: a recovery restore of a persisted pane tells its deferred birth fence WHICH session may still be born', async () => {
    providerDeps.prepareProviderSpawn.mockReturnValue({ ok: true, overrides: {} });
    const persisted = { id: 'orch-record', missionId: 'mission-a', adapterId: 'claude', model: 'm', accountId: 'a', effort: 'high',
      paneId: 'orch-pane', role: 'orchestrator' as const, cwd: '/workspace/a', scope: authorityDeps.scope,
      authoritySeal: authoritySealFor(), createdAt: 1 };
    authorityDeps.findMissionPaneByPaneId.mockReturnValue(persisted);
    authorityDeps.getMission.mockReturnValue(approvedMissionForSpawn());
    const recovery = { scope: authorityDeps.scope, request: { requestId: 'orchrecover-1', missionId: 'mission-a', paneId: 'orch-pane',
      role: 'orchestrator' as const, recap: 'continue', pane: { adapterId: 'claude', model: 'm', accountId: 'a', effort: 'high', cwd: '/workspace/a',
        title: 'Orchestrator', role: 'orchestrator' as const } } };
    authorityDeps.claimPendingRecoverySpawnMeta.mockReturnValueOnce(recovery);
    const sender = { id: 7 };
    const result = await ipcDeps.handlers.get(PTY_CHANNELS.spawn)?.({ sender },
      { kind: 'cli-agent', adapterId: 'claude', model: 'm', accountId: 'a', effort: 'high', paneId: 'orch-pane', missionId: 'mission-a',
        cwd: '/workspace/a', orchRequestId: 'orchrecover-1', cols: 100, rows: 30, resume: true });
    expect(result).toMatchObject({ ok: true });
    const overrides = (ptyDeps.spawnAgentSession.mock.calls.at(-1) as unknown as unknown[])[3] as { assertDeferredSpawnCurrent: (sessionId: string) => void };
    authorityDeps.assertPendingRecoverySpawnGrantActive.mockClear();
    overrides.assertDeferredSpawnCurrent('pty-created');
    expect(authorityDeps.assertPendingRecoverySpawnGrantActive).toHaveBeenCalledWith('orchrecover-1', sender, 'pty-created');
  });

  it.each([
    { mode: "operator-choice" as const, isolatedHome: false },
    { mode: "governed" as const, isolatedHome: true },
  ])(
    "uses the exact main-persisted provider request for mission resume in $mode",
    async ({ mode, isolatedHome }) => {
      settingsDeps.getOrchSettings.mockReturnValue({
        intentFirstMissionRuntimeV1: true,
        squadCliPolicy: mode,
      });
      providerDeps.prepareProviderSpawn.mockReturnValueOnce({
        ok: true,
        overrides: {},
      });
      const persisted = {
        id: "mpane-a",
        missionId: "mission-a",
        adapterId: "claude",
        model: "claude-opus-4-1",
        accountId: "account-main",
        effort: "high",
        title: "Orchestrator",
        role: "orchestrator" as const,
        paneId: "pane-a",
        cwd: "/workspace/a/trusted-cwd",
        scope: authorityDeps.scope,
        authoritySeal: authoritySealFor(),
        createdAt: 1,
      };
      authorityDeps.findMissionPaneByPaneId.mockReturnValue(persisted);
      authorityDeps.getMission.mockReturnValue(approvedMissionForSpawn());
      authorityDeps.resolveCwdForScope.mockReturnValueOnce(persisted.cwd);
      const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);

      const result = await handler?.(
        { sender: { id: 7 } },
        {
          kind: "cli-agent",
          adapterId: "claude",
          model: persisted.model,
          accountId: persisted.accountId,
          effort: persisted.effort,
          missionId: persisted.missionId,
          paneId: "pane-a",
          resume: true,
          resumeLatestOnly: false,
          restorePersistedAuthority: false,
          cwd: persisted.cwd,
          cols: 100,
          rows: 30,
        },
      );

      expect(result).toEqual({ ok: true, sessionId: "pty-created" });
      expect(authorityDeps.resolveCwdForScope).toHaveBeenCalledWith(
        authorityDeps.scope,
        persisted.cwd,
      );
      expect(authorityDeps.requireRendererWorkspaceScope).toHaveBeenCalledWith({
        id: 7,
      });
      expect(authorityDeps.attachOrchMeta).toHaveBeenCalledWith(
        { id: 7 },
        "pane-a",
        expect.objectContaining({
          missionId: "mission-a",
          role: "orchestrator",
        }),
      );
      expect(providerDeps.prepareProviderSpawn).toHaveBeenCalledWith(
        "claude",
        {
          effort: persisted.effort,
          accountId: persisted.accountId,
          model: persisted.model,
          isolatedHome,
        },
      );
    },
  );

  it("resumes a persisted Claude pane whose renderer payload omits accountId (F bug: undefined != sealed)", async () => {
    // Campo: "[nexus] failed to start — accountId[undefined != acct-…]".
    // O pane de missão não espelha conta no modelo do renderer (a spec selada
    // do Main é a autoridade); a cerca deve deferir `undefined` ao selo e
    // retomar na conta persistida, sem afrouxar para valores divergentes.
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({
      ok: true,
      overrides: {},
    });
    const persisted = {
      id: "mpane-omitted-account",
      missionId: "mission-a",
      adapterId: "claude",
      model: "claude-opus-4-1",
      accountId: "account-main",
      effort: "high",
      title: "Orchestrator",
      role: "orchestrator" as const,
      paneId: "pane-omitted-account",
      cwd: "/workspace/a/trusted-cwd",
      scope: authorityDeps.scope,
      authoritySeal: authoritySealFor(),
      createdAt: 1,
    };
    authorityDeps.findMissionPaneByPaneId.mockReturnValue(persisted);
    authorityDeps.getMission.mockReturnValue(approvedMissionForSpawn());
    authorityDeps.resolveCwdForScope.mockReturnValueOnce(persisted.cwd);
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);

    const result = await handler?.(
      { sender: { id: 7 } },
      {
        kind: "cli-agent",
        adapterId: persisted.adapterId,
        model: persisted.model,
        // accountId e effort omitidos — exatamente o payload do bug.
        missionId: persisted.missionId,
        paneId: persisted.paneId,
        resume: true,
        resumeLatestOnly: false,
        restorePersistedAuthority: false,
        cwd: persisted.cwd,
        cols: 100,
        rows: 30,
      },
    );

    expect(result).toEqual({ ok: true, sessionId: "pty-created" });
    expect(providerDeps.prepareProviderSpawn).toHaveBeenCalledWith(
      "claude",
      expect.objectContaining({
        accountId: "account-main",
        effort: "high",
      }),
    );
    expect(ptyDeps.spawnAgentSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        accountId: "account-main",
        effort: "high",
        paneId: persisted.paneId,
        missionId: persisted.missionId,
        resume: true,
      }),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it.each([
    {
      label: "freeze after the initial intent-only seal",
      previousSeal: authoritySealFor(),
      contextRevision: "a".repeat(64),
      contractHash: "b".repeat(64),
    },
    {
      label: "explicit refreeze after context drift",
      previousSeal: authoritySealForWorkflow(
        "a".repeat(64),
        "b".repeat(64),
      ),
      contextRevision: "c".repeat(64),
      contractHash: "d".repeat(64),
    },
  ])(
    "reseals the exact crashed orchestrator on $label",
    async ({ previousSeal, contextRevision, contractHash }) => {
      providerDeps.prepareProviderSpawn.mockReturnValueOnce({
        ok: true,
        overrides: {},
      });
      const persisted = {
        id: "mpane-orchestrator",
        missionId: "mission-a",
        adapterId: "claude",
        model: "claude-opus-4-1",
        accountId: "account-main",
        effort: "high",
        title: "Orchestrator",
        role: "orchestrator" as const,
        paneId: "pane-orchestrator",
        cwd: "/workspace/a/trusted-cwd",
        scope: authorityDeps.scope,
        authoritySeal: previousSeal,
        createdAt: 1,
      };
      const authoritySeal = authoritySealForWorkflow(
        contextRevision,
        contractHash,
      );
      workflowDeps.contract = { contextRevision, contractHash };
      authorityDeps.findMissionPaneByPaneId.mockReturnValue(persisted);
      // A releitura do store (b4ff521f7) passa a ver a linha resselada.
      const rebound = { ...persisted, authoritySeal };
      authorityDeps.rebindOrchestratorAuthority.mockImplementationOnce(() => {
        authorityDeps.findMissionPaneByPaneId.mockReturnValue(rebound);
        return rebound;
      });
      authorityDeps.getMission.mockReturnValue(approvedMissionForSpawn());
      const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);

      const result = await handler?.(
        { sender: { id: 7 } },
        {
          kind: "cli-agent",
          adapterId: persisted.adapterId,
          model: persisted.model,
          accountId: persisted.accountId,
          effort: persisted.effort,
          missionId: persisted.missionId,
          paneId: persisted.paneId,
          resume: true,
          resumeLatestOnly: false,
          restorePersistedAuthority: false,
          cwd: persisted.cwd,
          cols: 100,
          rows: 30,
        },
      );

      expect(result).toEqual({ ok: true, sessionId: "pty-created" });
      expect(
        authorityDeps.rebindOrchestratorAuthority,
      ).toHaveBeenCalledWith({
        missionId: persisted.missionId,
        paneId: persisted.paneId,
        expectedAuthoritySeal: previousSeal,
        authoritySeal,
      });
    },
  );

  it.each([
    ["provider", { adapterId: "opencode" }],
    ["model", { model: "renderer-model" }],
    ["account", { accountId: "renderer-account" }],
    ["effort", { effort: "low" }],
    ["cwd", { cwd: "/workspace/a/renderer-cwd" }],
    ["mission", { missionId: "mission-renderer" }],
    ["latest", { resumeLatestOnly: true }],
    ["mode", { restorePersistedAuthority: true }],
    ["pane", { paneId: "pane-renderer" }],
  ])(
    "rejects persisted mission %s drift before provider preparation or process spawn",
    async (_field, drift) => {
      const persisted = {
        id: "mpane-a",
        missionId: "mission-a",
        adapterId: "claude",
        model: "claude-opus-4-1",
        accountId: "account-main",
        effort: "high",
        title: "Orchestrator",
        role: "orchestrator" as const,
        paneId: "pane-a",
        cwd: "/workspace/a/trusted-cwd",
        scope: authorityDeps.scope,
        authoritySeal: authoritySealFor(),
        createdAt: 1,
      };
      authorityDeps.findMissionPaneByPaneId.mockReturnValue(persisted);
      authorityDeps.getMission.mockReturnValue(approvedMissionForSpawn());
      const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);
      const exact = {
        kind: "cli-agent" as const,
        adapterId: persisted.adapterId,
        model: persisted.model,
        accountId: persisted.accountId,
        effort: persisted.effort,
        missionId: persisted.missionId,
        paneId: persisted.paneId,
        resume: true,
        resumeLatestOnly: false,
        restorePersistedAuthority: false,
        cwd: persisted.cwd,
        cols: 100,
        rows: 30,
      };

      await expect(
        Promise.resolve(
          handler?.({ sender: { id: 7 } }, { ...exact, ...drift }),
        ),
      ).resolves.toEqual({
        ok: false,
        error: expect.stringMatching(/main-sealed persisted pane/i),
      });
      expect(providerDeps.prepareProviderSpawn).not.toHaveBeenCalled();
      expect(ptyDeps.spawnAgentSession).not.toHaveBeenCalled();
    },
  );

  it("rejects a legacy persisted worker without a revision seal", async () => {
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({ ok: true, overrides: {} });
    const persisted = {
      id: "mpane-worker",
      missionId: "mission-a",
      adapterId: "claude",
      title: "Worker",
      role: "worker" as const,
      paneId: "pane-worker",
      cwd: "/workspace/a/trusted-cwd",
      scope: authorityDeps.scope,
      createdAt: 1,
    };
    authorityDeps.findMissionPaneByPaneId.mockReturnValue(persisted);
    authorityDeps.getMission.mockReturnValue(approvedMissionForSpawn());
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);
    const sender = { id: 7 };

    const result = await handler?.(
      { sender },
      {
        kind: "cli-agent",
        adapterId: "claude",
        missionId: persisted.missionId,
        paneId: "pane-worker",
        resume: false,
        resumeLatestOnly: false,
        restorePersistedAuthority: true,
        cwd: persisted.cwd,
        cols: 100,
        rows: 30,
      },
    );

    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(/legacy persisted mission pane authority/i),
    });
    expect(ptyDeps.spawnAgentSession).not.toHaveBeenCalled();
  });

  it("recreates a persisted worker only from its exact current dispatch authority", async () => {
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({ ok: true, overrides: {} });
    const persisted = {
      id: "mpane-worker-fenced",
      missionId: "mission-a",
      adapterId: "claude",
      title: "Worker fenced",
      agentName: "Worker A",
      workerIncarnationId: "worker-incarnation-a",
      role: "worker" as const,
      paneId: "pane-worker-fenced",
      cwd: "/workspace/a/trusted-cwd",
      scope: authorityDeps.scope,
      authoritySeal: authoritySealFor(),
      createdAt: 1,
    };
    authorityDeps.findMissionPaneByPaneId.mockReturnValue(persisted);
    authorityDeps.getMission.mockReturnValue(approvedMissionForSpawn());
    authorityDeps.resolveCwdForScope.mockReturnValueOnce(persisted.cwd);
    dispatchDeps.list.mockReturnValueOnce([
      {
        id: "dispatch-worker-fenced",
        taskId: "task-worker-fenced",
        missionId: persisted.missionId,
        revision: 4,
        state: "running",
        paneId: persisted.paneId,
        sessionId: "pty-dead",
        workerIncarnationId: persisted.workerIncarnationId,
      },
    ]);
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);
    const sender = { id: 7 };

    const result = await handler?.(
      { sender },
      {
        kind: "cli-agent",
        adapterId: "claude",
        missionId: persisted.missionId,
        paneId: persisted.paneId,
        resume: true,
        resumeLatestOnly: false,
        restorePersistedAuthority: false,
        cwd: persisted.cwd,
        cols: 100,
        rows: 30,
      },
    );

    expect(result).toEqual({ ok: true, sessionId: "pty-created" });
    expect(ptyDeps.adoptMainOwnedAgentSession).toHaveBeenCalledWith(
      sender,
      expect.objectContaining({
        paneId: persisted.paneId,
        workerIncarnationId: persisted.workerIncarnationId,
      }),
    );
    expect(ptyDeps.spawnAgentSession).toHaveBeenCalledOnce();
    expect(dispatchDeps.rebindRestartedWorker).toHaveBeenCalledWith({
      missionId: persisted.missionId,
      paneId: persisted.paneId,
      expectedSessionId: "pty-dead",
      replacementSessionId: "pty-created",
      workerIncarnationId: persisted.workerIncarnationId,
      leaseMs: 10 * 60_000,
    });
  });

  it("opens a persisted worker without rebind when no restartable dispatch exists", async () => {
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({
      ok: true,
      overrides: {},
    });
    const persisted = {
      id: "mpane-worker-unbound",
      missionId: "mission-a",
      adapterId: "claude",
      title: "Worker unbound",
      agentName: "Worker A",
      workerIncarnationId: "worker-incarnation-a",
      role: "worker" as const,
      paneId: "pane-worker-unbound",
      cwd: "/workspace/a/trusted-cwd",
      scope: authorityDeps.scope,
      authoritySeal: authoritySealFor(),
      createdAt: 1,
    };
    authorityDeps.findMissionPaneByPaneId.mockReturnValue(persisted);
    authorityDeps.getMission.mockReturnValue(approvedMissionForSpawn());
    authorityDeps.resolveCwdForScope.mockReturnValueOnce(persisted.cwd);
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);

    const result = await handler?.(
      { sender: { id: 7 } },
      {
        kind: "cli-agent",
        adapterId: "claude",
        missionId: persisted.missionId,
        paneId: persisted.paneId,
        resume: true,
        resumeLatestOnly: false,
        restorePersistedAuthority: false,
        cwd: persisted.cwd,
        cols: 100,
        rows: 30,
      },
    );

    expect(result).toEqual({ ok: true, sessionId: "pty-created" });
    expect(ptyDeps.spawnAgentSession).toHaveBeenCalledOnce();
    expect(dispatchDeps.rebindRestartedWorker).not.toHaveBeenCalled();
  });

  it("reconciles a persisted worker missing incarnation after restart", async () => {
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({
      ok: true,
      overrides: {},
    });
    const persisted = {
      id: "mpane-worker-no-incarnation",
      missionId: "mission-a",
      adapterId: "claude",
      title: "Motor",
      agentName: "Motor",
      role: "worker" as const,
      paneId: "pane-3",
      cwd: "/workspace/a/trusted-cwd",
      scope: authorityDeps.scope,
      authoritySeal: authoritySealFor(),
      createdAt: 1,
    };
    authorityDeps.findMissionPaneByPaneId.mockReturnValue(persisted);
    authorityDeps.getMission.mockReturnValue(approvedMissionForSpawn());
    authorityDeps.resolveCwdForScope.mockReturnValueOnce(persisted.cwd);
    dispatchDeps.list.mockReturnValueOnce([
      {
        id: "dispatch-motor",
        taskId: "task-motor",
        missionId: persisted.missionId,
        revision: 4,
        state: "running",
        paneId: persisted.paneId,
        sessionId: "pty-dead",
        workerIncarnationId: "worker-incarnation-after-restart",
      },
    ]);
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);

    const result = await handler?.(
      { sender: { id: 7 } },
      {
        kind: "cli-agent",
        adapterId: "claude",
        missionId: persisted.missionId,
        paneId: persisted.paneId,
        resume: true,
        resumeLatestOnly: false,
        restorePersistedAuthority: false,
        cwd: persisted.cwd,
        cols: 100,
        rows: 30,
      },
    );

    expect(result).toEqual({ ok: true, sessionId: "pty-created" });
    expect(JSON.stringify(result)).not.toMatch(
      /missing pane\/incarnation restart authority/,
    );
    expect(dispatchDeps.rebindRestartedWorker).toHaveBeenCalledWith({
      missionId: persisted.missionId,
      paneId: persisted.paneId,
      expectedSessionId: "pty-dead",
      replacementSessionId: "pty-created",
      workerIncarnationId: "worker-incarnation-after-restart",
      leaseMs: 10 * 60_000,
    });
  });

  it("reconciles a persisted worker whose incarnation rotated after restart", async () => {
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({
      ok: true,
      overrides: {},
    });
    const persisted = {
      id: "mpane-worker-stale-incarnation",
      missionId: "mission-a",
      adapterId: "claude",
      title: "Interface",
      agentName: "Interface",
      workerIncarnationId: "worker-incarnation-before-restart",
      role: "worker" as const,
      paneId: "pane-4",
      cwd: "/workspace/a/trusted-cwd",
      scope: authorityDeps.scope,
      authoritySeal: authoritySealFor(),
      createdAt: 1,
    };
    authorityDeps.findMissionPaneByPaneId.mockReturnValue(persisted);
    authorityDeps.getMission.mockReturnValue(approvedMissionForSpawn());
    authorityDeps.resolveCwdForScope.mockReturnValueOnce(persisted.cwd);
    dispatchDeps.list.mockReturnValueOnce([
      {
        id: "dispatch-interface",
        taskId: "task-interface",
        missionId: persisted.missionId,
        revision: 7,
        state: "running",
        paneId: persisted.paneId,
        sessionId: "pty-dead",
        workerIncarnationId: "worker-incarnation-after-restart",
      },
    ]);
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);

    const result = await handler?.(
      { sender: { id: 7 } },
      {
        kind: "cli-agent",
        adapterId: "claude",
        missionId: persisted.missionId,
        paneId: persisted.paneId,
        resume: true,
        resumeLatestOnly: false,
        restorePersistedAuthority: false,
        cwd: persisted.cwd,
        cols: 100,
        rows: 30,
      },
    );

    expect(result).toEqual({ ok: true, sessionId: "pty-created" });
    expect(JSON.stringify(result)).not.toMatch(
      /missing pane\/incarnation restart authority/,
    );
    expect(dispatchDeps.rebindRestartedWorker).toHaveBeenCalledWith({
      missionId: persisted.missionId,
      paneId: persisted.paneId,
      expectedSessionId: "pty-dead",
      replacementSessionId: "pty-created",
      workerIncarnationId: "worker-incarnation-after-restart",
      leaseMs: 10 * 60_000,
    });
  });

  it("respawns a proven-dead persisted orchestrator fresh without a grant", async () => {
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({
      ok: true,
      overrides: {},
    });
    const persisted = {
      id: "mpane-orch-dead",
      missionId: "mission-a",
      adapterId: "claude",
      model: "claude-opus-4-1",
      accountId: "account-main",
      effort: "high",
      title: "Orchestrator",
      role: "orchestrator" as const,
      paneId: "pane-orch-dead",
      cwd: "/workspace/a/trusted-cwd",
      scope: authorityDeps.scope,
      authoritySeal: authoritySealFor(),
      createdAt: 1,
    };
    authorityDeps.hasLivePaneSession.mockReturnValueOnce(false);
    authorityDeps.findMissionPaneByPaneId.mockReturnValue(persisted);
    authorityDeps.rebindOrchestratorAuthority.mockReturnValueOnce(persisted);
    authorityDeps.getMission.mockReturnValue(approvedMissionForSpawn());
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);

    const result = await handler?.(
      { sender: { id: 7 } },
      {
        kind: "cli-agent",
        adapterId: persisted.adapterId,
        model: persisted.model,
        accountId: persisted.accountId,
        effort: persisted.effort,
        missionId: persisted.missionId,
        paneId: persisted.paneId,
        resume: false,
        resumeLatestOnly: false,
        restorePersistedAuthority: true,
        cwd: persisted.cwd,
        cols: 100,
        rows: 30,
      },
    );

    expect(result).toEqual({ ok: true, sessionId: "pty-created" });
    expect(authorityDeps.hasLivePaneSession).toHaveBeenCalledWith(
      persisted.paneId,
    );
    expect(ptyDeps.spawnAgentSession).toHaveBeenCalled();
  });

  it("forwards the fresh-context resumeMode when the dead provider session respawns fresh", async () => {
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({
      ok: true,
      overrides: {},
    });
    const persisted = {
      id: "mpane-orch-fresh-context",
      missionId: "mission-a",
      adapterId: "claude",
      model: "claude-opus-4-1",
      accountId: "account-main",
      effort: "high",
      title: "Orchestrator",
      role: "orchestrator" as const,
      paneId: "pane-orch-fresh-context",
      cwd: "/workspace/a/trusted-cwd",
      scope: authorityDeps.scope,
      authoritySeal: authoritySealFor(),
      createdAt: 1,
    };
    authorityDeps.findMissionPaneByPaneId.mockReturnValue(persisted);
    authorityDeps.getMission.mockReturnValue(approvedMissionForSpawn());
    // Physical death of the provider session: main resolves the fresh-context
    // fallback inside spawnAgentSession instead of failing into a dead pane.
    ptyDeps.spawnAgentSession.mockReturnValueOnce({
      sessionId: "pty-created",
      resumeMode: "fresh-context",
    });
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);

    const result = await handler?.(
      { sender: { id: 7 } },
      {
        kind: "cli-agent",
        adapterId: persisted.adapterId,
        model: persisted.model,
        accountId: persisted.accountId,
        effort: persisted.effort,
        missionId: persisted.missionId,
        paneId: persisted.paneId,
        resume: true,
        resumeLatestOnly: false,
        restorePersistedAuthority: false,
        cwd: persisted.cwd,
        cols: 100,
        rows: 30,
      },
    );

    // The renderer needs the fresh-context signal to print the PT-BR CTA and
    // inject the mission continuity path; the new session is bound to the
    // same persisted mission authority, not thrown away.
    expect(result).toEqual({
      ok: true,
      sessionId: "pty-created",
      resumeMode: "fresh-context",
    });
    expect(authorityDeps.attachOrchMeta).toHaveBeenCalledWith(
      { id: 7 },
      persisted.paneId,
      expect.objectContaining({
        missionId: persisted.missionId,
        role: "orchestrator",
      }),
    );
  });

  it("reattaches instead of fresh when the persisted pane session is alive", async () => {
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({
      ok: true,
      overrides: { selectedAccountId: "account-main" },
    });
    const persisted = {
      id: "mpane-orch-alive",
      missionId: "mission-a",
      adapterId: "claude",
      model: "claude-opus-4-1",
      accountId: "account-main",
      effort: "high",
      title: "Orchestrator",
      role: "orchestrator" as const,
      paneId: "pane-orch-alive",
      cwd: "/workspace/a/trusted-cwd",
      scope: authorityDeps.scope,
      authoritySeal: authoritySealFor(),
      createdAt: 1,
    };
    authorityDeps.hasLivePaneSession.mockReturnValueOnce(true);
    authorityDeps.findMissionPaneByPaneId.mockReturnValue(persisted);
    authorityDeps.getMission.mockReturnValue(approvedMissionForSpawn());
    ptyDeps.adoptMainOwnedAgentSession.mockReturnValueOnce({
      sessionId: "pty-adopted",
      state: "idle",
    });
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);

    const result = await handler?.(
      { sender: { id: 7 } },
      {
        kind: "cli-agent",
        adapterId: persisted.adapterId,
        model: persisted.model,
        accountId: persisted.accountId,
        effort: persisted.effort,
        missionId: persisted.missionId,
        paneId: persisted.paneId,
        resume: false,
        resumeLatestOnly: false,
        restorePersistedAuthority: true,
        cwd: persisted.cwd,
        cols: 100,
        rows: 30,
      },
    );

    // A live identity is never destroyed on the renderer's word: the fresh
    // request canonicalizes to reattach and adopts the live main-owned PTY.
    expect(result).toEqual({
      ok: true,
      sessionId: "pty-adopted",
      accountId: "account-main",
      adopted: true,
      state: "idle",
    });
    expect(ptyDeps.spawnAgentSession).not.toHaveBeenCalled();
    expect(
      authorityDeps.rebindOrchestratorAuthority,
    ).not.toHaveBeenCalled();
  });

  it("keeps the ambiguous resume+fresh payload fenced", async () => {
    const persisted = {
      id: "mpane-orch-ambiguous",
      missionId: "mission-a",
      adapterId: "claude",
      model: "claude-opus-4-1",
      accountId: "account-main",
      effort: "high",
      title: "Orchestrator",
      role: "orchestrator" as const,
      paneId: "pane-orch-ambiguous",
      cwd: "/workspace/a/trusted-cwd",
      scope: authorityDeps.scope,
      authoritySeal: authoritySealFor(),
      createdAt: 1,
    };
    authorityDeps.findMissionPaneByPaneId.mockReturnValue(persisted);
    authorityDeps.getMission.mockReturnValue(approvedMissionForSpawn());
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);

    const result = await handler?.(
      { sender: { id: 7 } },
      {
        kind: "cli-agent",
        adapterId: persisted.adapterId,
        model: persisted.model,
        accountId: persisted.accountId,
        effort: persisted.effort,
        missionId: persisted.missionId,
        paneId: persisted.paneId,
        resume: true,
        resumeLatestOnly: false,
        restorePersistedAuthority: true,
        cwd: persisted.cwd,
        cols: 100,
        rows: 30,
      },
    );

    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(/resume\+fresh simultâneos/i),
    });
    expect(ptyDeps.spawnAgentSession).not.toHaveBeenCalled();
  });

  it("resumes a persisted pane carrying its historical orchRequestId after restart", async () => {
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({
      ok: true,
      overrides: {},
    });
    const persisted = {
      id: "mpane-worker-stale-token",
      missionId: "mission-a",
      adapterId: "claude",
      model: "claude-opus-4-1",
      accountId: "account-main",
      effort: "high",
      title: "Worker",
      agentName: "Worker B",
      workerIncarnationId: "worker-incarnation-b",
      role: "worker" as const,
      paneId: "pane-worker-stale-token",
      cwd: "/workspace/a/trusted-cwd",
      scope: authorityDeps.scope,
      authoritySeal: authoritySealFor(),
      createdAt: 1,
    };
    authorityDeps.findMissionPaneByPaneId.mockReturnValue(persisted);
    authorityDeps.getMission.mockReturnValue(approvedMissionForSpawn());
    authorityDeps.resolveCwdForScope.mockReturnValueOnce(persisted.cwd);
    ptyDeps.adoptMainOwnedAgentSession.mockReturnValueOnce({
      sessionId: "pty-adopted-stale",
      state: "idle",
    });
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);

    // The saved layout persists the pane's historical orchRequestId, but the
    // main-process grant maps are empty after a restart (both claims → null).
    // The stale token must not fence the resume: the persisted record wins.
    const result = await handler?.(
      { sender: { id: 7 } },
      {
        kind: "cli-agent",
        adapterId: persisted.adapterId,
        model: persisted.model,
        accountId: persisted.accountId,
        effort: persisted.effort,
        missionId: persisted.missionId,
        paneId: persisted.paneId,
        orchRequestId: "orchspawn-stale-from-layout",
        resume: true,
        resumeLatestOnly: false,
        restorePersistedAuthority: false,
        cwd: persisted.cwd,
        cols: 100,
        rows: 30,
      },
    );

    expect(result).toEqual({
      ok: true,
      sessionId: "pty-adopted-stale",
      adopted: true,
      state: "idle",
    });
    expect(ptyDeps.spawnAgentSession).not.toHaveBeenCalled();
  });

  it("reattaches an already-live persisted mission pane even when a stale renderer retries with no resume flags", async () => {
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({
      ok: true,
      overrides: {},
    });
    const persisted = {
      id: "mpane-orch-stale-plain",
      missionId: "mission-a",
      adapterId: "claude",
      model: "claude-opus-4-1",
      accountId: "account-main",
      effort: "high",
      title: "Orchestrator",
      agentName: "Maestro",
      role: "orchestrator" as const,
      paneId: "pane-orch-stale-plain",
      cwd: "/workspace/a/trusted-cwd",
      scope: authorityDeps.scope,
      authoritySeal: authoritySealFor(),
      createdAt: 1,
    };
    authorityDeps.findMissionPaneByPaneId.mockReturnValue(persisted);
    authorityDeps.getMission.mockReturnValue(approvedMissionForSpawn());
    authorityDeps.hasLivePaneSession.mockReturnValueOnce(true);
    authorityDeps.resolveCwdForScope.mockReturnValueOnce(persisted.cwd);
    ptyDeps.adoptMainOwnedAgentSession.mockReturnValueOnce({
      sessionId: "pty-adopted-plain",
      state: "idle",
    });
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);

    const result = await handler?.(
      { sender: { id: 7 } },
      {
        kind: "cli-agent",
        adapterId: persisted.adapterId,
        model: persisted.model,
        accountId: persisted.accountId,
        effort: persisted.effort,
        missionId: persisted.missionId,
        paneId: persisted.paneId,
        resume: false,
        resumeLatestOnly: false,
        restorePersistedAuthority: false,
        cwd: persisted.cwd,
        cols: 100,
        rows: 30,
      },
    );

    expect(result).toEqual({
      ok: true,
      sessionId: "pty-adopted-plain",
      adopted: true,
      state: "idle",
    });
    expect(authorityDeps.findMissionPaneByPaneId).toHaveBeenCalledWith(
      persisted.paneId,
    );
    expect(ptyDeps.spawnAgentSession).not.toHaveBeenCalled();
  });

  it("adopts the exact live main-owned pane instead of spawning a duplicate provider process", async () => {
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({ ok: true, overrides: {} });
    const persisted = {
      id: "mpane-worker",
      missionId: "mission-a",
      adapterId: "claude",
      title: "Worker",
      agentName: "Worker A",
      workerIncarnationId: "worker-incarnation-main-owned",
      role: "worker" as const,
      paneId: "pane-worker",
      cwd: "/workspace/a/trusted-cwd",
      scope: authorityDeps.scope,
      authoritySeal: authoritySealFor(),
      createdAt: 1,
    };
    authorityDeps.findMissionPaneByPaneId.mockReturnValue(persisted);
    authorityDeps.getMission.mockReturnValue(approvedMissionForSpawn());
    authorityDeps.resolveCwdForScope.mockReturnValueOnce(persisted.cwd);
    ptyDeps.adoptMainOwnedAgentSession.mockReturnValueOnce({
      sessionId: "pty-headless",
      state: "idle",
    });
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);
    const sender = { id: 7 };

    const result = await handler?.(
      { sender },
      {
        kind: "cli-agent",
        adapterId: "claude",
        missionId: persisted.missionId,
        paneId: "pane-worker",
        resume: true,
        resumeLatestOnly: false,
        restorePersistedAuthority: false,
        cwd: persisted.cwd,
        cols: 100,
        rows: 30,
      },
    );

    expect(result).toEqual({
      ok: true,
      sessionId: "pty-headless",
      adopted: true,
      state: "idle",
    });
    expect(ptyDeps.adoptMainOwnedAgentSession).toHaveBeenCalledWith(
      sender,
      expect.objectContaining({
        paneId: "pane-worker",
        adapterId: "claude",
        missionId: "mission-a",
        role: "worker",
        workerIncarnationId: "worker-incarnation-main-owned",
        model: undefined,
        accountId: undefined,
        effort: undefined,
        cwd: persisted.cwd,
        agentName: persisted.agentName,
        readOnly: false,
        nativeReadOnly: false,
        allowedTools: [],
        allowedSkills: null,
        authoritySeal: persisted.authoritySeal,
        scope: authorityDeps.scope,
      }),
    );
    expect(ptyDeps.spawnAgentSession).not.toHaveBeenCalled();
    expect(authorityDeps.attachSessionScope).toHaveBeenCalledWith(
      "pty-headless",
      authorityDeps.scope,
    );
    expect(authorityDeps.attachOrchMeta).toHaveBeenCalledWith(
      sender,
      "pane-worker",
      expect.objectContaining({
        missionId: "mission-a",
        role: "worker",
      }),
    );
  });

  it("rejects persisted pane restore after the mission intent version changes", async () => {
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({ ok: true, overrides: {} });
    authorityDeps.findMissionPaneByPaneId.mockReturnValue({
      id: "mpane-worker",
      missionId: "mission-a",
      adapterId: "claude",
      title: "Worker",
      role: "worker",
      paneId: "pane-worker",
      cwd: "/workspace/a/trusted-cwd",
      scope: authorityDeps.scope,
      authoritySeal: authoritySealFor(),
      createdAt: 1,
    });
    authorityDeps.getMission.mockReturnValue(approvedMissionForSpawn(2));
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);

    expect(
      handler?.(
        { sender: { id: 7 } },
        {
          kind: "cli-agent",
          adapterId: "claude",
          missionId: "mission-a",
          paneId: "pane-worker",
          resume: false,
          resumeLatestOnly: false,
          restorePersistedAuthority: true,
          cwd: "/workspace/a/trusted-cwd",
          cols: 100,
          rows: 30,
        },
      ),
    ).toEqual({
      ok: false,
      error: expect.stringMatching(/stale|revision|replane/i),
    });
    expect(ptyDeps.spawnAgentSession).not.toHaveBeenCalled();
  });

  it("rejects a resumed mission pane when the renderer substitutes its adapter", async () => {
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({
      ok: true,
      overrides: {},
    });
    authorityDeps.findMissionPaneByPaneId.mockReturnValue({
      id: "mpane-a",
      missionId: "mission-a",
      adapterId: "codex",
      title: "Worker",
      role: "worker",
      paneId: "pane-a",
      scope: authorityDeps.scope,
      authoritySeal: authoritySealFor(),
      createdAt: 1,
    });
    authorityDeps.getMission.mockReturnValue(approvedMissionForSpawn());
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);

    const result = await handler?.(
      { sender: { id: 7 } },
      {
        kind: "cli-agent",
        adapterId: "claude",
        missionId: "mission-a",
        paneId: "pane-a",
        resume: true,
        cols: 100,
        rows: 30,
      },
    );

    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(/main-sealed persisted pane/i),
    });
    expect(ptyDeps.spawnAgentSession).not.toHaveBeenCalled();
  });

  it("falls back to direct-user spawn when orchRequestId is spent (Reiniciar)", async () => {
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({
      ok: true,
      overrides: {},
    });
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);
    const sender = { id: 7 };

    // claimPending returns null (default) → spent token; must not throw.
    const result = await handler?.(
      { sender },
      {
        kind: "cli-agent",
        adapterId: "claude",
        orchRequestId: "orchspawn-stale",
        cols: 100,
        rows: 30,
      },
    );

    expect(result).toEqual({ ok: true, sessionId: "pty-created" });
    expect(authorityDeps.requireRendererWorkspaceScope).toHaveBeenCalledWith(
      sender,
    );
    expect(ptyDeps.spawnAgentSession).toHaveBeenCalledWith(
      sender,
      expect.objectContaining({
        adapterId: "claude",
        orchRequestId: "orchspawn-stale",
        cwd: "/workspace/a",
      }),
      expect.objectContaining({ id: "claude" }),
      expect.objectContaining({ binPath: "/usr/local/bin/claude" }),
      expect.objectContaining({
        source: "direct-user",
        scope: authorityDeps.scope,
        cwd: "/workspace/a",
      }),
    );
  });

  it("binds a user shell to the renderer-authorized workspace and configured shell", async () => {
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);
    const sender = { id: 7 };

    const result = await handler?.(
      { sender },
      {
        kind: "shell",
        cwd: "/workspace/a/packages/app",
        shell: "/bin/zsh",
        cols: 100,
        rows: 30,
      },
    );

    expect(result).toEqual({ ok: true, sessionId: "shell-created" });
    expect(ptyDeps.spawnSession).toHaveBeenCalledWith(
      sender,
      expect.objectContaining({ cwd: "/workspace/a", shell: "/bin/zsh" }),
      {
        scope: authorityDeps.scope,
        cwd: "/workspace/a",
        shell: "/bin/zsh",
      },
    );
    expect(authorityDeps.attachSessionScope).toHaveBeenCalledWith(
      "shell-created",
      authorityDeps.scope,
    );
  });

  it("rejects a renderer-selected shell that differs from main settings", async () => {
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);

    const result = await handler?.(
      { sender: { id: 7 } },
      {
        kind: "shell",
        shell: "/bin/bash",
        cols: 100,
        rows: 30,
      },
    );

    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(/shell does not match/i),
    });
    expect(ptyDeps.spawnSession).not.toHaveBeenCalled();
  });

  it("confirms a PTY write only when the main process accepts the owned session", async () => {
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.writeConfirmed);
    const sender = { id: 7 };

    expect(handler?.(
      { sender },
      { sessionId: "session-owned", data: "continue\r" },
    )).toBe(true);
    expect(ptyDeps.writeSession).toHaveBeenCalledWith(
      sender,
      "session-owned",
      "continue\r",
    );

    ptyDeps.writeSession.mockReturnValueOnce(false);
    expect(handler?.(
      { sender },
      { sessionId: "session-missing", data: "continue\r" },
    )).toBe(false);
    expect(handler?.({ sender }, { sessionId: "bad" })).toBe(false);
  });
});
