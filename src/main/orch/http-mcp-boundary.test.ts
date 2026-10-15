import fs from "node:fs";
import path from "node:path";
import { promiseHooks } from "node:v8";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindTokenToSession,
  mintToken,
  resetGateForTests,
  type AgentGateContext,
} from "./gate";
import {
  consumeAgentTransportPhysicalReceipt,
  mintAgentTransportPhysicalReceipt,
  runInsideMissionShimTransport,
  runInsidePtyStreamAgentTransport,
} from "./http-mcp-boundary";
import { testProjectScope } from "./__tests__/scope-fixture";

function context(): AgentGateContext {
  resetGateForTests();
  const ctx = mintToken({
    label: "physical worker",
    role: "worker",
    providerId: "codex",
    missionId: "mission-a",
    workerIncarnationId: "incarnation-a",
    scope: testProjectScope(),
    allowedTools: ["nexus_handoff_submit"],
  });
  bindTokenToSession(ctx.token, "session-a");
  return ctx;
}

function orchestratorContext(): AgentGateContext {
  resetGateForTests();
  const ctx = mintToken({
    label: "physical Maestro",
    role: "orchestrator",
    providerId: "agy",
    missionId: "mission-a",
    scope: testProjectScope(),
    allowedTools: null,
  });
  bindTokenToSession(ctx.token, "session-maestro");
  return ctx;
}

function productionTypeScriptFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionTypeScriptFiles(resolved);
    if (
      !entry.isFile() ||
      !entry.name.endsWith(".ts") ||
      entry.name.endsWith(".test.ts")
    ) {
      return [];
    }
    return [resolved];
  });
}

