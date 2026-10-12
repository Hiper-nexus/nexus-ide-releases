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
import { configureMissionEventEmit } from './mission-event-emit';
import { createScopedBrowserArtifactStore } from '../browser/browser-artifact-store';
import { recordVisualHandoffEvidence } from './visual-handoff-gate';
import {
  armAutoCloseOnHandoff,
  armedAutoClosePaneId,
  disarmAutoCloseOnHandoff,
} from "./pane-close-scopes";

const jevReview = vi.hoisted(() => ({
  reviewMissionHandoff: vi.fn(
    async (): Promise<unknown> => ({ kind: "skipped", reason: "test" }),
  ),
}));

vi.mock('../license-access', async () => (await import('../__tests__/licensed-access')).licensedAccessMock);

vi.mock("./jev-handoff-review", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./jev-handoff-review")>()),
  reviewMissionHandoff: jevReview.reviewMissionHandoff,
}));

const regressionGate = vi.hoisted(() => ({
  evaluateHandoffRegressionGate: vi.fn(
    async (): Promise<unknown> => ({ kind: "skipped", reason: "test" }),
  ),
}));

vi.mock("../regression-gate/regression-gate-handoff", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../regression-gate/regression-gate-handoff")
  >()),
  evaluateHandoffRegressionGate: regressionGate.evaluateHandoffRegressionGate,
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
  regressionGate.evaluateHandoffRegressionGate.mockReset();
  regressionGate.evaluateHandoffRegressionGate.mockResolvedValue({
    kind: "skipped",
    reason: "test",
  });
  jevReview.reviewMissionHandoff.mockReset();
  jevReview.reviewMissionHandoff.mockResolvedValue({
    kind: "skipped",
    reason: "test",
  });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-workspace-handoff-"));
  manager = new ProjectRuntimeManager({ baseDir: dir, appVersion: "test" });
  configureProjectDomainStoreRegistry(manager);
  configureMissionEventEmit(manager);
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
  vi.spyOn(panes, "findPane").mockImplementation((id) => {
    const current = runtime.get(id);
    return current ? { paneId: current.paneId, sessionId: id } as ReturnType<typeof panes.findPane> : null;
  });
  vi.spyOn(transport, "injectPrompt").mockResolvedValue();
});
afterEach(async () => {
  disarmAutoCloseOnHandoff("child");
  vi.useRealTimers();
  vi.restoreAllMocks();
  await disposeProjectDomainStoreRegistry();
  disposeAuditLogRuntime();
  configureMissionEventEmit(null);
  manager.closeAll();
  fs.rmSync(dir, { recursive: true, force: true });
  resetGateForTests();
});

