import { beforeEach, describe, expect, it, vi } from "vitest";
import { PTY_CHANNELS } from "../../shared/channels";

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
  spawnAgentSession: vi.fn(() => ({ sessionId: "pty-created" })),
  spawnSession: vi.fn(() => ({ sessionId: "shell-created" })),
  setPtyHost: vi.fn(),
  killSession: vi.fn(),
  writeSession: vi.fn(() => true),
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
    bindPendingSpawnSession: vi.fn(() => true),
    attachOrchMeta: vi.fn(),
    attachSessionScope: vi.fn(),
    findMissionPaneByPaneId: vi.fn((_paneId: string): unknown => null),
    createScopedMissionPaneStore: vi.fn(),
    getMission: vi.fn((_missionId: string): unknown => null),
    createScopedMissionStore: vi.fn(),
    listSquads: vi.fn((): unknown[] => []),
  };
});

const settingsDeps = vi.hoisted(() => ({
  getOrchSettings: vi.fn(() => ({ intentFirstMissionRuntimeV1: true })),
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
  killSession: ptyDeps.killSession,
  resizeSession: vi.fn(),
  setPtyHost: ptyDeps.setPtyHost,
  spawnAgentSession: ptyDeps.spawnAgentSession,
  spawnSession: ptyDeps.spawnSession,
  writeSession: ptyDeps.writeSession,
}));

vi.mock("./pty-host-client", () => ({
  createRealPtyHost: () => ({ kind: "test-host" }),
}));

vi.mock("../persistence/renderer-workspace-scope", () => ({
  requireRendererWorkspaceScope: authorityDeps.requireRendererWorkspaceScope,
}));

vi.mock("../orch/workspace-path", () => ({
  resolveCwdForScope: authorityDeps.resolveCwdForScope,
}));

vi.mock("../orch/pane-registry", () => ({
  claimPendingSpawnMeta: authorityDeps.claimPendingSpawnMeta,
  bindPendingSpawnSession: authorityDeps.bindPendingSpawnSession,
  attachOrchMeta: authorityDeps.attachOrchMeta,
  attachSessionScope: authorityDeps.attachSessionScope,
}));

