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
  mintAgentTransportPhysicalReceipt,
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
    expect(importers("mintAgentTransportPhysicalReceipt")).toEqual([
      "orch/mcp-dispatch.ts",
      "orch/pty-stream-handoff.ts",
    ]);
    expect(importers("consumeAgentTransportPhysicalReceipt")).toEqual([
      "orch/handoff-store.ts",
    ]);
    expect(
      importers("inspectCurrentAgentTransportPhysicalReceipt"),
    ).toEqual(["orch/handoff-store.ts"]);
  });
});