describe("workspace handoff", () => {
  it('preserves the visual worker until a current Main capture proves the next handoff', async () => {
    caller('parent');
    const child = caller('child');
    child.visualTask = { since: 1000, id: 'workspace-assignment' };
    const close = vi.spyOn(panes, 'requestPaneClose').mockResolvedValue(true);
    armAutoCloseOnHandoff('child', 'pane-child');
    const first = await tool('submit').handler({ ...args, fullText: "Relatório completo: implementação em result.ts, validação executada e resultados conferidos." }, child);
    expect(first).toMatchObject({ status: 'partial', visualVerification: { verified: false } });
    expect(close).not.toHaveBeenCalled();
    expect(armedAutoClosePaneId('child')).toBe('pane-child');
    const proof = createScopedBrowserArtifactStore(manager, scope).recordScreenshot({ paneId: 'browser-pane',
      png: Buffer.from('Main capture fixture'), width: 1, height: 1, url: 'http://localhost:3000', title: 'UI', capturedAt: 1100 });
    expect(recordVisualHandoffEvidence(child, proof.id)).toBe(true);
    const second = await tool('submit').handler({ ...args, fullText: "Relatório completo: implementação em result.ts, validação executada e resultados conferidos." }, child);
    expect(second).toMatchObject({ status: 'success', visualVerification: { verified: true, artifactId: proof.id } });
    expect(getProjectDomainStores(scope).handoffs.list({ includeDelivered: true }).map(h => h.status)).toEqual(['partial', 'success']);
  });
  it('keeps a summary-only helper open until its full report can be preserved', async () => {
    caller('parent');
    const child = caller('child');
    const close = vi.spyOn(panes, 'requestPaneClose').mockResolvedValue(true);
    armAutoCloseOnHandoff('child', 'pane-child');
    await expect(tool('submit').handler(args, child)).rejects.toThrow('fullText');
    expect(close).not.toHaveBeenCalled();
    expect(getProjectDomainStores(scope).handoffs.list({ includeDelivered: true })).toHaveLength(0);
    expect(armedAutoClosePaneId('child')).toBe('pane-child');
  });
  it.each([
    { fullText: args.summary },
    { artifacts: [{ fullText: `  ${args.summary}\n` }] },
    { artifacts: [{ kind: 'overclock.fullText', payload: args.summary }] },
  ])('preserves a Main-sanitized terminal tail before closing a repeated summary: %j', async (report) => {
    caller('parent');
    const child = caller('child');
    const close = vi.spyOn(panes, 'requestPaneClose').mockResolvedValue(true);
    const output = vi.spyOn(panes, 'readSessionOutput').mockReturnValue(
      '\u001b[32mDetalhes da pesquisa: fonte primária, método e resultado.\u001b[0m\n' +
      'ANTHROPIC_API_KEY=sk-ant-test-secret-do-not-preserve\n',
    );
    armAutoCloseOnHandoff('child', 'pane-child');
    vi.useFakeTimers();
    const result = await tool('submit').handler({ ...args, ...report }, child);
    expect(result).toMatchObject({ delivered: true, warning: expect.stringContaining('cauda') });
    const handoff = getProjectDomainStores(scope).handoffs.list({ includeDelivered: true })[0];
    expect(handoff.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'nexus.terminal-tail', payload: expect.stringContaining('Detalhes da pesquisa') }),
    ]));
    expect(JSON.stringify(handoff.artifacts)).not.toContain('sk-ant-test-secret-do-not-preserve');
    expect(JSON.stringify(handoff.artifacts)).not.toContain('\u001b');
    expect(output).toHaveBeenCalledWith('child', 40);
    expect(close).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(close).toHaveBeenCalledWith('pane-child', 'child');
  });
  it('keeps the pane and its report when repeated summary has no Main terminal tail', async () => {
    caller('parent');
    const child = caller('child');
    const close = vi.spyOn(panes, 'requestPaneClose').mockResolvedValue(true);
    vi.spyOn(panes, 'readSessionOutput').mockReturnValue('');
    armAutoCloseOnHandoff('child', 'pane-child');
    await expect(tool('submit').handler({ ...args, fullText: args.summary }, child))
      .rejects.toThrow('handoff_report_required');
    expect(getProjectDomainStores(scope).handoffs.list({ includeDelivered: true })).toHaveLength(0);
    expect(close).not.toHaveBeenCalled();
    expect(armedAutoClosePaneId('child')).toBe('pane-child');
  });
  it("fecha helper armado só depois de registrar a entrega de sucesso", async () => {
    caller("parent");
    const child = caller("child");
    const close = vi.spyOn(panes, "requestPaneClose").mockResolvedValue(true);
    armAutoCloseOnHandoff("child", "pane-child");
    vi.useFakeTimers();

    expect(await tool("submit").handler({ ...args, fullText: "Relatório completo: implementação em result.ts, validação executada e resultados conferidos." }, child)).toMatchObject({ delivered: true });
    expect(close).not.toHaveBeenCalled();
    expect(getProjectDomainStores(scope).handoffs.list({ includeDelivered: true })).toMatchObject([
      { deliveryState: "submitted" },
    ]);
    await vi.runAllTimersAsync();
    expect(close).toHaveBeenCalledWith("pane-child", "child");
    expect(armedAutoClosePaneId("child")).toBeNull();
  });

  it("não fecha o pane se outra sessão o ocupou após o handoff", async () => {
    caller("parent");
    const close = vi.spyOn(panes, "requestPaneClose").mockResolvedValue(true);
    armAutoCloseOnHandoff("child", "pane-child");
    vi.useFakeTimers();

    expect(await tool("submit").handler({ ...args, fullText: "Relatório completo: implementação em result.ts, validação executada e resultados conferidos." }, caller("child"))).toMatchObject({ delivered: true });
    runtime.delete("child");
    runtime.set("replacement", {
      paneId: "pane-child",
      sessionId: "replacement",
      kind: "cli-agent",
      scope,
      owner: null,
    });
    await vi.runAllTimersAsync();

    expect(close).not.toHaveBeenCalled();
  });

  it.each(["blocked", "failed"])("mantém helper armado no handoff %s", async (status) => {
    caller("parent");
    const close = vi.spyOn(panes, "requestPaneClose").mockResolvedValue(true);
    armAutoCloseOnHandoff("child", "pane-child");
    vi.useFakeTimers();
    await tool("submit").handler({ ...args, status }, caller("child"));
    await vi.runAllTimersAsync();
    expect(close).not.toHaveBeenCalled();
    expect(armedAutoClosePaneId("child")).toBe("pane-child");
  });

  it("mantém helper quando o handoff de sucesso ficou na fila", async () => {
    caller("parent");
    const close = vi.spyOn(panes, "requestPaneClose").mockResolvedValue(true);
    vi.mocked(transport.injectPrompt).mockRejectedValueOnce(new Error("parent gone"));
    armAutoCloseOnHandoff("child", "pane-child");
    vi.useFakeTimers();
    expect(await tool("submit").handler({ ...args, fullText: "Relatório completo: implementação em result.ts, validação executada e resultados conferidos." }, caller("child"))).toMatchObject({ delivered: false });
    await vi.runAllTimersAsync();
    expect(close).not.toHaveBeenCalled();
    expect(armedAutoClosePaneId("child")).toBe("pane-child");
  });

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

  it("portão de regressão falhando devolve ao filho sem persistir nada", async () => {
    caller("parent");
    const child = caller("child");
    regressionGate.evaluateHandoffRegressionGate.mockResolvedValue({
      kind: "retry",
      message: "handoff NÃO aceito pelo portão de regressão: src/a.test.ts",
    });
    await expect(tool("submit").handler(args, child)).rejects.toThrow(
      "handoff NÃO aceito pelo portão de regressão",
    );
    expect(
      getProjectDomainStores(scope).handoffs.list({ includeDelivered: true }),
    ).toEqual([]);
    expect(transport.injectPrompt).not.toHaveBeenCalled();
    expect(reviewMissionHandoff).not.toHaveBeenCalled();
  });

  it("portão de regressão sem verificar aceita com '[testes impactados não verificados]'", async () => {
    caller("parent");
    const child = caller("child");
    regressionGate.evaluateHandoffRegressionGate.mockResolvedValue({
      kind: "accepted",
      unverified: true,
      artifact: { kind: "nexus.regressionGate", payload: { status: "unavailable" } },
    });
    await tool("submit").handler(args, child);
    const rows = getProjectDomainStores(scope).handoffs.list({ includeDelivered: true });
    expect(rows[0]?.status).toBe("success");
    expect(rows[0]?.summary).toMatch(/^\[testes impactados não verificados\] /);
    expect(rows[0]?.artifacts).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "nexus.regressionGate" })]),
    );
  });

  it("portão de regressão esgotado entra como blocked com as falhas em artifact", async () => {
    caller("parent");
    const child = caller("child");
    regressionGate.evaluateHandoffRegressionGate.mockResolvedValue({
      kind: "exhausted",
      report: "Seu diff quebrou 1 arquivo(s)",
      artifact: {
        kind: "nexus.regressionGate",
        payload: { status: "failed" },
      },
    });
    await tool("submit").handler(args, child);
    const rows = getProjectDomainStores(scope).handoffs.list({
      includeDelivered: true,
    });
    expect(rows[0]?.status).toBe("blocked");
    expect(rows[0]?.summary).toMatch(/^\[testes impactados falhando\] /);
    expect(rows[0]?.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "nexus.regressionGate" }),
      ]),
    );
    expect(reviewMissionHandoff).not.toHaveBeenCalled();
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

  it("não revisa status não-success nem sessão que o Hardened confina à leitura", async () => {
    caller("parent");
    const child = caller("child");
    await tool("submit").handler({ ...args, status: "partial" }, child);
    expect(reviewMissionHandoff).not.toHaveBeenCalled();

    // F-1157: só a lane que o Hardened confina à leitura não escreve.
    child.readOnly = true;
    child.readOnlyEnforced = true;
    await tool("submit").handler(args, child);
    expect(reviewMissionHandoff).not.toHaveBeenCalled();
  });

  it("F-1157: sessão só rotulada read-only escreve no Autopilot, então a entrega é revisada", async () => {
    caller("parent");
    const child = caller("child");
    child.readOnly = true;
    await tool("submit").handler(args, child);
    expect(reviewMissionHandoff).toHaveBeenCalled();
  });

  it("F-1262: pai promovido recupera por ids o relatório completo do helper sem missão", async () => {
    const parent = caller("parent");
    const child = caller("child");
    // O operador promoveu o pai a orquestrador da missão da aba DEPOIS de
    // abrir o helper: o helper sem missão continua entregando a ele.
    const mission = getProjectDomainStores(scope).missions.create({
      title: "Missão da aba",
    });
    getProjectDomainStores(scope).missions.setOrchestratorSession(
      mission.id,
      "parent",
    );
    parent.role = "orchestrator";
    parent.missionId = mission.id;
    parent.contextRevision = "rev-tab";
    const close = vi.spyOn(panes, "requestPaneClose").mockResolvedValue(true);
    armAutoCloseOnHandoff("child", "pane-child");
    vi.useFakeTimers();

    const unique = "RELATORIO-EXCLUSIVO-F-1262: causa raiz, diff e validação.";
    const result = (await tool("submit").handler(
      { ...args, fullText: unique },
      child,
    )) as { handoffId: string };
    expect(result).toMatchObject({ delivered: true });
    // A notificação precisa trazer o handoffId e a chamada de recuperação.
    expect(transport.injectPrompt).toHaveBeenCalledWith(
      "parent",
      expect.stringContaining(result.handoffId),
      expect.anything(),
    );
    // O auto-close fecha o helper: o relatório só existe no ledger e o pane
    // some do registro vivo — a leitura por id não pode depender dele.
    await vi.runAllTimersAsync();
    expect(close).toHaveBeenCalledWith("pane-child", "child");
    runtime.delete("child");

    const rows = (await tool("list").handler(
      { ids: [result.handoffId] },
      parent,
    )) as Array<{ id: string; missionId?: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(result.handoffId);
    expect(rows[0]!.missionId).toBeUndefined();
    expect(JSON.stringify(rows)).toContain(unique);

    // A correspondência de workspace continua fora da cadeia de ACK da missão.
    await expect(
      tool("ack").handler({ handoffId: result.handoffId }, parent),
    ).rejects.toThrow();
    // Sem o vínculo Main-owned do spawn, outro orquestrador não lê por id.
    const stranger = caller("stranger");
    stranger.role = "orchestrator";
    stranger.missionId = mission.id;
    stranger.contextRevision = "rev-tab";
    expect(
      await tool("list").handler({ ids: [result.handoffId] }, stranger),
    ).toEqual([]);
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