vi.mock("../orch/mission-pane-store", () => ({
  createScopedMissionPaneStore: authorityDeps.createScopedMissionPaneStore,
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
          install: { command: "npm install claude" },
        }
      : null,
  isAdapterInstalled: () => true,
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

function approvedMissionForSpawn() {
  return {
    id: "mission-a",
    title: "Review",
    description: "Review",
    status: "running",
    squadId: "review-squad",
    milestones: [],
    learnings: "",
    intentState: "dispatched",
    intentVersion: 1,
    intentContract: {
      version: 1,
      source: "typed",
      goal: "Review",
      acceptanceCriteria: ["Done"],
      risk: "normal",
      executionMode: "assisted",
      contextPolicy: "on-demand",
      intentVersion: 1,
      approvedAt: 100,
      dispatchedAt: 100,
      budgets: {
        planningTokens: 1_200,
        executionTokens: 8_000,
        maxWorkers: 2,
      },
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("registerPtyIpc account fail-fast", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ipcDeps.handlers.clear();
    authorityDeps.requireRendererWorkspaceScope.mockReturnValue(
      authorityDeps.scope,
    );
    authorityDeps.resolveCwdForScope.mockReturnValue("/workspace/a");
    authorityDeps.claimPendingSpawnMeta.mockReturnValue(null);
    authorityDeps.bindPendingSpawnSession.mockReturnValue(true);
    authorityDeps.findMissionPaneByPaneId.mockReturnValue(null);
    authorityDeps.createScopedMissionPaneStore.mockReturnValue({
      findByPaneId: authorityDeps.findMissionPaneByPaneId,
    });
    authorityDeps.getMission.mockReturnValue(null);
    authorityDeps.createScopedMissionStore.mockReturnValue({
      get: authorityDeps.getMission,
    });
    authorityDeps.listSquads.mockReturnValue([]);
    settingsDeps.getOrchSettings.mockReturnValue({
      intentFirstMissionRuntimeV1: true,
    });
    ptyDeps.writeSession.mockReturnValue(true);
    configurePtyProjectRuntimeManager({} as never);
    registerPtyIpc();
  });

  it.each([
    "selected account does not belong to this provider",
    'selected account "Claude limite" is cooling down',
    'selected subscription "Claude Max" could not be activated',
    'selected account "Sem key" has no stored API credential',
  ])("rejects before creating a PTY: %s", (error) => {
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({ ok: false, error });
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);

    const result = handler?.(
      { sender: { id: 7 } },
      {
        kind: "cli-agent",
        adapterId: "claude",
        accountId: "acct-selected",
        cols: 100,
        rows: 30,
      },
    );

    expect(result).toEqual({ ok: false, error });
    expect(providerDeps.prepareProviderSpawn).toHaveBeenCalledWith("claude", {
      effort: undefined,
      accountId: "acct-selected",
    });
    expect(ptyDeps.spawnAgentSession).not.toHaveBeenCalled();
  });

  it("creates the PTY only after the exact account preparation succeeds", () => {
    const overrides = {
      binPath: "/usr/local/bin/claude",
      defaultModel: null,
      extraArgs: [],
      keyEnv: { ANTHROPIC_API_KEY: "sk-selected" },
      suppressEnv: [],
    };
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({
      ok: true,
      overrides,
    });
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);
    const request = {
      kind: "cli-agent" as const,
      adapterId: "claude",
      accountId: "acct-selected",
      cols: 100,
      rows: 30,
    };
    const sender = { id: 7 };

    const result = handler?.({ sender }, request);

    expect(result).toEqual({ ok: true, sessionId: "pty-created" });
    expect(ptyDeps.spawnAgentSession).toHaveBeenCalledWith(
      sender,
      { ...request, cwd: "/workspace/a" },
      expect.objectContaining({ id: "claude" }),
      overrides,
      {
        source: "direct-user",
        context: null,
        scope: authorityDeps.scope,
        coordinationScope: authorityDeps.scope,
        cwd: "/workspace/a",
      },
    );
    expect(authorityDeps.attachSessionScope).toHaveBeenCalledWith(
      "pty-created",
      authorityDeps.scope,
    );
  });

  it("rejects renderer cwd outside the main-authorized project", () => {
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({
      ok: true,
      overrides: {},
    });
    authorityDeps.resolveCwdForScope.mockImplementationOnce(() => {
      throw new Error("cwd escapes workspace: /etc");
    });
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);

    const result = handler?.(
      { sender: { id: 7 } },
      {
        kind: "cli-agent",
        adapterId: "claude",
        cwd: "/etc",
        cols: 100,
        rows: 30,
      },
    );

    expect(result).toEqual({ ok: false, error: "cwd escapes workspace: /etc" });
    expect(authorityDeps.requireRendererWorkspaceScope).toHaveBeenCalledWith({
      id: 7,
    });
    expect(ptyDeps.spawnAgentSession).not.toHaveBeenCalled();
  });

  it("rejects a direct agent spawn when no user-authorized workspace is open", () => {
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({
      ok: true,
      overrides: {},
    });
    authorityDeps.requireRendererWorkspaceScope.mockImplementationOnce(() => {
      throw new Error("renderer has no authorized workspace scope");
    });
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);

    const result = handler?.(
      { sender: { id: 7 } },
      {
        kind: "cli-agent",
        adapterId: "claude",
        cols: 100,
        rows: 30,
      },
    );

    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(/authorized workspace scope/),
    });
    expect(ptyDeps.spawnAgentSession).not.toHaveBeenCalled();
  });

  it("uses a one-time pending scope bound to the requesting WebContents", () => {
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({
      ok: true,
      overrides: {},
    });
    const sender = { id: 7 };
    const pending = {
      missionId: "mission-a",
      agentName: "worker-a",
      role: "worker" as const,
      allowedTools: [],
      allowedSkills: ["review"],
      scope: authorityDeps.scope,
      requestedCwd: "/workspace/a/packages/api",
    };
    authorityDeps.claimPendingSpawnMeta.mockReturnValueOnce(pending);
    authorityDeps.getMission.mockReturnValueOnce(approvedMissionForSpawn());
    authorityDeps.resolveCwdForScope.mockReturnValueOnce(
      "/workspace/a/packages/api",
    );
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);
    const request = {
      kind: "cli-agent" as const,
      adapterId: "claude",
      orchRequestId: "orchspawn-1",
      cwd: "/workspace/a/renderer-selected-subdir",
      cols: 100,
      rows: 30,
    };

    const result = handler?.({ sender }, request);

    expect(result).toEqual({ ok: true, sessionId: "pty-created" });
    expect(authorityDeps.claimPendingSpawnMeta).toHaveBeenCalledWith(
      "orchspawn-1",
      sender,
    );
    expect(authorityDeps.resolveCwdForScope).toHaveBeenCalledWith(
      authorityDeps.scope,
      pending.requestedCwd,
    );
    expect(authorityDeps.requireRendererWorkspaceScope).not.toHaveBeenCalled();
    expect(ptyDeps.spawnAgentSession).toHaveBeenCalledWith(
      sender,
      { ...request, cwd: "/workspace/a/packages/api" },
      expect.objectContaining({ id: "claude" }),
      {},
      {
        source: "pending",
        context: pending,
        scope: authorityDeps.scope,
        coordinationScope: authorityDeps.scope,
        cwd: "/workspace/a/packages/api",
      },
    );
    expect(authorityDeps.bindPendingSpawnSession).toHaveBeenCalledWith(
      "orchspawn-1",
      sender,
      "pty-created",
    );
    expect(authorityDeps.attachSessionScope).toHaveBeenCalledWith(
      "pty-created",
      authorityDeps.scope,
    );
  });

  it("kills a created PTY if its pending request cannot bind that session", () => {
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({
      ok: true,
      overrides: {},
    });
    const sender = { id: 7 };
    authorityDeps.claimPendingSpawnMeta.mockReturnValueOnce({
      role: "worker",
      allowedTools: [],
      scope: authorityDeps.scope,
    });
    authorityDeps.bindPendingSpawnSession.mockReturnValueOnce(false);
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);

    const result = handler?.(
      { sender },
      {
        kind: "cli-agent",
        adapterId: "claude",
        orchRequestId: "orchspawn-raced",
        cols: 100,
        rows: 30,
      },
    );

    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(/could not bind spawned PTY session/),
    });
    expect(ptyDeps.killSession).toHaveBeenCalledWith(sender, "pty-created");
    expect(authorityDeps.attachSessionScope).not.toHaveBeenCalled();
  });

  it("rejects a renderer-forged legacy squad spawn while intent-first is enabled", () => {
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({ ok: true, overrides: {} });
    authorityDeps.listSquads.mockReturnValueOnce([
      {
        id: "review-squad",
        name: "Review",
        description: "Review",
        agents: [
          {
            id: "maestro",
            agentName: "Maestro",
            category: "orchestrator",
            cli: "claude",
          },
        ],
      },
    ]);
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);

    const result = handler?.(
      { sender: { id: 7 } },
      {
        kind: "cli-agent",
        adapterId: "claude",
        orchRequestId: "squad-review-squad-forged",
        cols: 100,
        rows: 30,
      },
    );

    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(/intent-first|immediate.*not authorized/i),
    });
    expect(ptyDeps.spawnAgentSession).not.toHaveBeenCalled();
  });

  it.each([
    { squadId: "review-squad", intentFirst: false },
    { squadId: "nexus-pet-studio", intentFirst: true },
  ])(
    "preserves the main-owned immediate launch exception for $squadId",
    ({ squadId, intentFirst }) => {
      providerDeps.prepareProviderSpawn.mockReturnValueOnce({ ok: true, overrides: {} });
      settingsDeps.getOrchSettings.mockReturnValueOnce({
        intentFirstMissionRuntimeV1: intentFirst,
      });
      authorityDeps.listSquads.mockReturnValueOnce([
        {
          id: squadId,
          name: "Immediate",
          description: "Immediate",
          agents: [
            {
              id: "maestro",
              agentName: "Maestro",
              category: "orchestrator",
              cli: "claude",
            },
          ],
        },
      ]);
      const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);

      expect(
        handler?.(
          { sender: { id: 7 } },
          {
            kind: "cli-agent",
            adapterId: "claude",
            orchRequestId: `squad-${squadId}-approvedexception`,
            cols: 100,
            rows: 30,
          },
        ),
      ).toEqual({ ok: true, sessionId: "pty-created" });
    },
  );

  it("allows an approved current mission spawn and rejects a stale intent revision", () => {
    const squad = {
      id: "review-squad",
      name: "Review",
      description: "Review",
      agents: [
        {
          id: "maestro",
          agentName: "Maestro",
          category: "orchestrator",
          cli: "claude",
        },
      ],
    };
    const approved = {
      id: "mission-a",
      title: "Review",
      description: "Review",
      status: "running",
      squadId: "review-squad",
      milestones: [],
      learnings: "",
      intentState: "dispatched",
      intentVersion: 1,
      intentContract: {
        version: 1,
        source: "typed",
        goal: "Review",
        acceptanceCriteria: ["Done"],
        risk: "normal",
        executionMode: "assisted",
        contextPolicy: "on-demand",
        intentVersion: 1,
        approvedAt: 100,
        dispatchedAt: 100,
        budgets: {
          planningTokens: 1_200,
          executionTokens: 8_000,
          maxWorkers: 2,
        },
      },
      createdAt: 1,
      updatedAt: 1,
    };
    authorityDeps.listSquads.mockReturnValue([squad]);
    authorityDeps.getMission.mockReturnValueOnce(approved).mockReturnValueOnce({
      ...approved,
      intentVersion: 2,
    });
    providerDeps.prepareProviderSpawn.mockReturnValue({ ok: true, overrides: {} });
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);
    const request = {
      kind: "cli-agent",
      adapterId: "claude",
      missionId: "mission-a",
      orchRequestId: "squad-review-squad-approved",
      cols: 100,
      rows: 30,
    };

    expect(handler?.({ sender: { id: 7 } }, request)).toEqual({
      ok: true,
      sessionId: "pty-created",
    });
    expect(ptyDeps.spawnAgentSession).toHaveBeenCalledWith(
      { id: 7 },
      expect.objectContaining({ missionId: "mission-a" }),
      expect.objectContaining({ id: "claude" }),
      {},
      expect.objectContaining({
        source: "legacy-squad",
        context: expect.objectContaining({ missionId: "mission-a" }),
      }),
    );

    ptyDeps.spawnAgentSession.mockClear();
    expect(handler?.({ sender: { id: 7 } }, request)).toEqual({
      ok: false,
      error: expect.stringMatching(/approval|required|current intent/i),
    });
    expect(ptyDeps.spawnAgentSession).not.toHaveBeenCalled();
  });

  it("pins a resumed mission pane to its persisted adapter, scope and cwd", () => {
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({
      ok: true,
      overrides: {},
    });
    const persisted = {
      id: "mpane-a",
      missionId: "mission-a",
      adapterId: "claude",
      title: "Orchestrator",
      role: "orchestrator" as const,
      paneId: "pane-a",
      cwd: "/workspace/a/trusted-cwd",
      scope: authorityDeps.scope,
      createdAt: 1,
    };
    authorityDeps.findMissionPaneByPaneId.mockReturnValueOnce(persisted);
    authorityDeps.getMission.mockReturnValueOnce(approvedMissionForSpawn());
    authorityDeps.resolveCwdForScope.mockReturnValueOnce(persisted.cwd);
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);

    const result = handler?.(
      { sender: { id: 7 } },
      {
        kind: "cli-agent",
        adapterId: "claude",
        paneId: "pane-a",
        resume: true,
        cwd: "/workspace/a/renderer-selected-cwd",
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
  });

  it("starts a fresh conversation with the exact persisted mission authority", () => {
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
    authorityDeps.getMission.mockReturnValueOnce(approvedMissionForSpawn());
    authorityDeps.resolveCwdForScope.mockReturnValueOnce(persisted.cwd);
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);
    const sender = { id: 7 };

    const result = handler?.(
      { sender },
      {
        kind: "cli-agent",
        adapterId: "claude",
        paneId: "pane-worker",
        resume: false,
        restorePersistedAuthority: true,
        cols: 100,
        rows: 30,
      },
    );

    expect(result).toEqual({ ok: true, sessionId: "pty-created" });
    expect(ptyDeps.spawnAgentSession).toHaveBeenCalledWith(
      sender,
      expect.objectContaining({
        paneId: "pane-worker",
        resume: false,
        restorePersistedAuthority: true,
        cwd: persisted.cwd,
      }),
      expect.objectContaining({ id: "claude" }),
      {},
      expect.objectContaining({
        source: "persisted-pane",
        context: expect.objectContaining({
          missionId: "mission-a",
          role: "worker",
        }),
      }),
    );
    expect(authorityDeps.attachOrchMeta).toHaveBeenCalledWith(
      sender,
      "pane-worker",
      expect.objectContaining({ missionId: "mission-a", role: "worker" }),
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
      createdAt: 1,
    });
    authorityDeps.getMission.mockReturnValueOnce({
      ...approvedMissionForSpawn(),
      intentVersion: 2,
    });
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);

    expect(
      handler?.(
        { sender: { id: 7 } },
        {
          kind: "cli-agent",
          adapterId: "claude",
          paneId: "pane-worker",
          restorePersistedAuthority: true,
          cols: 100,
          rows: 30,
        },
      ),
    ).toEqual({
      ok: false,
      error: expect.stringMatching(/approval_required|current intent/i),
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
      createdAt: 1,
    });
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);

    const result = handler?.(
      { sender: { id: 7 } },
      {
        kind: "cli-agent",
        adapterId: "claude",
        paneId: "pane-a",
        resume: true,
        cols: 100,
        rows: 30,
      },
    );

    expect(result).toEqual({
      ok: false,
      error: "persisted pane adapter does not match spawn request",
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
      {},
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
