import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureAuditLogRuntime,
  disposeAuditLogRuntime,
} from "../jarvis/audit-log";
import { dispatchToolCall } from "./mcp-dispatch";
import { ProjectRuntimeManager } from "../runtime/project-runtime-manager";
import { testProjectScope } from "./__tests__/scope-fixture";
import { bindTokenToSession, mintToken, resetGateForTests } from "./gate";
import {
  configureProjectDomainStoreRegistry,
  disposeProjectDomainStoreRegistry,
  getProjectDomainStores,
} from "./project-domain-store-registry";
import { buildHandoffTools } from "./tools-handoff";
import * as panes from "./pane-registry";
import * as transport from "./tool-util";
import type { PaneRuntimeAuthority } from "./pane-registry";
import { reviewMissionHandoff } from "./jev-handoff-review";

const jevReview = vi.hoisted(() => ({
  reviewMissionHandoff: vi.fn(
    async (): Promise<unknown> => ({ kind: "skipped", reason: "test" }),
  ),
}));

vi.mock("./jev-handoff-review", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./jev-handoff-review")>()),
  reviewMissionHandoff: jevReview.reviewMissionHandoff,
}));

const scope = testProjectScope();
let dir: string;
let manager: ProjectRuntimeManager;
let runtime: Map<string, PaneRuntimeAuthority>;
function caller(sessionId: string) {
  const ctx = mintToken({ label: sessionId, role: "user", scope });
  bindTokenToSession(ctx.token, sessionId);
  return ctx;
}
function tool(name: string) {
  return buildHandoffTools().find((t) => t.name === `nexus_handoff_${name}`)!;
}
const args = {
  status: "success",
  summary: "Implementação concluída e validada com testes.",
  artifacts: [{ path: "result.ts" }],
};

beforeEach(() => {
  resetGateForTests();
  jevReview.reviewMissionHandoff.mockReset();
  jevReview.reviewMissionHandoff.mockResolvedValue({
    kind: "skipped",
    reason: "test",
  });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-workspace-handoff-"));
  manager = new ProjectRuntimeManager({ baseDir: dir, appVersion: "test" });
  configureProjectDomainStoreRegistry(manager);
  configureAuditLogRuntime(manager);
  runtime = new Map([
    [
      "parent",
      {
        paneId: "pane-parent",
        sessionId: "parent",
        kind: "cli-agent",
        scope,
        owner: null,
      },
    ],
    [
      "child",
      {
        paneId: "pane-child",
        sessionId: "child",
        kind: "cli-agent",
        scope,
        owner: null,
        operatorParentSessionId: "parent",
      },
    ],
  ]);
  vi.spyOn(panes, "getPaneRuntimeAuthorityBySession").mockImplementation(
    (id) => runtime.get(id) ?? null,
  );
  vi.spyOn(transport, "injectPrompt").mockResolvedValue();
});
afterEach(() => {
  vi.restoreAllMocks();
  disposeProjectDomainStoreRegistry();
  disposeAuditLogRuntime();
  manager.closeAll();
  fs.rmSync(dir, { recursive: true, force: true });
  resetGateForTests();
});

