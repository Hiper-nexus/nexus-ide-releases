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
  listAgentSessionsForPane: vi.fn((): unknown[] => []),
  spawnAgentSession: vi.fn(() => ({ sessionId: "pty-created" })),
  spawnSession: vi.fn(() => ({ sessionId: "shell-created" })),
  setPtyHost: vi.fn(),
  killSession: vi.fn(),
  orchKillSession: vi.fn(),
  orchTerminateSession: vi.fn(async () => true),
  writeSession: vi.fn(() => true),
}));

const ompDeps = vi.hoisted(() => ({
  spawnOmpRpcPane: vi.fn(
    async (input?: { assertAuthority?: () => void }) => {
      input?.assertAuthority?.();
      return {
        ok: true as const,
        sessionId: "omp-created",
      };
    },
  ),
  listOmpRpcSessions: vi.fn((): unknown[] => []),
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
    requireRendererWorkspaceScope: vi.fn(() => scope),
    resolveCwdForScope: vi.fn(() => "/workspace/a"),
    claimPendingSpawnMeta: vi.fn(
      (_requestId: string, _owner: unknown): unknown => null,
    ),
    claimPendingRecoverySpawnMeta: vi.fn(
      (_requestId: string, _owner: unknown): unknown => null,
    ),
    bindPendingSpawnSession: vi.fn(() => true),
    bindPendingRecoverySpawnSession: vi.fn(() => true),
    assertPendingSpawnGrantActive: vi.fn(),
    assertPendingRecoverySpawnGrantActive: vi.fn(),
    attachOrchMeta: vi.fn(),
    attachSessionScope: vi.fn(),
    findMissionPaneByPaneId: vi.fn((_paneId: string): unknown => null),
    rebindOrchestratorAuthority: vi.fn(),
    createScopedMissionPaneStore: vi.fn(),
    getMission: vi.fn((_missionId: string): unknown => null),
    createScopedMissionStore: vi.fn(),
    listSquads: vi.fn((): unknown[] => []),
  };
});

const settingsDeps = vi.hoisted(() => ({
  getOrchSettings: vi.fn(() => ({ intentFirstMissionRuntimeV1: true })),
}));

const workflowDeps = vi.hoisted(() => ({
  contract: null as null | {
    contextRevision: string;
    contractHash: string;
  },
}));

const providerDeps = vi.hoisted(() => ({
  prepareProviderSpawn: vi.fn(),
  providerReadiness: vi.fn(() => ({ ready: true, reason: "ready" })),
  providerSpawnOverrides: vi.fn(() => ({
    binPath: "/usr/local/bin/claude",
    defaultModel: null,
    extraArgs: [],
    keyEnv: {},
    suppressEnv: [],
  })),
}));

vi.mock("electron", () => ({
  ipcMain: { handle: ipcDeps.handle, on: ipcDeps.on },
}));

vi.mock("./pty-manager", () => ({
  adoptMainOwnedAgentSession: ptyDeps.adoptMainOwnedAgentSession,
  listAgentSessionsForPane: ptyDeps.listAgentSessionsForPane,
  killSession: ptyDeps.killSession,
  orchKillSession: ptyDeps.orchKillSession,
  orchTerminateSession: ptyDeps.orchTerminateSession,
  resizeSession: vi.fn(),
  setPtyHost: ptyDeps.setPtyHost,
  spawnAgentSession: ptyDeps.spawnAgentSession,
  spawnSession: ptyDeps.spawnSession,
  writeSession: ptyDeps.writeSession,
}));

vi.mock("./pty-host-client", () => ({
  createRealPtyHost: () => ({ kind: "test-host" }),
}));

vi.mock("../adapters/omp-rpc-ipc", () => ({
  acknowledgeOmpRpcPaneOutput: vi.fn(),
  isOmpRpcPaneOwnedBy: vi.fn(() => false),
  canRendererControlOmpRpcPane: vi.fn(() => false),
  killOmpRpcPane: vi.fn(),
  listOmpRpcSessions: ompDeps.listOmpRpcSessions,
  recoverOmpRpcPaneOutput: vi.fn(() => []),
  spawnOmpRpcPane: ompDeps.spawnOmpRpcPane,
  terminateOmpRpcSession: vi.fn(async () => true),
  writeOmpRpcPaneInput: vi.fn(() => false),
}));

vi.mock("../persistence/renderer-workspace-scope", () => ({
  requireRendererWorkspaceScope: authorityDeps.requireRendererWorkspaceScope,
}));

