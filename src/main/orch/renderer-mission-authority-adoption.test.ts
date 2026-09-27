import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";

/**
 * Ponta a ponta SEM mocks nas fronteiras que o P1 atravessava: gate real
 * (token `user` mintado), ficha PTY real (sessão direct-user num host falso),
 * registry real (syncPanes) e stores SQLite reais. Só o que é ambiente (binário,
 * userData, sessão persistente) é trocado.
 */
vi.mock("electron", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "adoption-userdata-"));
  return { app: { getPath: () => userData } };
});
vi.mock("../path-resolver", () => ({
  resolveSpawnBinary: (command: string) => ({
    binPath: `/mock/bin/${command || "cli"}`,
    effectivePath: "/mock/bin",
    source: "process-path",
  }),
  revalidateExecutable: (binPath: string) => binPath.startsWith("/"),
  resolveCliBinary: (command: string) => ({
    binPath: `/mock/bin/${command}`,
    effectivePath: "/mock/bin",
    source: "process-path",
  }),
  resolveWindowsCodexNpmShimLaunch: () => null,
}));
vi.mock("../pty/persistent-session", () => ({
  planPersistentAgentSpawn: (input: { file: string; args: readonly string[] }) => ({
    mode: "direct" as const,
    file: input.file,
    args: [...input.args],
  }),
  getPersistentSessionBackend: () => ({ killSessionSync: vi.fn() }),
}));
vi.mock("../persistence/persistent-session-store", () => ({
  upsertPersistentPty: vi.fn(() => true),
  deletePersistentPty: vi.fn(),
}));
vi.mock("../feature-flags/feature-flag-registry", () => ({
  getFeatureFlagRegistry: () => ({ isEnabled: () => false }),
}));
import type { CliPtyAdapter } from "../../shared/adapter-types";
import type { ProjectExecutionScope } from "../../shared/types";
import { ProjectRuntimeManager } from "../runtime/project-runtime-manager";
import {
  bindResolvedRendererWorkspaceScope,
  clearRendererWorkspaceScope,
} from "../persistence/renderer-workspace-scope";
import {
  getAgentSessionInfo,
  getOwnedAgentSessionInfo,
  orchTerminateSession,
  setPtyHost,
  setSquadCliPolicyLookupForTests,
  spawnAgentSession,
} from "../pty/pty-manager";
import type { PtyHost } from "../pty/pty-host-core";
import {
  bindTokenToSession,
  getContextBySession,
  mintToken,
  resetGateForTests,
  returnOperatorHandFromEndedMission,
} from "./gate";
import {
  configureProjectDomainStoreRegistry,
  disposeProjectDomainStoreRegistry,
  requireProjectDomainStoreRegistry,
} from "./project-domain-store-registry";
import { authorizeMainOwnedAgentSpawn } from "./main-owned-agent-spawn";
import {
  getPaneAuthzInfo,
  resolveCurrentMissionSpawnAuthoritySeal,
  syncPanes,
} from "./pane-registry";
import { RendererMissionAuthority } from "./renderer-mission-authority";

function fakeHost(): PtyHost {
  return {
    spawn(_spec, handlers) {
      let exited = false;
      return {
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
        terminate: vi.fn(async () => {
          if (!exited) {
            exited = true;
            handlers.onExit(0, 15);
          }
          return { ok: true, rootExited: true, descendantsExited: true };
        }),
      };
    },
  };
}

function adapter(): CliPtyAdapter {
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
    },
    env: { static: {}, passthrough: [], ephemeralHome: false },
    models: { flag: "--model", list: ["default"], default: "default" },
    promptInjection: { method: "arg", trailingNewline: true, bracketedPaste: false },
    stateParsing: { idle: { type: "timeout", ms: 500 }, shellIntegration: false, exitCodes: {} },
    quirks: { altScreen: false, requiresNoAutoUpdate: false, mcpAutoload: false, nexusMcp: "none" },
    control: { permission: { safe: [], yolo: [], modes: {}, default: "" } },
  } as CliPtyAdapter;
}

const owner = {
  id: 91,
  isDestroyed: () => false,
  isCrashed: () => false,
  send: () => {},
} as unknown as WebContents;

