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
    on: vi.fn(
      (channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      },
    ),
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
    findMissionPaneByPaneId: vi.fn((_paneId: string): unknown => null),
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

const providerDeps = vi.hoisted(() => ({
  prepareProviderSpawn: vi.fn(),
  prepareProviderSpawnAuthoritative: vi.fn(),
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
  startSessionMortalityReconciler: vi.fn(),
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
      : id === "opencode" || id === "custom" || id === "agy" || id === "muse"
        ? {
            id,
            kind: "cli-pty",
            label:
              id === "opencode"
                ? "OpenCode"
                : id === "agy"
                  ? "Antigravity"
                  : "Custom CLI",
            bin: id,
            install: { command: `install ${id}` },
            quirks: { mcpAutoload: true },
            env: { passthrough: [], ephemeralHome: false },
            control: {},
          }
        : null,
  isAdapterInstalled: () => true,
  getAdapterResolvedBin: (id: string) => id === 'muse' ? '/usr/local/bin/muse' : '/usr/local/bin/claude',
  resolveAdapterBinary: (id: string) => id === 'muse' ? '/usr/local/bin/muse' : '/usr/local/bin/claude',
}));

vi.mock("../path-resolver", () => ({
  revalidateExecutable: (binPath: string) =>
    typeof binPath === "string" && binPath.startsWith("/"),
}));

