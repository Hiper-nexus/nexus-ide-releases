import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import type { OrchPaneSpawnRequest } from "../../shared/orch-types";
import { testProjectScope } from "./__tests__/scope-fixture";
import {
  attachOrchMeta,
  bindPendingSpawnSession,
  claimPendingSpawnMeta,
  findPane,
  findPaneOwnedBy,
  getOwnedPaneAuthzInfo,
  getPaneAuthzInfoOwnedBy,
  getPaneAuthzInfoOwnedByPane,
  registerOrchRenderer,
  requestPaneSpawn,
  resolvePaneSpawn,
  syncPanes,
  unregisterOrchRenderer,
} from "./pane-registry";

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

afterEach(() => {
  if (registered) unregisterOrchRenderer(registered);
  registered = null;
});

describe("pending pane spawn authority", () => {
  it("routes a worker spawn back to the renderer that owns its mission", async () => {
    const missionOwner = renderer();
    const unrelatedOwner = renderer();
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
    const resultPromise = requestPaneSpawn({
      adapterId: "codex",
      missionId: "mission-a",
      agentName: "worker-a",
      role: "worker",
      allowedTools: [],
      scope,
    });
    const request = owner.send.mock.calls[0]?.[1] as OrchPaneSpawnRequest;

    expect(claimPendingSpawnMeta(request.requestId, attacker)).toBeNull();
    expect(claimPendingSpawnMeta(request.requestId, owner)).toEqual({
      missionId: "mission-a",
      agentName: "worker-a",
      role: "worker",
      allowedTools: [],
      allowedSkills: undefined,
      scope,
      executionScope: undefined,
      readOnly: false,
    });
    expect(claimPendingSpawnMeta(request.requestId, owner)).toBeNull();

    resolvePaneSpawn(
      { requestId: request.requestId, ok: false, error: "test cleanup" },
      owner,
    );
    await expect(resultPromise).resolves.toMatchObject({ ok: false });
  });

  it("ignores a forged completion from another renderer", async () => {
    const owner = renderer();
    const attacker = renderer();
    registered = owner;
    registerOrchRenderer(owner);
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
          paneId: "pane-a",
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
          paneId: "pane-a",
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
          paneId: "pane-a",
          sessionId: "pty-a",
        },
        owner,
      ),
    ).toBe(true);
    await expect(resultPromise).resolves.toMatchObject({
      ok: true,
      paneId: "pane-a",
      sessionId: "pty-a",
    });
  });
});
