import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { WebContents } from "electron";
import { testProjectScope } from "./__tests__/scope-fixture";
import {
  bindResolvedRendererWorkspaceScope,
  clearRendererWorkspaceScope,
} from "../persistence/renderer-workspace-scope";

const rootRealPath = fs.realpathSync(process.cwd());
const scope = testProjectScope({ rootRealPath });
const executionScope = {
  ...scope,
  checkoutId: "checkout-worker",
  rootRealPath: fs.realpathSync(path.join(rootRealPath, "src")),
};
const missionAuthority = vi.hoisted(() => {
  const seal = {
    intentVersion: 1,
    intentContractHash: "intent-contract-hash",
    contextRevision: "context-revision-a",
    contractHash: "contract-hash",
    squadRevisionHash: "squad-revision-hash",
  };
  return {
    seal,
    currentSeal: seal,
  };
});

const pty = vi.hoisted(() => ({
  paneId: "",
  authority: null as unknown,
  claimedAuthoritySeal: missionAuthority.seal as unknown,
  live: new Set<string>(),
  kill: vi.fn(() => true),
  terminate: vi.fn(async (sessionId: string) => {
    pty.live.delete(sessionId);
    return true;
  }),
  spawn: vi.fn((
    req: { paneId?: string },
    _adapter: unknown,
    _overrides: unknown,
    authority: unknown,
  ) => {
    pty.paneId = req.paneId ?? "";
    pty.authority = authority;
    pty.live.add("pty-headless-1");
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
const provider = vi.hoisted(() => ({
  prepare: vi.fn(() => ({
    ok: true as const,
    overrides: { binPath: "/mock/bin/codex" },
  })),
}));
const binaryTrust = vi.hoisted(() => ({
  rejectedBinPath: null as string | null,
}));

vi.mock("../pty/pty-manager", () => ({
  spawnMainOwnedAgentSession: pty.spawn,
  orchKillSession: pty.kill,
  orchTerminateSession: pty.terminate,
  getSessionState: vi.fn((sessionId: string) =>
    pty.live.has(sessionId) ? "spawning" : null,
  ),
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
          authoritySeal:
            sessionId === "pty-claimed"
              ? pty.claimedAuthoritySeal
              : missionAuthority.seal,
        }
      : null,
  ),
  isSessionOwnedBy: vi.fn(
    (_owner: WebContents, sessionId: string) =>
      sessionId === "omp-mission-1" || pty.live.has(sessionId),
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
  getAdapter: vi.fn((id: string) =>
    id === "codex"
      ? {
          kind: "cli-pty",
          id: "codex",
          label: "Codex",
          bin: "codex",
          install: { command: "npm install -g codex" },
          spawn: { interactive: ["codex"], extraArgs: [] },
          quirks: { mcpAutoload: false, nexusMcp: "codex" },
          env: { passthrough: [], ephemeralHome: false },
          control: {
            permission: {
              arg: "--ask-for-approval",
              modes: { auto: "never", default: "on-request" },
              safe: [
                "--sandbox",
                "workspace-write",
                "--ask-for-approval",
                "on-request",
              ],
              yolo: ["--dangerously-bypass-approvals-and-sandbox"],
              default: "",
            },
          },
        }
      : {
          kind: "cli-pty",
          id,
          label: id,
          bin: id,
          install: { command: `install ${id}` },
          spawn: { interactive: [id], extraArgs: [] },
          quirks: { mcpAutoload: false, nexusMcp: id },
          env: { passthrough: [], ephemeralHome: false },
          control: {},
        },
  ),
  isAdapterInstalled: vi.fn(() => true),
  isBuiltinAdapter: vi.fn((id: string) => id === "codex"),
  resolveAdapterBinary: vi.fn((id: string) => `/mock/bin/${id}`),
}));

vi.mock("../persistence/provider-config-store", () => ({
  prepareProviderSpawn: provider.prepare,
}));

vi.mock("../pty/trusted-native-cli-binary", () => ({
  assertTrustedNativeConfinementBinary: vi.fn(
    ({ requestedBinPath }: { requestedBinPath: string }) => {
      if (requestedBinPath === binaryTrust.rejectedBinPath) {
        throw new Error(
          "executable override diverges from canonical discovery",
        );
      }
      // Real Codex qualification returns the vendor Mach-O, not the npm wrapper.
      // Main-owned must keep the discovery path in overrides (pty re-qualifies).
      return `${requestedBinPath}-native`;
    },
  ),
}));

vi.mock("./project-domain-store-registry", () => ({
  getProjectDomainStores: vi.fn(() => ({
    missions: {
      get: vi.fn(() => ({
        id: "mission-headless",
        squadId: "squad-headless",
      })),
    },
  })),
}));

vi.mock("./squad-store", () => ({
  listSquads: vi.fn(() => [{ id: "squad-headless" }]),
}));

vi.mock("./mission-pane-authority", () => ({
  resolveMissionPaneAuthoritySeal: vi.fn(() => missionAuthority.currentSeal),
  sameMissionPaneAuthoritySeal: (left: unknown, right: unknown) =>
    JSON.stringify(left) === JSON.stringify(right),
}));

import {
  attachOrchMeta,
  getPaneRuntimeAuthorityBySession,
  bindPendingSpawnSession,
  claimPendingSpawnMeta,
  listPaneSnapshots,
  registerOrchRenderer,
  requestMissionPaneRecovery,
  requestMissionWorkerPaneRetirement,
  requestPaneClose,
  requestPaneSpawn,
  resolvePaneSpawn,
  syncPanes,
  unregisterOrchRenderer,
} from "./pane-registry";

describe("main-owned mission pane spawn", () => {
  beforeEach(() => {
    pty.authority = null;
    pty.claimedAuthoritySeal = missionAuthority.seal;
    pty.live.clear();
    pty.spawn.mockClear();
    pty.terminate.mockReset();
    pty.terminate.mockImplementation(async (sessionId: string) => {
      pty.live.delete(sessionId);
      return true;
    });
    provider.prepare.mockClear();
    provider.prepare.mockReturnValue({
      ok: true,
      overrides: { binPath: "/mock/bin/codex" },
    });
    binaryTrust.rejectedBinPath = null;
    missionAuthority.currentSeal = missionAuthority.seal;
  });

  it("creates the physical worker and registry authority without a renderer", async () => {
    const result = await requestPaneSpawn({
      adapterId: "codex",
      model: "gpt-5.6-sol",
      cwd: executionScope.rootRealPath,
      missionId: "mission-headless",
      agentName: "Worker Headless",
      workerIncarnationId: "worker-incarnation-main",
      role: "worker",
      allowedTools: [],
      allowedSkills: null,
      scope,
      executionScope,
    });

    expect(result).toEqual({
      requestId: expect.stringMatching(/^orchspawn-/),
      ok: true,
      paneId: expect.stringMatching(/^pane-/),
      sessionId: "pty-headless-1",
    });
    expect(pty.spawn).toHaveBeenCalledOnce();
    // Discovery path stays in overrides — sealed native path is not fed back
    // as requestedBinPath (that would diverge from canonical discovery).
    expect(pty.spawn.mock.calls[0]?.[2]).toMatchObject({
      binPath: "/mock/bin/codex",
    });
    expect(pty.authority).toMatchObject({
      context: expect.objectContaining({
        contextRevision: missionAuthority.seal.contextRevision,
        authoritySeal: missionAuthority.seal,
      }),
    });
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
      executionScope,
    });
    await expect(requestPaneClose(pty.paneId)).resolves.toBe(true);
    expect(pty.terminate).toHaveBeenCalledWith("pty-headless-1");
    expect(getPaneRuntimeAuthorityBySession("pty-headless-1")).toBeNull();
  });

  it("retires only the exact worker incarnation and makes replay inert", async () => {
    const result = await requestPaneSpawn({
      adapterId: "codex",
      missionId: "mission-headless",
      agentName: "Worker Headless",
      workerIncarnationId: "worker-incarnation-main",
      role: "worker",
      scope,
      executionScope,
    });
    expect(result.ok).toBe(true);

    await expect(
      requestMissionWorkerPaneRetirement({
        paneId: result.paneId!,
        sessionId: result.sessionId!,
        missionId: "mission-headless",
        workerIncarnationId: "worker-incarnation-stale",
        scope,
      }),
    ).resolves.toBe(false);
    expect(pty.terminate).not.toHaveBeenCalled();
    expect(getPaneRuntimeAuthorityBySession(result.sessionId!)).not.toBeNull();

    const exact = {
      paneId: result.paneId!,
      sessionId: result.sessionId!,
      missionId: "mission-headless",
      workerIncarnationId: "worker-incarnation-main",
      scope,
    };
    await expect(
      requestMissionWorkerPaneRetirement(exact),
    ).resolves.toBe(true);
    await expect(
      requestMissionWorkerPaneRetirement(exact),
    ).resolves.toBe(true);
    expect(pty.terminate).toHaveBeenCalledTimes(1);
  });

  it("keeps the exact worker registered when physical close fails", async () => {
    const result = await requestPaneSpawn({
      adapterId: "codex",
      missionId: "mission-headless",
      agentName: "Worker Headless",
      workerIncarnationId: "worker-incarnation-main",
      role: "worker",
      scope,
      executionScope,
    });
    pty.terminate.mockResolvedValueOnce(false);

    await expect(
      requestMissionWorkerPaneRetirement({
        paneId: result.paneId!,
        sessionId: result.sessionId!,
        missionId: "mission-headless",
        workerIncarnationId: "worker-incarnation-main",
        scope,
      }),
    ).resolves.toBe(false);
    expect(getPaneRuntimeAuthorityBySession(result.sessionId!)).toMatchObject({
      paneId: result.paneId,
      workerIncarnationId: "worker-incarnation-main",
    });

    await expect(
      requestMissionWorkerPaneRetirement({
        paneId: result.paneId!,
        sessionId: result.sessionId!,
        missionId: "mission-headless",
        workerIncarnationId: "worker-incarnation-main",
        scope,
      }),
    ).resolves.toBe(true);
  });

  it("collapses the one exact renderer leaf after natural physical exit", async () => {
    const owner = {
      id: 920,
      isDestroyed: () => false,
      isCrashed: () => false,
      send: vi.fn(),
    } as unknown as WebContents & { send: ReturnType<typeof vi.fn> };
    bindResolvedRendererWorkspaceScope(owner, scope);
    syncPanes(
      [{
        paneId: "pane-natural-exit",
        sessionId: null,
        title: "Exited worker",
        kind: "cli-agent",
        state: "exited",
      }],
      owner,
    );
    attachOrchMeta(owner, "pane-natural-exit", {
      missionId: "mission-headless",
      role: "worker",
      workerIncarnationId: "worker-incarnation-natural",
      scope,
      executionScope,
    });
    owner.send.mockClear();

    await expect(
      requestMissionWorkerPaneRetirement({
        paneId: "pane-natural-exit",
        sessionId: "pty-natural-exit",
        missionId: "mission-headless",
        workerIncarnationId: "worker-incarnation-natural",
        scope,
      }),
    ).resolves.toBe(true);

    expect(pty.terminate).not.toHaveBeenCalled();
    expect(owner.send).toHaveBeenCalledOnce();
    expect(owner.send).toHaveBeenCalledWith(
      expect.anything(),
      "pane-natural-exit",
    );
    syncPanes([], owner);
    clearRendererWorkspaceScope(owner);
  });

  it("never collapses a replacement session or duplicate renderer identity", async () => {
    const replacementOwner = {
      id: 921,
      isDestroyed: () => false,
      isCrashed: () => false,
      send: vi.fn(),
    } as unknown as WebContents & { send: ReturnType<typeof vi.fn> };
    bindResolvedRendererWorkspaceScope(replacementOwner, scope);
    pty.live.add("pty-replacement");
    syncPanes(
      [{
        paneId: "pane-reused",
        sessionId: "pty-replacement",
        title: "Replacement worker",
        kind: "cli-agent",
        state: "busy",
      }],
      replacementOwner,
    );
    attachOrchMeta(replacementOwner, "pane-reused", {
      missionId: "mission-headless",
      role: "worker",
      workerIncarnationId: "worker-incarnation-natural",
      scope,
      executionScope,
    });
    replacementOwner.send.mockClear();

    await expect(
      requestMissionWorkerPaneRetirement({
        paneId: "pane-reused",
        sessionId: "pty-natural-exit",
        missionId: "mission-headless",
        workerIncarnationId: "worker-incarnation-natural",
        scope,
      }),
    ).resolves.toBe(false);
    expect(replacementOwner.send).not.toHaveBeenCalled();
    expect(pty.terminate).not.toHaveBeenCalled();

    const duplicateA = {
      id: 922,
      isDestroyed: () => false,
      isCrashed: () => false,
      send: vi.fn(),
    } as unknown as WebContents & { send: ReturnType<typeof vi.fn> };
    const duplicateB = {
      id: 923,
      isDestroyed: () => false,
      isCrashed: () => false,
      send: vi.fn(),
    } as unknown as WebContents & { send: ReturnType<typeof vi.fn> };
    for (const owner of [duplicateA, duplicateB]) {
      bindResolvedRendererWorkspaceScope(owner, scope);
      syncPanes(
        [{
          paneId: "pane-duplicate",
          sessionId: null,
          title: "Duplicate worker",
          kind: "cli-agent",
          state: "exited",
        }],
        owner,
      );
      attachOrchMeta(owner, "pane-duplicate", {
        missionId: "mission-headless",
        role: "worker",
        workerIncarnationId: "worker-incarnation-duplicate",
        scope,
        executionScope,
      });
      owner.send.mockClear();
    }

    await expect(
      requestMissionWorkerPaneRetirement({
        paneId: "pane-duplicate",
        sessionId: "pty-duplicate-exit",
        missionId: "mission-headless",
        workerIncarnationId: "worker-incarnation-duplicate",
        scope,
      }),
    ).resolves.toBe(false);
    expect(duplicateA.send).not.toHaveBeenCalled();
    expect(duplicateB.send).not.toHaveBeenCalled();

    syncPanes([], replacementOwner);
    syncPanes([], duplicateA);
    syncPanes([], duplicateB);
    pty.live.delete("pty-replacement");
    clearRendererWorkspaceScope(replacementOwner);
    clearRendererWorkspaceScope(duplicateA);
    clearRendererWorkspaceScope(duplicateB);
  });

  it("keeps stale, cross-scope, main-owned and OMP identities fail-closed", async () => {
    const foreignScope = testProjectScope({
      projectId: "project-foreign",
      checkoutId: "checkout-foreign",
      rootRealPath: executionScope.rootRealPath,
    });
    const cases = [
      {
        id: 924,
        paneId: "pane-stale-incarnation",
        ownerScope: scope,
        meta: {
          missionId: "mission-headless",
          role: "worker" as const,
          workerIncarnationId: "worker-incarnation-stale",
          scope,
        },
      },
      {
        id: 925,
        paneId: "pane-main-role",
        ownerScope: scope,
        meta: {
          missionId: "mission-headless",
          role: "orchestrator" as const,
          workerIncarnationId: "worker-incarnation-natural",
          scope,
        },
      },
      {
        id: 926,
        paneId: "pane-foreign-scope",
        ownerScope: foreignScope,
        meta: {
          missionId: "mission-headless",
          role: "worker" as const,
          workerIncarnationId: "worker-incarnation-natural",
          scope: foreignScope,
        },
      },
    ];
    const owners: Array<
      WebContents & { send: ReturnType<typeof vi.fn> }
    > = [];
    for (const candidate of cases) {
      const owner = {
        id: candidate.id,
        isDestroyed: () => false,
        isCrashed: () => false,
        send: vi.fn(),
      } as unknown as WebContents & { send: ReturnType<typeof vi.fn> };
      owners.push(owner);
      bindResolvedRendererWorkspaceScope(owner, candidate.ownerScope);
      syncPanes(
        [{
          paneId: candidate.paneId,
          sessionId: null,
          title: "Stale worker identity",
          kind: "cli-agent",
          state: "exited",
        }],
        owner,
      );
      attachOrchMeta(owner, candidate.paneId, candidate.meta);
      owner.send.mockClear();
      await expect(
        requestMissionWorkerPaneRetirement({
          paneId: candidate.paneId,
          sessionId: `pty-${candidate.paneId}`,
          missionId: "mission-headless",
          workerIncarnationId: "worker-incarnation-natural",
          scope,
        }),
      ).resolves.toBe(false);
      expect(owner.send).not.toHaveBeenCalled();
    }
    for (const owner of owners) {
      syncPanes([], owner);
      clearRendererWorkspaceScope(owner);
    }

    const mainOwned = await requestPaneSpawn({
      adapterId: "codex",
      missionId: "mission-headless",
      agentName: "Replacement Main Worker",
      workerIncarnationId: "worker-incarnation-main",
      role: "worker",
      scope,
      executionScope,
    });
    await expect(
      requestMissionWorkerPaneRetirement({
        paneId: mainOwned.paneId!,
        sessionId: "pty-retired-before-main-replacement",
        missionId: "mission-headless",
        workerIncarnationId: "worker-incarnation-main",
        scope,
      }),
    ).resolves.toBe(false);
    expect(pty.terminate).not.toHaveBeenCalled();

    await expect(
      requestMissionWorkerPaneRetirement({
        paneId: "pane-omp-natural-exit",
        sessionId: "omp-mission-1",
        missionId: "mission-headless",
        workerIncarnationId: "worker-incarnation-omp",
        scope,
      }),
    ).resolves.toBe(false);
    expect(omp.terminate).not.toHaveBeenCalled();

    await expect(requestPaneClose(mainOwned.paneId!)).resolves.toBe(true);
  });

  it("rejects missing and same-root worker execution scopes before provider preparation", async () => {
    for (const candidateExecutionScope of [undefined, scope]) {
      const result = await requestPaneSpawn({
        adapterId: "codex",
        missionId: "mission-headless",
        role: "worker",
        scope,
        executionScope: candidateExecutionScope,
      });
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringMatching(/physically distinct/i),
      });
    }

    expect(provider.prepare).not.toHaveBeenCalled();
    expect(pty.spawn).not.toHaveBeenCalled();
  });

  it("rejects OMP as a revision-bound writable worker before provider preparation", async () => {
    const result = await requestPaneSpawn({
      adapterId: "omp",
      missionId: "mission-headless",
      role: "worker",
      scope,
      executionScope,
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/workspace-write authority/i),
    });
    expect(provider.prepare).not.toHaveBeenCalled();
    expect(pty.spawn).not.toHaveBeenCalled();
  });

  it("rejects a provider executable override before the PTY spawn", async () => {
    binaryTrust.rejectedBinPath = "/mock/bin/codex-override";
    provider.prepare.mockReturnValueOnce({
      ok: true,
      overrides: { binPath: "/mock/bin/codex-override" },
    });

    const result = await requestPaneSpawn({
      adapterId: "codex",
      missionId: "mission-headless",
      role: "worker",
      scope,
      executionScope,
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/diverges from canonical discovery/i),
    });
    expect(provider.prepare).toHaveBeenCalledOnce();
    expect(pty.spawn).not.toHaveBeenCalled();
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
      executionScope,
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

  it("rejects authority drift that occurs while an unclaimed renderer spawn is pending", async () => {
    const owner = {
      id: 917,
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
    missionAuthority.currentSeal = {
      ...missionAuthority.seal,
      contractHash: "drifted-contract-hash",
    };

    unregisterOrchRenderer(owner);

    await expect(resultPromise).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/stale mission pane authority/i),
    });
    expect(pty.spawn).not.toHaveBeenCalled();
    clearRendererWorkspaceScope(owner);
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

  it("does not adopt a renderer PTY whose complete authority seal drifted", async () => {
    const owner = {
      id: 916,
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
    pty.claimedAuthoritySeal = {
      ...missionAuthority.seal,
      contractHash: "drifted-contract-hash",
    };

    unregisterOrchRenderer(owner);

    await expect(resultPromise).resolves.toEqual({
      requestId,
      ok: false,
      error: "renderer window closed during spawn",
    });
    expect(getPaneRuntimeAuthorityBySession("pty-claimed")).toBeNull();
    clearRendererWorkspaceScope(owner);
  });

  it("never delegates worker recovery or kill authority to the renderer", async () => {
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
    owner.send.mockClear();
    const result = await requestMissionPaneRecovery({
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
    expect(result).toMatchObject({
      requestId: "",
      ok: false,
      paneId: "pane-recovery-unbound",
      error: expect.stringMatching(/dispatch-owned/u),
    });
    expect(owner.send).not.toHaveBeenCalled();
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
