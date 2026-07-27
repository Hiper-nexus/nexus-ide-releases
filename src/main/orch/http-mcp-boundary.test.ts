import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bindTokenToSession,
  mintToken,
  resetGateForTests,
  type AgentGateContext,
} from "./gate";
import {
  consumeAgentTransportPhysicalReceipt,
  inspectCurrentAgentTransportPhysicalReceipt,
  mintAgentTransportPhysicalReceipt,
  mintOmpRpcPhysicalHostCall,
  runInsideOmpRpcHostCall,
} from "./http-mcp-boundary";
import { testProjectScope } from "./__tests__/scope-fixture";

function context(): AgentGateContext {
  resetGateForTests();
  const ctx = mintToken({
    label: "omp physical worker",
    role: "worker",
    providerId: "omp",
    missionId: "mission-a",
    workerIncarnationId: "incarnation-a",
    scope: testProjectScope(),
    allowedTools: ["nexus_handoff_submit"],
  });
  bindTokenToSession(ctx.token, "session-a");
  return ctx;
}

function captureError(operation: () => unknown): string | undefined {
  try {
    operation();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
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

  it("rejects a mismatched scope, then consumes an OMP receipt exactly once", () => {
    const ctx = context();
    const hostCall = mintOmpRpcPhysicalHostCall({
      sessionId: ctx.sessionId!,
      childPid: 4242,
      callId: "omp-call-a",
      toolName: "nexus_handoff_submit",
    });

    runInsideOmpRpcHostCall(hostCall, ctx, "nexus_handoff_submit", () => {
      const receipt = mintAgentTransportPhysicalReceipt({
        ctx,
        toolCallId: "tool-call-a",
        toolName: "nexus_handoff_submit",
      });
      expect(() =>
        consumeAgentTransportPhysicalReceipt(receipt, {
          projectId: ctx.scope.projectId,
          checkoutId: ctx.scope.checkoutId,
          missionId: "mission-other",
          sessionId: ctx.sessionId!,
          workerIncarnationId: ctx.workerIncarnationId,
        }),
      ).toThrow(/out-of-scope/i);

      const expectation = {
        projectId: ctx.scope.projectId,
        checkoutId: ctx.scope.checkoutId,
        missionId: ctx.missionId!,
        sessionId: ctx.sessionId!,
        workerIncarnationId: ctx.workerIncarnationId,
      };
      const inspected = inspectCurrentAgentTransportPhysicalReceipt(
        receipt,
        expectation,
      );
      const consumed = consumeAgentTransportPhysicalReceipt(receipt, {
        ...expectation,
      });
      expect(consumed).toEqual(inspected);
      expect(consumed).toMatchObject({
        source: "omp-rpc-stdio",
        toolCallId: "tool-call-a",
        toolName: "nexus_handoff_submit",
        missionId: "mission-a",
        sessionId: "session-a",
        workerIncarnationId: "incarnation-a",
        authoritySha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
      expect(() =>
        consumeAgentTransportPhysicalReceipt(receipt, {
          projectId: ctx.scope.projectId,
          checkoutId: ctx.scope.checkoutId,
          missionId: ctx.missionId!,
          sessionId: ctx.sessionId!,
          workerIncarnationId: ctx.workerIncarnationId,
        }),
      ).toThrow(/invalid, stale/i);
    });

    expect(() =>
      runInsideOmpRpcHostCall(
        hostCall,
        ctx,
        "nexus_handoff_submit",
        () => undefined,
      ),
    ).toThrow(/physical OMP RPC host call/i);
  });

  it("revokes detached OMP async resources after the synchronous host boundary returns", async () => {
    const ctx = context();
    const hostCall = mintOmpRpcPhysicalHostCall({
      sessionId: ctx.sessionId!,
      childPid: 4242,
      callId: "omp-call-detached",
      toolName: "nexus_handoff_submit",
    });
    let releaseDetached!: () => void;
    const detachedGate = new Promise<void>((resolve) => {
      releaseDetached = resolve;
    });
    let detachedAttempt!: Promise<{
      mintError: string | undefined;
      consumeError: string | undefined;
    }>;

    runInsideOmpRpcHostCall(
      hostCall,
      ctx,
      "nexus_handoff_submit",
      () => {
        const receipt = mintAgentTransportPhysicalReceipt({
          ctx,
          toolCallId: "tool-call-before-omp-return",
          toolName: "nexus_handoff_submit",
        });
        // Register while ALS is active, but release only after the physical
        // host boundary has returned. The callback retains stale ALS state.
        detachedAttempt = detachedGate.then(() => ({
          mintError: captureError(() =>
            mintAgentTransportPhysicalReceipt({
              ctx,
              toolCallId: "tool-call-after-omp-return",
              toolName: "nexus_handoff_submit",
            }),
          ),
          consumeError: captureError(() =>
            consumeAgentTransportPhysicalReceipt(receipt, {
              projectId: ctx.scope.projectId,
              checkoutId: ctx.scope.checkoutId,
              missionId: ctx.missionId!,
              sessionId: ctx.sessionId!,
              workerIncarnationId: ctx.workerIncarnationId,
            }),
          ),
        }));
      },
    );

    releaseDetached();
    await expect(detachedAttempt).resolves.toEqual({
      mintError: expect.stringMatching(/physical agent transport boundary/i),
      consumeError: expect.stringMatching(/invalid, stale or out-of-scope/i),
    });
  });

  it("revokes OMP authority before reactions of the settled operation promise", async () => {
    const ctx = context();
    const hostCall = mintOmpRpcPhysicalHostCall({
      sessionId: ctx.sessionId!,
      childPid: 4242,
      callId: "omp-call-settlement-reaction",
      toolName: "nexus_handoff_submit",
    });
    let reactionAttempt!: Promise<{
      mintError: string | undefined;
      consumeError: string | undefined;
    }>;

    const operation = runInsideOmpRpcHostCall(
      hostCall,
      ctx,
      "nexus_handoff_submit",
      () => {
        const receipt = mintAgentTransportPhysicalReceipt({
          ctx,
          toolCallId: "tool-call-before-omp-settle",
          toolName: "nexus_handoff_submit",
        });
        const settledResult = Promise.resolve("logical-result");
        // This reaction is registered before runWithLiveTransport can attach
        // its fallback `.finally`. It must still observe revoked authority.
        reactionAttempt = settledResult.then(() => ({
          mintError: captureError(() =>
            mintAgentTransportPhysicalReceipt({
              ctx,
              toolCallId: "tool-call-in-omp-settlement-reaction",
              toolName: "nexus_handoff_submit",
            }),
          ),
          consumeError: captureError(() =>
            consumeAgentTransportPhysicalReceipt(receipt, {
              projectId: ctx.scope.projectId,
              checkoutId: ctx.scope.checkoutId,
              missionId: ctx.missionId!,
              sessionId: ctx.sessionId!,
              workerIncarnationId: ctx.workerIncarnationId,
            }),
          ),
        }));
        return settledResult;
      },
    );

    await expect(operation).resolves.toBe("logical-result");
    await expect(reactionAttempt).resolves.toEqual({
      mintError: expect.stringMatching(/physical agent transport boundary/i),
      consumeError: expect.stringMatching(/invalid, stale or out-of-scope/i),
    });
  });

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
    expect(importers("mintAgentTransportPhysicalReceipt")).toEqual([
      "orch/mcp-dispatch.ts",
    ]);
    expect(importers("consumeAgentTransportPhysicalReceipt")).toEqual([
      "orch/handoff-store.ts",
    ]);
    expect(
      importers("inspectCurrentAgentTransportPhysicalReceipt"),
    ).toEqual(["orch/handoff-store.ts"]);
    expect(importers("mintOmpRpcPhysicalHostCall")).toEqual([
      "adapters/omp-rpc-service.ts",
    ]);
    expect(importers("runInsideOmpRpcHostCall")).toEqual([
      "adapters/omp-rpc-ipc.ts",
    ]);
  });
});