describe("physical agent transport boundary", () => {
  afterEach(() => {
    resetGateForTests();
  });

  it("cannot mint a durable handoff receipt outside a physical transport", () => {
    const ctx = context();
    expect(() =>
      mintAgentTransportPhysicalReceipt({
        ctx,
        toolCallId: "tool-call-a",
        toolName: "nexus_handoff_submit",
      }),
    ).toThrow(/physical agent transport boundary/i);
  });

  it("mints a one-shot receipt only for the exact current PTY worker session", () => {
    const ctx = context();
    const consumed = runInsidePtyStreamAgentTransport(
      "session-a",
      ctx,
      () => {
        const receipt = mintAgentTransportPhysicalReceipt({
          ctx,
          toolCallId: "pty-call-a",
          toolName: "nexus_handoff_submit",
        });
        return consumeAgentTransportPhysicalReceipt(receipt, {
          projectId: ctx.scope.projectId,
          checkoutId: ctx.scope.checkoutId,
          missionId: ctx.missionId!,
          sessionId: "session-a",
          workerIncarnationId: ctx.workerIncarnationId,
          rawPayloadSha256: "a".repeat(64),
        });
      },
    );

    expect(consumed).toMatchObject({
      source: "pty-stream",
      toolCallId: "pty-call-a",
      missionId: "mission-a",
      sessionId: "session-a",
      workerIncarnationId: "incarnation-a",
    });
    expect(() =>
      runInsidePtyStreamAgentTransport("session-spoofed", ctx, () => null),
    ).toThrow(/current physical PTY mission session/i);
  });

  it("admits the exact current PTY Maestro to the physical transport boundary", () => {
    const ctx = orchestratorContext();

    const consumed = runInsidePtyStreamAgentTransport(
      "session-maestro",
      ctx,
      () => {
        const receipt = mintAgentTransportPhysicalReceipt({
          ctx,
          toolCallId: "pty-maestro-handoff",
          toolName: "nexus_handoff_submit",
        });
        return consumeAgentTransportPhysicalReceipt(receipt, {
          projectId: ctx.scope.projectId,
          checkoutId: ctx.scope.checkoutId,
          missionId: ctx.missionId!,
          sessionId: "session-maestro",
        });
      },
    );

    expect(consumed).toMatchObject({
      source: "pty-stream",
      toolCallId: "pty-maestro-handoff",
      missionId: "mission-a",
      sessionId: "session-maestro",
      workerIncarnationId: undefined,
    });
  });

  it("mints the same physical receipt from an authenticated mission shim intent", () => {
    const ctx = context();
    const consumed = runInsideMissionShimTransport(
      "session-a",
      "00000000-0000-4000-8000-000000000001",
      ctx,
      () => {
        const receipt = mintAgentTransportPhysicalReceipt({
          ctx,
          toolCallId: "shim-call-a",
          toolName: "nexus_handoff_submit",
        });
        return consumeAgentTransportPhysicalReceipt(receipt, {
          projectId: ctx.scope.projectId,
          checkoutId: ctx.scope.checkoutId,
          missionId: ctx.missionId!,
          sessionId: "session-a",
          workerIncarnationId: ctx.workerIncarnationId,
          rawPayloadSha256: "b".repeat(64),
        });
      },
    );

    expect(consumed).toMatchObject({
      source: "mission-shim",
      toolCallId: "shim-call-a",
      missionId: "mission-a",
      sessionId: "session-a",
      workerIncarnationId: "incarnation-a",
    });
  });

  it("does not widen the worker-only shim boundary to the Maestro", () => {
    const ctx = orchestratorContext();

    expect(() =>
      runInsideMissionShimTransport(
        "session-maestro",
        "00000000-0000-4000-8000-000000000002",
        ctx,
        () => null,
      ),
    ).toThrow(/mission shim session/i);
  });

  it.each(["nexus_handoff_ack", "nexus_mission_set_status"] as const)(
    "does not let the shim mint physical authority for %s",
    (toolName) => {
      const ctx = context();
      expect(() =>
        runInsideMissionShimTransport(
          "session-a",
          "00000000-0000-4000-8000-000000000003",
          ctx,
          () =>
            mintAgentTransportPhysicalReceipt({
              ctx,
              toolCallId: `shim-forbidden-${toolName}`,
              toolName,
            }),
        ),
      ).toThrow(/mission shim.*handoff submit/i);
    },
  );

  it("keeps every production capability seam owned by one exact module", () => {
    const mainDirectory = path.resolve(__dirname, "..");
    const owners = productionTypeScriptFiles(mainDirectory)
      .filter((file) => path.basename(file) !== "http-mcp-boundary.ts")
      .map((file) => ({
        file: path.relative(mainDirectory, file),
        source: fs.readFileSync(file, "utf8"),
      }));
    const importers = (symbol: string) =>
      owners
        .filter(({ source }) => source.includes(symbol))
        .map(({ file }) => file)
        .sort();

    expect(importers("runInsideHttpMcpTransport")).toEqual([
      "orch/mcp-server.ts",
    ]);
    expect(importers("runInsidePtyStreamAgentTransport")).toEqual([
      "orch/mcp-server.ts",
      "orch/pty-stream-handoff.ts",
    ]);
    expect(importers("runInsideMissionShimTransport")).toEqual([
      "orch/mission-shim-runtime.ts",
    ]);
    expect(importers("mintAgentTransportPhysicalReceipt")).toEqual([
      "orch/mcp-dispatch.ts",
      "orch/pty-stream-handoff.ts",
    ]);
    expect(importers("consumeAgentTransportPhysicalReceipt")).toEqual([
      "orch/handoff-physical-ack-authority.ts",
      "orch/handoff-store.ts",
    ]);
    expect(
      importers("inspectCurrentAgentTransportPhysicalReceipt"),
    ).toEqual([
      "orch/handoff-physical-ack-authority.ts",
      "orch/handoff-store.ts",
    ]);
  });
});

