import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import type {
  BrowserPaneOpenRequest,
  OrchPaneSpawnRequest,
} from "../../shared/orch-types";
import type { MissionPaneRecoveryRequest } from "../../shared/orch-types";
import { ORCH_CHANNELS } from "../../shared/orch-channels";
import {
  bindResolvedRendererWorkspaceScope,
  clearRendererWorkspaceScope,
} from "../persistence/renderer-workspace-scope";
import { testProjectScope } from "./__tests__/scope-fixture";
import * as ptyManager from "../pty/pty-manager";
import * as providerSessionStore from "../persistence/provider-session-store";
import * as mainOwnedPaneRuntime from "./main-owned-pane-runtime";
import type { CallerCtx } from "./pane-authz";
import {
  attachOrchMeta,
  assertPendingRecoverySpawnGrantActive,
  bindPendingRecoverySpawnSession,
  claimPendingRecoverySpawnMeta,
  bindPendingSpawnSession,
  claimPendingSpawnMeta,
  claimPendingSpawnMetaByPane,
  findPane,
  findPaneOwnedBy,
  getOwnedPaneAuthzInfo,
  getPaneAuthzInfoOwnedBy,
  getPaneAuthzInfoOwnedByPane,
  isAgentRequestedBrowser,
  registerOrchRenderer,
  requestBrowserPane,
  requestMissionPaneClose,
  requestPaneClose,
  requestPaneSpawn,
  requestMissionPaneRecovery,
  resolveBrowserOpen,
  resolveMissionPaneRecovery,
  resolvePaneSpawn,
  syncPanes,
  unregisterOrchRenderer,
} from "./pane-registry";

const missionAuthority = vi.hoisted(() => ({
  seal: {
    intentVersion: 1,
    intentContractHash: "intent-contract-hash",
    contextRevision: "context-revision-a",
    contractHash: "contract-hash",
    squadRevisionHash: "squad-revision-hash",
  },
}));

// This suite exercises renderer ownership and the pending-spawn token. The
// Main-held identity boundary is covered by pane-registry-main-owned and the
// identity suites; keep this fixture's agent issuance successful so a missing
// renderer handoff cannot be mistaken for an identity failure.
const identity = vi.hoisted(() => ({
  issue: vi.fn(),
}));

vi.mock("./project-domain-store-registry", () => ({
  getProjectDomainStores: vi.fn(() => ({
    missions: {
      get: vi.fn((missionId: string) => ({
        id: missionId,
        squadId: "squad-a",
      })),
    },
  })),
}));

vi.mock("./squad-store", () => ({
  getSquad: vi.fn((squadId: string) =>
    squadId === "squad-a" ? { id: "squad-a", agents: [] } : null,
  ),
  listSquads: vi.fn(() => [{ id: "squad-a" }]),
}));

vi.mock("./mission-pane-authority", () => ({
  resolveMissionPaneAuthoritySeal: vi.fn(() => missionAuthority.seal),
  sameMissionPaneAuthoritySeal: (left: unknown, right: unknown) =>
    JSON.stringify(left) === JSON.stringify(right),
}));

vi.mock("./agent-identity-spawn", () => ({
  issueAgentIdentityBestEffort: identity.issue,
  issueAgentIdentityRequired: identity.issue,
}));

let rendererId = 100;
function renderer(): WebContents & { send: ReturnType<typeof vi.fn> } {
  return {
    id: rendererId++,
    isDestroyed: () => false,
    isCrashed: () => false,
    send: vi.fn(),
  } as unknown as WebContents & { send: ReturnType<typeof vi.fn> };
}

let registered: WebContents | null = null;
const scopedRenderers = new Set<WebContents>();

function bindScope(owner: WebContents, scope = testProjectScope()): void {
  bindResolvedRendererWorkspaceScope(owner, scope);
  scopedRenderers.add(owner);
}

function bindLiveBrowserWorker(owner: ReturnType<typeof renderer>, scope: CallerCtx["scope"]): CallerCtx {
  const sessionId = "browser-worker-session";
  const paneId = "browser-worker-pane";
  const caller: CallerCtx = { sessionId, missionId: "mission-browser", role: "worker", scope };
  // Browser opens derive their owner from the live Main session, rather than
  // whichever renderer registered last. Mirror the exact PTY ownership proof.
  vi.spyOn(ptyManager, "isSessionOwnedBy").mockImplementation(
    (candidate, id) => candidate.id === owner.id && id === sessionId,
  );
  vi.spyOn(ptyManager, "getSessionState").mockImplementation(
    (id) => id === sessionId ? "idle" : null,
  );
  syncPanes([{ paneId, sessionId, kind: "cli-agent", title: "Browser worker" }], owner);
  attachOrchMeta(owner, paneId, { missionId: caller.missionId, role: "worker", scope });
  owner.send.mockClear();
  return caller;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (registered) unregisterOrchRenderer(registered);
  for (const owner of scopedRenderers) {
    unregisterOrchRenderer(owner);
    clearRendererWorkspaceScope(owner);
  }
  scopedRenderers.clear();
  registered = null;
});

