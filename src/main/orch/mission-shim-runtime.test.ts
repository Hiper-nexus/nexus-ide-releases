import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
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
import { runInsideMissionShimTransport } from "./http-mcp-boundary";
import {
  createMissionShimRuntime,
  isMissionShimSandboxSupported,
  missionShimPosixLauncher,
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

  afterEach(async () => {
    await runtime?.dispose();
    resetGateForTests();
    fs.rmSync(baseDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it('settles a pending handler before removing its runtime and never publishes after disposal', async () => {
    await runtime.dispose();
    let finish!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    runtime = createMissionShimRuntime({ ctx, baseDir, pollIntervalMs: 60_000,
      invoke: async (invocation) => {
        started();
        await new Promise<void>((resolve) => { finish = resolve; });
        return { ok: true, tool: invocation.toolName, result: { accepted: true } };
      },
    });
    runtime.bindSession(SESSION_ID);
    const request = runtime.createRequestForTests({ requestId: '00000000-0000-4000-8000-000000000099',
      sequence: 1, issuedAt: Date.now(), command: 'notify', operation: 'heartbeat', args: {} });
    fs.writeFileSync(path.join(runtime.requestsDir, `0000000000000001-${request.requestId}.json`), JSON.stringify(request));
    const scan = runtime.scanNowForTests();
    void scan.catch(() => undefined);
    await entered;
    const stop = runtime.dispose();
    expect(stop).toBeInstanceOf(Promise);
    expect(fs.existsSync(runtime.rootDir)).toBe(true);
    finish();
    await stop;
    expect(fs.existsSync(runtime.rootDir)).toBe(false);
  });

  it('cleanup failure preserves revoked authority and waits the active handler, then permits cleanup retry', async () => {
    await runtime.dispose();
    let finish!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    runtime = createMissionShimRuntime({ ctx, baseDir, pollIntervalMs: 60_000,
      invoke: async (invocation) => { started(); await new Promise<void>((resolve) => { finish = resolve; }); return { ok: true, tool: invocation.toolName, result: {} }; },
    });
    runtime.bindSession(SESSION_ID);
    const request = runtime.createRequestForTests({ requestId: '00000000-0000-4000-8000-000000000098', sequence: 1, issuedAt: Date.now(), command: 'notify', operation: 'heartbeat', args: {} });
    fs.writeFileSync(path.join(runtime.requestsDir, `0000000000000001-${request.requestId}.json`), JSON.stringify(request));
    const scan = runtime.scanNowForTests(); void scan.catch(() => undefined); await entered;
    const remove = vi.spyOn(fs.promises, 'rm').mockRejectedValueOnce(new Error('finite cleanup denied'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const stopping = runtime.dispose(); const rejected = expect(stopping).rejects.toThrow('finite cleanup denied');
      expect(() => runtime.bindSession(SESSION_ID)).toThrow(/disposed/);
      expect(fs.existsSync(runtime.rootDir)).toBe(true);
      finish(); await rejected;
      expect(fs.existsSync(runtime.rootDir)).toBe(true);
      expect(fs.readdirSync(runtime.responsesDir)).toEqual([]);
      remove.mockRestore(); await runtime.dispose();
      expect(fs.existsSync(runtime.rootDir)).toBe(false);
    } finally { remove.mockRestore(); warning.mockRestore(); }
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

  // ── alias canônico nexus_handoff_submit (padrão invokta, 19/08) ──
  // O voo real: worker qwen sem MCP rodou `nexus_handoff_submit` como
  // comando de shell e recebeu command-not-found. Agora o nome canônico da
  // ação existe no PATH do pane e roteia pro MESMO dispatcher.
  it("nexus_handoff_submit com flags roteia como mail send", async () => {
    const result = await execFileAsync(
      path.join(
        runtime.binDir,
        process.platform === "win32"
          ? "nexus_handoff_submit.cmd"
          : "nexus_handoff_submit",
      ),
      ["--status", "success", "--summary", "Entrega da story com evidência."],
      { env: { ...process.env, ...runtime.env } },
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      tool: "nexus_handoff_submit",
    });
    expect(invocations.at(-1)).toMatchObject({
      toolName: "nexus_handoff_submit",
      args: { status: "success", summary: "Entrega da story com evidência." },
    });
  });

  it("F-971: worker aberto DENTRO da chamada de outro agente entrega pelo shim (o timer não herda a fronteira)", async () => {
    await runtime.dispose();
    const opener = mintToken({
      label: "quem abriu o worker",
      role: "worker",
      missionId: "mission-shim",
      workerIncarnationId: "incarnation-opener",
      scope: testProjectScope(),
      allowedTools: [],
    });
    bindTokenToSession(opener.token, "session-opener");
    runtime = createMissionShimRuntime({
      ctx,
      baseDir,
      pollIntervalMs: 5,
      invoke: async (invocation) => {
        invocations.push(invocation);
        return { ok: true, tool: invocation.toolName, result: { accepted: true } };
      },
    });
    // O spawn (e o bind do shim) roda dentro do transporte físico de quem
    // abriu o worker — no app, a chamada MCP do orquestrador.
    runInsideMissionShimTransport("session-opener", randomUUID(), opener, () =>
      runtime.bindSession(SESSION_ID),
    );
    const result = await execFileAsync(
      path.join(runtime.binDir, "nexus_handoff_submit"),
      ["--status", "success", "--summary", "Entrega do worker aberto por outro agente."],
      { env: { ...process.env, ...runtime.env } },
    );
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, tool: "nexus_handoff_submit" });
    expect(invocations.at(-1)).toMatchObject({ toolName: "nexus_handoff_submit", sessionId: SESSION_ID });
  });

  it("nexus_handoff_submit aceita um único argumento JSON (estilo tool-call)", async () => {
    await execFileAsync(
      path.join(
        runtime.binDir,
        process.platform === "win32"
          ? "nexus_handoff_submit.cmd"
          : "nexus_handoff_submit",
      ),
      ['{"status":"blocked","summary":"Faltou credencial do provedor X."}'],
      { env: { ...process.env, ...runtime.env } },
    );
    expect(invocations.at(-1)).toMatchObject({
      toolName: "nexus_handoff_submit",
      args: { status: "blocked", summary: "Faltou credencial do provedor X." },
    });
  });

  it("`nexus handoff-submit` roteia pelo subcomando", async () => {
    await execFileAsync(
      path.join(
        runtime.binDir,
        process.platform === "win32" ? "nexus.cmd" : "nexus",
      ),
      ["handoff-submit", "--status", "partial", "--summary", "Metade entregue."],
      { env: { ...process.env, ...runtime.env } },
    );
    expect(invocations.at(-1)).toMatchObject({
      toolName: "nexus_handoff_submit",
      args: { status: "partial", summary: "Metade entregue." },
    });
  });

  // ── F-962: worker Muse relatou que `nx-mail --help` e
  // `nexus_handoff_submit --help` penduravam até o timeout. ──
  const bin = (name: string) =>
    path.join(runtime.binDir, process.platform === "win32" ? `${name}.cmd` : name);
  /** Ambiente sem o canal do Main: prova que a ajuda não depende dele. */
  const offlineEnv = () => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(runtime.env)) delete env[key];
    delete env.NEXUS_HEAVY_HELPER;
    delete env.NEXUS_HEAVY_LEASE;
    return env;
  };

  it("F-962: --help/-h/help responde localmente, na hora, sem dispatcher", async () => {
    const cases: Array<[string, string[], RegExp]> = [
      ["nx-mail", ["--help"], /uso: nx-mail send --status/],
      ["nx-mail", ["send", "--help"], /uso: nx-mail send --status/],
      ["nx-mail", ["help"], /nx-mail list \[--all\]/],
      ["nexus_handoff_submit", ["--help"], /uso: nexus_handoff_submit --status/],
      ["nexus_handoff_submit", ["-h"], /ou: nexus_handoff_submit '\{"status"/],
      ["nx-task", ["-h"], /uso: nx-task list/],
      ["nx-notify", ["--help"], /uso: nx-notify heartbeat/],
      ["nexus", ["--help"], /nx-mail send[\s\S]*nx-task list[\s\S]*nx-notify heartbeat/],
      ["nexus", ["handoff-submit", "--help"], /uso: nexus_handoff_submit/],
    ];
    for (const [name, args, usage] of cases) {
      const started = Date.now();
      const result = await execFileAsync(bin(name), args, {
        env: offlineEnv(),
        timeout: 5_000,
      });
      expect(result.stdout, `${name} ${args.join(" ")}`).toMatch(usage);
      expect(result.stdout).toContain("nada foi enviado ao Nexus");
      expect(Date.now() - started).toBeLessThan(5_000);
    }
    // Com o canal disponível, a ajuda também não vira pedido ao Main.
    await execFileAsync(bin("nx-mail"), ["--help"], {
      env: { ...process.env, ...runtime.env },
      timeout: 5_000,
    });
    expect(invocations).toHaveLength(0);
    expect(fs.readdirSync(path.join(runtime.rootDir, "requests"))).toEqual([]);
  }, 60_000);

  it("F-962: o valor de uma opção não é pedido de ajuda", async () => {
    await execFileAsync(
      bin("nx-mail"),
      ["send", "--status", "blocked", "--summary", "-h"],
      { env: { ...process.env, ...runtime.env }, timeout: 10_000 },
    );
    expect(invocations.at(-1)).toMatchObject({
      toolName: "nexus_handoff_submit",
      args: { status: "blocked", summary: "-h" },
    });
  }, 20_000);

  it.skipIf(process.platform !== "darwin" || !fs.existsSync("/usr/bin/perl"))(
    "F-962: a fila de admissão pesada do pane não segura --help nem o handoff",
    async () => {
      // Reproduz o ambiente do pane no macOS: preload de admissão no
      // NODE_OPTIONS e uma base de job pesado que fica 20 s "na fila".
      const preload = path.resolve(
        __dirname,
        "../../../resources/heavy-command/preload.cjs",
      );
      const heavyEnv = {
        ...offlineEnv(),
        NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
        NEXUS_HEAVY_COMMAND_URL: "http://127.0.0.1:9/hook/heavy-command",
        NEXUS_GATE_TOKEN: "f962-token",
        NEXUS_HEAVY_JOB_BASE: JSON.stringify({
          file: "/usr/bin/perl",
          args: ["-e", "sleep 20", "heavy-job"],
        }),
      };
      const help = await execFileAsync(bin("nexus_handoff_submit"), ["--help"], {
        env: heavyEnv,
        timeout: 5_000,
      });
      expect(help.stdout).toMatch(/uso: nexus_handoff_submit --status/);

      const sent = await execFileAsync(
        bin("nx-mail"),
        ["send", "--status", "success", "--summary", "Estudo entregue sem fila."],
        { env: { ...heavyEnv, ...runtime.env }, timeout: 5_000 },
      );
      expect(JSON.parse(sent.stdout)).toMatchObject({ ok: true });
      expect(invocations.at(-1)).toMatchObject({
        toolName: "nexus_handoff_submit",
        args: { status: "success", summary: "Estudo entregue sem fila." },
      });
    },
    15_000,
  );

  it("F-962: sem Main respondendo, o shim termina dentro do prazo (nunca pendura)", async () => {
    // Canal órfão: ninguém lê os pedidos (Main travado/ausente).
    const orphan = fs.mkdtempSync(path.join(baseDir, "orphan-"));
    for (const dir of ["requests", "responses", "state"]) {
      fs.mkdirSync(path.join(orphan, dir), { mode: 0o700 });
    }
    const started = Date.now();
    const result = await execFileAsync(bin("nx-task"), ["list"], {
      env: {
        ...offlineEnv(),
        NEXUS_SHIM_ROOT: orphan,
        NEXUS_SHIM_CAPABILITY_ID: "00000000-0000-4000-8000-00000000f962",
        NEXUS_SHIM_SECRET: "a".repeat(64),
        NEXUS_SHIM_RESPONSE_TIMEOUT_MS: "200",
      },
      timeout: 5_000,
    }).catch((error: { stdout: string }) => error);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: "shim_response_timeout",
    });
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 20_000);

  it("F-962: lançador POSIX marca o cliente como auxiliar e repassa o prefixo", () => {
    const launcher = missionShimPosixLauncher("/tmp/a b/it's/nx-shim.cjs", "mail");
    expect(launcher.startsWith("#!/bin/sh\n")).toBe(true);
    expect(launcher).toContain("NEXUS_HEAVY_HELPER=1\nexport NEXUS_HEAVY_HELPER\n");
    expect(launcher).toContain(`'/tmp/a b/it'\\''s/nx-shim.cjs' mail "$@"`);
    expect(missionShimPosixLauncher("/x/nx-shim.cjs", "")).toContain(
      `'/x/nx-shim.cjs' "$@"`,
    );
  });
});
