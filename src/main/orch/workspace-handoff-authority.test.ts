import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testProjectScope } from "./__tests__/scope-fixture";
import {
  bindTokenToSession,
  mintToken,
  releaseSessionByToken,
  resetGateForTests,
} from "./gate";
import {
  deleteMainOwnedPane,
  setMainOwnedPane,
} from "./main-owned-pane-runtime";
import { resolveWorkspaceHandoffParent } from "./workspace-handoff-authority";

const scope = testProjectScope();
function context(sessionId: string) {
  const ctx = mintToken({ label: sessionId, role: "user", scope });
  bindTokenToSession(ctx.token, sessionId);
  return ctx;
}
function pane(sessionId: string, parent?: string) {
  setMainOwnedPane(`pane-${sessionId}`, {
    entry: {
      paneId: `pane-${sessionId}`,
      sessionId,
      title: sessionId,
      kind: "cli-agent",
      state: "idle",
    },
    meta: { scope, operatorParentSessionId: parent },
  });
}
beforeEach(() => resetGateForTests());
afterEach(() => {
  deleteMainOwnedPane("pane-parent");
  deleteMainOwnedPane("pane-child");
  resetGateForTests();
});

describe("workspace handoff authority", () => {
  it("resolves a Main-owned child and its current local orchestrator", () => {
    const parent = context("parent");
    parent.role = "orchestrator";
    const child = context("child");
    pane("parent");
    pane("child", "parent");
    expect(resolveWorkspaceHandoffParent(child)).toMatchObject({
      parent: { sessionId: "parent" },
    });
    releaseSessionByToken(parent.token);
    expect(resolveWorkspaceHandoffParent(child)).toBeNull();
  });

  it("does not infer a parent merely from sharing the checkout", () => {
    context("parent");
    const child = context("child");
    pane("parent");
    pane("child");
    expect(resolveWorkspaceHandoffParent(child)).toBeNull();
  });

  it("rejects a detached mission worker even if the caller token lost its mission", () => {
    context("parent");
    const child = context("child");
    pane("parent");
    setMainOwnedPane("pane-child", {
      entry: {
        paneId: "pane-child",
        sessionId: "child",
        title: "child",
        kind: "cli-agent",
        state: "idle",
      },
      meta: {
        scope,
        missionId: "other-mission",
        role: "worker",
        operatorParentSessionId: "parent",
      },
    });
    expect(resolveWorkspaceHandoffParent(child)).toBeNull();
  });

  it("rejects a stale caller object after token revocation", () => {
    context("parent");
    const child = context("child");
    pane("parent");
    pane("child", "parent");
    releaseSessionByToken(child.token);
    expect(resolveWorkspaceHandoffParent(child)).toBeNull();
  });
});
