import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testProjectScope } from "./__tests__/scope-fixture";
import {
  bindTokenToSession,
  mintToken,
  releaseSession,
  resetGateForTests,
  type AgentGateContext,
} from "./gate";
import {
  createMissionShimRuntime,
  isMissionShimSandboxSupported,
  type MissionShimInvocation,
  type MissionShimRuntime,
} from "./mission-shim-runtime";

const execFileAsync = promisify(execFile);
const SESSION_ID = "session-mission-shim";

describe("mission shim filesystem transport", () => {
  it("degrades to the existing handoff paths when Windows OCI cannot mount the shim runtime", () => {
    expect(isMissionShimSandboxSupported("darwin")).toBe(true);
    expect(isMissionShimSandboxSupported("linux")).toBe(true);
    expect(isMissionShimSandboxSupported("win32")).toBe(false);
  });

  let baseDir = "";
  let ctx: AgentGateContext;
  let runtime: MissionShimRuntime;
  let invocations: MissionShimInvocation[];

  beforeEach(() => {
    baseDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nexus-mission-shim-test-"),
    );
    resetGateForTests();
    ctx = mintToken({
      label: "worker shim",
      role: "worker",
      missionId: "mission-shim",
      workerIncarnationId: "incarnation-shim",
      scope: testProjectScope(),
      allowedTools: [],
    });
    invocations = [];
    runtime = createMissionShimRuntime({
      ctx,
      baseDir,
      pollIntervalMs: 5,
      invoke: async (invocation) => {
        invocations.push(invocation);
        return {
          ok: true,
          tool: invocation.toolName,
          result: { accepted: true },
        };
      },
    });
    bindTokenToSession(ctx.token, SESSION_ID);
    runtime.bindSession(SESSION_ID);
  });

  afterEach(() => {
    runtime?.dispose();
    resetGateForTests();
    fs.rmSync(baseDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("injects private canonical commands and routes nx-mail send", async () => {
    const result = await execFileAsync(
      path.join(
        runtime.binDir,
        process.platform === "win32" ? "nx-mail.cmd" : "nx-mail",
      ),
      [
        "send",
        "--status",
        "success",
        "--summary",
        "Implementação concluída com testes e evidência verificável.",
      ],
      { env: { ...process.env, ...runtime.env } },
    );

    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      tool: "nexus_handoff_submit",
      result: { accepted: true },
    });
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({
      requestId: expect.any(String),
      sessionId: SESSION_ID,
      toolName: "nexus_handoff_submit",
      args: {
        status: "success",
        summary: "Implementação concluída com testes e evidência verificável.",
      },
    });
    expect(fs.statSync(runtime.rootDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(runtime.binDir).mode & 0o777).toBe(0o700);
  });

  it("preserves scalar-looking artifact paths instead of coercing them to JSON primitives", async () => {
    await execFileAsync(
      path.join(
        runtime.binDir,
        process.platform === "win32" ? "nx-mail.cmd" : "nx-mail",
      ),
      [
        "send",
        "--status",
        "success",
        "--summary",
        "Entrega concluída.",
        "--artifact",
        "12345",
      ],
      { env: { ...process.env, ...runtime.env } },
    );

    expect(invocations).toEqual([
      expect.objectContaining({
        toolName: "nexus_handoff_submit",
        args: {
          status: "success",
          summary: "Entrega concluída.",
          artifacts: ["12345"],
        },
      }),
    ]);
  });

  it("recovers a stale sequence lock left by a crashed shim process", async () => {
    const lockPath = path.join(runtime.rootDir, "state", "sequence.lock");
    fs.writeFileSync(lockPath, "orphaned", { mode: 0o600 });
    const staleAt = new Date(Date.now() - 10_000);
    fs.utimesSync(lockPath, staleAt, staleAt);

    await execFileAsync(
      path.join(
        runtime.binDir,
        process.platform === "win32" ? "nx-notify.cmd" : "nx-notify",
      ),
      ["heartbeat"],
      { env: { ...process.env, ...runtime.env } },
    );

    expect(invocations).toHaveLength(1);
    expect(fs.existsSync(lockPath)).toBe(false);
  }, 10_000);

  it.each([
    [
      "nx-mail",
      ["list", "--all"],
      "nexus_handoff_list",
      { includeDelivered: true },
    ],
    ["nx-task", ["list"], "nexus_task", { action: "list" }],
    ["nx-notify", ["heartbeat"], "nexus_worker_heartbeat", {}],
  ] as const)(
    "maps %s to one fixed canonical tool",
    async (command, args, toolName, expectedArgs) => {
      await execFileAsync(
        path.join(
          runtime.binDir,
          process.platform === "win32" ? `${command}.cmd` : command,
        ),
        [...args],
        { env: { ...process.env, ...runtime.env } },
      );

      expect(invocations).toHaveLength(1);
      expect(invocations[0]).toMatchObject({ toolName, args: expectedArgs });
    },
  );

  it("rejects tampering, replay, stale requests and out-of-order sequences before invoke", async () => {
    const valid = runtime.createRequestForTests({
      requestId: "00000000-0000-4000-8000-000000000001",
      sequence: 1,
      issuedAt: Date.now(),
      command: "notify",
      operation: "heartbeat",
      args: {},
    });
    const tampered = { ...valid, args: { injected: true } };

    expect(await runtime.processRequestForTests(tampered)).toMatchObject({
      ok: false,
      error: "invalid_capability_mac",
    });
    expect(invocations).toHaveLength(0);

    expect(await runtime.processRequestForTests(valid)).toMatchObject({
      ok: true,
    });
    expect(await runtime.processRequestForTests(valid)).toMatchObject({
      ok: false,
      error: "request_replayed",
    });

    const outOfOrder = runtime.createRequestForTests({
      requestId: "00000000-0000-4000-8000-000000000002",
      sequence: 1,
      issuedAt: Date.now(),
      command: "notify",
      operation: "heartbeat",
      args: {},
    });
    expect(await runtime.processRequestForTests(outOfOrder)).toMatchObject({
      ok: false,
      error: "request_sequence_invalid",
    });

    const stale = runtime.createRequestForTests({
      requestId: "00000000-0000-4000-8000-000000000003",
      sequence: 2,
      issuedAt: Date.now() - 60_000,
      command: "notify",
      operation: "heartbeat",
      args: {},
    });
    expect(await runtime.processRequestForTests(stale)).toMatchObject({
      ok: false,
      error: "request_expired",
    });
    expect(invocations).toHaveLength(1);
  });

  it("narrows signed mail arguments again at the Main boundary", async () => {
    const request = runtime.createRequestForTests({
      requestId: "00000000-0000-4000-8000-000000000006",
      sequence: 1,
      issuedAt: Date.now(),
      command: "mail",
      operation: "send",
      args: {
        status: "success",
        summary: "Entrega válida.",
        artifacts: [{ path: "resultado.txt" }],
        evidenceIds: ["evidence-a"],
        missionId: "mission-forged",
        workerIncarnationId: "incarnation-forged",
        unexpected: true,
      },
    });

    expect(await runtime.processRequestForTests(request)).toMatchObject({
      ok: true,
    });
    expect(invocations).toEqual([
      expect.objectContaining({
        toolName: "nexus_handoff_submit",
        args: {
          status: "success",
          summary: "Entrega válida.",
          artifacts: [{ path: "resultado.txt" }],
          evidenceIds: ["evidence-a"],
        },
      }),
    ]);
  });

  it("rejects unknown CLI flags instead of silently ignoring them", async () => {
    await expect(
      execFileAsync(
        path.join(
          runtime.binDir,
          process.platform === "win32" ? "nx-notify.cmd" : "nx-notify",
        ),
        ["heartbeat", "--mission", "mission-forged"],
        { env: { ...process.env, ...runtime.env } },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("opção não suportada: --mission"),
    });
    expect(invocations).toHaveLength(0);
  });

  it("revokes immediately with the physical session", async () => {
    releaseSession(SESSION_ID);
    const request = runtime.createRequestForTests({
      requestId: "00000000-0000-4000-8000-000000000004",
      sequence: 1,
      issuedAt: Date.now(),
      command: "notify",
      operation: "heartbeat",
      args: {},
    });

    expect(await runtime.processRequestForTests(request)).toMatchObject({
      ok: false,
      error: "session_authority_revoked",
    });
    expect(invocations).toHaveLength(0);
  });

  it("refuses symlink request files instead of following them", async () => {
    if (process.platform === "win32") return;
    const outside = path.join(baseDir, "outside.json");
    fs.writeFileSync(outside, "{}", { mode: 0o600 });
    const requestPath = path.join(
      runtime.requestsDir,
      "000000000001-00000000-0000-4000-8000-000000000005.json",
    );
    fs.symlinkSync(outside, requestPath);

    await runtime.scanNowForTests();

    expect(invocations).toHaveLength(0);
    expect(fs.readFileSync(outside, "utf8")).toBe("{}");
    expect(fs.existsSync(requestPath)).toBe(false);
  });

  it("binds the signed request identity to its claimed filename", async () => {
    const filenameRequestId = "00000000-0000-4000-8000-000000000007";
    const signedRequest = runtime.createRequestForTests({
      requestId: "00000000-0000-4000-8000-000000000008",
      sequence: 1,
      issuedAt: Date.now(),
      command: "notify",
      operation: "heartbeat",
      args: {},
    });
    fs.writeFileSync(
      path.join(
        runtime.requestsDir,
        `0000000000000001-${filenameRequestId}.json`,
      ),
      `${JSON.stringify(signedRequest)}\n`,
      { mode: 0o600 },
    );

    await runtime.scanNowForTests();

    expect(invocations).toHaveLength(0);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(runtime.responsesDir, `${filenameRequestId}.json`),
          "utf8",
        ),
      ),
    ).toMatchObject({ ok: false, error: "request_filename_mismatch" });
  });

  it("removes invalid directory entries instead of rescanning them forever", async () => {
    const junk = path.join(runtime.requestsDir, "junk-request");
    fs.mkdirSync(junk);
    fs.writeFileSync(path.join(junk, "payload"), "untrusted");

    await runtime.scanNowForTests();

    expect(fs.existsSync(junk)).toBe(false);
    expect(invocations).toHaveLength(0);
  });

  it("preserves an in-flight atomic request temp and reaps it after it is stale", async () => {
    const temporary = path.join(
      runtime.requestsDir,
      ".0000000000000001-00000000-0000-4000-8000-000000000011.json.1234.00000000-0000-4000-8000-000000000012.tmp",
    );
    fs.writeFileSync(temporary, "partial", { mode: 0o600 });

    await runtime.scanNowForTests();

    expect(fs.existsSync(temporary)).toBe(true);
    const staleAt = new Date(Date.now() - 60_000);
    fs.utimesSync(temporary, staleAt, staleAt);

    await runtime.scanNowForTests();

    expect(fs.existsSync(temporary)).toBe(false);
    expect(invocations).toHaveLength(0);
  });

  it("responds to an invalid hard-linked request and continues draining the queue", async () => {
    if (process.platform === "win32") return;
    const invalidRequestId = "00000000-0000-4000-8000-000000000009";
    const invalidSource = path.join(baseDir, "hard-linked-request.json");
    fs.writeFileSync(invalidSource, "{}", { mode: 0o600 });
    fs.linkSync(
      invalidSource,
      path.join(
        runtime.requestsDir,
        `0000000000000001-${invalidRequestId}.json`,
      ),
    );

    const validRequestId = "00000000-0000-4000-8000-000000000010";
    const valid = runtime.createRequestForTests({
      requestId: validRequestId,
      sequence: 2,
      issuedAt: Date.now(),
      command: "notify",
      operation: "heartbeat",
      args: {},
    });
    fs.writeFileSync(
      path.join(runtime.requestsDir, `0000000000000002-${validRequestId}.json`),
      `${JSON.stringify(valid)}\n`,
      { mode: 0o600 },
    );

    await runtime.scanNowForTests();

    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(runtime.responsesDir, `${invalidRequestId}.json`),
          "utf8",
        ),
      ),
    ).toMatchObject({ ok: false, error: "invalid_request" });
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(runtime.responsesDir, `${validRequestId}.json`),
          "utf8",
        ),
      ),
    ).toMatchObject({ ok: true });
    expect(invocations).toHaveLength(1);
  });
});