vi.mock("../orch/workspace-path", () => ({
  resolveCwdForScope: authorityDeps.resolveCwdForScope,
}));

vi.mock("../orch/pane-registry", () => ({
  claimPendingSpawnMeta: authorityDeps.claimPendingSpawnMeta,
  claimPendingRecoverySpawnMeta:
    authorityDeps.claimPendingRecoverySpawnMeta,
  bindPendingSpawnSession: authorityDeps.bindPendingSpawnSession,
  bindPendingRecoverySpawnSession:
    authorityDeps.bindPendingRecoverySpawnSession,
  assertPendingSpawnGrantActive:
    authorityDeps.assertPendingSpawnGrantActive,
  assertPendingRecoverySpawnGrantActive:
    authorityDeps.assertPendingRecoverySpawnGrantActive,
  attachOrchMeta: authorityDeps.attachOrchMeta,
  attachSessionScope: authorityDeps.attachSessionScope,
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
      : id === "omp"
        ? {
            id: "omp",
            kind: "cli-rpc",
            label: "Oh My Pi",
            install: { command: "npm install -g @oh-my-pi/omp" },
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
    ipcDeps.handlers.clear();
    authorityDeps.requireRendererWorkspaceScope.mockReturnValue(
      authorityDeps.scope,
    );
    authorityDeps.resolveCwdForScope.mockReset();
    authorityDeps.resolveCwdForScope.mockReturnValue("/workspace/a");
    authorityDeps.claimPendingSpawnMeta.mockReturnValue(null);
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
    });
    ptyDeps.writeSession.mockReturnValue(true);
    ptyDeps.adoptMainOwnedAgentSession.mockReturnValue(null);
    ompDeps.spawnOmpRpcPane.mockImplementation(
      async (input?: { assertAuthority?: () => void }) => {
        input?.assertAuthority?.();
        return { ok: true as const, sessionId: "omp-created" };
      },
    );
    configurePtyProjectRuntimeManager({} as never);
    registerPtyIpc();
  });
  it("uses the exact main-persisted provider request for mission resume", () => {
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
    authorityDeps.findMissionPaneByPaneId.mockReturnValueOnce(persisted);
    authorityDeps.getMission.mockReturnValue(approvedMissionForSpawn());
    authorityDeps.resolveCwdForScope.mockReturnValueOnce(persisted.cwd);
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);

    const result = handler?.(
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
      expect.objectContaining({ missionId: "mission-a", role: "orchestrator" }),
    );
    expect(providerDeps.prepareProviderSpawn).toHaveBeenCalledWith("claude", {
      effort: persisted.effort,
      accountId: persisted.accountId,
      model: persisted.model,
    });
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
    ({ previousSeal, contextRevision, contractHash }) => {
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
      authorityDeps.findMissionPaneByPaneId.mockReturnValueOnce(persisted);
      authorityDeps.rebindOrchestratorAuthority.mockReturnValueOnce({
        ...persisted,
        authoritySeal,
      });
      authorityDeps.getMission.mockReturnValue(approvedMissionForSpawn());
      const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);

      const result = handler?.(
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
    ["provider", { adapterId: "omp" }],
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
      authorityDeps.findMissionPaneByPaneId.mockReturnValueOnce(persisted);
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
      expect(ompDeps.spawnOmpRpcPane).not.toHaveBeenCalled();
    },
  );

  it("rejects a legacy persisted worker without a revision seal", () => {
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
    authorityDeps.findMissionPaneByPaneId.mockReturnValueOnce(persisted);
    authorityDeps.getMission.mockReturnValue(approvedMissionForSpawn());
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);
    const sender = { id: 7 };

    const result = handler?.(
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

  it("does not reuse a persisted incarnation when its exact process cannot be adopted", () => {
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
    authorityDeps.findMissionPaneByPaneId.mockReturnValueOnce(persisted);
    authorityDeps.getMission.mockReturnValue(approvedMissionForSpawn());
    authorityDeps.resolveCwdForScope.mockReturnValueOnce(persisted.cwd);
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);
    const sender = { id: 7 };

    const result = handler?.(
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

    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(/incarnation|encarnação|processo exato/i),
    });
    expect(ptyDeps.adoptMainOwnedAgentSession).toHaveBeenCalledWith(
      sender,
      expect.objectContaining({
        paneId: persisted.paneId,
        workerIncarnationId: persisted.workerIncarnationId,
      }),
    );
    expect(ptyDeps.spawnAgentSession).not.toHaveBeenCalled();
  });

  it("rejects a fresh persisted RPC worker without an active recovery grant", async () => {
    const persisted = {
      id: "mpane-worker-rpc",
      missionId: "mission-a",
      adapterId: "omp",
      title: "Worker RPC",
      agentName: "Worker OMP",
      workerIncarnationId: "worker-incarnation-omp",
      role: "worker" as const,
      paneId: "pane-worker-rpc",
      cwd: "/workspace/a/trusted-cwd",
      scope: authorityDeps.scope,
      authoritySeal: authoritySealFor(),
      createdAt: 1,
    };
    authorityDeps.findMissionPaneByPaneId.mockReturnValueOnce(persisted);
    authorityDeps.getMission.mockReturnValue(approvedMissionForSpawn());
    authorityDeps.resolveCwdForScope.mockReturnValueOnce(persisted.cwd);
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);

    const result = await handler?.(
      { sender: { id: 7 } },
      {
        kind: "cli-agent",
        adapterId: "omp",
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

    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(/main-sealed persisted pane/i),
    });
    expect(ompDeps.spawnOmpRpcPane).not.toHaveBeenCalled();
  });

  it("spawns one exact persisted RPC worker only under its recovery grant", async () => {
    const persisted = {
      id: "mpane-orch-rpc-recovery",
      missionId: "mission-a",
      adapterId: "omp",
      model: "openai/gpt-5.6",
      accountId: "omp-account",
      effort: "high",
      title: "Worker RPC",
      agentName: "Executor OMP",
      role: "worker" as const,
      paneId: "pane-orch-rpc-recovery",
      cwd: "/workspace/a/trusted-cwd",
      scope: authorityDeps.scope,
      allowedTools: ["nexus_file_read"],
      allowedSkills: [],
      readOnly: false,
      nativeReadOnly: false,
      authoritySeal: authoritySealFor(),
      createdAt: 1,
    };
    const requestId = "panerecovery-main";
    authorityDeps.claimPendingRecoverySpawnMeta.mockReturnValueOnce({
      scope: authorityDeps.scope,
      request: {
        requestId,
        missionId: persisted.missionId,
        paneId: persisted.paneId,
        role: persisted.role,
        pane: {
          adapterId: persisted.adapterId,
          model: persisted.model,
          accountId: persisted.accountId,
          effort: persisted.effort,
          cwd: persisted.cwd,
          title: persisted.title,
          agentName: persisted.agentName,
          role: persisted.role,
        },
        recap: "Continue.",
      },
    });
    authorityDeps.findMissionPaneByPaneId.mockReturnValueOnce(persisted);
    authorityDeps.getMission.mockReturnValue(approvedMissionForSpawn());
    authorityDeps.resolveCwdForScope.mockReturnValueOnce(persisted.cwd);
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);
    const sender = { id: 7 };

    const result = await handler?.(
      { sender },
      {
        kind: "cli-agent",
        adapterId: persisted.adapterId,
        model: persisted.model,
        accountId: persisted.accountId,
        effort: persisted.effort,
        orchRequestId: requestId,
        missionId: persisted.missionId,
        paneId: persisted.paneId,
        cwd: persisted.cwd,
        resume: false,
        resumeLatestOnly: false,
        restorePersistedAuthority: true,
        cols: 100,
        rows: 30,
      },
    );

    expect(result).toEqual({ ok: true, sessionId: "omp-created" });
    expect(ompDeps.spawnOmpRpcPane).toHaveBeenCalledWith(
      expect.objectContaining({
        paneId: persisted.paneId,
        title: persisted.title,
        agentName: persisted.agentName,
        missionId: persisted.missionId,
        allowedTools: persisted.allowedTools,
        assertAuthority: expect.any(Function),
      }),
    );
    expect(
      authorityDeps.assertPendingRecoverySpawnGrantActive,
    ).toHaveBeenCalledWith(requestId, sender);
    expect(
      authorityDeps.bindPendingRecoverySpawnSession,
    ).toHaveBeenCalledWith(requestId, sender, "omp-created");
  });

  it("blocks recovery while a live OMP runtime still owns the persisted pane", async () => {
    const persisted = {
      id: "mpane-orch-rpc-duplicate",
      missionId: "mission-a",
      adapterId: "omp",
      model: "openai/gpt-5.6",
      title: "Worker RPC",
      role: "worker" as const,
      paneId: "pane-orch-rpc-duplicate",
      cwd: "/workspace/a/trusted-cwd",
      scope: authorityDeps.scope,
      readOnly: false,
      nativeReadOnly: false,
      authoritySeal: authoritySealFor(),
      createdAt: 1,
    };
    const requestId = "panerecovery-duplicate";
    authorityDeps.claimPendingRecoverySpawnMeta.mockReturnValueOnce({
      scope: authorityDeps.scope,
      request: {
        requestId,
        missionId: persisted.missionId,
        paneId: persisted.paneId,
        role: persisted.role,
        pane: {
          adapterId: persisted.adapterId,
          model: persisted.model,
          cwd: persisted.cwd,
          title: persisted.title,
          role: persisted.role,
        },
        recap: "Continue.",
      },
    });
    authorityDeps.findMissionPaneByPaneId.mockReturnValueOnce(persisted);
    authorityDeps.getMission.mockReturnValue(approvedMissionForSpawn());
    authorityDeps.resolveCwdForScope.mockReturnValueOnce(persisted.cwd);
    ompDeps.listOmpRpcSessions.mockReturnValueOnce([
      {
        sessionId: "omp-existing",
        paneId: persisted.paneId,
        kind: "mission",
        missionId: persisted.missionId,
        state: "busy",
        snapshot: { state: "busy" },
      },
    ]);
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);

    const result = await handler?.(
      { sender: { id: 7 } },
      {
        kind: "cli-agent",
        adapterId: persisted.adapterId,
        model: persisted.model,
        orchRequestId: requestId,
        missionId: persisted.missionId,
        paneId: persisted.paneId,
        cwd: persisted.cwd,
        resume: false,
        resumeLatestOnly: false,
        restorePersistedAuthority: true,
        cols: 100,
        rows: 30,
      },
    );

    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(/live physical mission process/i),
    });
    expect(ompDeps.spawnOmpRpcPane).not.toHaveBeenCalled();
  });

  it("does not turn an RPC mission resume into a fresh provider process", async () => {
    const persisted = {
      id: "mpane-orch-rpc",
      missionId: "mission-a",
      adapterId: "omp",
      model: "omp-main",
      title: "Orchestrator RPC",
      role: "orchestrator" as const,
      paneId: "pane-orch-rpc",
      cwd: "/workspace/a/trusted-cwd",
      scope: authorityDeps.scope,
      authoritySeal: authoritySealFor(),
      createdAt: 1,
    };
    authorityDeps.findMissionPaneByPaneId.mockReturnValueOnce(persisted);
    authorityDeps.getMission.mockReturnValue(approvedMissionForSpawn());
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);

    const result = await handler?.(
      { sender: { id: 7 } },
      {
        kind: "cli-agent",
        adapterId: persisted.adapterId,
        model: persisted.model,
        missionId: persisted.missionId,
        paneId: persisted.paneId,
        cwd: persisted.cwd,
        resume: true,
        resumeLatestOnly: false,
        restorePersistedAuthority: false,
        cols: 100,
        rows: 30,
      },
    );

    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(/exact main-owned provider session/i),
    });
    expect(ompDeps.spawnOmpRpcPane).not.toHaveBeenCalled();
  });

  it("adopts the exact live main-owned pane instead of spawning a duplicate provider process", () => {
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
    authorityDeps.findMissionPaneByPaneId.mockReturnValueOnce(persisted);
    authorityDeps.getMission.mockReturnValue(approvedMissionForSpawn());
    authorityDeps.resolveCwdForScope.mockReturnValueOnce(persisted.cwd);
    ptyDeps.adoptMainOwnedAgentSession.mockReturnValueOnce({
      sessionId: "pty-headless",
      state: "idle",
    });
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);
    const sender = { id: 7 };

    const result = handler?.(
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

  it("rejects persisted pane restore after the mission intent version changes", () => {
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({ ok: true, overrides: {} });
    authorityDeps.findMissionPaneByPaneId.mockReturnValueOnce({
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

  it("rejects a resumed mission pane when the renderer substitutes its adapter", () => {
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({
      ok: true,
      overrides: {},
    });
    authorityDeps.findMissionPaneByPaneId.mockReturnValueOnce({
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

    const result = handler?.(
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

  it("falls back to direct-user spawn when orchRequestId is spent (Reiniciar)", () => {
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({
      ok: true,
      overrides: {},
    });
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);
    const sender = { id: 7 };

    // claimPending returns null (default) → spent token; must not throw.
    const result = handler?.(
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

  it("binds a user shell to the renderer-authorized workspace and configured shell", () => {
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);
    const sender = { id: 7 };

    const result = handler?.(
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

  it("rejects a renderer-selected shell that differs from main settings", () => {
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);

    const result = handler?.(
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

  it("confirms a PTY write only when the main process accepts the owned session", () => {
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
