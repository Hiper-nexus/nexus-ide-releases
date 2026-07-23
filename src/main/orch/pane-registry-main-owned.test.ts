import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import type { WebContents } from "electron";
import { testProjectScope } from "./__tests__/scope-fixture";
import {
  bindResolvedRendererWorkspaceScope,
  clearRendererWorkspaceScope,
} from "../persistence/renderer-workspace-scope";

const rootRealPath = fs.realpathSync(process.cwd());
const scope = testProjectScope({ rootRealPath });

const pty = vi.hoisted(() => ({
  paneId: "",
  kill: vi.fn(() => true),
  terminate: vi.fn(async () => true),
  spawn: vi.fn((req: { paneId?: string }) => {
    pty.paneId = req.paneId ?? "";
    return { sessionId: "pty-headless-1" };
  }),
}));
const omp = vi.hoisted(() => ({
  isSession: vi.fn((sessionId: string) => sessionId === "omp-mission-1"),
  detach: vi.fn(() => true),
  list: vi.fn((): unknown[] => []),
  owned: vi.fn(() => false),
  terminate: vi.fn(async () => true),
}));

vi.mock("../pty/pty-manager", () => ({
  spawnMainOwnedAgentSession: pty.spawn,
  orchKillSession: pty.kill,
  orchTerminateSession: pty.terminate,
  getSessionState: vi.fn(() => "spawning"),
  detachOwnedMissionAgentSession: vi.fn(() => true),
  getOwnedAgentSessionInfo: vi.fn(() => null),
  listAgentSessionsForPane: vi.fn(() => []),
  getAgentSessionInfo: vi.fn((sessionId: string) =>
    sessionId === "pty-headless-1" || sessionId === "pty-claimed"
      ? {
          sessionId,
          paneId:
            sessionId === "pty-claimed" ? "pane-renderer-created" : pty.paneId,
          adapterId: "codex",
          cwd: rootRealPath,
          scope,
          source: "pending",
          role: "worker",
          missionId: "mission-headless",
          agentName: "Worker Headless",
          workerIncarnationId: "worker-incarnation-main",
          readOnly: false,
          allowedTools: [],
          allowedSkills: null,
        }
      : null,
  ),
  isSessionOwnedBy: vi.fn(
    (_owner: WebContents, sessionId: string) =>
      sessionId === "omp-mission-1",
  ),
  tapSessionData: vi.fn(() => () => {}),
  tapSessionExit: vi.fn(() => () => {}),
  tapSessionState: vi.fn(() => () => {}),
}));

vi.mock("../adapters/omp-rpc-ipc", () => ({
  detachOmpRpcMissionPane: omp.detach,
  isOmpRpcPaneOwnedBy: omp.owned,
  isOmpRpcSession: omp.isSession,
  listOmpRpcSessions: omp.list,
  terminateOmpRpcSession: omp.terminate,
}));

vi.mock("../adapters/adapter-registry", () => ({
  getAdapter: vi.fn(() => ({
    kind: "cli-pty",
    id: "codex",
    label: "Codex",
    install: { command: "npm install -g codex" },
  })),
  isAdapterInstalled: vi.fn(() => true),
}));

vi.mock("../persistence/provider-config-store", () => ({
  prepareProviderSpawn: vi.fn(() => ({ ok: true, overrides: {} })),
}));

import {
  attachOrchMeta,
  getPaneRuntimeAuthorityBySession,
  bindPendingSpawnSession,
  claimPendingSpawnMeta,
  listPaneSnapshots,
  registerOrchRenderer,
  requestMissionPaneRecovery,
  requestPaneClose,
  requestPaneSpawn,
  resolveMissionPaneRecovery,
  resolvePaneSpawn,
  syncPanes,
  unregisterOrchRenderer,
} from "./pane-registry";