let dir: string;
let manager: ProjectRuntimeManager;
let scope: ProjectExecutionScope;
const sessions: string[] = [];

/** Um pane aberto pelo "+ Pane": sessão direct-user e token `user`. */
function operatorPane(paneId: string): string {
  const { sessionId } = spawnAgentSession(
    owner,
    { kind: "cli-agent", cols: 80, rows: 24, paneId, adapterId: "test-cli" },
    adapter(),
    {},
    { source: "direct-user", context: null, cwd: scope.rootRealPath, scope },
  );
  sessions.push(sessionId);
  const ctx = mintToken({ label: paneId, role: "user", scope });
  bindTokenToSession(ctx.token, sessionId);
  return sessionId;
}

function register(entries: Array<{ paneId: string; sessionId: string }>): void {
  syncPanes(
    entries.map((entry) => ({ ...entry, title: entry.paneId, kind: "cli-agent" as const, adapterId: "test-cli" })),
    owner,
  );
}

beforeEach(() => {
  resetGateForTests();
  setSquadCliPolicyLookupForTests(() => "operator-choice");
  setPtyHost(fakeHost());
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-adoption-")));
  scope = {
    version: 1,
    installationId: "installation-test",
    projectId: "project-test",
    checkoutId: "checkout-test",
    rootRealPath: dir,
    identitySource: "manifest",
  };
  bindResolvedRendererWorkspaceScope(owner, scope);
  manager = new ProjectRuntimeManager({ baseDir: path.join(dir, ".runtime"), appVersion: "test" });
  configureProjectDomainStoreRegistry(manager);
});

afterEach(async () => {
  for (const sessionId of sessions.splice(0)) await orchTerminateSession(sessionId);
  syncPanes([], owner);
  clearRendererWorkspaceScope(owner);
  setSquadCliPolicyLookupForTests(null);
  disposeProjectDomainStoreRegistry();
  manager.closeAll();
  fs.rmSync(dir, { recursive: true, force: true });
  resetGateForTests();
});

function authority(
  resolveContextRevision: () => string | undefined = () => undefined,
): RendererMissionAuthority {
  return new RendererMissionAuthority(requireProjectDomainStoreRegistry(), resolveContextRevision);
}