describe("pending pane spawn authority", () => {
  it.each(["unbound", "other-project", "closed"])(
    "opens helpers in the live workspace after a %s window registered last",
    async (lastWindow) => {
      const owner = renderer();
      const unrelated = renderer();
      const scope = testProjectScope();
      bindScope(owner, scope);
      registerOrchRenderer(owner);
      syncPanes([], owner);
      registered = unrelated;
      registerOrchRenderer(unrelated);
      if (lastWindow === "other-project") {
        bindScope(unrelated, testProjectScope({ projectId: "project-other" }));
      }
      if (lastWindow === "closed") unregisterOrchRenderer(unrelated);

      const pending = requestPaneSpawn({ adapterId: "codex", scope });
      const request = owner.send.mock.calls[0]?.[1] as OrchPaneSpawnRequest;
      expect(request).toMatchObject({ adapterId: "codex", cwd: scope.rootRealPath });
      expect(unrelated.send).not.toHaveBeenCalled();
      expect(claimPendingSpawnMeta(request.requestId, owner)?.scope).toEqual(scope);
      resolvePaneSpawn({ requestId: request.requestId, ok: false, error: "test cleanup" }, owner);
      await pending;
    },
  );

  it("opens browser panes in the workspace grid after an auxiliary window registered", async () => {
    const owner = renderer();
    const auxiliary = renderer();
    const scope = testProjectScope();
    bindScope(owner, scope);
    registerOrchRenderer(owner);
    syncPanes([], owner);
    registered = auxiliary;
    registerOrchRenderer(auxiliary);

    const pending = requestBrowserPane({ scope, url: "https://example.com" });
    const request = owner.send.mock.calls[0]?.[1] as BrowserPaneOpenRequest;
    expect(request).toMatchObject({ url: "https://example.com" });
    expect(auxiliary.send).not.toHaveBeenCalled();
    resolveBrowserOpen({ requestId: request.requestId, ok: false, error: "test cleanup" }, owner);
    await pending;
  });

  it("keeps operator helpers in their parent's window when two grids share a workspace", async () => {
    const owner = renderer();
    const sibling = renderer();
    const scope = testProjectScope();
    bindScope(owner, scope);
    bindScope(sibling, scope);
    registerOrchRenderer(owner);
    vi.spyOn(ptyManager, "isSessionOwnedBy").mockImplementation(
      (candidate, sessionId) => candidate.id === owner.id && sessionId === "operator-parent",
    );
    syncPanes([{ paneId: "operator-pane", sessionId: "operator-parent", kind: "cli-agent", title: "Operator" }], owner);
    registered = sibling;
    registerOrchRenderer(sibling);
    syncPanes([], sibling);

    const pending = requestPaneSpawn({ adapterId: "claude", scope, operatorParentSessionId: "operator-parent" });
    const request = owner.send.mock.calls[0]?.[1] as OrchPaneSpawnRequest;
    expect(request).toMatchObject({ parentPaneId: "operator-pane" });
    expect(sibling.send).not.toHaveBeenCalled();
    resolvePaneSpawn({ requestId: request.requestId, ok: false, error: "test cleanup" }, owner);
    await pending;
  });

  it("does not use a mirrored grid after it changes workspace", async () => {
    const owner = renderer();
    const auxiliary = renderer();
    const scope = testProjectScope();
    bindScope(owner, scope);
    registerOrchRenderer(owner);
    syncPanes([], owner);
    bindScope(owner, testProjectScope({ projectId: "project-other" }));
    registered = auxiliary;
    registerOrchRenderer(auxiliary);

    await expect(requestPaneSpawn({ adapterId: "codex", scope })).resolves.toMatchObject({ ok: false });
    expect(owner.send).not.toHaveBeenCalledWith(ORCH_CHANNELS.paneSpawnRequest, expect.anything());
    expect(auxiliary.send).not.toHaveBeenCalled();
  });

  it.each(["switched", "crashed", "missing"])(
    "does not redirect an operator helper to another grid when its parent is %s",
    async (parentState) => {
      const owner = renderer();
      const sibling = renderer();
      const scope = testProjectScope();
      bindScope(owner, scope);
      bindScope(sibling, scope);
      registerOrchRenderer(owner);
      vi.spyOn(ptyManager, "isSessionOwnedBy").mockImplementation(
        (candidate, sessionId) => candidate.id === owner.id && sessionId === "operator-parent",
      );
      syncPanes([{ paneId: "operator-pane", sessionId: "operator-parent", kind: "cli-agent", title: "Operator" }], owner);
      if (parentState === "switched") {
        bindScope(owner, testProjectScope({ projectId: "project-other" }));
      } else if (parentState === "crashed") {
        vi.spyOn(owner, "isCrashed").mockReturnValue(true);
      } else {
        syncPanes([], owner);
      }
      registered = sibling;
      registerOrchRenderer(sibling);
      syncPanes([], sibling);

      await expect(requestPaneSpawn({ adapterId: "codex", scope, operatorParentSessionId: "operator-parent" }))
        .resolves.toMatchObject({ ok: false });
      expect(owner.send).not.toHaveBeenCalledWith(ORCH_CHANNELS.paneSpawnRequest, expect.anything());
      expect(sibling.send).not.toHaveBeenCalled();
    },
  );

  it("retains the operator spawner in Main metadata, outside the renderer request", async () => {
    const owner = renderer();
    registered = owner;
    registerOrchRenderer(owner);
    const scope = testProjectScope();
    bindScope(owner, scope);
    vi.spyOn(ptyManager, "isSessionOwnedBy").mockImplementation(
      (candidate, sessionId) => candidate.id === owner.id && sessionId === "operator-parent",
    );
    syncPanes([{ paneId: "operator-pane", sessionId: "operator-parent", kind: "cli-agent", title: "Operator" }], owner);
    const pending = requestPaneSpawn({
      adapterId: "codex", scope, operatorParentSessionId: "operator-parent",
    });
    const request = owner.send.mock.calls[0]?.[1] as OrchPaneSpawnRequest;
    expect(request).not.toHaveProperty("operatorParentSessionId");
    expect(claimPendingSpawnMeta(request.requestId, owner)).toMatchObject({
      operatorParentSessionId: "operator-parent",
    });
    resolvePaneSpawn({ requestId: request.requestId, ok: false, error: "test cleanup" }, owner);
    await expect(pending).resolves.toMatchObject({ ok: false });
  });

  it("carries the isolated-writer mark of an operator helper into Main metadata", async () => {
    const owner = renderer();
    registered = owner;
    registerOrchRenderer(owner);
    const scope = testProjectScope();
    bindScope(owner, scope);
    vi.spyOn(ptyManager, "isSessionOwnedBy").mockImplementation(
      (candidate, sessionId) => candidate.id === owner.id && sessionId === "operator-parent",
    );
    syncPanes([{ paneId: "operator-pane", sessionId: "operator-parent", kind: "cli-agent", title: "Operator" }], owner);
    const pending = requestPaneSpawn({
      adapterId: "codex", scope, operatorParentSessionId: "operator-parent", isolatedWriter: true,
    });
    const request = owner.send.mock.calls[0]?.[1] as OrchPaneSpawnRequest;
    expect(request).not.toHaveProperty("isolatedWriter");
    expect(claimPendingSpawnMeta(request.requestId, owner)).toMatchObject({ isolatedWriter: true });
    resolvePaneSpawn({ requestId: request.requestId, ok: false, error: "test cleanup" }, owner);
    await expect(pending).resolves.toMatchObject({ ok: false });
  });

  it("closes the main-minted browser pane when its acknowledgement arrives after timeout", async () => {
    vi.useFakeTimers();
    const owner = renderer();
    registered = owner;
    registerOrchRenderer(owner);
    const scope = testProjectScope();
    bindScope(owner, scope);
    const caller = bindLiveBrowserWorker(owner, scope);

    const pending = requestBrowserPane({
      url: "https://example.com",
      missionId: "mission-browser",
      role: "worker",
      scope,
      caller,
    });
    const request = owner.send.mock.calls[0]?.[1] as BrowserPaneOpenRequest;
    expect(request.paneId).toMatch(/^browser-/);
    expect(isAgentRequestedBrowser(owner, request.paneId)).toBe(true);
    expect(isAgentRequestedBrowser(renderer(), request.paneId)).toBe(false);

    await vi.advanceTimersByTimeAsync(30 * 60_000 + 1_000);
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: "browser open timed out",
    });
    expect(isAgentRequestedBrowser(owner, request.paneId)).toBe(false);

    expect(resolveBrowserOpen({
      requestId: request.requestId,
      ok: true,
      paneId: "renderer-controlled-id",
    }, owner)).toBe(true);
    expect(owner.send).toHaveBeenLastCalledWith(
      ORCH_CHANNELS.paneCloseRequest,
      { requestId: request.requestId, paneId: request.paneId },
    );
  });

  it("uses a request-sealed cleanup when browser creation reports failure", async () => {
    const owner = renderer();
    registered = owner;
    registerOrchRenderer(owner);
    const scope = testProjectScope();
    bindScope(owner, scope);
    const caller = bindLiveBrowserWorker(owner, scope);

    const pending = requestBrowserPane({
      url: "https://example.com/failure",
      missionId: "mission-browser",
      role: "worker",
      scope,
      caller,
    });
    const request = owner.send.mock.calls[0]?.[1] as BrowserPaneOpenRequest;
    expect(
      resolveBrowserOpen(
        { requestId: request.requestId, ok: false, error: "renderer failed" },
        owner,
      ),
    ).toBe(true);

    await expect(pending).resolves.toMatchObject({ ok: false });
    expect(owner.send).toHaveBeenLastCalledWith(
      ORCH_CHANNELS.paneCloseRequest,
      { requestId: request.requestId, paneId: request.paneId },
    );
  });

  it("never closes a homonymous mission pane from another checkout", async () => {
    const owner = renderer();
    registered = owner;
    registerOrchRenderer(owner);
    const localScope = testProjectScope({
      projectId: "project-local",
      checkoutId: "checkout-local",
      rootRealPath: "/workspace/local",
    });
    const foreignScope = testProjectScope({
      projectId: "project-foreign",
      checkoutId: "checkout-foreign",
      rootRealPath: "/workspace/foreign",
    });
    bindScope(owner, foreignScope);
    syncPanes(
      [
        {
          paneId: "pane-shared",
          sessionId: null,
          title: "Foreign worker",
          kind: "cli-agent",
        },
      ],
      owner,
    );
    attachOrchMeta(owner, "pane-shared", {
      missionId: "mission-shared",
      role: "worker",
      scope: foreignScope,
    });
    owner.send.mockClear();

    await expect(
      requestMissionPaneClose({
        paneId: "pane-shared",
        missionId: "mission-shared",
        scope: localScope,
      }),
    ).resolves.toBe(false);
    expect(owner.send).not.toHaveBeenCalledWith(
      ORCH_CHANNELS.paneCloseRequest,
      expect.anything(),
    );
  });

  it("routes a worker spawn back to the renderer that owns its mission", async () => {
    const missionOwner = renderer();
    const unrelatedOwner = renderer();
    bindScope(missionOwner);
    syncPanes(
      [{ paneId: "mission-orch", sessionId: null, title: "Orch", kind: "cli-agent" }],
      missionOwner,
    );
    attachOrchMeta(missionOwner, "mission-orch", {
      missionId: "mission-a",
      role: "orchestrator",
      scope: testProjectScope(),
    });
    registered = unrelatedOwner;
    registerOrchRenderer(unrelatedOwner);

    const resultPromise = requestPaneSpawn({
      adapterId: "codex",
      missionId: "mission-a",
      role: "worker",
      scope: testProjectScope(),
    });
    expect(missionOwner.send).toHaveBeenCalledOnce();
    expect(unrelatedOwner.send).not.toHaveBeenCalled();
    const request = missionOwner.send.mock.calls[0]?.[1] as OrchPaneSpawnRequest;
    resolvePaneSpawn(
      { requestId: request.requestId, ok: false, error: "test cleanup" },
      missionOwner,
    );
    await expect(resultPromise).resolves.toMatchObject({ ok: false });
    syncPanes([], missionOwner);
  });

  it("requests sealed renderer cleanup before resolving a failed pane spawn", async () => {
    const owner = renderer();
    registered = owner;
    registerOrchRenderer(owner);
    const scope = testProjectScope();
    bindScope(owner, scope);
    const resultPromise = requestPaneSpawn({
      adapterId: "codex",
      scope,
    });
    const request = owner.send.mock.calls[0]?.[1] as OrchPaneSpawnRequest;

    expect(resolvePaneSpawn({
      requestId: request.requestId,
      ok: false,
      error: "renderer failed",
    }, owner)).toBe(true);

    await expect(resultPromise).resolves.toMatchObject({
      ok: false,
      error: "renderer failed",
    });
    expect(owner.send).toHaveBeenLastCalledWith(
      ORCH_CHANNELS.paneCloseRequest,
      { requestId: request.requestId, paneId: request.paneId },
    );
  });

  it("still resolves an unclaimed failure when renderer cleanup send throws", async () => {
    const owner = renderer();
    registered = owner;
    registerOrchRenderer(owner);
    const scope = testProjectScope();
    bindScope(owner, scope);
    const resultPromise = requestPaneSpawn({
      adapterId: "codex",
      scope,
    });
    const request = owner.send.mock.calls[0]?.[1] as OrchPaneSpawnRequest;
    owner.send.mockImplementation(() => {
      throw new Error("WebContents was destroyed");
    });

    expect(resolvePaneSpawn({
      requestId: request.requestId,
      ok: false,
      error: "renderer failed",
    }, owner)).toBe(true);

    await expect(resultPromise).resolves.toEqual({
      requestId: request.requestId,
      ok: false,
      error: "renderer failed",
    });
  });

  it("requests sealed cleanup when an unclaimed pane spawn times out", async () => {
    vi.useFakeTimers();
    const owner = renderer();
    registered = owner;
    registerOrchRenderer(owner);
    const scope = testProjectScope();
    bindScope(owner, scope);
    const resultPromise = requestPaneSpawn({
      adapterId: "codex",
      scope,
    });
    const request = owner.send.mock.calls[0]?.[1] as OrchPaneSpawnRequest;

    await vi.advanceTimersByTimeAsync(30 * 60_000 + 1_000);

    await expect(resultPromise).resolves.toMatchObject({
      ok: false,
      error: "pane spawn timed out",
    });
    expect(owner.send).toHaveBeenLastCalledWith(
      ORCH_CHANNELS.paneCloseRequest,
      { requestId: request.requestId, paneId: request.paneId },
    );
  });

  it("F-721: conversa copiada na retomada exige resume exato e não cai no spawn headless", async () => {
    vi.useFakeTimers();
    const copy = vi
      .spyOn(providerSessionStore, "copyProviderPaneSession")
      .mockReturnValue(true);
    const headless = vi.spyOn(mainOwnedPaneRuntime, "fallbackPendingSpawnToMain");
    const owner = renderer();
    registered = owner;
    registerOrchRenderer(owner);
    const scope = testProjectScope();
    bindScope(owner, scope);
    const options = {
      adapterId: "claude",
      accountId: "acct-a",
      missionId: "mission-a",
      role: "orchestrator" as const,
      agentName: "Orquestrador",
      contextRevision: missionAuthority.seal.contextRevision,
      authoritySeal: missionAuthority.seal,
      resume: true,
      resumeFromPaneId: "pane-antigo",
      scope,
    };

    const claimedResult = requestPaneSpawn(options);
    const request = owner.send.mock.calls[0]?.[1] as OrchPaneSpawnRequest;
    expect(copy).toHaveBeenCalledWith(
      scope, "pane-antigo", request.paneId, "claude", "acct-a", undefined,
    );
    expect(request.resume).toBe(true);
    expect(claimPendingSpawnMeta(request.requestId, owner)).toMatchObject({
      exactResumeRequired: true,
    });
    resolvePaneSpawn({ requestId: request.requestId, ok: false, error: "test cleanup" }, owner);
    await claimedResult;

    // O renderer nunca respondeu: o spawn headless abriria conversa nova.
    const unclaimed = requestPaneSpawn(options);
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 1_000);
    await expect(unclaimed).resolves.toMatchObject({
      ok: false,
      error: "pane spawn timed out",
    });
    expect(headless).not.toHaveBeenCalled();
  });

  it("aborts idempotently and requests sealed cleanup exactly once", async () => {
    const owner = renderer();
    registered = owner;
    registerOrchRenderer(owner);
    const scope = testProjectScope();
    bindScope(owner, scope);
    const abort = new AbortController();
    const resultPromise = requestPaneSpawn({
      adapterId: "codex",
      scope,
      abortSignal: abort.signal,
    });
    const request = owner.send.mock.calls[0]?.[1] as OrchPaneSpawnRequest;

    abort.abort("review superseded");
    abort.abort("duplicate abort");

    await expect(resultPromise).resolves.toMatchObject({
      ok: false,
      error: "review superseded",
    });
    expect(owner.send.mock.calls.filter(([channel, payload]) =>
      channel === ORCH_CHANNELS.paneCloseRequest &&
      (payload as { requestId?: string }).requestId === request.requestId
    )).toHaveLength(1);
    expect(resolvePaneSpawn({
      requestId: request.requestId,
      ok: false,
      error: "late renderer failure",
    }, owner)).toBe(false);
  });

  it("fails closed instead of falling back to a renderer from another workspace", async () => {
    const ownerB = renderer();
    const scopeA = testProjectScope({ projectId: "project-a" });
    const scopeB = testProjectScope({ projectId: "project-b" });
    registered = ownerB;
    registerOrchRenderer(ownerB);
    bindScope(ownerB, scopeB);

    await expect(requestPaneSpawn({
      adapterId: "codex",
      missionId: "mission-a",
      scope: scopeA,
    })).resolves.toMatchObject({
      ok: false,
      error: "no renderer window available",
    });
    expect(ownerB.send).not.toHaveBeenCalled();
  });

  it("keeps pane registrations isolated per renderer and fails closed on ambiguous ids", () => {
    const ownerA = renderer();
    const ownerB = renderer();
    syncPanes(
      [
        {
          paneId: "shared-pane",
          sessionId: null,
          title: "A",
          kind: "cli-agent",
        },
      ],
      ownerA,
    );
    syncPanes(
      [
        {
          paneId: "shared-pane",
          sessionId: null,
          title: "B",
          kind: "cli-agent",
        },
      ],
      ownerB,
    );

    expect(findPaneOwnedBy(ownerA, "shared-pane")?.title).toBe("A");
    expect(findPaneOwnedBy(ownerB, "shared-pane")?.title).toBe("B");
    expect(findPane("shared-pane")).toBeNull();
    expect(getOwnedPaneAuthzInfo("shared-pane")).toBeNull();
    expect(getPaneAuthzInfoOwnedBy(ownerA, "shared-pane")).toMatchObject({
      paneId: "shared-pane",
      kind: "cli-agent",
    });
    expect(getPaneAuthzInfoOwnedBy(ownerB, "shared-pane")).toMatchObject({
      paneId: "shared-pane",
      kind: "cli-agent",
    });
    expect(Object.isFrozen(getPaneAuthzInfoOwnedBy(ownerA, "shared-pane"))).toBe(
      true,
    );
    expect(getPaneAuthzInfoOwnedByPane(ownerA, "shared-pane")?.paneId).toBe(
      "shared-pane",
    );

    syncPanes([], ownerA);
    syncPanes([], ownerB);
  });

  it("returns immutable main-side ownership only for an unambiguous pane", () => {
    const owner = renderer();
    syncPanes(
      [
        {
          paneId: "owned-pane",
          sessionId: null,
          title: "Owned",
          kind: "cli-agent",
        },
      ],
      owner,
    );

    const authority = getOwnedPaneAuthzInfo("owned-pane");

    expect(authority).toMatchObject({
      owner,
      paneId: "owned-pane",
      sessionId: null,
      kind: "cli-agent",
    });
    expect(Object.isFrozen(authority)).toBe(true);

    syncPanes([], owner);
  });

  it("is claimable once and only by the renderer WebContents that received it", async () => {
    const owner = renderer();
    const attacker = renderer();
    registered = owner;
    registerOrchRenderer(owner);
    const scope = testProjectScope();
    bindScope(owner, scope);
    const initialPrompt = "main-owned AGY brief";
    const resultPromise = requestPaneSpawn({
      adapterId: "codex",
      initialPrompt,
      missionId: "mission-a",
      agentName: "worker-a",
      role: "worker",
      contextRevision: missionAuthority.seal.contextRevision,
      authoritySeal: missionAuthority.seal,
      allowedTools: [],
      scope,
    });
    const request = owner.send.mock.calls[0]?.[1] as OrchPaneSpawnRequest;

    expect(request).not.toHaveProperty("initialPrompt");
    expect(claimPendingSpawnMeta(request.requestId, attacker)).toBeNull();
    const claimed = claimPendingSpawnMeta(request.requestId, owner);
    expect(claimed).toMatchObject({
      initialPrompt,
      missionId: "mission-a",
      agentName: "worker-a",
      role: "worker",
      allowedTools: [],
      allowedSkills: undefined,
      scope,
      requestedCwd: scope.rootRealPath,
      executionScope: undefined,
      readOnly: false,
      sealedRequest: {
        requestId: request.requestId,
        paneId: request.paneId,
        adapterId: "codex",
        cwd: scope.rootRealPath,
        missionId: "mission-a",
        agentName: "worker-a",
        role: "worker",
        resume: false,
        resumeLatestOnly: false,
        restorePersistedAuthority: false,
      },
    });
    expect(Object.isFrozen(claimed?.sealedRequest)).toBe(true);
    expect(Object.isFrozen(claimed?.authoritySeal)).toBe(true);
    expect(claimPendingSpawnMeta(request.requestId, owner)).toBeNull();

    resolvePaneSpawn(
      { requestId: request.requestId, ok: false, error: "test cleanup" },
      owner,
    );
    await expect(resultPromise).resolves.toMatchObject({ ok: false });
  });

  it("recovers a lost presentation token only for the exact owner, pane, and mission", async () => {
    const owner = renderer();
    const attacker = renderer();
    registered = owner;
    registerOrchRenderer(owner);
    const scope = testProjectScope();
    bindScope(owner, scope);
    const resultPromise = requestPaneSpawn({
      adapterId: "codex",
      missionId: "mission-a",
      agentName: "worker-a",
      role: "worker",
      contextRevision: missionAuthority.seal.contextRevision,
      authoritySeal: missionAuthority.seal,
      scope,
    });
    const request = owner.send.mock.calls[0]?.[1] as OrchPaneSpawnRequest;

    expect(
      claimPendingSpawnMetaByPane(
        {
          paneId: request.paneId,
          missionId: "mission-a",
        },
        attacker,
      ),
    ).toBeNull();
    expect(
      claimPendingSpawnMetaByPane(
        {
          paneId: request.paneId,
          missionId: "mission-forged",
        },
        owner,
      ),
    ).toBeNull();

    const claimed = claimPendingSpawnMetaByPane(
      {
        paneId: request.paneId,
        missionId: "mission-a",
      },
      owner,
    );

    expect(claimed?.sealedRequest).toMatchObject({
      requestId: request.requestId,
      paneId: request.paneId,
      missionId: "mission-a",
      role: "worker",
    });
    expect(claimPendingSpawnMeta(request.requestId, owner)).toBeNull();

    resolvePaneSpawn(
      { requestId: request.requestId, ok: false, error: "test cleanup" },
      owner,
    );
    await expect(resultPromise).resolves.toMatchObject({ ok: false });
  });

  it("replays an unclaimed spawn when the renderer syncs after a remount", async () => {
    vi.useFakeTimers();
    const owner = renderer();
    registered = owner;
    registerOrchRenderer(owner);
    bindScope(owner);
    const resultPromise = requestPaneSpawn({
      adapterId: "codex",
      missionId: "mission-replay",
      scope: testProjectScope(),
    });
    const request = owner.send.mock.calls[0]?.[1] as OrchPaneSpawnRequest;
    vi.advanceTimersByTime(600);
    syncPanes([], owner);
    expect(owner.send).toHaveBeenCalledTimes(2);
    expect(owner.send.mock.calls[1]?.[1]).toEqual(request);
    resolvePaneSpawn(
      { requestId: request.requestId, ok: false, error: "test cleanup" },
      owner,
    );
    await expect(resultPromise).resolves.toMatchObject({ ok: false });
    vi.useRealTimers();
  });

  it("ignores a forged completion from another renderer", async () => {
    const owner = renderer();
    const attacker = renderer();
    registered = owner;
    registerOrchRenderer(owner);
    bindScope(owner);
    const resultPromise = requestPaneSpawn({
      adapterId: "codex",
      scope: testProjectScope(),
    });
    const request = owner.send.mock.calls[0]?.[1] as OrchPaneSpawnRequest;

    expect(
      resolvePaneSpawn(
        { requestId: request.requestId, ok: true, paneId: "forged-pane" },
        attacker,
      ),
    ).toBe(false);
    expect(
      resolvePaneSpawn(
        { requestId: request.requestId, ok: false, error: "owner cleanup" },
        owner,
      ),
    ).toBe(true);
    await expect(resultPromise).resolves.toMatchObject({
      ok: false,
      error: "owner cleanup",
    });
  });

  it("accepts success only for the exact PTY session bound after the claim", async () => {
    const owner = renderer();
    registered = owner;
    registerOrchRenderer(owner);
    bindScope(owner);
    const resultPromise = requestPaneSpawn({
      adapterId: "codex",
      scope: testProjectScope(),
    });
    const request = owner.send.mock.calls[0]?.[1] as OrchPaneSpawnRequest;

    expect(
      resolvePaneSpawn(
        {
          requestId: request.requestId,
          ok: true,
          paneId: request.paneId,
          sessionId: "pty-a",
        },
        owner,
      ),
    ).toBe(false);
    expect(claimPendingSpawnMeta(request.requestId, owner)).not.toBeNull();
    expect(bindPendingSpawnSession(request.requestId, owner, "pty-a")).toBe(
      true,
    );
    expect(
      bindPendingSpawnSession(request.requestId, owner, "pty-replay"),
    ).toBe(false);
    expect(
      resolvePaneSpawn(
        {
          requestId: request.requestId,
          ok: true,
          paneId: request.paneId,
          sessionId: "pty-forged",
        },
        owner,
      ),
    ).toBe(false);
    expect(
      resolvePaneSpawn(
        {
          requestId: request.requestId,
          ok: true,
          paneId: request.paneId,
          sessionId: "pty-a",
        },
        owner,
      ),
    ).toBe(true);
    await expect(resultPromise).resolves.toMatchObject({
      ok: true,
      paneId: request.paneId,
      sessionId: "pty-a",
    });
  });

  it("refuses worker recovery because the dispatch lifecycle owns it", async () => {
    const owner = renderer();
    const scope = testProjectScope();
    bindScope(owner, scope);
    syncPanes(
      [{
        paneId: "pane-dead", sessionId: null, title: "Worker",
        kind: "cli-agent", state: "exited",
      }],
      owner,
    );
    attachOrchMeta(owner, "pane-dead", {
      missionId: "mission-a",
      role: "worker",
      scope,
    });
    owner.send.mockClear();
    const result = await requestMissionPaneRecovery({
      missionId: "mission-a",
      paneId: "pane-dead",
      role: "worker",
      pane: {
        id: "spec-worker",
        missionId: "mission-a",
        paneId: "pane-dead",
        adapterId: "claude",
        title: "Worker",
        role: "worker",
        scope,
        createdAt: 1,
      },
      scope,
      recap: "Continue the worker task.",
    });
    expect(result).toEqual({
      requestId: "",
      ok: false,
      paneId: "pane-dead",
      error:
        "worker pane recovery is dispatch-owned; resume or replan the blocked task",
    });
    expect(owner.send).not.toHaveBeenCalled();
    syncPanes([], owner);
  });

  it("routes a completely missing persisted pane to the live renderer in the same scope", async () => {
    const owner = renderer();
    const scope = testProjectScope();
    registered = owner;
    registerOrchRenderer(owner);
    bindScope(owner, scope);
    const promise = requestMissionPaneRecovery({
      missionId: "mission-missing",
      paneId: "pane-missing",
      role: "orchestrator",
      expectedSessionId: "old-session",
      pane: {
        id: "spec-orch",
        missionId: "mission-missing",
        paneId: "pane-missing",
        adapterId: "codex",
        title: "Orchestrator",
        role: "orchestrator",
        scope,
        createdAt: 1,
      },
      scope,
      recap: "Continue the mission.",
    });
    await Promise.resolve();
    const request = owner.send.mock.calls[0]?.[1] as MissionPaneRecoveryRequest;
    expect(request.paneId).toBe("pane-missing");
    resolveMissionPaneRecovery({
      requestId: request.requestId,
      ok: false,
      paneId: request.paneId,
      error: "test cleanup",
    }, owner);
    await expect(promise).resolves.toMatchObject({ ok: false });
  });
});

