import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A entrega success sem missão dispara a memória (F-768); aqui só importa a
// atribuição e a taxa.
vi.mock("../memory/trusted-memory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../memory/trusted-memory")>()),
  retainAcknowledgedHandoffMemoryBestEffort: vi.fn(async () => null),
  retainAcceptedHandoffMemoryDistilledBestEffort: vi.fn(async () => null),
}));
import { ProjectRuntimeManager } from "../runtime/project-runtime-manager";
import { INITIAL_PROJECT_MIGRATIONS } from "../runtime/project-runtime-schema";
import { testProjectScope } from "./__tests__/scope-fixture";
import {
  clearExitedSessionAttributionsForTesting,
  createScopedHandoffStore,
  rememberExitedSessionAttribution,
  routeAttributionFromSession,
  setHandoffRouteAttributionResolver,
} from "./handoff-store";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("F-773: handoff grava quem entregou e alimenta a taxa de sucesso", () => {
  let baseDir = "";
  let manager: ProjectRuntimeManager;
  let clock = 0;
  let nextId = 0;
  let handoffs: ReturnType<typeof createScopedHandoffStore>;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-f773-outcome-"));
    manager = new ProjectRuntimeManager({ baseDir, appVersion: "f773-test" });
    clock = 100 * DAY_MS;
    handoffs = createScopedHandoffStore(manager, testProjectScope(), {
      now: () => clock,
      idFactory: () => `handoff-f773-${++nextId}`,
    });
    // Sessões físicas da fixture: pty-<cli>-<n> roda <cli> no modelo dela.
    setHandoffRouteAttributionResolver((sessionId) => {
      const [, cli] = sessionId.split("-");
      const models: Record<string, string> = { kimi: "kimi-code/k3", grok: "grok-4.7" };
      return cli && models[cli] ? { adapterId: cli, model: models[cli] } : null;
    });
  });

  afterEach(() => {
    setHandoffRouteAttributionResolver(null);
    clearExitedSessionAttributionsForTesting();
    manager?.closeAll();
    if (baseDir) fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const db = () => manager.open(testProjectScope()).db;
  const submit = (
    sessionId: string | undefined,
    status: "success" | "partial" | "blocked" | "failed" | "progress" | "stalled",
    fromAgent = "worker",
  ) =>
    handoffs.submit({
      ...(sessionId ? { sessionId } : {}),
      fromAgent,
      status,
      summary: `entrega ${status} de ${sessionId ?? "sistema"}`,
    });
  const attributionOf = (id: string) =>
    db().prepare(`SELECT adapter_id, model FROM handoffs WHERE id = ?`).get(id);

  it("o handoff gravado carrega adapter_id e model da sessão física", () => {
    const handoff = submit("pty-kimi-1", "success");
    expect(attributionOf(handoff.id)).toEqual({ adapter_id: "kimi", model: "kimi-code/k3" });
  });

  it("sessão desconhecida, sem sessão ou resolvedor quebrado: grava sem atribuição e não falha", () => {
    expect(attributionOf(submit("pty-desconhecida-1", "success").id)).toEqual({
      adapter_id: null,
      model: null,
    });
    expect(attributionOf(submit(undefined, "failed", "nexus-delegation-supervisor").id)).toEqual({
      adapter_id: null,
      model: null,
    });
    setHandoffRouteAttributionResolver(() => {
      throw new Error("registro de sessão indisponível");
    });
    expect(attributionOf(submit("pty-kimi-2", "success").id)).toEqual({
      adapter_id: null,
      model: null,
    });
  });

  it("o Maestro não entra na taxa: ele não é escolhido pelo roteador", () => {
    expect(
      routeAttributionFromSession({ adapterId: "claude", model: "claude-opus-5-5", role: "orchestrator" }),
    ).toBeNull();
    expect(routeAttributionFromSession({ adapterId: "kimi", role: "worker", requestedModel: "kimi-code/k3" }))
      .toEqual({ adapterId: "kimi", model: "kimi-code/k3" });
    expect(routeAttributionFromSession(null)).toBeNull();
  });

  it("taxa: success conta, partial/blocked/failed são falha, progress/stalled ficam fora", () => {
    for (const status of ["success", "success", "success", "partial", "failed"] as const) {
      submit("pty-kimi-1", status);
    }
    submit("pty-kimi-1", "progress", "nexus-delegation-supervisor");
    submit("pty-kimi-1", "stalled", "nexus-watchdog");
    expect(handoffs.routeOutcomeCountsSince(0)).toEqual([
      { adapterId: "kimi", model: "kimi-code/k3", successes: 3, total: 5 },
    ]);
  });

  it("devolução do Maestro (ack_verdict rework) transforma o success em falha", () => {
    const reworked = submit("pty-grok-1", "success");
    submit("pty-grok-2", "success");
    db().prepare(`UPDATE handoffs SET ack_verdict = 'rework' WHERE id = ?`).run(reworked.id);
    expect(handoffs.routeOutcomeCountsSince(0)).toEqual([
      { adapterId: "grok", model: "grok-4.7", successes: 1, total: 2 },
    ]);
  });

  it("falha provisória do enforcement superada por success da mesma sessão não conta", () => {
    submit("pty-kimi-1", "blocked", "nexus-handoff-enforcement");
    clock += 1_000;
    submit("pty-kimi-1", "success");
    // Outra sessão ficou só com a falha provisória: essa conta.
    submit("pty-kimi-2", "failed", "nexus-handoff-enforcement");
    expect(handoffs.routeOutcomeCountsSince(0)).toEqual([
      { adapterId: "kimi", model: "kimi-code/k3", successes: 1, total: 2 },
    ]);
  });

  it("falha gravada depois do exit (sessão fora do registro) conta para a CLI que morreu", () => {
    // O enforcement grava "a sessão terminou sem entregar" depois do exit: o
    // registro vivo já não conhece a sessão, o tap de saída lembrou quem era.
    rememberExitedSessionAttribution("pty-agy-1", { adapterId: "agy", model: "gemini-4-argon" });
    const failure = submit("pty-agy-1", "failed", "nexus-handoff-enforcement");
    expect(attributionOf(failure.id)).toEqual({ adapter_id: "agy", model: "gemini-4-argon" });
    expect(handoffs.routeOutcomeCountsSince(0)).toEqual([
      { adapterId: "agy", model: "gemini-4-argon", successes: 0, total: 1 },
    ]);
  });

  it("o registro vivo vence a lembrança, e a lista de sessões encerradas é limitada", () => {
    rememberExitedSessionAttribution("pty-kimi-1", { adapterId: "grok", model: "grok-4.7" });
    expect(attributionOf(submit("pty-kimi-1", "success").id)).toEqual({
      adapter_id: "kimi",
      model: "kimi-code/k3",
    });
    rememberExitedSessionAttribution("pty-antiga-0", { adapterId: "agy" });
    for (let index = 1; index <= 256; index += 1) {
      rememberExitedSessionAttribution(`pty-nova-${index}`, { adapterId: "agy" });
    }
    expect(attributionOf(submit("pty-antiga-0", "failed").id)).toEqual({
      adapter_id: null,
      model: null,
    });
    expect(attributionOf(submit("pty-nova-256", "failed").id)).toEqual({
      adapter_id: "agy",
      model: null,
    });
  });

  it("só a janela pedida entra", () => {
    submit("pty-kimi-1", "failed");
    clock += 15 * DAY_MS;
    submit("pty-kimi-2", "success");
    expect(handoffs.routeOutcomeCountsSince(clock - 14 * DAY_MS)).toEqual([
      { adapterId: "kimi", model: "kimi-code/k3", successes: 1, total: 1 },
    ]);
  });
});

