// The bundled CLI asset is outside this IPC fixture; keep the test independent of asset packaging.
vi.mock('../orch/impeccable-manifest', () => ({ IMPECCABLE_MANIFEST: [] }));
import { LicenseError } from '../../shared/license-errors';
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PTY_CHANNELS } from "../../shared/channels";
import { hasPendingPaneSpawns } from "../orch/pane-admission";

const tabDeps = vi.hoisted(() => ({ prepare: vi.fn(), requireLive: vi.fn() }));
// F-790: a espera do Codex pela sonda de versão (o helper real tem testes próprios).
const settleDeps = vi.hoisted(() => ({
  settle: vi.fn((_adapter: unknown): Promise<void> | null => null),
  proveHeavyBase: vi.fn<() => Promise<void> | undefined>(),
}));
vi.mock('../orch/native-heavy-preload', () => ({ ensureNativeHeavyJobBase: settleDeps.proveHeavyBase }));
vi.mock('../orch/codex-cli-version', () => ({ settleCodexCliVersionForSpawn: settleDeps.settle }));
vi.mock('./pane-space-worktree', () => ({ preparePaneSpaceWorktree: tabDeps.prepare }));

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
  resizeSession: vi.fn(),
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
    reportPendingSpawnStartFailure: vi.fn(
      (_requestId: string, _owner: unknown, _error: string) => true,
    ),
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