describe("F-1151: deferred native birth after the single-use recovery grant was consumed", () => {
  it("admits only the exact replacement session once the renderer's final ACK consumed the recovery grant", async () => {
    const owner = renderer();
    const scope = testProjectScope();
    registered = owner;
    registerOrchRenderer(owner);
    bindScope(owner, scope);
    const promise = requestMissionPaneRecovery({
      missionId: "mission-missing",
      paneId: "pane-missing",
      role: "orchestrator",
      expectedSessionId: "old-session",
      pane: {
        id: "spec-orch", missionId: "mission-missing", paneId: "pane-missing", adapterId: "codex",
        title: "Orchestrator", role: "orchestrator", scope, createdAt: 1,
      },
      scope,
      recap: "Continue the mission.",
    });
    await Promise.resolve();
    const request = owner.send.mock.calls[0]?.[1] as MissionPaneRecoveryRequest;
    expect(claimPendingRecoverySpawnMeta(request.requestId, owner)).not.toBeNull();
    expect(bindPendingRecoverySpawnSession(request.requestId, owner, "sess-replacement")).toBe(true);
    expect(() => assertPendingRecoverySpawnGrantActive(request.requestId, owner)).not.toThrow();
    // The renderer sees the allocated SID before the native readiness finishes.
    vi.spyOn(ptyManager, "isSessionOwnedBy").mockImplementation((candidate, id) => candidate.id === owner.id && id === "sess-replacement");
    vi.spyOn(ptyManager, "getSessionState").mockImplementation((id) => id === "sess-replacement" ? "busy" : null);
    syncPanes([{ paneId: request.paneId, sessionId: "sess-replacement", kind: "cli-agent", title: "Orchestrator", adapterId: "codex", state: "busy" }], owner);
    attachOrchMeta(owner, request.paneId, { missionId: request.missionId, role: "orchestrator", scope });
    expect(resolveMissionPaneRecovery({ requestId: request.requestId, ok: true, paneId: request.paneId, sessionId: "sess-replacement" }, owner)).toBe(true);
    await expect(promise).resolves.toMatchObject({ ok: true });

    // The ordinary single-use fence keeps its meaning; only the deferred fence knows the session.
    expect(() => assertPendingRecoverySpawnGrantActive(request.requestId, owner)).toThrow(/expired before process start/);
    expect(() => assertPendingRecoverySpawnGrantActive(request.requestId, owner, "sess-replacement")).not.toThrow();
    expect(() => assertPendingRecoverySpawnGrantActive(request.requestId, owner, "sess-other")).toThrow(/expired before process start/);
    expect(() => assertPendingRecoverySpawnGrantActive(request.requestId, renderer(), "sess-replacement")).toThrow(/expired before process start/);
    syncPanes([], owner);
  });

  it("never admits a recovery grant that settled as a failure", async () => {
    const owner = renderer();
    const scope = testProjectScope();
    registered = owner;
    registerOrchRenderer(owner);
    bindScope(owner, scope);
    const promise = requestMissionPaneRecovery({
      missionId: "mission-missing", paneId: "pane-missing", role: "orchestrator", expectedSessionId: "old-session",
      pane: { id: "spec-orch", missionId: "mission-missing", paneId: "pane-missing", adapterId: "codex",
        title: "Orchestrator", role: "orchestrator", scope, createdAt: 1 },
      scope, recap: "Continue the mission.",
    });
    await Promise.resolve();
    const request = owner.send.mock.calls[0]?.[1] as MissionPaneRecoveryRequest;
    expect(claimPendingRecoverySpawnMeta(request.requestId, owner)).not.toBeNull();
    expect(bindPendingRecoverySpawnSession(request.requestId, owner, "sess-replacement")).toBe(true);
    resolveMissionPaneRecovery({ requestId: request.requestId, ok: false, paneId: request.paneId, error: "renderer refused" }, owner);
    await expect(promise).resolves.toMatchObject({ ok: false });
    expect(() => assertPendingRecoverySpawnGrantActive(request.requestId, owner, "sess-replacement")).toThrow(/expired before process start/);
  });
});