vi.mock("../persistence/provider-config-store", () => ({
  isProviderEnabled: () => true,
  prepareProviderSpawn: providerDeps.prepareProviderSpawn,
  prepareProviderSpawnAuthoritative:
    providerDeps.prepareProviderSpawnAuthoritative,
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
import { issueImmediateSquadSpawnGrant } from "../orch/spawn-authority";

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

function sealedPendingSpawn() {
  const requestedCwd = "/workspace/a/packages/api";
  const authoritySeal = {
    intentVersion: 1,
    intentContractHash: "intent-contract-hash",
    contextRevision: "context-revision-a",
    contractHash: "contract-hash",
    squadRevisionHash: "squad-revision-hash",
  };
  return {
    missionId: "mission-a",
    contextRevision: authoritySeal.contextRevision,
    authoritySeal,
    agentName: "worker-a",
    role: "worker" as const,
    allowedTools: [],
    allowedSkills: ["review"],
    scope: authorityDeps.scope,
    requestedCwd,
    sealedRequest: {
      requestId: "orchspawn-1",
      paneId: "pane-main-sealed",
      adapterId: "claude",
      model: "sealed-model",
      accountId: "sealed-account",
      effort: "high",
      cwd: requestedCwd,
      missionId: "mission-a",
      agentName: "worker-a",
      role: "worker" as const,
      resume: false as const,
      resumeLatestOnly: false as const,
      restorePersistedAuthority: false as const,
    },
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
    authorityDeps.claimPendingSpawnMetaByPane.mockReturnValue(null);
    authorityDeps.bindPendingSpawnSession.mockReturnValue(true);
    authorityDeps.assertMissionSpawnAuthorityCurrent.mockImplementation(
      () => undefined,
    );
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
      squadCliPolicy: "operator-choice",
    });
    ptyDeps.writeSession.mockReturnValue(true);
    ptyDeps.adoptMainOwnedAgentSession.mockReturnValue(null);
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
      isolatedHome: expect.any(Boolean),
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

  it('offers a native Muse auth attempt only for the already-authorized direct user pane', () => {
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({ ok: true, overrides: {} });
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);
    const result = handler?.({ sender: { id: 7 } }, {
      kind: 'cli-agent', adapterId: 'muse', cols: 100, rows: 30,
    });
    expect(result).toEqual({ ok: true, sessionId: 'pty-created' });
    expect(providerDeps.prepareProviderSpawn).toHaveBeenCalledWith('muse', expect.objectContaining({
      allowNativeAuthAttempt: true, isolatedHome: false,
    }));
    expect(ptyDeps.spawnAgentSession).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), { binPath: '/usr/local/bin/muse' },
      expect.objectContaining({ source: 'direct-user', context: null, scope: authorityDeps.scope }),
    );
  });

  it('does not extend a mission-bound Muse request into a native-auth attempt', () => {
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({ ok: true, overrides: {} });
    const original = sealedPendingSpawn();
    const pending = { ...original, sealedRequest: { ...original.sealedRequest, adapterId: 'muse' } };
    authorityDeps.claimPendingSpawnMeta.mockReturnValueOnce(pending);
    authorityDeps.getMission.mockReturnValueOnce(approvedMissionForSpawn());
    authorityDeps.resolveCwdForScope.mockReturnValueOnce('/workspace/a/packages/api');
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);
    const result = handler?.({ sender: { id: 7 } }, {
      ...pending.sealedRequest, kind: 'cli-agent', orchRequestId: 'orchspawn-1',
      cols: 100, rows: 30,
    });
    expect(result).toEqual({ ok: true, sessionId: 'pty-created' });
    expect(providerDeps.prepareProviderSpawn.mock.calls[0]?.[1])
      .not.toHaveProperty('allowNativeAuthAttempt');
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
    const pending = sealedPendingSpawn();
    authorityDeps.claimPendingSpawnMeta.mockReturnValueOnce(pending);
    authorityDeps.getMission.mockReturnValueOnce(approvedMissionForSpawn());
    authorityDeps.resolveCwdForScope.mockReturnValueOnce(
      "/workspace/a/packages/api",
    );
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);
    const request = {
      kind: "cli-agent" as const,
      adapterId: "claude",
      model: "sealed-model",
      accountId: "sealed-account",
      effort: "high",
      orchRequestId: "orchspawn-1",
      missionId: "mission-a",
      paneId: "pane-main-sealed",
      cwd: "/workspace/a/packages/api",
      resume: false,
      resumeLatestOnly: false,
      restorePersistedAuthority: false,
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
      {
        ...request,
        cols: 120,
        rows: 36,
        cwd: "/workspace/a/packages/api",
      },
      expect.objectContaining({ id: "claude" }),
      expect.objectContaining({ binPath: "/usr/local/bin/claude" }),
      {
        source: "pending",
        context: {
          ...pending,
          squadId: "review-squad",
        },
        scope: authorityDeps.scope,
        coordinationScope: authorityDeps.scope,
        cwd: "/workspace/a/packages/api",
      },
    );
    expect(authorityDeps.assertPendingSpawnGrantActive).toHaveBeenCalledWith(
      "orchspawn-1",
      sender,
    );
    expect(
      authorityDeps.assertMissionSpawnAuthorityCurrent,
    ).toHaveBeenCalledWith({
      missionId: "mission-a",
      scope: authorityDeps.scope,
      contextRevision: pending.contextRevision,
      authoritySeal: pending.authoritySeal,
    });
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

  it("revalidates AGY auth at the final PTY spawn boundary", async () => {
    const sender = { id: 7 };
    const basePending = sealedPendingSpawn();
    const pending = {
      ...basePending,
      sealedRequest: {
        ...basePending.sealedRequest,
        adapterId: "agy",
        accountId: undefined,
      },
    };
    authorityDeps.claimPendingSpawnMeta.mockReturnValueOnce(pending);
    authorityDeps.getMission.mockReturnValueOnce(approvedMissionForSpawn());
    authorityDeps.resolveCwdForScope.mockReturnValueOnce(
      "/workspace/a/packages/api",
    );
    providerDeps.prepareProviderSpawnAuthoritative.mockResolvedValueOnce({
      ok: true,
      overrides: {
        binPath: "/usr/local/bin/agy",
        defaultModel: null,
        extraArgs: [],
        keyEnv: {},
        suppressEnv: [],
      },
    });
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);
    const request = {
      kind: "cli-agent" as const,
      adapterId: "agy",
      model: "sealed-model",
      effort: "high",
      orchRequestId: "orchspawn-1",
      missionId: "mission-a",
      paneId: "pane-main-sealed",
      cwd: "/workspace/a/packages/api",
      resume: false,
      resumeLatestOnly: false,
      restorePersistedAuthority: false,
      cols: 100,
      rows: 30,
    };

    await expect(handler?.({ sender }, request)).resolves.toEqual({
      ok: true,
      sessionId: "pty-created",
    });
    expect(
      providerDeps.prepareProviderSpawnAuthoritative,
    ).toHaveBeenCalledWith("agy", {
      effort: "high",
      accountId: undefined,
      model: "sealed-model",
      isolatedHome: expect.any(Boolean),
    });
    expect(providerDeps.prepareProviderSpawn).not.toHaveBeenCalled();
  });

  it.each([
    {
      mode: "operator-choice" as const,
      expected: { ok: true, sessionId: "pty-created" },
      shouldPrepare: true,
    },
    {
      mode: "governed" as const,
      expected: {
        ok: false,
        error: expect.stringMatching(/cannot enforce native read-only authority/i),
      },
      shouldPrepare: false,
    },
  ])(
    "applies native read-only confinement only when $mode requires it",
    ({ mode, expected, shouldPrepare }) => {
      settingsDeps.getOrchSettings.mockReturnValue({
        intentFirstMissionRuntimeV1: true,
        squadCliPolicy: mode,
      });
      providerDeps.prepareProviderSpawn.mockReturnValueOnce({
        ok: true,
        overrides: {},
      });
      const base = sealedPendingSpawn();
      const pending = {
        ...base,
        agentName: "custom-maestro",
        role: "orchestrator" as const,
        readOnly: false,
        nativeReadOnly: false,
        sealedRequest: {
          ...base.sealedRequest,
          adapterId: "custom",
          model: "sealed-custom-model",
          agentName: "custom-maestro",
          role: "orchestrator" as const,
        },
      };
      authorityDeps.claimPendingSpawnMeta.mockReturnValueOnce(pending);
      authorityDeps.getMission.mockReturnValueOnce(approvedMissionForSpawn());
      authorityDeps.resolveCwdForScope.mockReturnValueOnce(
        "/workspace/a/packages/api",
      );
      const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);

      const result = handler?.(
        { sender: { id: 7 } },
        {
          kind: "cli-agent",
          adapterId: "custom",
          model: "sealed-custom-model",
          accountId: "sealed-account",
          effort: "high",
          orchRequestId: "orchspawn-1",
          missionId: "mission-a",
          paneId: "pane-main-sealed",
          cwd: "/workspace/a/packages/api",
          resume: false,
          resumeLatestOnly: false,
          restorePersistedAuthority: false,
          cols: 100,
          rows: 30,
        },
      );

      expect(result).toEqual(expected);
      if (shouldPrepare) {
        expect(providerDeps.prepareProviderSpawn).toHaveBeenCalledWith(
          "custom",
          expect.objectContaining({ model: "sealed-custom-model" }),
        );
        expect(ptyDeps.spawnAgentSession).toHaveBeenCalled();
      } else {
        expect(providerDeps.prepareProviderSpawn).not.toHaveBeenCalled();
        expect(ptyDeps.spawnAgentSession).not.toHaveBeenCalled();
      }
    },
  );

  it("rejects async mission-seal drift at the last main-owned PTY boundary", () => {
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({
      ok: true,
      overrides: {},
    });
    const pending = sealedPendingSpawn();
    authorityDeps.claimPendingSpawnMeta.mockReturnValueOnce(pending);
    authorityDeps.getMission.mockReturnValueOnce(approvedMissionForSpawn());
    authorityDeps.assertMissionSpawnAuthorityCurrent.mockImplementationOnce(
      () => {
        throw new Error(
          "stale mission pane authority; replane and approve the current revision",
        );
      },
    );
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);

    const result = handler?.(
      { sender: { id: 7 } },
      {
        kind: "cli-agent",
        adapterId: "claude",
        model: "sealed-model",
        accountId: "sealed-account",
        effort: "high",
        orchRequestId: "orchspawn-1",
        missionId: "mission-a",
        paneId: "pane-main-sealed",
        cwd: "/workspace/a/packages/api",
        resume: false,
        resumeLatestOnly: false,
        restorePersistedAuthority: false,
        cols: 100,
        rows: 30,
      },
    );

    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(/stale mission pane authority/i),
    });
    expect(ptyDeps.spawnAgentSession).not.toHaveBeenCalled();
    expect(authorityDeps.bindPendingSpawnSession).not.toHaveBeenCalled();
  });

  it.each([
    ["provider", { adapterId: "opencode" }],
    ["model", { model: "renderer-model" }],
    ["account", { accountId: "renderer-account" }],
    ["effort", { effort: "low" }],
    ["cwd", { cwd: "/workspace/a/renderer-cwd" }],
    ["resume", { resume: true }],
    ["resumeLatestOnly", { resumeLatestOnly: true }],
    ["restorePersistedAuthority", { restorePersistedAuthority: true }],
    ["paneId", { paneId: "pane-renderer" }],
  ])(
    "rejects forged pending %s before provider preparation or process spawn",
    async (_field, forged) => {
      const pending = sealedPendingSpawn();
      authorityDeps.claimPendingSpawnMeta.mockReturnValueOnce(pending);
      authorityDeps.getMission.mockReturnValue(approvedMissionForSpawn());
      const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);
      const exact = {
        kind: "cli-agent" as const,
        adapterId: "claude",
        model: "sealed-model",
        accountId: "sealed-account",
        effort: "high",
        orchRequestId: "orchspawn-1",
        missionId: "mission-a",
        paneId: "pane-main-sealed",
        cwd: "/workspace/a/packages/api",
        resume: false,
        resumeLatestOnly: false,
        restorePersistedAuthority: false,
        cols: 100,
        rows: 30,
      };

      await expect(
        Promise.resolve(handler?.({ sender: { id: 7 } }, { ...exact, ...forged })),
      ).resolves.toEqual({
        ok: false,
        error: expect.stringMatching(/main-sealed pending spawn/i),
      });
      expect(providerDeps.prepareProviderSpawn).not.toHaveBeenCalled();
      expect(ptyDeps.spawnAgentSession).not.toHaveBeenCalled();
    },
  );

  it("awaits physical PTY exit if its pending request cannot bind that session", async () => {
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({
      ok: true,
      overrides: {},
    });
    const sender = { id: 7 };
    const pending = sealedPendingSpawn();
    authorityDeps.claimPendingSpawnMeta.mockReturnValueOnce(pending);
    authorityDeps.getMission.mockReturnValueOnce(approvedMissionForSpawn());
    authorityDeps.bindPendingSpawnSession.mockReturnValueOnce(false);
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);

    const result = handler?.(
      { sender },
      {
        kind: "cli-agent",
        adapterId: "claude",
        model: "sealed-model",
        accountId: "sealed-account",
        effort: "high",
        orchRequestId: "orchspawn-1",
        missionId: "mission-a",
        paneId: "pane-main-sealed",
        cwd: "/workspace/a/packages/api",
        resume: false,
        resumeLatestOnly: false,
        restorePersistedAuthority: false,
        cols: 100,
        rows: 30,
      },
    );

    await expect(result).resolves.toEqual({
      ok: false,
      error: expect.stringMatching(/could not bind spawned PTY session/),
    });
    expect(ptyDeps.orchTerminateSession).toHaveBeenCalledWith("pty-created");
    expect(authorityDeps.attachSessionScope).not.toHaveBeenCalled();
  });

  it.each([
    { squadId: "review-squad", intentFirst: true },
    { squadId: "review-squad", intentFirst: false },
    { squadId: "nexus-pet-studio", intentFirst: true },
  ])(
    "rejects a derived $squadId id even when intentFirst=$intentFirst",
    ({ squadId, intentFirst }) => {
      providerDeps.prepareProviderSpawn.mockReturnValueOnce({
        ok: true,
        overrides: {},
      });
      settingsDeps.getOrchSettings.mockReturnValue({
        intentFirstMissionRuntimeV1: intentFirst,
        squadCliPolicy: "operator-choice",
      });
      authorityDeps.listSquads.mockReturnValueOnce([
        {
          id: squadId,
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
          orchRequestId: `squad-${squadId}-forged`,
          cols: 100,
          rows: 30,
        },
      );

      expect(result).toEqual({
        ok: false,
        error: expect.stringMatching(/unknown or expired.*spawn grant/i),
      });
      expect(settingsDeps.getOrchSettings).not.toHaveBeenCalled();
      expect(ptyDeps.spawnAgentSession).not.toHaveBeenCalled();
    },
  );

  it.each([
    { squadId: "review-squad", intentFirst: false },
    { squadId: "nexus-pet-studio", intentFirst: true },
  ])(
    "accepts one exact main-owned immediate launch grant for $squadId",
    ({ squadId, intentFirst }) => {
      providerDeps.prepareProviderSpawn.mockReturnValueOnce({ ok: true, overrides: {} });
      settingsDeps.getOrchSettings.mockReturnValueOnce({
        intentFirstMissionRuntimeV1: intentFirst,
        squadCliPolicy: "operator-choice",
      });
      const immediateSquad = {
        id: squadId,
        name: "Immediate",
        createdAt: "1",
        builtin: squadId === "nexus-pet-studio",
        orchestratorInstructions: "",
        agents: [
          {
            id: "maestro",
            agentName: "Maestro",
            category: "orchestrator" as const,
            cli: "claude",
          },
        ],
      };
      authorityDeps.listSquads.mockReturnValue([immediateSquad]);
      const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);
      const sender = { id: 7, isDestroyed: () => false };
      const token = issueImmediateSquadSpawnGrant({
        owner: sender as never,
        scope: authorityDeps.scope,
        squad: immediateSquad,
        runtime: {
          adapterId: "claude",
          paneId: "pane-immediate",
          title: "Maestro",
          missionTitle: "Reviewed mission",
          missionGoal: "Reviewed mission",
        },
      });
      const request = {
        kind: "cli-agent" as const,
        adapterId: "claude",
        orchRequestId: token,
        paneId: "pane-immediate",
        cwd: "/workspace/a/renderer-selected-subdir",
        cols: 100,
        rows: 30,
      };

      expect(
        handler?.({ sender }, request),
      ).toEqual({ ok: true, sessionId: "pty-created" });
      expect(ptyDeps.spawnAgentSession).toHaveBeenCalledWith(
        sender,
        expect.objectContaining({ orchRequestId: token }),
        expect.objectContaining({ id: "claude" }),
        expect.objectContaining({ binPath: "/usr/local/bin/claude" }),
        expect.objectContaining({
          source: "legacy-squad",
          context: expect.objectContaining({ squadId }),
        }),
      );
      expect(authorityDeps.resolveCwdForScope).toHaveBeenCalledWith(
        authorityDeps.scope,
        authorityDeps.scope.rootRealPath,
      );

      ptyDeps.spawnAgentSession.mockClear();
      providerDeps.prepareProviderSpawn.mockReturnValueOnce({ ok: true, overrides: {} });
      expect(handler?.({ sender }, request)).toEqual({
        ok: false,
        error: expect.stringMatching(/unknown or expired.*spawn grant/i),
      });
      expect(ptyDeps.spawnAgentSession).not.toHaveBeenCalled();
    },
  );

  it("burns an immediate squad grant when the renderer workspace scope drifts", () => {
    const immediateSquad = {
      id: "review-squad",
      name: "Immediate",
      createdAt: "1",
      builtin: false,
      orchestratorInstructions: "",
      agents: [
        {
          id: "maestro",
          agentName: "Maestro",
          category: "orchestrator" as const,
          cli: "claude",
        },
      ],
    };
    const sender = { id: 7, isDestroyed: () => false };
    const token = issueImmediateSquadSpawnGrant({
      owner: sender as never,
      scope: authorityDeps.scope,
      squad: immediateSquad,
      runtime: {
        adapterId: "claude",
        paneId: "pane-immediate",
        title: "Maestro",
        missionTitle: "Reviewed mission",
        missionGoal: "Reviewed mission",
      },
    });
    authorityDeps.listSquads.mockReturnValue([immediateSquad]);
    authorityDeps.requireRendererWorkspaceScope.mockReturnValueOnce({
      ...authorityDeps.scope,
      checkoutId: "checkout-drift",
    });
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);
    const request = {
      kind: "cli-agent" as const,
      adapterId: "claude",
      orchRequestId: token,
      paneId: "pane-immediate",
      cols: 100,
      rows: 30,
    };

    expect(handler?.({ sender }, request)).toEqual({
      ok: false,
      error: expect.stringMatching(/unknown or expired.*spawn grant/i),
    });
    authorityDeps.requireRendererWorkspaceScope.mockReturnValue(
      authorityDeps.scope,
    );
    expect(handler?.({ sender }, request)).toEqual({
      ok: false,
      error: expect.stringMatching(/unknown or expired.*spawn grant/i),
    });
    expect(ptyDeps.spawnAgentSession).not.toHaveBeenCalled();
  });

  it.each([
    ["adapterId", "opencode"],
    ["model", "renderer-model"],
    ["accountId", "renderer-account"],
    ["effort", "medium"],
    ["paneId", "pane-swapped"],
  ] as const)(
    "burns the grant before provider preparation when exact %s drifts",
    async (field, driftedValue) => {
      const immediateSquad = {
        id: "review-squad",
        name: "Immediate",
        createdAt: "1",
        builtin: false,
        orchestratorInstructions: "Reviewed.",
        nativeInstructions: "Reviewed native policy.",
        agents: [
          {
            id: "maestro",
            agentName: "Maestro",
            category: "orchestrator" as const,
            cli: "claude",
          },
          {
            id: "worker",
            agentName: "Executor",
            category: "executor" as const,
            cli: "claude",
          },
        ],
      };
      const sender = { id: 7, isDestroyed: () => false };
      const token = issueImmediateSquadSpawnGrant({
        owner: sender as never,
        scope: authorityDeps.scope,
        squad: immediateSquad,
        runtime: {
          adapterId: "claude",
          model: "reviewed-model",
          accountId: "reviewed-account",
          effort: "high",
          paneId: "pane-immediate",
          title: "Maestro",
          missionTitle: "Reviewed mission",
          missionGoal: "Reviewed mission",
        },
      });
      authorityDeps.listSquads.mockReturnValue([immediateSquad]);
      const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn)!;
      const exactRequest = {
        kind: "cli-agent" as const,
        adapterId: "claude",
        model: "reviewed-model",
        accountId: "reviewed-account",
        effort: "high",
        paneId: "pane-immediate",
        orchRequestId: token,
        cols: 100,
        rows: 30,
      };

      expect(
        await handler(
          { sender },
          { ...exactRequest, [field]: driftedValue },
        ),
      ).toEqual({
        ok: false,
        error: expect.stringMatching(/unknown or expired.*spawn grant/i),
      });
      expect(await handler({ sender }, exactRequest)).toEqual({
        ok: false,
        error: expect.stringMatching(/unknown or expired.*spawn grant/i),
      });
      expect(providerDeps.prepareProviderSpawn).not.toHaveBeenCalled();
      expect(ptyDeps.spawnAgentSession).not.toHaveBeenCalled();
    },
  );

  it("allows an approved current mission spawn and rejects a stale intent revision", () => {
    const squad = {
      id: "review-squad",
      name: "Review",
      createdAt: "1",
      builtin: false,
      orchestratorInstructions: "",
      agents: [
        {
          id: "maestro",
          agentName: "Maestro",
          category: "orchestrator" as const,
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
    const sender = { id: 7, isDestroyed: () => false };
    const firstToken = issueImmediateSquadSpawnGrant({
      owner: sender as never,
      scope: authorityDeps.scope,
      squad,
      runtime: {
        adapterId: "claude",
        paneId: "pane-immediate",
        title: "Maestro",
        missionTitle: "Review",
        missionGoal: "Review",
        missionId: "mission-a",
      },
    });
    const request = {
      kind: "cli-agent",
      adapterId: "claude",
      missionId: "mission-a",
      orchRequestId: firstToken,
      paneId: "pane-immediate",
      cols: 100,
      rows: 30,
    };

    expect(handler?.({ sender }, request)).toEqual({
      ok: true,
      sessionId: "pty-created",
    });
    expect(ptyDeps.spawnAgentSession).toHaveBeenCalledWith(
      sender,
      expect.objectContaining({ missionId: "mission-a" }),
      expect.objectContaining({ id: "claude" }),
      expect.objectContaining({ binPath: "/usr/local/bin/claude" }),
      expect.objectContaining({
        source: "legacy-squad",
        context: expect.objectContaining({ missionId: "mission-a" }),
      }),
    );

    ptyDeps.spawnAgentSession.mockClear();
    const staleToken = issueImmediateSquadSpawnGrant({
      owner: sender as never,
      scope: authorityDeps.scope,
      squad,
      runtime: {
        adapterId: "claude",
        paneId: "pane-immediate",
        title: "Maestro",
        missionTitle: "Review",
        missionGoal: "Review",
        missionId: "mission-a",
      },
    });
    expect(
      handler?.(
        { sender },
        { ...request, orchRequestId: staleToken },
      ),
    ).toEqual({
      ok: false,
      error: expect.stringMatching(/approval|required|current intent/i),
    });
    expect(ptyDeps.spawnAgentSession).not.toHaveBeenCalled();
  });
});