const authGateDeps = vi.hoisted(() => ({
  wait: vi.fn<(...args: unknown[]) => Promise<string>>(async () => "fresh"),
  track: vi.fn(),
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

vi.mock("electron", () => ({
  ipcMain: { handle: ipcDeps.handle, on: ipcDeps.on },
}));

vi.mock("./pty-manager", () => ({
  adoptMainOwnedAgentSession: ptyDeps.adoptMainOwnedAgentSession,
  listAgentSessionsForPane: ptyDeps.listAgentSessionsForPane,
  killSession: ptyDeps.killSession,
  orchKillSession: ptyDeps.orchKillSession,
  orchTerminateSession: ptyDeps.orchTerminateSession,
  resizeSession: ptyDeps.resizeSession,
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
  requireLiveRendererWorkspaceScope: tabDeps.requireLive,
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
  reportPendingSpawnStartFailure: authorityDeps.reportPendingSpawnStartFailure,
  hasLivePaneSession: () => false,
}));

// F-1151: durable ownership is proved by its own suites; here only the WIRING of
// pty-ipc to the exact reserved tuple is observed.
const continuationDeps = vi.hoisted(() => ({
  bindWorkerContinuationSession: vi.fn(),
  authorizeWorkerContinuationBirth: vi.fn(),
  assertWorkerContinuationTarget: vi.fn(),
  assertWorkerContinuationAccount: vi.fn(),
  physicalProofFactory: vi.fn(),
  physicalProof: vi.fn(),
}));
vi.mock("../orch/mission-pane-resume-ownership", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../orch/mission-pane-resume-ownership")>()),
  bindWorkerContinuationSession: continuationDeps.bindWorkerContinuationSession,
  authorizeWorkerContinuationBirth: continuationDeps.authorizeWorkerContinuationBirth,
  assertWorkerContinuationTarget: continuationDeps.assertWorkerContinuationTarget,
  assertWorkerContinuationAccount: continuationDeps.assertWorkerContinuationAccount,
  workerContinuationPhysicalProof: (...args: unknown[]) => {
    continuationDeps.physicalProofFactory(...args);
    return continuationDeps.physicalProof;
  },
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
      : id === "opencode" || id === "custom" || id === "agy" || id === "muse" || id === "codex" || id === "grok"
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

vi.mock("../path-resolver", async (importOriginal) => ({
  ...await importOriginal<typeof import("../path-resolver")>(),
  revalidateExecutable: (binPath: string) =>
    typeof binPath === "string" && binPath.startsWith("/"),
}));

vi.mock("../adapters/managed-credentials", async (importOriginal) => ({
  ...await importOriginal<typeof import("../adapters/managed-credentials")>(),
  trackManagedSession: authGateDeps.track,
}));

vi.mock("../adapters/managed-auth-spawn-gate", async (importOriginal) => ({
  ...await importOriginal<typeof import("../adapters/managed-auth-spawn-gate")>(),
  waitForRotatingAuthSpawnGate: authGateDeps.wait,
}));

vi.mock("../persistence/provider-config-store", () => ({
  isProviderEnabled: () => true,
  prepareProviderSpawn: providerDeps.prepareProviderSpawn,
  prepareProviderSpawnAuthoritative:
    providerDeps.prepareProviderSpawnAuthoritative,
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

const persistedSeal = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../orch/mission-pane-authority', async original => ({
  ...await original<typeof import('../orch/mission-pane-authority')>(),
  resolveMissionPaneAuthoritySeal: () => persistedSeal.current,
}));

const traceDeps = vi.hoisted(() => ({ trace: vi.fn() }));
vi.mock("../observability/main-trace", () => ({ trace: traceDeps.trace }));

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

const gateFixtureDirs: string[] = [];
afterEach(() => {
  for (const dir of gateFixtureDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("registerPtyIpc account fail-fast", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settleDeps.proveHeavyBase.mockReset();
    tabDeps.prepare.mockReset();
    tabDeps.requireLive.mockReset();
    authGateDeps.wait.mockReset().mockResolvedValue("fresh");
    providerDeps.prepareProviderSpawn.mockReset();
    providerDeps.prepareProviderSpawnAuthoritative.mockReset().mockImplementation(
      async (adapterId: string, perSpawn: unknown) =>
        providerDeps.prepareProviderSpawn(adapterId, perSpawn),
    );
    providerDeps.acquireCliSpawnPermit.mockReset().mockResolvedValue(() => {});
    authorityDeps.assertPendingSpawnGrantActive.mockReset();
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
    persistedSeal.current = null;
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
  ])("rejects before creating a PTY: %s", async (error) => {
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({ ok: false, error });
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);

    const result = await handler?.(
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

  it('holds renderer agent spawn behind the native job proof and proceeds degraded after a failed proof', async () => {
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({
      ok: true, overrides: { binPath: '/usr/local/bin/claude', defaultModel: null, extraArgs: [], keyEnv: {}, suppressEnv: [] },
    });
    let fail!: (error: Error) => void;
    settleDeps.proveHeavyBase.mockReturnValueOnce(new Promise<void>((_resolve, reject) => { fail = reject; }).catch(() => undefined));
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn)!;
    const pending = handler({ sender: { id: 7 } }, { kind: 'cli-agent', adapterId: 'claude', cols: 80, rows: 24 });
    await vi.waitFor(() => expect(settleDeps.proveHeavyBase).toHaveBeenCalledOnce());
    expect(ptyDeps.spawnAgentSession).not.toHaveBeenCalled();
    fail(new Error('native_heavy_job_authority_unavailable'));
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(ptyDeps.spawnAgentSession).toHaveBeenCalledOnce();
  });

  it('waits for a successful in-flight native proof before renderer agent spawn', async () => {
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({
      ok: true, overrides: { binPath: '/usr/local/bin/claude', defaultModel: null, extraArgs: [], keyEnv: {}, suppressEnv: [] },
    });
    let finish!: () => void;
    settleDeps.proveHeavyBase.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn)!;
    const pending = handler({ sender: { id: 7 } }, { kind: 'cli-agent', adapterId: 'claude', cols: 80, rows: 24 });
    await vi.waitFor(() => expect(settleDeps.proveHeavyBase).toHaveBeenCalledOnce());
    expect(ptyDeps.spawnAgentSession).not.toHaveBeenCalled();
    finish();
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(ptyDeps.spawnAgentSession).toHaveBeenCalledOnce();
  });

  it('counts a renderer spawn as pending from pty:spawn entry until it settles, including the native-proof wait (C6)', async () => {
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({
      ok: true, overrides: { binPath: '/usr/local/bin/claude', defaultModel: null, extraArgs: [], keyEnv: {}, suppressEnv: [] },
    });
    let finish!: () => void;
    settleDeps.proveHeavyBase.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));
    expect(hasPendingPaneSpawns()).toBe(false);
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn)!;
    const pending = handler({ sender: { id: 7 } }, { kind: 'cli-agent', adapterId: 'claude', cols: 80, rows: 24 });
    await vi.waitFor(() => expect(settleDeps.proveHeavyBase).toHaveBeenCalledOnce());
    // The PTY census has nothing in "spawning" yet: only the entry counter sees this wait.
    expect(hasPendingPaneSpawns()).toBe(true);
    finish();
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(hasPendingPaneSpawns()).toBe(false);
  });

  it('settles the pty:spawn entry counter for synchronous refusals', async () => {
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn)!;
    await handler({ sender: { id: 7 } }, { kind: 'cli-agent', cols: 80, rows: 24, adapterId: '' });
    expect(hasPendingPaneSpawns()).toBe(false);
  });

  it("creates the PTY only after the exact account preparation succeeds", async () => {
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

    const result = await handler?.({ sender }, request);

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

  it.each(['shell', 'cli-agent'] as const)('spawns %s inside the Main-owned tab worktree and returns its cwd', async (kind) => {
    providerDeps.prepareProviderSpawn.mockReturnValue({ ok: true, overrides: {} });
    const scope = { ...authorityDeps.scope, rootRealPath: '/private/tab-a' };
    tabDeps.prepare.mockResolvedValue({ scope, cwd: scope.rootRealPath });
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn)!;
    const result = await handler({ sender: { id: 7 } }, {
      kind, adapterId: kind === 'cli-agent' ? 'claude' : undefined,
      paneId: 'pane-tab', worktreeSpaceId: 'space-a', cwd: '/private/tab-a', cols: 80, rows: 24,
    });
    expect(result).toMatchObject({ ok: true, cwd: '/private/tab-a' });
    expect(tabDeps.prepare).toHaveBeenCalledWith(authorityDeps.scope, 'space-a', '/private/tab-a');
    expect(tabDeps.requireLive).toHaveBeenCalledWith({ id: 7 }, authorityDeps.scope);
    if (kind === 'cli-agent') expect(ptyDeps.spawnAgentSession).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.objectContaining({
      scope, coordinationScope: authorityDeps.scope, cwd: '/private/tab-a', source: 'direct-user',
    }));
    else expect(ptyDeps.spawnSession).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ scope, cwd: '/private/tab-a' }));
  });

  it('F-790: Codex com a sonda de versão em voo só prepara e spawna depois dela; outras CLIs não esperam', async () => {
    providerDeps.prepareProviderSpawn.mockReturnValue({ ok: true, overrides: {} });
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn)!;
    let finish!: () => void;
    settleDeps.settle.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));

    const pending = handler({ sender: { id: 7 } }, { kind: 'cli-agent', adapterId: 'codex', cols: 100, rows: 30 }) as Promise<unknown>;
    await Promise.resolve();
    await Promise.resolve();
    expect(settleDeps.settle).toHaveBeenCalledWith(expect.objectContaining({ id: 'codex', bin: 'codex' }));
    expect(providerDeps.prepareProviderSpawn).not.toHaveBeenCalled();
    expect(ptyDeps.spawnAgentSession).not.toHaveBeenCalled();
    finish();
    await expect(pending).resolves.toMatchObject({ ok: true, sessionId: 'pty-created' });
    expect(ptyDeps.spawnAgentSession).toHaveBeenCalledOnce();

    // Nada a esperar (null): o caminho de sempre, sem espera.
    ptyDeps.spawnAgentSession.mockClear();
    const other = await handler({ sender: { id: 7 } }, { kind: 'cli-agent', adapterId: 'claude', cols: 100, rows: 30 });
    expect(settleDeps.settle).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'claude' }));
    expect(other).toMatchObject({ ok: true });
    expect(ptyDeps.spawnAgentSession).toHaveBeenCalledOnce();
  });

  it('F-790: aba isolada também espera a sonda do Codex antes de preparar o spawn', async () => {
    providerDeps.prepareProviderSpawn.mockReturnValue({ ok: true, overrides: {} });
    const scope = { ...authorityDeps.scope, rootRealPath: '/private/tab-a' };
    tabDeps.prepare.mockResolvedValue({ scope, cwd: scope.rootRealPath });
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn)!;
    let finish!: () => void;
    settleDeps.settle.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));

    const pending = handler({ sender: { id: 7 } }, {
      kind: 'cli-agent', adapterId: 'codex', paneId: 'pane-tab', worktreeSpaceId: 'space-a',
      cwd: '/private/tab-a', cols: 80, rows: 24,
    }) as Promise<unknown>;
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    expect(settleDeps.settle).toHaveBeenCalledWith(expect.objectContaining({ id: 'codex' }));
    expect(providerDeps.prepareProviderSpawn).not.toHaveBeenCalled();
    expect(ptyDeps.spawnAgentSession).not.toHaveBeenCalled();
    finish();
    await expect(pending).resolves.toMatchObject({ ok: true, cwd: '/private/tab-a' });
    expect(ptyDeps.spawnAgentSession).toHaveBeenCalledOnce();
  });

  it('restores an operator helper tab after its ad-hoc spawn grant expired', async () => {
    providerDeps.prepareProviderSpawn.mockReturnValue({ ok: true, overrides: {} });
    const scope = { ...authorityDeps.scope, rootRealPath: '/private/tab-a' };
    tabDeps.prepare.mockResolvedValue({ scope, cwd: scope.rootRealPath });
    const result = await ipcDeps.handlers.get(PTY_CHANNELS.spawn)!({ sender: { id: 7 } }, {
      kind: 'cli-agent', adapterId: 'claude', paneId: 'pane-helper', resume: true,
      orchRequestId: 'orchspawn-spent', worktreeSpaceId: 'space-a', cwd: '/private/tab-a', cols: 80, rows: 24,
    });
    expect(result).toMatchObject({ ok: true, cwd: '/private/tab-a' });
    expect(tabDeps.prepare).toHaveBeenCalledTimes(1);
  });

  it('rechecks tab authority after provider authentication waits, immediately before physical spawn', async () => {
    const scope = { ...authorityDeps.scope, rootRealPath: '/private/tab-a' };
    tabDeps.prepare.mockResolvedValue({ scope, cwd: scope.rootRealPath });
    providerDeps.prepareProviderSpawnAuthoritative.mockImplementationOnce(async () => {
      tabDeps.requireLive.mockImplementation(() => { throw new Error('renderer workspace authority changed'); });
      return { ok: true, overrides: {} };
    });
    const result = await ipcDeps.handlers.get(PTY_CHANNELS.spawn)!({ sender: { id: 7 } }, {
      kind: 'cli-agent', adapterId: 'claude', worktreeSpaceId: 'space-a', cols: 80, rows: 24,
    });
    expect(result).toMatchObject({ ok: false });
    expect(ptyDeps.spawnAgentSession).not.toHaveBeenCalled();
  });

  it('never spawns into the old tab after the renderer switches workspace while Git is preparing it', async () => {
    tabDeps.prepare.mockResolvedValue({ scope: authorityDeps.scope, cwd: '/private/tab-a' });
    tabDeps.requireLive.mockImplementation(() => { throw new Error('renderer workspace authority changed'); });
    const result = await ipcDeps.handlers.get(PTY_CHANNELS.spawn)!({ sender: { id: 7 } }, {
      kind: 'shell', worktreeSpaceId: 'space-a', cols: 80, rows: 24,
    });
    expect(result).toMatchObject({ ok: false });
    expect(ptyDeps.spawnSession).not.toHaveBeenCalled();
  });

  it('offers a native Muse auth attempt only for the already-authorized direct user pane', async () => {
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({ ok: true, overrides: {} });
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);
    const result = await handler?.({ sender: { id: 7 } }, {
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

  it('F-1485: o pane Grok direto do operador pode abrir para aprovar o login, sem a trava de sessão vencida', async () => {
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({ ok: true, overrides: {} });
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);
    const result = await handler?.({ sender: { id: 7 } }, {
      kind: 'cli-agent', adapterId: 'grok', cols: 100, rows: 30,
    });
    expect(result).toEqual({ ok: true, sessionId: 'pty-created' });
    expect(providerDeps.prepareProviderSpawn).toHaveBeenCalledWith('grok', expect.objectContaining({
      allowNativeAuthAttempt: true,
    }));
    for (const [options] of authGateDeps.wait.mock.calls) {
      expect(options).not.toHaveProperty('refuseExpiredGrokSession');
    }
  });

  it('F-1485: Grok com XAI_API_KEY injetada nem passa pela trava/espera do OAuth', async () => {
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({ ok: true, overrides: { keyEnv: { XAI_API_KEY: 'xai-sintetica' } } });
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);
    const result = await handler?.({ sender: { id: 7 } }, {
      kind: 'cli-agent', adapterId: 'grok', cols: 100, rows: 30,
    });
    expect(result).toEqual({ ok: true, sessionId: 'pty-created' });
    expect(authGateDeps.wait).not.toHaveBeenCalled();
  });

  it('does not extend a mission-bound Muse request into a native-auth attempt', async () => {
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({ ok: true, overrides: {} });
    const original = sealedPendingSpawn();
    const pending = { ...original, sealedRequest: { ...original.sealedRequest, adapterId: 'muse' } };
    authorityDeps.claimPendingSpawnMeta.mockReturnValueOnce(pending);
    authorityDeps.getMission.mockReturnValue(approvedMissionForSpawn());
    authorityDeps.resolveCwdForScope.mockReturnValueOnce('/workspace/a/packages/api');
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);
    const result = await handler?.({ sender: { id: 7 } }, {
      ...pending.sealedRequest, kind: 'cli-agent', orchRequestId: 'orchspawn-1',
      cols: 100, rows: 30,
    });
    expect(result).toEqual({ ok: true, sessionId: 'pty-created' });
    expect(providerDeps.prepareProviderSpawn.mock.calls[0]?.[1])
      .not.toHaveProperty('allowNativeAuthAttempt');
  });

  it('F-1151: a pending worker continuation wires account, deferred fence, session binding, birth authorization and raw proof to its exact tuple', async () => {
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({ ok: true, overrides: { selectedAccountId: 'sealed-account' } });
    const ref = { sourcePaneId: 'pane-original', attemptId: 'workerresume-1' };
    const pending = { ...sealedPendingSpawn(), workerIncarnationId: 'incarnation-new', workerContinuation: ref };
    authorityDeps.claimPendingSpawnMeta.mockReturnValueOnce(pending);
    authorityDeps.getMission.mockReturnValue(approvedMissionForSpawn());
    authorityDeps.resolveCwdForScope.mockReturnValueOnce('/workspace/a/packages/api');
    const sender = { id: 7 };
    const result = await ipcDeps.handlers.get(PTY_CHANNELS.spawn)?.({ sender },
      { ...pending.sealedRequest, kind: 'cli-agent', orchRequestId: 'orchspawn-1', cols: 100, rows: 30 });
    expect(result).toMatchObject({ ok: true, sessionId: 'pty-created' });
    const tuple = { paneId: 'pane-main-sealed', requestId: 'orchspawn-1', workerIncarnationId: 'incarnation-new' };
    // The account Main will physically use is fenced BEFORE any child exists.
    expect(continuationDeps.assertWorkerContinuationAccount).toHaveBeenCalledWith(authorityDeps.scope, ref, 'sealed-account');
    expect(continuationDeps.assertWorkerContinuationAccount.mock.invocationCallOrder[0])
      .toBeLessThan(ptyDeps.spawnAgentSession.mock.invocationCallOrder[0]!);
    const overrides = (ptyDeps.spawnAgentSession.mock.calls.at(-1) as unknown as unknown[])[3] as {
      assertDeferredSpawnCurrent: (sessionId: string) => void; onSpawnSessionAllocated: (sessionId: string) => void;
      onNativeBirthAuthorized: () => void; onPhysicalTerminationProof: unknown;
    };
    expect(continuationDeps.physicalProofFactory).toHaveBeenCalledWith(authorityDeps.scope, ref, tuple);
    expect(overrides.onPhysicalTerminationProof).toBe(continuationDeps.physicalProof);
    overrides.onSpawnSessionAllocated('pty-created');
    expect(continuationDeps.bindWorkerContinuationSession).toHaveBeenCalledWith(authorityDeps.scope, ref, tuple, 'pty-created');
    overrides.onNativeBirthAuthorized();
    expect(continuationDeps.authorizeWorkerContinuationBirth).toHaveBeenCalledWith(authorityDeps.scope, ref, tuple);
    // The deferred fence is told WHICH session may still be born after the grant was consumed.
    authorityDeps.assertPendingSpawnGrantActive.mockClear();
    continuationDeps.assertWorkerContinuationTarget.mockClear();
    overrides.assertDeferredSpawnCurrent('pty-created');
    expect(authorityDeps.assertPendingSpawnGrantActive).toHaveBeenCalledWith('orchspawn-1', sender, 'pty-created');
    expect(continuationDeps.assertWorkerContinuationTarget).toHaveBeenCalledWith(authorityDeps.scope, ref, tuple);
  });

  it('F-1151: a physical account that differs from the original pin refuses the continuation before any spawn', async () => {
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({ ok: true, overrides: { selectedAccountId: 'sealed-account' } });
    continuationDeps.assertWorkerContinuationAccount.mockImplementationOnce(() => {
      throw new Error('resume_authority_changed: a conta selecionada difere da conta original do worker');
    });
    const pending = { ...sealedPendingSpawn(), workerIncarnationId: 'incarnation-new',
      workerContinuation: { sourcePaneId: 'pane-original', attemptId: 'workerresume-1' } };
    authorityDeps.claimPendingSpawnMeta.mockReturnValueOnce(pending);
    authorityDeps.getMission.mockReturnValue(approvedMissionForSpawn());
    authorityDeps.resolveCwdForScope.mockReturnValueOnce('/workspace/a/packages/api');
    const result = await ipcDeps.handlers.get(PTY_CHANNELS.spawn)?.({ sender: { id: 7 } },
      { ...pending.sealedRequest, kind: 'cli-agent', orchRequestId: 'orchspawn-1', cols: 100, rows: 30 });
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/conta selecionada/) });
    expect(ptyDeps.spawnAgentSession).not.toHaveBeenCalled();
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

  it("uses a one-time pending scope bound to the requesting WebContents", async () => {
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({
      ok: true,
      overrides: {},
    });
    const sender = { id: 7 };
    const pending = sealedPendingSpawn();
    authorityDeps.claimPendingSpawnMeta.mockReturnValueOnce(pending);
    authorityDeps.getMission.mockReturnValue(approvedMissionForSpawn());
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

    const result = await handler?.({ sender }, request);

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

  it.each([undefined, "acct-selected"])(
    "gates materialized Codex auth for account %s before spawning and keeps that selection",
    async (accountId) => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-ipc-auth-gate-"));
      gateFixtureDirs.push(home);
      const authFile = path.join(home, "auth.json");
      const order: string[] = [];
      const overrides = { binPath: "/mock/bin/codex", keyEnv: { CODEX_HOME: home } };
      providerDeps.prepareProviderSpawn.mockImplementationOnce(() => {
        // A scrubbed managed home is materialized by preparation, before the gate.
        fs.writeFileSync(authFile, JSON.stringify({ tokens: { access_token: "synthetic-stale" } }));
        order.push("materialize");
        return { ok: true, overrides };
      });
      let release!: () => void;
      authGateDeps.wait.mockImplementationOnce(async (options) => {
        expect(options).toEqual({ authFile });
        expect(fs.existsSync(authFile)).toBe(true);
        order.push("gate");
        await new Promise<void>((resolve) => { release = resolve; });
        return "follower-fresh";
      });
      const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);
      const result = handler?.({ sender: { id: 7 } }, {
        kind: "cli-agent", adapterId: "codex", accountId, cols: 100, rows: 30,
      });
      expect(order).toEqual(["materialize", "gate"]);
      expect(ptyDeps.spawnAgentSession).not.toHaveBeenCalled();
      release();
      await expect(result).resolves.toEqual({ ok: true, sessionId: "pty-created" });
      expect(providerDeps.prepareProviderSpawn).toHaveBeenCalledTimes(1);
      expect(authGateDeps.wait).toHaveBeenCalledTimes(1);
      expect(ptyDeps.spawnAgentSession).toHaveBeenCalledWith(
        expect.anything(), expect.anything(), expect.objectContaining({ id: "codex" }),
        overrides, expect.anything(),
      );
    },
  );

  it("binds an automatically selected account to the physical session and auth lifecycle", async () => {
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({
      ok: true,
      overrides: { binPath: "/mock/bin/codex", selectedAccountId: "acct-main-selected", keyEnv: { CODEX_HOME: "/synthetic/account" } },
    });
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);
    await expect(handler?.({ sender: { id: 7 } }, {
      kind: "cli-agent", adapterId: "codex", cols: 100, rows: 30,
    })).resolves.toMatchObject({ ok: true, accountId: "acct-main-selected" });
    expect(ptyDeps.spawnAgentSession).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ accountId: "acct-main-selected" }),
      expect.anything(), expect.anything(), expect.anything(),
    );
    expect(authGateDeps.track).toHaveBeenCalledWith("pty-created", "codex", "acct-main-selected");
  });

  it("refuses a prepared account that diverges from the explicit Main-sealed pin", async () => {
    const base = sealedPendingSpawn();
    const pending = { ...base, sealedRequest: { ...base.sealedRequest, adapterId: "codex" } };
    authorityDeps.claimPendingSpawnMeta.mockReturnValueOnce(pending);
    authorityDeps.getMission.mockReturnValue(approvedMissionForSpawn());
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({
      ok: true, overrides: { selectedAccountId: "different-account", keyEnv: { CODEX_HOME: "/synthetic/account" } },
    });
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);
    const result = await handler?.({ sender: { id: 7 } }, {
      ...pending.sealedRequest, kind: "cli-agent", orchRequestId: "orchspawn-1", cols: 100, rows: 30,
    });
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/selected account.*pin/i) });
    expect(ptyDeps.spawnAgentSession).not.toHaveBeenCalled();
    expect(authGateDeps.track).not.toHaveBeenCalled();
  });

  it("F-723: liquida no Main, na hora, o grant pendente cujo PTY foi recusado", async () => {
    // Campo 02/10: o Qwen do Maestro morreu no spawn ("modelo selado ... não
    // entrou no argv") e o grant ficou pendurado 30 min — ninguém soube.
    const base = sealedPendingSpawn();
    const pending = { ...base, sealedRequest: { ...base.sealedRequest, adapterId: "codex" } };
    authorityDeps.claimPendingSpawnMeta.mockReturnValueOnce(pending);
    authorityDeps.getMission.mockReturnValue(approvedMissionForSpawn());
    const refusal = 'Qwen Code: modelo selado "qwen3.7-plus" não entrou no argv do spawn';
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({ ok: false, error: refusal });
    const sender = { id: 7 };
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);

    const result = await handler?.({ sender }, {
      ...pending.sealedRequest, kind: "cli-agent", orchRequestId: "orchspawn-1", cols: 100, rows: 30,
    });

    expect(result).toEqual({ ok: false, error: refusal });
    expect(ptyDeps.spawnAgentSession).not.toHaveBeenCalled();
    expect(authorityDeps.reportPendingSpawnStartFailure).toHaveBeenCalledTimes(1);
    expect(authorityDeps.reportPendingSpawnStartFailure).toHaveBeenCalledWith(
      "orchspawn-1",
      sender,
      refusal,
    );
  });

  it("F-723: spawn sem grant pendente reivindicado não liquida grant nenhum", async () => {
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({ ok: false, error: "selected account unavailable" });
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);
    await handler?.({ sender: { id: 7 } }, {
      kind: "cli-agent", adapterId: "codex", orchRequestId: "orchspawn-alheio", cols: 100, rows: 30,
    });
    expect(authorityDeps.reportPendingSpawnStartFailure).not.toHaveBeenCalled();
  });

  it("F-723: grant pendente cujo PTY sobe não é reportado como falha", async () => {
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({ ok: true, overrides: {} });
    authorityDeps.claimPendingSpawnMeta.mockReturnValueOnce(sealedPendingSpawn());
    authorityDeps.getMission.mockReturnValue(approvedMissionForSpawn());
    authorityDeps.resolveCwdForScope.mockReturnValueOnce("/workspace/a/packages/api");
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);
    const result = await handler?.({ sender: { id: 7 } }, {
      ...sealedPendingSpawn().sealedRequest, kind: "cli-agent", orchRequestId: "orchspawn-1", cols: 100, rows: 30,
    });
    expect(result).toEqual({ ok: true, sessionId: "pty-created" });
    expect(authorityDeps.reportPendingSpawnStartFailure).not.toHaveBeenCalled();
  });

  it("does not create a PTY after auth refresh coordination times out", async () => {
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({ ok: true, overrides: { keyEnv: { CODEX_HOME: "/synthetic/account" } } });
    authGateDeps.wait.mockRejectedValueOnce(new Error("Codex auth refresh timed out; retry shortly"));
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);
    await expect(handler?.({ sender: { id: 7 } }, {
      kind: "cli-agent", adapterId: "codex", cols: 100, rows: 30,
    })).resolves.toEqual({ ok: false, error: "Codex auth refresh timed out; retry shortly" });
    expect(ptyDeps.spawnAgentSession).not.toHaveBeenCalled();
  });

  it("does not gate Codex auth when account preparation fails", async () => {
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({ ok: false, error: "selected account unavailable" });
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);
    const result = await handler?.({ sender: { id: 7 } }, {
      kind: "cli-agent", adapterId: "codex", cols: 100, rows: 30,
    });
    expect(result).toEqual({ ok: false, error: "selected account unavailable" });
    expect(authGateDeps.wait).not.toHaveBeenCalled();
    expect(ptyDeps.spawnAgentSession).not.toHaveBeenCalled();
  });

  it("revalidates the pending Main grant after the Codex auth wait", async () => {
    const base = sealedPendingSpawn();
    const pending = { ...base, sealedRequest: { ...base.sealedRequest, adapterId: "codex" } };
    authorityDeps.claimPendingSpawnMeta.mockReturnValueOnce(pending);
    authorityDeps.getMission.mockReturnValue(approvedMissionForSpawn());
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({
      ok: true, overrides: { binPath: "/mock/bin/codex", keyEnv: { CODEX_HOME: "/synthetic/account" } },
    });
    let release!: () => void;
    authGateDeps.wait.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return "follower-fresh";
    });
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);
    const result = handler?.({ sender: { id: 7 } }, {
      ...pending.sealedRequest, kind: "cli-agent", orchRequestId: "orchspawn-1", cols: 100, rows: 30,
    });
    expect(ptyDeps.spawnAgentSession).not.toHaveBeenCalled();
    authorityDeps.assertPendingSpawnGrantActive.mockImplementationOnce(() => {
      throw new Error("pending spawn grant revoked during auth wait");
    });
    release();
    await expect(result).resolves.toEqual({ ok: false, error: "pending spawn grant revoked during auth wait" });
    expect(ptyDeps.spawnAgentSession).not.toHaveBeenCalled();
    expect(providerDeps.prepareProviderSpawn).toHaveBeenCalledTimes(1);
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
    authorityDeps.getMission.mockReturnValue(approvedMissionForSpawn());
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

  it('refuses a Claude pane before PTY creation when authoritative identity differs', async () => {
    providerDeps.prepareProviderSpawnAuthoritative.mockResolvedValueOnce({
      ok: false, error: 'credencial Claude pertence a outra conta',
    });
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);
    await expect(handler?.({ sender: { id: 7 } }, {
      kind: 'cli-agent', adapterId: 'claude', accountId: 'acct-selected',
      cols: 100, rows: 30,
    })).resolves.toEqual({ ok: false, error: 'credencial Claude pertence a outra conta' });
    expect(providerDeps.prepareProviderSpawnAuthoritative).toHaveBeenCalledWith(
      'claude', expect.objectContaining({ accountId: 'acct-selected' }),
    );
    expect(providerDeps.prepareProviderSpawn).not.toHaveBeenCalled();
    expect(ptyDeps.spawnAgentSession).not.toHaveBeenCalled();
  });

  it.each(['authentication', 'permit', 'pane-revoked', 'stop-verdict'])('F-429: refuses persisted spawn if authority changes during %s', async waitingOn => {
    const seal = sealedPendingSpawn().authoritySeal;
    persistedSeal.current = seal;
    authorityDeps.findMissionPaneByPaneId.mockReturnValue({ id: 'spec-429', missionId: 'mission-a', paneId: 'pane-429',
      role: 'orchestrator', adapterId: 'claude', title: 'Maestro', cwd: '/workspace/a',
      scope: authorityDeps.scope, executionScope: authorityDeps.scope, authoritySeal: seal, allowedTools: null, allowedSkills: null });
    authorityDeps.getMission.mockReturnValue(approvedMissionForSpawn());
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const release = vi.fn();
    if (waitingOn === 'authentication') providerDeps.prepareProviderSpawnAuthoritative.mockImplementationOnce(async () => {
      await pending; return { ok: true, overrides: {} };
    });
    else {
      providerDeps.prepareProviderSpawn.mockReturnValue({ ok: true, overrides: {} });
      providerDeps.acquireCliSpawnPermit.mockImplementationOnce(async () => { await pending; return release; });
    }
    const request = ipcDeps.handlers.get(PTY_CHANNELS.spawn)!({ sender: { id: 7 } }, {
      kind: 'cli-agent', adapterId: 'claude', paneId: 'pane-429', missionId: 'mission-a', cwd: '/workspace/a', resume: true, cols: 100, rows: 30,
    });
    const early = await Promise.race([Promise.resolve(request), Promise.resolve(null)]);
    if (early) throw new Error(JSON.stringify(early));
    await vi.waitFor(() => expect(waitingOn === 'authentication' ? providerDeps.prepareProviderSpawnAuthoritative : providerDeps.acquireCliSpawnPermit).toHaveBeenCalled());
    if (waitingOn === 'pane-revoked') authorityDeps.findMissionPaneByPaneId.mockReturnValue(null);
    else if (waitingOn === 'stop-verdict') authorityDeps.getMission.mockReturnValue({ ...approvedMissionForSpawn(),
      description: '<!-- nexus:runtime-closed -->\n[NEXUS_RUNTIME_CLOSED] Encerrada.' });
    else {
      authorityDeps.getMission.mockReturnValue({ ...approvedMissionForSpawn(), status: 'blocked', intentState: 'blocked_user' });
      authorityDeps.assertMissionSpawnAuthorityCurrent.mockImplementation(() => { throw new Error('mission stopped while preparing spawn'); });
    }
    finish();
    await expect(request).resolves.toMatchObject({ ok: false, error: expect.stringContaining(waitingOn === 'pane-revoked' ? 'authority changed' : 'approval_required') });
    expect(ptyDeps.spawnAgentSession).not.toHaveBeenCalled();
    if (waitingOn !== 'authentication') expect(release).toHaveBeenCalledOnce();
  });

  it('waits for a same-CLI update permit and releases it after physical spawn', async () => {
    const release = vi.fn();
    let grant!: (value: () => void) => void;
    providerDeps.acquireCliSpawnPermit.mockImplementationOnce(() =>
      new Promise<() => void>((resolve) => { grant = resolve; }));
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({ ok: true, overrides: {} });
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);
    const result = handler?.({ sender: { id: 7 } }, {
      kind: 'cli-agent', adapterId: 'claude', cols: 100, rows: 30,
    });
    await Promise.resolve();
    expect(ptyDeps.spawnAgentSession).not.toHaveBeenCalled();

    grant(release);
    await expect(result).resolves.toMatchObject({ ok: true, sessionId: 'pty-created' });
    expect(providerDeps.acquireCliSpawnPermit).toHaveBeenCalledWith('claude');
    expect(release).toHaveBeenCalledOnce();
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
    async ({ mode, expected, shouldPrepare }) => {
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
      authorityDeps.getMission.mockReturnValue(approvedMissionForSpawn());
      authorityDeps.resolveCwdForScope.mockReturnValueOnce(
        "/workspace/a/packages/api",
      );
      const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);

      const result = await handler?.(
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

  it("rejects async mission-seal drift at the last main-owned PTY boundary", async () => {
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({
      ok: true,
      overrides: {},
    });
    const pending = sealedPendingSpawn();
    authorityDeps.claimPendingSpawnMeta.mockReturnValueOnce(pending);
    authorityDeps.getMission.mockReturnValue(approvedMissionForSpawn());
    authorityDeps.assertMissionSpawnAuthorityCurrent.mockImplementationOnce(
      () => {
        throw new Error(
          "stale mission pane authority; replane and approve the current revision",
        );
      },
    );
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);

    const result = await handler?.(
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
    authorityDeps.getMission.mockReturnValue(approvedMissionForSpawn());
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
    expect(ptyDeps.orchTerminateSession).toHaveBeenCalledWith("pty-created", {
      origin: "pty-ipc:spawn-settlement",
    });
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
    async ({ squadId, intentFirst }) => {
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
        await handler?.({ sender }, request),
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

  it("allows an approved current mission spawn and rejects a stale intent revision", async () => {
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
    // Cada spawn lê a missão duas vezes: o gate de órfão do renderer
    // (missão alegada existe no escopo?) e o bindMissionLaunchAuthority.
    // 1º spawn: aprovada nas duas leituras; 2º: revisão intent vencida nas
    // duas — a recusa continua sendo a de autoridade de dispatch.
    const staleRevision = { ...approved, intentVersion: 2 };
    authorityDeps.getMission
      .mockReturnValueOnce(approved)
      .mockReturnValueOnce(approved)
      .mockReturnValueOnce(staleRevision)
      .mockReturnValueOnce(staleRevision);
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

    expect(await handler?.({ sender }, request)).toEqual({
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

  describe("F-213 pane spawn timing", () => {
    const timingEvents = () =>
      traceDeps.trace.mock.calls
        .map(([event]) => event as Record<string, unknown>)
        .filter((event) => event.kind === "pane-spawn-timing");

    it('preserves the license code across the spawn IPC response', async () => {
      providerDeps.prepareProviderSpawn.mockReturnValueOnce({ ok: true, overrides: {} });
      ptyDeps.spawnAgentSession.mockImplementationOnce(() => { throw new LicenseError('license_agent_limit', undefined, 2); });
      const result = await ipcDeps.handlers.get(PTY_CHANNELS.spawn)?.({ sender: { id: 7 } }, { kind: 'cli-agent', adapterId: 'claude', paneId: 'license-pane', cols: 80, rows: 24 });
      expect(result).toMatchObject({ ok: false, code: 'license_agent_limit', error: expect.stringContaining('2 agentes') });
    });

    it("emite pane-spawn-timing com fases e o rendererWaitMs do pedido", async () => {
      providerDeps.prepareProviderSpawn.mockReturnValueOnce({
        ok: true,
        overrides: {},
      });
      const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);
      const result = await handler?.(
        { sender: { id: 7 } },
        {
          kind: "cli-agent",
          adapterId: "claude",
          paneId: "pane-timed",
          cols: 100,
          rows: 30,
          rendererWaitMs: 42,
        },
      );
      expect(result).toMatchObject({ ok: true });
      expect(timingEvents()).toEqual([
        expect.objectContaining({
          source: "renderer",
          adapterId: "claude",
          paneId: "pane-timed",
          rendererWaitMs: 42,
          totalMs: expect.any(Number),
        }),
      ]);
      const phases = timingEvents()[0].phases as Record<string, number>;
      expect(phases).toHaveProperty("provider-prep");
      expect(phases).toHaveProperty("cli-spawn-permit");
      expect(phases).toHaveProperty("pty-spawn");
    });

    it("emite pane-spawn-timing também quando o spawn falha", async () => {
      providerDeps.prepareProviderSpawn.mockReturnValueOnce({
        ok: false,
        error: "no account",
      });
      const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);
      const result = await handler?.(
        { sender: { id: 7 } },
        {
          kind: "cli-agent",
          adapterId: "claude",
          cols: 100,
          rows: 30,
        },
      );
      expect(result).toMatchObject({ ok: false });
      expect(timingEvents()).toEqual([
        expect.objectContaining({
          source: "renderer",
          adapterId: "claude",
          ok: false,
          totalMs: expect.any(Number),
        }),
      ]);
    });

    // F-213 R6: rendererWaitMs é telemetria — um pane restaurado retido mais
    // de 10 min (ou qualquer valor estranho) NUNCA pode reprovar o spawn.
    it.each([
      { sent: 700_000, expected: 600_000 },
      { sent: 1.5, expected: 2 },
      { sent: Number.POSITIVE_INFINITY, expected: null },
      { sent: "lento", expected: null },
      { sent: -1, expected: null },
    ])(
      "rendererWaitMs $sent é clampado/ignorado e o spawn segue ($expected)",
      async ({ sent, expected }) => {
        providerDeps.prepareProviderSpawn.mockReturnValueOnce({
          ok: true,
          overrides: {},
        });
        const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);
        const result = await handler?.(
          { sender: { id: 7 } },
          {
            kind: "cli-agent",
            adapterId: "claude",
            paneId: "pane-timed",
            cols: 100,
            rows: 30,
            rendererWaitMs: sent,
          },
        );
        expect(result).toMatchObject({ ok: true });
        expect(timingEvents()).toEqual([
          expect.objectContaining({
            source: "renderer",
            adapterId: "claude",
            rendererWaitMs: expected,
            ok: true,
          }),
        ]);
      },
    );
  });
});

describe("F-216 — resize com assert", () => {
  beforeEach(() => {
    ipcDeps.handlers.clear();
    ptyDeps.resizeSession.mockClear();
    registerPtyIpc();
  });

  it("aceita assert booleano e repassa para resizeSession", () => {
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.resize)!;
    handler(
      { sender: { id: 1 } },
      { sessionId: "s1", cols: 80, rows: 24, assert: true },
    );
    expect(ptyDeps.resizeSession).toHaveBeenCalledExactlyOnceWith(
      { id: 1 },
      "s1",
      80,
      24,
      { assert: true },
    );
  });

  it("sem assert chama resizeSession sem a flag", () => {
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.resize)!;
    handler(
      { sender: { id: 1 } },
      { sessionId: "s1", cols: 80, rows: 24 },
    );
    expect(ptyDeps.resizeSession).toHaveBeenCalledExactlyOnceWith(
      { id: 1 },
      "s1",
      80,
      24,
      { assert: undefined },
    );
  });

  it.each([["yes"], [1], [{}], [null]])(
    "rejeita assert não-booleano (%j)",
    (bad) => {
      const handler = ipcDeps.handlers.get(PTY_CHANNELS.resize)!;
      handler(
        { sender: { id: 1 } },
        { sessionId: "s1", cols: 80, rows: 24, assert: bad },
      );
      expect(ptyDeps.resizeSession).not.toHaveBeenCalled();
    },
  );

  it("schema estrito rejeita chaves desconhecidas", () => {
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.resize)!;
    handler(
      { sender: { id: 1 } },
      { sessionId: "s1", cols: 80, rows: 24, origin: "renderer" },
    );
    expect(ptyDeps.resizeSession).not.toHaveBeenCalled();
  });
});
