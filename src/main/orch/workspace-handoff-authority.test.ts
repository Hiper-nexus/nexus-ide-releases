import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testProjectScope } from "./__tests__/scope-fixture";

const liveAgents = vi.hoisted(() => new Map<string, Record<string, unknown>>());
vi.mock("../pty/pty-manager", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../pty/pty-manager")>()),
  getAgentSessionInfo: (sessionId: string) => liveAgents.get(sessionId) ?? null,
}));
const missionOrchestrators = vi.hoisted(() => new Map<string, string>());
vi.mock("./project-domain-store-registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./project-domain-store-registry")>()),
  getProjectDomainStores: () => ({
    missions: {
      get: (id: string) =>
        missionOrchestrators.has(id)
          ? { id, orchestratorSessionId: missionOrchestrators.get(id) }
          : null,
    },
  }),
}));
// Primeiro import: o mock acima carrega o registro original, que fecha o ciclo
// handoff-store → … → mcp-dispatch → este módulo. Se outro import (o
// main-owned-pane-runtime importa o registro desde b4ff521f7) disparar a
// fábrica antes, este módulo nasce dentro dela preso ao registro real.
import { resolveWorkspaceHandoffParent } from "./workspace-handoff-authority";
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
  liveAgents.clear();
  missionOrchestrators.clear();
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

  it("entrega ao pai que virou orquestrador ATUAL da missão da aba", () => {
    // O operador tornou o pai orquestrador depois de abrir o helper: a missão
    // leve da aba nasce e o helper sem missão continua entregando a ele.
    const parent = context("parent");
    parent.role = "orchestrator";
    parent.missionId = "mission-tab";
    parent.contextRevision = "rev-1";
    const child = context("child");
    pane("parent");
    pane("child", "parent");
    missionOrchestrators.set("mission-tab", "parent");
    expect(resolveWorkspaceHandoffParent(child)).toMatchObject({
      parent: { sessionId: "parent" },
    });

    // Outro pane assumiu a missão: o pai antigo não é mais destino.
    missionOrchestrators.set("mission-tab", "other");
    expect(resolveWorkspaceHandoffParent(child)).toBeNull();
  });

  it("não entrega a um pai que é worker de missão", () => {
    const parent = context("parent");
    parent.role = "worker";
    parent.missionId = "mission-tab";
    const child = context("child");
    pane("parent");
    pane("child", "parent");
    missionOrchestrators.set("mission-tab", "parent");
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

describe("workspace handoff authority with the workspace off screen", () => {
  // A janela mostra outro workspace: o registro de panes não espelha estes
  // panes, mas as sessões PTY e os tokens seguem vivos no main.
  function liveAgent(sessionId: string, extra: Record<string, unknown> = {}) {
    liveAgents.set(sessionId, { sessionId, paneId: `pane-${sessionId}`, scope, role: "user", ...extra });
  }
  function helper(sessionId: string, operatorParentSessionId?: string) {
    const ctx = mintToken({ label: sessionId, role: "user", scope, operatorParentSessionId });
    bindTokenToSession(ctx.token, sessionId);
    return ctx;
  }

  it("resolves the parent from the link minted at spawn and the live sessions", () => {
    const parent = context("parent");
    const child = helper("child", "parent");
    liveAgent("parent");
    liveAgent("child");
    expect(resolveWorkspaceHandoffParent(child)).toMatchObject({
      child: { paneId: "pane-child" },
      parent: { paneId: "pane-parent" },
      parentContext: parent,
    });
  });

  it("does not guess a parent without the minted link", () => {
    context("parent");
    const child = helper("child");
    liveAgent("parent");
    liveAgent("child");
    expect(resolveWorkspaceHandoffParent(child)).toBeNull();
  });

  it("fails closed when the registry contradicts the minted link", () => {
    context("parent");
    context("other");
    const child = helper("child", "parent");
    pane("child", "other");
    liveAgent("parent");
    expect(resolveWorkspaceHandoffParent(child)).toBeNull();
  });

  it("never treats a mission session or a dead parent as the destination", () => {
    context("parent");
    const child = helper("child", "parent");
    liveAgent("child");
    expect(resolveWorkspaceHandoffParent(child)).toBeNull();
    liveAgent("parent", { missionId: "m1", role: "orchestrator" });
    expect(resolveWorkspaceHandoffParent(child)).toBeNull();
  });

  it("mintToken refuses an operator parent link on mission or worker tokens", () => {
    expect(() => mintToken({ label: "w", role: "worker", missionId: "m1", scope, operatorParentSessionId: "p" }))
      .toThrow(/operator parent/);
  });
});