describe("missão leve da aba — adoção da mão do operador", () => {
  it("promove o pane user: gate, ficha PTY e composição selada concordam, e a retomada passa", () => {
    const sessionId = operatorPane("pane-a");
    register([{ paneId: "pane-a", sessionId }]);

    const result = authority().createPaneMissionFromRenderer(owner, {
      paneId: "pane-a",
      title: "Missão · Login",
    });

    expect(result).toMatchObject({ ok: true });
    const missionId = result.mission!.id;
    expect(getContextBySession(sessionId)).toMatchObject({
      role: "orchestrator",
      missionId,
      promotedFromUserSession: true,
    });
    expect(getOwnedAgentSessionInfo(owner, sessionId)).toMatchObject({
      role: "orchestrator",
      missionId,
    });
    expect(getPaneAuthzInfo("pane-a")).toMatchObject({ missionId, role: "orchestrator" });
    // Spawn físico de worker: o selo da missão livre sem squad existe.
    expect(() => resolveCurrentMissionSpawnAuthoritySeal(scope, missionId)).not.toThrow();
    // Retomada do orquestrador (pane fechado/reiniciado): selo persistido confere.
    const resumed = authorizeMainOwnedAgentSpawn(
      owner,
      {
        kind: "cli-agent",
        cols: 80,
        rows: 24,
        paneId: "pane-a",
        adapterId: "test-cli",
        model: "default",
        cwd: scope.rootRealPath,
        missionId,
        resume: true,
      },
      manager,
    );
    expect(resumed.persistedPane).toMatchObject({ missionId, role: "orchestrator" });
  });

  it("falha fechado quando o gate não aceita a adoção: nenhuma missão fica pendurada", () => {
    const sessionId = operatorPane("pane-a");
    register([{ paneId: "pane-a", sessionId }]);
    // Sessão `user` que já é mão de outro fluxo: o gate a deu a outra missão.
    getContextBySession(sessionId)!.role = "worker";

    const result = authority().createPaneMissionFromRenderer(owner, {
      paneId: "pane-a",
      title: "Missão · Login",
    });

    expect(result).toEqual({ ok: false, error: "promotion_failed" });
    expect(requireProjectDomainStoreRegistry().forScope(scope).missions.list()).toEqual([]);
    expect(getOwnedAgentSessionInfo(owner, sessionId)).toMatchObject({ role: "user" });
  });

  it("duas promoções na mesma aba reusam uma missão só", () => {
    const first = operatorPane("pane-a");
    const second = operatorPane("pane-b");
    register([
      { paneId: "pane-a", sessionId: first },
      { paneId: "pane-b", sessionId: second },
    ]);
    const main = authority();

    const a = main.createPaneMissionFromRenderer(owner, { paneId: "pane-a", title: "Missão · Login", tabKey: "space:login" });
    const b = main.createPaneMissionFromRenderer(owner, { paneId: "pane-b", title: "Missão · Login", tabKey: "space:login" });

    expect(a.ok && b.ok).toBe(true);
    expect(b.mission!.id).toBe(a.mission!.id);
    expect(requireProjectDomainStoreRegistry().forScope(scope).missions.list()).toHaveLength(1);
    expect(getContextBySession(second)).toMatchObject({ role: "orchestrator", missionId: a.mission!.id });
    // Outra aba ganha a sua.
    const third = operatorPane("pane-c");
    register([
      { paneId: "pane-a", sessionId: first },
      { paneId: "pane-b", sessionId: second },
      { paneId: "pane-c", sessionId: third },
    ]);
    const c = main.createPaneMissionFromRenderer(owner, { paneId: "pane-c", title: "Missão · Pagamento", tabKey: "space:pay" });
    expect(c.mission!.id).not.toBe(a.mission!.id);
  });

  it("missão encerrada devolve a mão e o pane pode liderar a próxima", () => {
    const sessionId = operatorPane("pane-a");
    register([{ paneId: "pane-a", sessionId }]);
    const main = authority();
    const first = main.createPaneMissionFromRenderer(owner, { paneId: "pane-a", title: "Missão · Login" });
    requireProjectDomainStoreRegistry().forScope(scope).missions.update(first.mission!.id, { status: "failed" });
    expect(returnOperatorHandFromEndedMission(getContextBySession(sessionId)!)).toBe(true);

    const next = main.createPaneMissionFromRenderer(owner, { paneId: "pane-a", title: "Missão · Login 2" });

    expect(next).toMatchObject({ ok: true });
    expect(getOwnedAgentSessionInfo(owner, sessionId)).toMatchObject({ missionId: next.mission!.id });
  });

  it("exceção no meio da promoção desfaz a missão e responde promotion_failed", () => {
    const sessionId = operatorPane("pane-a");
    register([{ paneId: "pane-a", sessionId }]);

    const result = authority(() => {
      throw new Error("workflow indisponível");
    }).createPaneMissionFromRenderer(owner, { paneId: "pane-a", title: "Missão · Login" });

    expect(result).toEqual({ ok: false, error: "promotion_failed" });
    const suite = requireProjectDomainStoreRegistry().forScope(scope);
    expect(suite.missions.list()).toEqual([]);
    expect(suite.missionPanes.findByPaneId("pane-a")).toBeNull();
    expect(getContextBySession(sessionId)).toMatchObject({ role: "user", missionId: undefined });
  });

  it("trocar de projeto não encerra o pane do operador que lidera a missão", async () => {
    const sessionId = operatorPane("pane-a");
    register([{ paneId: "pane-a", sessionId }]);
    expect(authority().createPaneMissionFromRenderer(owner, { paneId: "pane-a", title: "Missão · Login" }).ok).toBe(true);

    bindResolvedRendererWorkspaceScope(owner, { ...scope, projectId: "outro", checkoutId: "outro", rootRealPath: "/outro" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(getAgentSessionInfo(sessionId)).not.toBeNull();
  });
});