describe("deliberate pane close", () => {
  it("warns the renderer BEFORE terminating, so the exit never offers a shell", async () => {
    const owner = renderer();
    bindScope(owner);
    registerOrchRenderer(owner);
    registered = owner;
    vi.spyOn(ptyManager, "isSessionOwnedBy").mockImplementation(
      (candidate, sessionId) => candidate.id === owner.id && sessionId === "pty-helper",
    );
    syncPanes(
      [{ paneId: "pane-helper", sessionId: "pty-helper", kind: "cli-agent", title: "Helper" }],
      owner,
    );
    owner.send.mockClear();
    let live = true;
    vi.spyOn(ptyManager, "getSessionState").mockImplementation(() =>
      live ? ("idle" as ReturnType<typeof ptyManager.getSessionState>) : null,
    );
    let sendsBeforeTerminate: unknown[][] = [];
    vi.spyOn(ptyManager, "orchTerminateSession").mockImplementation(async () => {
      sendsBeforeTerminate = [...owner.send.mock.calls];
      live = false;
      return true;
    });

    await expect(requestPaneClose("pane-helper", "pty-helper")).resolves.toBe(true);

    expect(sendsBeforeTerminate).toEqual([
      [
        ORCH_CHANNELS.paneCloseRequest,
        { paneId: "pane-helper", closingSessionId: "pty-helper" },
      ],
    ]);
    expect(owner.send).toHaveBeenLastCalledWith(ORCH_CHANNELS.paneCloseRequest, {
      paneId: "pane-helper",
      expectedSessionId: "pty-helper",
    });
  });
});