describe("workspace handoff", () => {
  it("persists NULL mission, delivers to the spawner and lists delivered workspace rows", async () => {
    const parent = caller("parent");
    const child = caller("child");
    const result = await tool("submit").handler(args, child);
    expect(result).toMatchObject({ ok: true, stopGateSatisfied: false });
    expect(transport.injectPrompt).toHaveBeenCalledWith(
      "parent",
      expect.stringContaining("[handoff sem missão] de pane-child (child):"),
      expect.anything(),
    );
    const rows = (await tool("list").handler({}, parent)) as Array<{
      id: string;
      missionId?: string;
      checkoutId: string;
      deliveryState: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      missionId: undefined,
      checkoutId: scope.checkoutId,
      deliveryState: "submitted",
    });
    expect(
      manager.open(scope).db.prepare("SELECT mission_id FROM handoffs").get(),
    ).toEqual({ mission_id: null });
    expect(getProjectDomainStores(scope).missions.list()).toEqual([]);
    expect(child.handoffSubmitted).toBe(false);
    expect(await tool("list").handler({ panes: ["unknown"] }, parent)).toEqual(
      [],
    );
    expect(
      await tool("list").handler({ includeDelivered: false }, parent),
    ).toEqual([]);
  });

  it.each([
    "orphan",
    "worker",
    "stale",
    "other-checkout",
    "parent-mission",
    "shell-parent",
  ])("refuses %s before persistence or PTY input", async (reason) => {
    const parent = caller("parent");
    const child = caller("child");
    if (reason === "orphan") {
      runtime.delete("parent");
      child.readOnly = true;
    }
    if (reason === "worker") child.role = "worker";
    if (reason === "stale") child.contextRevision = "old";
    if (reason === "other-checkout")
      runtime.set("parent", {
        ...runtime.get("parent")!,
        scope: { ...scope, checkoutId: "other" },
      });
    if (reason === "parent-mission") parent.missionId = "mission-other";
    if (reason === "shell-parent")
      runtime.set("parent", { ...runtime.get("parent")!, kind: "shell" });
    await expect(tool("submit").handler(args, child)).rejects.toThrow();
    expect(
      getProjectDomainStores(scope).handoffs.list({ includeDelivered: true }),
    ).toEqual([]);
    expect(transport.injectPrompt).not.toHaveBeenCalled();
  });

  it("passes the real audited dispatcher without minting mission provenance", async () => {
    caller("parent");
    const child = caller("child");
    child.readOnly = true;
    const tools = buildHandoffTools();
    const result = await dispatchToolCall(
      "http-mcp",
      {
        tools,
        serverName: "workspace-test",
        serverVersion: "1",
      },
      "nexus_handoff_submit",
      args,
      child,
    );
    expect(result).toMatchObject({
      ok: true,
      result: { delivered: true, stopGateSatisfied: false },
    });
    expect(
      manager
        .open(scope)
        .db.prepare("SELECT count(*) AS count FROM handoff_mcp_receipts")
        .get(),
    ).toEqual({ count: 0 });
    for (const name of ["nexus_handoff_ack", "nexus_worker_heartbeat"]) {
      expect(
        await dispatchToolCall(
          "http-mcp",
          {
            tools,
            serverName: "workspace-test",
            serverVersion: "1",
          },
          name,
          name.endsWith("_ack") ? { handoffId: "any" } : {},
          child,
        ),
      ).toMatchObject({ ok: false });
    }
  });

  it("revalidates parent authority during asynchronous physical delivery", async () => {
    const parent = caller("parent");
    const child = caller("child");
    vi.mocked(transport.injectPrompt).mockImplementationOnce(
      async (_session, _text, invocation) => {
        parent.missionId = "new-mission";
        invocation?.assertCurrentAuthority?.();
      },
    );
    expect(await tool("submit").handler(args, child)).toMatchObject({
      delivered: false,
    });
    expect(getProjectDomainStores(scope).handoffs.list()).toMatchObject([
      { deliveryState: "queued" },
    ]);
  });

  it("refuses mission evidence before persisting a workspace handoff", async () => {
    caller("parent");
    await expect(
      tool("submit").handler(
        { ...args, evidenceIds: ["evidence-mission"] },
        caller("child"),
      ),
    ).rejects.toThrow(/requires missionId/);
    expect(getProjectDomainStores(scope).handoffs.list()).toEqual([]);
  });

  it("keeps the persisted handoff queued if physical delivery fails", async () => {
    caller("parent");
    const child = caller("child");
    vi.mocked(transport.injectPrompt).mockRejectedValueOnce(
      new Error("session is gone"),
    );
    const result = await tool("submit").handler(args, child);
    expect(result).toMatchObject({
      ok: true,
      delivered: false,
      deliveryError: "session is gone",
    });
    expect(getProjectDomainStores(scope).handoffs.list()).toMatchObject([
      { deliveryState: "queued" },
    ]);
  });

  it("retry verdict devolve ao filho uma vez sem persistir nada", async () => {
    caller("parent");
    const child = caller("child");
    jevReview.reviewMissionHandoff.mockResolvedValue({
      kind: "retry",
      signals: ["missing-evidence"],
      attempt: 1,
      retries: 1,
      message: "handoff devolvido: cite arquivos e verificação",
    });
    await expect(tool("submit").handler(args, child)).rejects.toThrow(
      "handoff devolvido: cite arquivos e verificação",
    );
    expect(
      getProjectDomainStores(scope).handoffs.list({ includeDelivered: true }),
    ).toEqual([]);
    expect(transport.injectPrompt).not.toHaveBeenCalled();
  });

  it("weak verdict prefixa [evidência fraca] no resumo do store e da injeção", async () => {
    caller("parent");
    const child = caller("child");
    jevReview.reviewMissionHandoff.mockResolvedValue({
      kind: "weak",
      signals: ["generic-summary"],
      artifact: { kind: "nexus.jevReview", payload: { outcome: "weak" } },
    });
    const result = await tool("submit").handler(args, child);
    expect(result).toMatchObject({ ok: true, delivered: true });
    const rows = getProjectDomainStores(scope).handoffs.list({
      includeDelivered: true,
    });
    expect(rows[0]?.summary).toMatch(/^\[evidência fraca\] /);
    expect(transport.injectPrompt).toHaveBeenCalledWith(
      "parent",
      expect.stringContaining("[evidência fraca]"),
      expect.anything(),
    );
    expect(rows[0]?.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "nexus.jevReview" }),
      ]),
    );
  });

  it("ok verdict mantém o resumo e anexa o artifact nexus.jevReview", async () => {
    caller("parent");
    const child = caller("child");
    jevReview.reviewMissionHandoff.mockResolvedValue({
      kind: "ok",
      artifact: { kind: "nexus.jevReview", payload: { outcome: "ok" } },
    });
    await tool("submit").handler(args, child);
    const rows = getProjectDomainStores(scope).handoffs.list({
      includeDelivered: true,
    });
    expect(rows[0]?.summary).toBe(args.summary);
    expect(rows[0]?.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "nexus.jevReview" }),
      ]),
    );
  });

  it("não revisa status não-success nem sessão read-only", async () => {
    caller("parent");
    const child = caller("child");
    await tool("submit").handler({ ...args, status: "partial" }, child);
    expect(reviewMissionHandoff).not.toHaveBeenCalled();

    child.readOnly = true;
    await tool("submit").handler(args, child);
    expect(reviewMissionHandoff).not.toHaveBeenCalled();
  });

  it("does not list mission history without a mission or grant mission ACK", async () => {
    const parent = caller("parent");
    const store = getProjectDomainStores(scope).handoffs;
    const mission = getProjectDomainStores(scope).missions.create({
      title: "Other mission",
    });
    store.submit({
      status: "partial",
      summary: "Private mission summary",
      missionId: mission.id,
    });
    expect(
      await tool("list").handler(
        { missionId: "mission-other", full: true },
        parent,
      ),
    ).toEqual([]);
    await expect(
      tool("ack").handler({ handoffId: "any" }, parent),
    ).rejects.toThrow(/physical mission orchestrator/);
  });
});