describe("V8 promise hook sharing (perf #7)", () => {
  function workerCtx(session: string, incarnation: string): AgentGateContext {
    const ctx = mintToken({
      label: `physical worker ${session}`,
      role: "worker",
      providerId: "codex",
      missionId: "mission-a",
      workerIncarnationId: incarnation,
      scope: testProjectScope(),
      allowedTools: ["nexus_handoff_submit"],
    });
    bindTokenToSession(ctx.token, session);
    return ctx;
  }

  it("installs one shared hook across overlapping async boundaries and releases it when idle", async () => {
    resetGateForTests();
    const ctxA = workerCtx("session-hook-a", "incarnation-hook-a");
    const ctxB = workerCtx("session-hook-b", "incarnation-hook-b");
    const createHookSpy = vi.spyOn(promiseHooks, "createHook");
    let releaseA!: () => void;
    let releaseB!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const gateB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    try {
      const runA = runInsidePtyStreamAgentTransport("session-hook-a", ctxA, async () => {
        await gateA;
      });
      const runB = runInsidePtyStreamAgentTransport("session-hook-b", ctxB, async () => {
        await gateB;
      });
      expect(createHookSpy).toHaveBeenCalledTimes(1);
      releaseA();
      await runA;
      releaseB();
      await runB;
      // Ocioso: o hook é desinstalado (o fast-path de Promise volta); a
      // próxima fronteira reinstala — nunca uma instalação por request.
      await runInsidePtyStreamAgentTransport("session-hook-a", ctxA, async () => {});
      expect(createHookSpy).toHaveBeenCalledTimes(2);
    } finally {
      createHookSpy.mockRestore();
      resetGateForTests();
    }
  });

  // L6: com o hook V8 compartilhado, o fechamento de uma fronteira não pode
  // revogar a outra nem desarmar o hook enquanto houver fence aberta, e a
  // verificação "a promise nasceu dentro desta fronteira" é POR fence.
  // "Vivo" é provado cunhando um recibo de DENTRO do contexto assíncrono da
  // fronteira: binding revogado lança "physical agent transport boundary".
  const REVOKED = /physical agent transport boundary/i;

  interface Deferred<T> {
    readonly promise: Promise<T>;
    readonly resolve: (value: T) => void;
  }

  function deferred<T = void>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((settle) => {
      resolve = settle;
    });
    return { promise, resolve };
  }

  function mintProbe(ctx: AgentGateContext, toolCallId: string): string | undefined {
    try {
      mintAgentTransportPhysicalReceipt({ ctx, toolCallId, toolName: "nexus_handoff_submit" });
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /** Macrotask agendada DENTRO da fronteira: roda depois de o `run*` voltar. */
  function mintProbeNextTick(ctx: AgentGateContext, toolCallId: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      setImmediate(() => resolve(mintProbe(ctx, toolCallId)));
    });
  }

  it("A fecha antes de B: B segue viva e a reação que B registrou na própria promise já vê live=false", async () => {
    resetGateForTests();
    const ctxA = workerCtx("session-hook-a", "incarnation-hook-a");
    const ctxB = workerCtx("session-hook-b", "incarnation-hook-b");
    const gateA = deferred();
    const aClosed = deferred();
    let resultB: Deferred<string> | undefined;
    let aAfterClose!: Promise<string | undefined>;
    let bWhileAClosed!: Promise<string | undefined>;
    let bSettlementReaction!: Promise<string | undefined>;
    let runA: Promise<void> | undefined;
    let runB: Promise<string> | undefined;
    try {
      runA = runInsidePtyStreamAgentTransport("session-hook-a", ctxA, async () => {
        aAfterClose = aClosed.promise.then(() => mintProbe(ctxA, "a-after-a-closed"));
        await gateA.promise;
      });
      runB = runInsidePtyStreamAgentTransport("session-hook-b", ctxB, () => {
        // Nasce DENTRO de B: uma promise de fora falharia fechada de saída.
        const result = deferred<string>();
        resultB = result;
        bWhileAClosed = aClosed.promise.then(() => mintProbe(ctxB, "b-while-a-is-closed"));
        // Registrada na promise de resultado de B ANTES do `.finally` de
        // fallback da fronteira: a ordem adversa que a fence de settlement cobre.
        bSettlementReaction = result.promise.then(() => mintProbe(ctxB, "b-in-own-settlement-reaction"));
        return result.promise;
      });

      gateA.resolve();
      await runA;
      aClosed.resolve();

      expect(await aAfterClose).toMatch(REVOKED);
      // O hook compartilhado fechou A, não B.
      expect(await bWhileAClosed).toBeUndefined();

      resultB!.resolve("b-done");
      await runB;
      expect(await bSettlementReaction).toMatch(REVOKED);
    } finally {
      gateA.resolve();
      resultB?.resolve("cleanup");
      aClosed.resolve();
      await Promise.allSettled([runA, runB]);
      resetGateForTests();
    }
  });

  it("o hook compartilhado só é desarmado depois que B fecha, a última fronteira aberta", async () => {
    resetGateForTests();
    const ctxA = workerCtx("session-hook-a", "incarnation-hook-a");
    const ctxB = workerCtx("session-hook-b", "incarnation-hook-b");
    const realCreateHook = promiseHooks.createHook.bind(promiseHooks);
    let created = 0;
    let stopped = 0;
    const createHookSpy = vi.spyOn(promiseHooks, "createHook").mockImplementation((callbacks) => {
      created += 1;
      const stop = realCreateHook(callbacks) as () => void;
      return () => {
        stopped += 1;
        stop();
      };
    });
    const gateA = deferred();
    const gateB = deferred();
    let runA: Promise<void> | undefined;
    let runB: Promise<void> | undefined;
    try {
      runA = runInsidePtyStreamAgentTransport("session-hook-a", ctxA, async () => {
        await gateA.promise;
      });
      runB = runInsidePtyStreamAgentTransport("session-hook-b", ctxB, async () => {
        await gateB.promise;
      });
      expect({ created, stopped }).toEqual({ created: 1, stopped: 0 });

      gateA.resolve();
      await runA;
      // A fechou, B segue aberta: o hook tem de continuar armado.
      expect({ created, stopped }).toEqual({ created: 1, stopped: 0 });

      gateB.resolve();
      await runB;
      expect({ created, stopped }).toEqual({ created: 1, stopped: 1 });
    } finally {
      gateA.resolve();
      gateB.resolve();
      await Promise.allSettled([runA, runB]);
      createHookSpy.mockRestore();
      resetGateForTests();
    }
  });

  it("promise criada antes de B abrir não está no conjunto observado de B: fail-closed, com A mantendo o hook armado", async () => {
    resetGateForTests();
    const ctxA = workerCtx("session-hook-a", "incarnation-hook-a");
    const ctxB = workerCtx("session-hook-b", "incarnation-hook-b");
    const gateA = deferred();
    let foreign: Deferred<string> | undefined;
    let born: Deferred<string> | undefined;
    let runA: Promise<void> | undefined;
    let runBorn: Promise<string> | undefined;
    let runForeign: Promise<string> | undefined;
    try {
      runA = runInsidePtyStreamAgentTransport("session-hook-a", ctxA, async () => {
        await gateA.promise;
      });
      // Nasce com a fence de A viva (o hook compartilhado a observa para A) e
      // ANTES de B abrir: nunca entra no conjunto observado de B.
      foreign = deferred<string>();

      // Controle: a promise que nasce DENTRO de B mantém B viva enquanto pendente.
      let bornProbe!: Promise<string | undefined>;
      runBorn = runInsidePtyStreamAgentTransport("session-hook-b", ctxB, () => {
        born = deferred<string>();
        bornProbe = mintProbeNextTick(ctxB, "b-promise-born-inside");
        return born.promise;
      });
      expect(await bornProbe).toBeUndefined();
      born!.resolve("born");
      await runBorn;

      // Mesmo B, agora devolvendo a promise anterior a ele: a fronteira fecha
      // na hora, sem esperar o settlement dela (que segue pendente).
      let foreignProbe!: Promise<string | undefined>;
      const foreignPromise = foreign.promise;
      runForeign = runInsidePtyStreamAgentTransport("session-hook-b", ctxB, () => {
        foreignProbe = mintProbeNextTick(ctxB, "b-promise-born-before-b");
        return foreignPromise;
      });
      expect(await foreignProbe).toMatch(REVOKED);
    } finally {
      gateA.resolve();
      born?.resolve("cleanup");
      foreign?.resolve("cleanup");
      await Promise.allSettled([runA, runBorn, runForeign]);
      resetGateForTests();
    }
  });
});