describe("F-773: migração 041 sobre banco existente", () => {
  let baseDir = "";

  afterEach(() => {
    if (baseDir) fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("preserva os handoffs antigos com as colunas novas nulas e fora da taxa", () => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-f773-migration-"));
    const scope = testProjectScope();
    const before = new ProjectRuntimeManager({
      baseDir,
      appVersion: "antes-f773",
      migrations: INITIAL_PROJECT_MIGRATIONS.filter((migration) => migration.schemaVersion <= 40),
    });
    before
      .open(scope)
      .db.prepare(
        `INSERT INTO handoffs (id, session_id, from_agent, status, summary, artifacts_json, delivered, created_at)
         VALUES ('handoff-legado', 'pty-legado', 'worker', 'success', 'entrega antiga', '[]', 1, 1)`,
      )
      .run();
    before.closeAll();

    const after = new ProjectRuntimeManager({ baseDir, appVersion: "f773" });
    try {
      const runtime = after.open(scope);
      expect(runtime.db.pragma("user_version", { simple: true })).toBe(
        INITIAL_PROJECT_MIGRATIONS.at(-1)!.schemaVersion,
      );
      expect(
        runtime.db
          .prepare(`SELECT id, summary, adapter_id, model, ack_verdict FROM handoffs`)
          .all(),
      ).toEqual([
        {
          id: "handoff-legado",
          summary: "entrega antiga",
          adapter_id: null,
          model: null,
          ack_verdict: null,
        },
      ]);
      expect(
        runtime.db
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_handoffs_route_outcome'`)
          .get(),
      ).toEqual({ name: "idx_handoffs_route_outcome" });
      expect(() =>
        runtime.db.prepare(`UPDATE handoffs SET ack_verdict = 'talvez'`).run(),
      ).toThrow(/CHECK constraint failed/);
      const store = createScopedHandoffStore(after, scope);
      expect(store.routeOutcomeCountsSince(0)).toEqual([]);
    } finally {
      after.closeAll();
    }
  });
});