describe("main-owned mission pane spawn", () => {
  it("creates the physical worker and registry authority without a renderer", async () => {
    const result = await requestPaneSpawn({
      adapterId: "codex",
      model: "gpt-5.6-sol",
      cwd: scope.rootRealPath,
      missionId: "mission-headless",
      agentName: "Worker Headless",
      workerIncarnationId: "worker-incarnation-main",
      role: "worker",
      allowedTools: [],
      allowedSkills: null,
      scope,
    });

    expect(result).toEqual({
      requestId: expect.stringMatching(/^orchspawn-/),
      ok: true,
      paneId: expect.stringMatching(/^pane-/),
      sessionId: "pty-headless-1",
    });
    expect(pty.spawn).toHaveBeenCalledOnce();
    expect(listPaneSnapshots()).toContainEqual(
      expect.objectContaining({
        paneId: pty.paneId,
        sessionId: "pty-headless-1",
        missionId: "mission-headless",
        role: "worker",
        scope,
      }),
    );
    expect(getPaneRuntimeAuthorityBySession("pty-headless-1")).toMatchObject({
      owner: null,
      paneId: pty.paneId,
      missionId: "mission-headless",
      role: "worker",
      scope,
    });
    await expect(requestPaneClose(pty.paneId)).resolves.toBe(true);
    expect(pty.terminate).toHaveBeenCalledWith("pty-headless-1");
    expect(getPaneRuntimeAuthorityBySession("pty-headless-1")).toBeNull();
  });

  it("continues an unclaimed mission spawn in main when its renderer closes", async () => {
    const owner = {
      id: 909,
      isDestroyed: () => false,
      isCrashed: () => false,
      send: vi.fn(),
    } as unknown as WebContents & { send: ReturnType<typeof vi.fn> };
    bindResolvedRendererWorkspaceScope(owner, scope);
    registerOrchRenderer(owner);
    const resultPromise = requestPaneSpawn({
      adapterId: "codex",
      missionId: "mission-headless",
      agentName: "Worker Headless",
      workerIncarnationId: "worker-incarnation-main",
      role: "worker",
      scope,
    });
    expect(owner.send).toHaveBeenCalledOnce();

    unregisterOrchRenderer(owner);

    await expect(resultPromise).resolves.toMatchObject({
      ok: true,
      paneId: expect.stringMatching(/^pane-/),
      sessionId: "pty-headless-1",
    });
    clearRendererWorkspaceScope(owner);
    await requestPaneClose(pty.paneId);
  });

  it("retains an already-created claimed PTY when the renderer dies before ACK", async () => {
    const owner = {
      id: 910,
      isDestroyed: () => false,
      isCrashed: () => false,
      send: vi.fn(),
    } as unknown as WebContents & { send: ReturnType<typeof vi.fn> };
    bindResolvedRendererWorkspaceScope(owner, scope);
    registerOrchRenderer(owner);
    const resultPromise = requestPaneSpawn({
      adapterId: "codex",
      missionId: "mission-headless",
      agentName: "Worker Headless",
      workerIncarnationId: "worker-incarnation-main",
      role: "worker",
      scope,
    });
    const requestId = (
      owner.send.mock.calls[0]?.[1] as { requestId: string }
    ).requestId;
    expect(claimPendingSpawnMeta(requestId, owner)).not.toBeNull();
    expect(bindPendingSpawnSession(requestId, owner, "pty-claimed")).toBe(true);

    unregisterOrchRenderer(owner);

    await expect(resultPromise).resolves.toEqual({
      requestId,
      ok: true,
      paneId: "pane-renderer-created",
      sessionId: "pty-claimed",
    });
    expect(getPaneRuntimeAuthorityBySession("pty-claimed")).toMatchObject({
      owner: null,
      paneId: "pane-renderer-created",
      sessionId: "pty-claimed",
      missionId: "mission-headless",
    });
    clearRendererWorkspaceScope(owner);
    await requestPaneClose("pane-renderer-created");
  });

  it("retains a bound PTY headless when the renderer reports spawn failure", async () => {
    const owner = {
      id: 913,
      isDestroyed: () => false,
      isCrashed: () => false,
      send: vi.fn(),
    } as unknown as WebContents & { send: ReturnType<typeof vi.fn> };
    bindResolvedRendererWorkspaceScope(owner, scope);
    registerOrchRenderer(owner);
    const resultPromise = requestPaneSpawn({
      adapterId: "codex",
      missionId: "mission-headless",
      agentName: "Worker Headless",
      workerIncarnationId: "worker-incarnation-main",
      role: "worker",
      scope,
    });
    const requestId = (
      owner.send.mock.calls[0]?.[1] as { requestId: string }
    ).requestId;
    expect(claimPendingSpawnMeta(requestId, owner)).not.toBeNull();
    expect(bindPendingSpawnSession(requestId, owner, "pty-claimed")).toBe(true);

    expect(
      resolvePaneSpawn(
        { requestId, ok: false, error: "renderer layout failed" },
        owner,
      ),
    ).toBe(true);

    await expect(resultPromise).resolves.toEqual({
      requestId,
      ok: true,
      paneId: "pane-renderer-created",
      sessionId: "pty-claimed",
    });
    expect(getPaneRuntimeAuthorityBySession("pty-claimed")).toMatchObject({
      owner: null,
      missionId: "mission-headless",
    });
    clearRendererWorkspaceScope(owner);
    await requestPaneClose("pane-renderer-created");
  });

  it("retains a bound PTY headless when the renderer ACK times out", async () => {
    vi.useFakeTimers();
    const owner = {
      id: 914,
      isDestroyed: () => false,
      isCrashed: () => false,
      send: vi.fn(),
    } as unknown as WebContents & { send: ReturnType<typeof vi.fn> };
    bindResolvedRendererWorkspaceScope(owner, scope);
    registerOrchRenderer(owner);
    const resultPromise = requestPaneSpawn({
      adapterId: "codex",
      missionId: "mission-headless",
      agentName: "Worker Headless",
      workerIncarnationId: "worker-incarnation-main",
      role: "worker",
      scope,
    });
    const requestId = (
      owner.send.mock.calls[0]?.[1] as { requestId: string }
    ).requestId;
    expect(claimPendingSpawnMeta(requestId, owner)).not.toBeNull();
    expect(bindPendingSpawnSession(requestId, owner, "pty-claimed")).toBe(true);

    await vi.advanceTimersByTimeAsync(90_000);
    await expect(resultPromise).resolves.toEqual({
      requestId,
      ok: true,
      paneId: "pane-renderer-created",
      sessionId: "pty-claimed",
    });
    expect(getPaneRuntimeAuthorityBySession("pty-claimed")).toMatchObject({
      owner: null,
      missionId: "mission-headless",
    });
    vi.useRealTimers();
    clearRendererWorkspaceScope(owner);
    await requestPaneClose("pane-renderer-created");
  });

  it("does not retain a claimed PTY from a different worker incarnation", async () => {
    const owner = {
      id: 911,
      isDestroyed: () => false,
      isCrashed: () => false,
      send: vi.fn(),
    } as unknown as WebContents & { send: ReturnType<typeof vi.fn> };
    bindResolvedRendererWorkspaceScope(owner, scope);
    registerOrchRenderer(owner);
    const resultPromise = requestPaneSpawn({
      adapterId: "codex",
      missionId: "mission-headless",
      agentName: "Worker Headless",
      workerIncarnationId: "worker-incarnation-other",
      role: "worker",
      scope,
    });
    const requestId = (
      owner.send.mock.calls[0]?.[1] as { requestId: string }
    ).requestId;
    expect(claimPendingSpawnMeta(requestId, owner)).not.toBeNull();
    expect(bindPendingSpawnSession(requestId, owner, "pty-claimed")).toBe(true);

    unregisterOrchRenderer(owner);

    await expect(resultPromise).resolves.toEqual({
      requestId,
      ok: false,
      error: "renderer window closed during spawn",
    });
    expect(getPaneRuntimeAuthorityBySession("pty-claimed")).toBeNull();
    clearRendererWorkspaceScope(owner);
  });

  it("never treats a renderer-reported recovery session as kill authority", async () => {
    pty.terminate.mockClear();
    const owner = {
      id: 915,
      isDestroyed: () => false,
      isCrashed: () => false,
      send: vi.fn(),
    } as unknown as WebContents & { send: ReturnType<typeof vi.fn> };
    bindResolvedRendererWorkspaceScope(owner, scope);
    syncPanes(
      [{
        paneId: "pane-recovery-unbound",
        sessionId: null,
        title: "Worker",
        kind: "cli-agent",
        state: "exited",
      }],
      owner,
    );
    attachOrchMeta(owner, "pane-recovery-unbound", {
      missionId: "mission-headless",
      role: "worker",
      scope,
    });
    const resultPromise = requestMissionPaneRecovery({
      missionId: "mission-headless",
      paneId: "pane-recovery-unbound",
      role: "worker",
      pane: {
        id: "spec-recovery-unbound",
        missionId: "mission-headless",
        paneId: "pane-recovery-unbound",
        adapterId: "codex",
        title: "Worker",
        role: "worker",
        scope,
        createdAt: 1,
      },
      scope,
      recap: "Continue.",
    });
    const requestId = (
      owner.send.mock.calls[0]?.[1] as { requestId: string }
    ).requestId;

    expect(
      resolveMissionPaneRecovery(
        {
          requestId,
          ok: false,
          paneId: "pane-recovery-unbound",
          sessionId: "pty-claimed",
          error: "renderer reported failure",
        },
        owner,
      ),
    ).toBe(true);
    await expect(resultPromise).resolves.toMatchObject({
      ok: false,
      paneId: "pane-recovery-unbound",
    });
    expect(pty.terminate).not.toHaveBeenCalledWith("pty-claimed");
    syncPanes([], owner);
    clearRendererWorkspaceScope(owner);
  });

  it("keeps an OMP mission pane visible until physical child exit is proven", async () => {
    let proveExit: ((value: boolean) => void) | undefined;
    omp.terminate.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          proveExit = resolve;
        }),
    );
    const owner = {
      id: 912,
      isDestroyed: () => false,
      isCrashed: () => false,
      send: vi.fn(),
    } as unknown as WebContents & { send: ReturnType<typeof vi.fn> };
    bindResolvedRendererWorkspaceScope(owner, scope);
    registerOrchRenderer(owner);
    syncPanes(
      [
        {
          paneId: "pane-omp-mission",
          sessionId: "omp-mission-1",
          title: "OMP worker",
          kind: "cli-agent",
          adapterId: "omp",
          state: "busy",
        },
      ],
      owner,
    );

    const closing = requestPaneClose("pane-omp-mission");
    await Promise.resolve();
    expect(omp.terminate).toHaveBeenCalledWith("omp-mission-1");
    expect(owner.send).not.toHaveBeenCalledWith(
      expect.anything(),
      "pane-omp-mission",
    );

    proveExit?.(true);
    await expect(closing).resolves.toBe(true);
    expect(owner.send).toHaveBeenCalledWith(
      expect.anything(),
      "pane-omp-mission",
    );
    unregisterOrchRenderer(owner);
    clearRendererWorkspaceScope(owner);
  });
});
