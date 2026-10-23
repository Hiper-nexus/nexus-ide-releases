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
vi.mock('../license-access', async () => (await import('../__tests__/licensed-access')).licensedAccessMock);

const advisor = vi.hoisted(() => ({ scheduleMissionKickoffAdvice: vi.fn() }));
vi.mock("./jev-mission-advisor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./jev-mission-advisor")>()),
  scheduleMissionKickoffAdvice: advisor.scheduleMissionKickoffAdvice,
}));
vi.mock("electron", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "adoption-userdata-"));
  return { app: { getPath: () => userData } };
});
vi.mock("../path-resolver", async (importOriginal) => ({
  // Parcial: o gate do Codex (F-790) e o aquecimento de versão leem outros
  // exports do resolvedor; só o que o teste controla é substituído.
  ...(await importOriginal<typeof import("../path-resolver")>()),
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
  realUserHome: () => "/mock/home",
  // F-790: a versão do Codex vem do cache (sonda fora do Main). Versão
  // conhecida e nula = "desconhecida" sem disparar sonda nenhuma no teste.
  cachedCliBinaryVersion: () => null,
  probeCliBinaryVersion: async () => null,
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
const physical = vi.hoisted(() => ({
  spawned: [] as Array<Record<string, unknown>>,
  allocateIsolatedWriterWorktree: vi.fn(async () => ({
    worktreePath: "/tmp/nexus-wt/aba-1", branch: "nexus/aba/1", release: () => {},
    // Contrato do 1c: o spawn liga o pane à worktree e o recibo traz o SHA base.
    baseSha: "0".repeat(40), link: () => {},
  })),
}));
// Só o spawn físico do helper e a alocação de worktree git são falsos aqui.
vi.mock("./tool-util", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tool-util")>()),
  spawnPaneAndMaybePrompt: vi.fn(async (options: Record<string, unknown>) => {
    physical.spawned.push(options);
    return { paneId: `helper-${physical.spawned.length}`, sessionId: `pty-helper-${physical.spawned.length}` };
  }),
}));
vi.mock("./isolated-writer-worktree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./isolated-writer-worktree")>()),
  allocateIsolatedWriterWorktree: physical.allocateIsolatedWriterWorktree,
}));
// F-231: o caminho Main-owned é o dos workers do Maestro — aqui só a borda
// é substituída (o físico já é falso); validação/autoridade/roster/record
// continuam reais.
const operatorSpawn = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  present: vi.fn(),
}));
vi.mock("./pane-registry", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./pane-registry")>();
  return {
    ...actual,
    presentMainOwnedPaneToRenderer: operatorSpawn.present,
    spawnMainOwnedMissionPaneAsync: vi.fn(
      async (options: Record<string, unknown>) => {
        operatorSpawn.calls.push(options);
        return {
          requestId: `req-op-${operatorSpawn.calls.length}`,
          ok: true,
          paneId: `pane-op-${operatorSpawn.calls.length}`,
          sessionId: `pty-op-${operatorSpawn.calls.length}`,
        };
      },
    ),
  };
});
// F-1002: o PTY físico do pane do operador é falso aqui (a borda do spawn é
// substituída acima). A conta/esforço que o Main SELOU nele é o que a
// apresentação do pane lê; o teste injeta essa ficha física por sessionId.
const operatorPhysical = vi.hoisted(
  () => new Map<string, Record<string, unknown>>(),
);
vi.mock("../pty/pty-manager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pty/pty-manager")>();
  return {
    ...actual,
    getAgentSessionInfo: (sessionId: string) =>
      (operatorPhysical.get(sessionId) as unknown as ReturnType<
        typeof actual.getAgentSessionInfo
      >) ?? actual.getAgentSessionInfo(sessionId),
  };
});
// F-231: o registry só é povoado por initAdapterRegistry (boot); nos testes
// servimos direto o cli-pty de teste e um api-provider para a recusa "só API".
const testAdapter = vi.hoisted(() => ({
  cli: null as unknown,
}));
vi.mock("../adapters/adapter-registry", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../adapters/adapter-registry")>();
  return {
    ...actual,
    getAdapter: (id: string) => {
      if (id === "test-cli") {
        return testAdapter.cli as ReturnType<typeof actual.getAdapter>;
      }
      if (id === "api-only-x") {
        return {
          kind: "api-provider",
          id: "api-only-x",
          label: "API Only",
          auth: { method: "api_key" },
        } as unknown as ReturnType<typeof actual.getAdapter>;
      }
      return actual.getAdapter(id);
    },
    isAdapterInstalled: (id: string) =>
      id === "test-cli" || actual.isAdapterInstalled(id),
  };
});
vi.mock("../feature-flags/feature-flag-registry", () => ({
  getFeatureFlagRegistry: () => ({ isEnabled: () => false }),
}));
import type { CliPtyAdapter } from "../../shared/adapter-types";
import type { ProjectExecutionScope } from "../../shared/types";
import { ProjectRuntimeManager } from "../runtime/project-runtime-manager";
import {
  configureContextWorkflowRegistry,
  disposeContextWorkflowRegistry,
} from "../context/context-workflow-registry";
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
import { requireMissionLeaderSession } from "./mission-leader-gate";
import {
  getPaneAuthzInfo,
  resolveCurrentMissionSpawnAuthoritySeal,
  syncPanes,
} from "./pane-registry";
import { captureMissionCodeBaseline } from './mission-code-baseline-ledger';
import { RendererMissionAuthority } from "./renderer-mission-authority";
import * as panes from "./pane-registry";
import * as nativeDb from '../persistence/db';
import { saveProviderPaneSession, getProviderPaneSession, copyProviderPaneSession } from '../persistence/provider-session-store';
import { operatorTabMissionResumeSpec } from './operator-tab-mission-resume';
import { authorizePaneRef } from "./tool-util";
import { paneSpawnTool, setOperatorTabMissionProvider } from "./tools-panes";

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
  testAdapter.cli = adapter();
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
  configureContextWorkflowRegistry(manager, { appVersion: "test" });
});

afterEach(async () => {
  setOperatorTabMissionProvider(null);
  physical.spawned.length = 0;
  operatorSpawn.calls.length = 0;
  operatorSpawn.present.mockReset();
  operatorPhysical.clear();
  vi.restoreAllMocks();
  for (const sessionId of sessions.splice(0)) await orchTerminateSession(sessionId);
  syncPanes([], owner);
  clearRendererWorkspaceScope(owner);
  setSquadCliPolicyLookupForTests(null);
  disposeContextWorkflowRegistry();
  disposeProjectDomainStoreRegistry();
  manager.closeAll();
  fs.rmSync(dir, { recursive: true, force: true });
  resetGateForTests();
});

/** O provider de produção (orch-ipc), sem os broadcasts de janela. */
function useTabMissionProvider(main: RendererMissionAuthority): void {
  setOperatorTabMissionProvider(async (ctx, task) => {
    const result = (await main.adoptOperatorHandForSpawn(ctx.sessionId!, task));
    if (!result.ok || !result.mission) return null;
    const missionId = result.mission.id;
    return {
      missionId,
      discardIfUnused: () => {
        if (result.created) main.discardUnusedTabMission(ctx.sessionId!, missionId);
      },
    };
  });
}

function authority(
  resolveContextRevision: () => string | undefined = () => undefined,
): RendererMissionAuthority {
  return new RendererMissionAuthority(requireProjectDomainStoreRegistry(), resolveContextRevision);
}

describe("missão leve da aba — adoção da mão do operador", () => {
  it('F-1113: actual normal adoption and reopened domain/native stores preserve the exact conversation for a new pane', async () => {
    const sessionId = operatorPane('native-original'); register([{ paneId: 'native-original', sessionId }]);
    const result = await authority().createPaneMissionFromRenderer(owner, { paneId: 'native-original', title: 'Runtime native fixture', ownGroup: true });
    expect(result.ok).toBe(true); expect(result.mission?.squadId).toBeUndefined();
    expect(result.mission?.intentContract?.workspaceBinding?.adoptedPaneId).toBe('native-original');
    const db = manager.open(scope).db;
    db.exec(`CREATE TABLE IF NOT EXISTS provider_pane_sessions (installation_id TEXT NOT NULL, project_id TEXT NOT NULL, checkout_id TEXT NOT NULL,
      pane_id TEXT NOT NULL, adapter_id TEXT NOT NULL, session_key TEXT NOT NULL, session_id TEXT NOT NULL, transcript_path TEXT, updated_at INTEGER NOT NULL,
      account_id TEXT, PRIMARY KEY (installation_id, project_id, checkout_id, pane_id, adapter_id))`);
    const access = vi.spyOn(nativeDb, 'getDb').mockReturnValue(db);
    expect(saveProviderPaneSession(scope, 'native-original', 'test-cli', { key: 'session_id', id: 'native-before-restart' })).toBe(true);
    expect(await orchTerminateSession(sessionId)).toBe(true);
    access.mockRestore(); disposeContextWorkflowRegistry(); disposeProjectDomainStoreRegistry(); manager.closeAll();
    manager = new ProjectRuntimeManager({ baseDir: path.join(dir, '.runtime'), appVersion: 'test-restarted' });
    configureProjectDomainStoreRegistry(manager); configureContextWorkflowRegistry(manager, { appVersion: 'test-restarted' });
    const suite = requireProjectDomainStoreRegistry().forScope(scope), mission = suite.missions.get(result.mission!.id)!;
    const spec = operatorTabMissionResumeSpec(mission, suite.missionPanes.list(mission.id));
    expect(spec?.paneId).toBe('native-original');
    vi.spyOn(nativeDb, 'getDb').mockReturnValue(manager.open(scope).db);
    expect(copyProviderPaneSession(scope, spec!.paneId!, 'new-normal-pane', 'test-cli')).toBe(true);
    expect(getProviderPaneSession(scope, 'new-normal-pane', 'test-cli')).toEqual({ key: 'session_id', id: 'native-before-restart' });
    expect(copyProviderPaneSession({ ...scope, checkoutId: 'foreign' }, spec!.paneId!, 'foreign-pane', 'test-cli')).toBe(false);
    expect(operatorTabMissionResumeSpec({ ...mission, squadId: 'prepared-squad' }, suite.missionPanes.list(mission.id))).toBeNull();
  });
  it("promove o pane user: gate, ficha PTY e composição selada concordam, e a retomada passa", async () => {
    const sessionId = operatorPane("pane-a");
    register([{ paneId: "pane-a", sessionId }]);

    const result = (await authority().createPaneMissionFromRenderer(owner, {
      paneId: "pane-a",
      title: "Missão · Login",
    }));

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

  it("F-1166: a missão da +pane agenda o kickoff consultivo (sem esperar) só quando nasce", async () => {
    advisor.scheduleMissionKickoffAdvice.mockClear();
    const sessionId = operatorPane("pane-a");
    register([{ paneId: "pane-a", sessionId }]);
    const result = (await authority().createPaneMissionFromRenderer(owner, { paneId: "pane-a", title: "Missão · Kickoff" }));
    expect(result).toMatchObject({ ok: true, created: true });
    expect(advisor.scheduleMissionKickoffAdvice).toHaveBeenCalledTimes(1);
    expect(advisor.scheduleMissionKickoffAdvice).toHaveBeenCalledWith(expect.objectContaining({
      missionId: result.mission!.id, origin: "pane", goal: expect.stringContaining("Kickoff"),
    }));
  });

  it("falha fechado quando o gate não aceita a adoção: nenhuma missão fica pendurada", async () => {
    advisor.scheduleMissionKickoffAdvice.mockClear();
    const sessionId = operatorPane("pane-a");
    register([{ paneId: "pane-a", sessionId }]);
    // Sessão `user` que já é mão de outro fluxo: o gate a deu a outra missão.
    getContextBySession(sessionId)!.role = "worker";

    const result = (await authority().createPaneMissionFromRenderer(owner, {
      paneId: "pane-a",
      title: "Missão · Login",
    }));

    expect(result).toEqual({ ok: false, error: "promotion_failed" });
    expect(requireProjectDomainStoreRegistry().forScope(scope).missions.list()).toEqual([]);
    expect(advisor.scheduleMissionKickoffAdvice).not.toHaveBeenCalled();
    expect(getOwnedAgentSessionInfo(owner, sessionId)).toMatchObject({ role: "user" });
  });

  it("duas promoções na mesma aba reusam uma missão só", async () => {
    const first = operatorPane("pane-a");
    const second = operatorPane("pane-b");
    register([
      { paneId: "pane-a", sessionId: first },
      { paneId: "pane-b", sessionId: second },
    ]);
    const main = authority();

    const a = (await main.createPaneMissionFromRenderer(owner, { paneId: "pane-a", title: "Missão · Login", tabKey: "space:login" }));
    const b = (await main.createPaneMissionFromRenderer(owner, { paneId: "pane-b", title: "Missão · Login", tabKey: "space:login" }));

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
    const c = (await main.createPaneMissionFromRenderer(owner, { paneId: "pane-c", title: "Missão · Pagamento", tabKey: "space:pay" }));
    expect(c.mission!.id).not.toBe(a.mission!.id);
  });

  it("ownGroup cria a missão do GRUPO: a coroa da aba não se move e o clique explícito ainda acha a 1ª", async () => {
    const first = operatorPane("pane-a");
    const second = operatorPane("pane-b");
    register([
      { paneId: "pane-a", sessionId: first },
      { paneId: "pane-b", sessionId: second },
    ]);
    const main = authority();

    const a = (await main.createPaneMissionFromRenderer(owner, { paneId: "pane-a", title: "Missão · Login", tabKey: "space:login" }));
    expect(a.ok).toBe(true);
    const missionId = a.mission!.id;

    const b = (await main.createPaneMissionFromRenderer(owner, { paneId: "pane-b", title: "Missão · Codex B", tabKey: "space:login", ownGroup: true }));
    expect(b.ok).toBe(true);
    expect(b.mission!.id).not.toBe(missionId);
    const suite = requireProjectDomainStoreRegistry().forScope(scope);
    // A coroa da missão da aba não se moveu: cada missão tem o seu orquestrador.
    expect(suite.missions.get(missionId)?.orchestratorSessionId).toBe(first);
    expect(getContextBySession(first)).toMatchObject({ role: "orchestrator", missionId });
    expect(getContextBySession(second)).toMatchObject({ role: "orchestrator", missionId: b.mission!.id });
    // A missão do grupo não rouba a chave da aba: ela segue apontando a 1ª.
    expect(suite.missions.get(missionId)?.intentContract?.workspaceBinding?.tabKey).toBe("space:login");
    expect(suite.missions.get(b.mission!.id)?.intentContract?.workspaceBinding?.tabKey).toBeUndefined();

    // Clique explícito depois (sem ownGroup) reusa a missão DA ABA, não a do grupo.
    const third = operatorPane("pane-c");
    register([
      { paneId: "pane-a", sessionId: first },
      { paneId: "pane-b", sessionId: second },
      { paneId: "pane-c", sessionId: third },
    ]);
    const c = (await main.createPaneMissionFromRenderer(owner, { paneId: "pane-c", title: "Missão · Login", tabKey: "space:login" }));
    expect(c).toMatchObject({ ok: true, mission: { id: missionId } });
  });

  it("Astra 7: a associação aba→missão sobrevive ao reinício do Main (store reaberto, mapa em memória vazio)", async () => {
    const first = operatorPane("pane-a");
    const second = operatorPane("pane-b");
    register([
      { paneId: "pane-a", sessionId: first },
      { paneId: "pane-b", sessionId: second },
    ]);
    const a = (await authority().createPaneMissionFromRenderer(owner, { paneId: "pane-a", title: "Missão · Login", tabKey: "__loose__" }));
    expect(a.ok).toBe(true);
    const suite = requireProjectDomainStoreRegistry().forScope(scope);
    expect(suite.missions.get(a.mission!.id)?.intentContract?.workspaceBinding).toMatchObject({ adoptedPaneId: "pane-a", tabKey: "__loose__" });

    // Reinício do Main: o store SQLite é fechado e reaberto do disco e uma
    // autoridade nova nasce sem nada em memória.
    disposeProjectDomainStoreRegistry();
    manager.closeAll();
    manager = new ProjectRuntimeManager({ baseDir: path.join(dir, ".runtime"), appVersion: "test" });
    configureProjectDomainStoreRegistry(manager);
    const reopened = requireProjectDomainStoreRegistry().forScope(scope);
    expect(reopened.missions.get(a.mission!.id)?.intentContract?.workspaceBinding).toMatchObject({ tabKey: "__loose__" });
    const restarted = authority();
    const b = (await restarted.createPaneMissionFromRenderer(owner, { paneId: "pane-b", title: "Missão · Login", tabKey: "__loose__" }));

    expect(b).toMatchObject({ ok: true, mission: { id: a.mission!.id } });
    expect(reopened.missions.list()).toHaveLength(1);
    // Outra aba, depois do reinício, continua ganhando a sua.
    const third = operatorPane("pane-c");
    register([
      { paneId: "pane-a", sessionId: first },
      { paneId: "pane-b", sessionId: second },
      { paneId: "pane-c", sessionId: third },
    ]);
    const c = (await restarted.createPaneMissionFromRenderer(owner, { paneId: "pane-c", title: "Missão · Pagamento", tabKey: "space:pay" }));
    expect(c.ok && c.mission!.id !== a.mission!.id).toBe(true);
    // Missão da aba encerrada: o próximo clique explícito cria outra, sem ressuscitar a antiga.
    reopened.missions.update(a.mission!.id, { status: "failed" });
    expect(returnOperatorHandFromEndedMission(getContextBySession(second)!)).toBe(true);
    const next = (await authority().createPaneMissionFromRenderer(owner, { paneId: "pane-b", title: "Missão · Login 2", tabKey: "__loose__" }));
    expect(next.ok && next.mission!.id !== a.mission!.id).toBe(true);
  });

  it("Astra 1: missão do próprio grupo já em uso (worker gravado) nunca é desfeita pela compensação de um spawn que falhou", async () => {
    const first = operatorPane("pane-a");
    syncPanes(
      [{ paneId: "pane-a", sessionId: first, tabKey: "__loose__", title: "pane-a", kind: "cli-agent" as const, adapterId: "test-cli" }],
      owner,
    );
    const main = authority();
    const adopted = (await main.adoptOperatorHandForSpawn(first, "revise o login"));
    expect(adopted.ok && adopted.created).toBe(true);
    const missionId = adopted.mission!.id;
    const suite = requireProjectDomainStoreRegistry().forScope(scope);
    // O 1º helper nasceu e foi gravado na composição da missão.
    suite.missionPanes.record({ missionId, adapterId: "test-cli", title: "helper", role: "worker", paneId: "helper-1" });

    // Um spawn posterior falha e tenta compensar: a missão em uso fica.
    expect(main.discardUnusedTabMission(first, missionId)).toBe(false);
    expect(suite.missions.get(missionId)).toMatchObject({ status: "running", orchestratorSessionId: first });
    expect(getContextBySession(first)).toMatchObject({ role: "orchestrator", missionId });
    // Sem worker gravado, a compensação desfaz (o caminho do spawn que nunca abriu).
    const second = operatorPane("pane-b");
    syncPanes(
      [
        { paneId: "pane-a", sessionId: first, tabKey: "__loose__", title: "pane-a", kind: "cli-agent" as const, adapterId: "test-cli" },
        { paneId: "pane-b", sessionId: second, tabKey: "__loose__", title: "pane-b", kind: "cli-agent" as const, adapterId: "test-cli" },
      ],
      owner,
    );
    const own = (await main.adoptOperatorHandForSpawn(second, "teste o login"));
    expect(own.ok && own.created && own.mission!.id !== missionId).toBe(true);
    expect(main.discardUnusedTabMission(second, own.mission!.id)).toBe(true);
    expect(suite.missions.get(own.mission!.id)).toBeNull();
    expect(getContextBySession(second)).toMatchObject({ role: "user" });
  });

  it("F-1315: o pedido inteiro do operador vira o goal da missão, não os 60 chars do título", async () => {
    const sessionId = operatorPane("pane-goal");
    syncPanes(
      [{ paneId: "pane-goal", sessionId, tabKey: "__loose__", title: "pane-goal", kind: "cli-agent" as const, adapterId: "test-cli" }],
      owner,
    );
    const tail = "e fecha o relatório final no repositório.";
    const task =
      `quero um novo teste interno nexus de caça a bugs onde possa executar sem tocar no repo alheio, ` +
      "cuidadosamente e com provas de regressão. ".repeat(6) +
      tail;
    const result = await authority().adoptOperatorHandForSpawn(sessionId, task);

    expect(result.ok).toBe(true);
    const mission = result.mission!;
    // O contrato guarda o pedido completo (teto de 16.384 chars), o título é só rótulo.
    expect(mission.intentContract!.goal).toBe(task);
    // Os critérios não podem repetir só o título cortado: precisam do resto do pedido.
    expect((mission.intentContract!.acceptanceCriteria ?? []).join("\n")).toContain(tail);
    expect(mission.title).toBe(`Missão · ${task.slice(0, 60).trim()}`);
    expect(mission.title.length).toBeLessThanOrEqual(69);
  });

  it("troca de coroa na aba devolve o líder anterior a `user` com tudo que tinha, nunca worker sem tools", async () => {
    const first = operatorPane("pane-a");
    const second = operatorPane("pane-b");
    register([
      { paneId: "pane-a", sessionId: first },
      { paneId: "pane-b", sessionId: second },
    ]);
    getContextBySession(first)!.allowedTools = ["nexus_pane_list"];
    const main = authority();
    const a = (await main.createPaneMissionFromRenderer(owner, { paneId: "pane-a", title: "Missão · Login", tabKey: "space:login" }));
    const missionId = a.mission!.id;

    const b = (await main.createPaneMissionFromRenderer(owner, { paneId: "pane-b", title: "Missão · Login", tabKey: "space:login" }));

    expect(b).toMatchObject({ ok: true, mission: { id: missionId } });
    expect(getContextBySession(second)).toMatchObject({ role: "orchestrator", missionId });
    const previous = getContextBySession(first)!;
    expect(previous.role).toBe("user");
    expect(previous.missionId).toBeUndefined();
    expect(previous.promotedFromUserSession).toBeUndefined();
    expect(previous.allowedTools).toEqual(["nexus_pane_list"]);
    expect(getOwnedAgentSessionInfo(owner, first)).toMatchObject({ role: "user" });
    expect(getOwnedAgentSessionInfo(owner, first)?.missionId).toBeUndefined();
    // Nem a composição da missão nem a meta do pane o prendem: a retomada não o
    // restaura como worker e a autorização não o vê como pane da missão.
    expect(requireProjectDomainStoreRegistry().forScope(scope).missionPanes.findByPaneId("pane-a")).toBeNull();
    expect(getPaneAuthzInfo("pane-a")?.missionId).toBeUndefined();
    // E ele pode liderar de novo (a coroa volta sem ficar preso).
    const again = (await main.createPaneMissionFromRenderer(owner, { paneId: "pane-a", title: "Missão · Login", tabKey: "space:login" }));
    expect(again).toMatchObject({ ok: true, mission: { id: missionId } });
    expect(getContextBySession(second)).toMatchObject({ role: "user" });
  });

  it("missão sob demanda no checkout principal: cada pane que delega ganha a sua, ninguém toma a coroa", async () => {
    const first = operatorPane("pane-a");
    const second = operatorPane("pane-b");
    const other = operatorPane("pane-c");
    syncPanes(
      [
        { paneId: "pane-a", sessionId: first, tabKey: "__loose__" },
        { paneId: "pane-b", sessionId: second, tabKey: "__loose__" },
        { paneId: "pane-c", sessionId: other, tabKey: "space:pagamento" },
      ].map((entry) => ({ ...entry, title: entry.paneId, kind: "cli-agent" as const, adapterId: "test-cli" })),
      owner,
    );
    const main = authority();

    const a = (await main.adoptOperatorHandForSpawn(first, "revise o login"));
    const b = (await main.adoptOperatorHandForSpawn(second, "teste o login"));
    const c = (await main.adoptOperatorHandForSpawn(other, "revise o pagamento"));

    expect(a.ok && b.ok && c.ok).toBe(true);
    expect(new Set([a.mission!.id, b.mission!.id, c.mission!.id]).size).toBe(3);
    expect(requireProjectDomainStoreRegistry().forScope(scope).missions.list()).toHaveLength(3);
    expect(getContextBySession(first)).toMatchObject({ role: "orchestrator", missionId: a.mission!.id });
    expect(getContextBySession(second)).toMatchObject({ role: "orchestrator", missionId: b.mission!.id });
    // O clique explícito na aba continua achando a 1ª missão dela (a do A).
    const d = operatorPane("pane-d");
    syncPanes(
      [
        { paneId: "pane-a", sessionId: first, tabKey: "__loose__" },
        { paneId: "pane-b", sessionId: second, tabKey: "__loose__" },
        { paneId: "pane-c", sessionId: other, tabKey: "space:pagamento" },
        { paneId: "pane-d", sessionId: d, tabKey: "__loose__" },
      ].map((entry) => ({ ...entry, title: entry.paneId, kind: "cli-agent" as const, adapterId: "test-cli" })),
      owner,
    );
    const explicit = (await main.createPaneMissionFromRenderer(owner, { paneId: "pane-d", title: "Missão · Terminais", tabKey: "__loose__" }));
    expect(explicit).toMatchObject({ ok: true, mission: { id: a.mission!.id } });
    // A aba viaja no espelho, mas não vaza no nexus_pane_list.
    expect(panes.listPaneSnapshots().find((pane) => pane.paneId === "pane-a")).not.toHaveProperty("tabKey");
  });

  it("dois panes da mesma aba delegam: cada helper entrega ao pane que o abriu e a coroa só muda no clique", async () => {
    const paneA = operatorPane("pane-a");
    const paneB = operatorPane("pane-b");
    syncPanes(
      [
        { paneId: "pane-a", sessionId: paneA, tabKey: "space:login" },
        { paneId: "pane-b", sessionId: paneB, tabKey: "space:login" },
      ].map((entry) => ({ ...entry, title: entry.paneId, kind: "cli-agent" as const, adapterId: "test-cli" })),
      owner,
    );
    const main = authority();
    useTabMissionProvider(main);
    const ctxA = getContextBySession(paneA)!;
    const ctxB = getContextBySession(paneB)!;
    const suite = requireProjectDomainStoreRegistry().forScope(scope);
    const leaderOf = (missionId: string) => {
      const leader = requireMissionLeaderSession(scope, missionId, {});
      return leader.ok ? leader.leader.sessionId : null;
    };

    const helperA = (await paneSpawnTool.handler(
      { adapterId: "codex", prompt: "Revise o login", readOnly: true },
      ctxA,
    )) as { tabMission: { missionId: string } };
    const missionA = helperA.tabMission.missionId;
    const helperB = (await paneSpawnTool.handler(
      { adapterId: "codex", prompt: "Teste o login", readOnly: true },
      ctxB,
    )) as { tabMission: { missionId: string } };
    const missionB = helperB.tabMission.missionId;

    expect(missionB).not.toBe(missionA);
    expect(ctxA).toMatchObject({ role: "orchestrator", missionId: missionA });
    expect(ctxB).toMatchObject({ role: "orchestrator", missionId: missionB });
    expect(suite.missions.get(missionA)).toMatchObject({ status: "running", orchestratorSessionId: paneA });
    expect(suite.missions.get(missionB)).toMatchObject({ status: "running", orchestratorSessionId: paneB });
    expect(physical.spawned.map((spawn) => spawn.missionId)).toEqual([missionA, missionB]);
    // A entrega do helper vai ao líder da missão DELE (o alvo do idle-delivery).
    expect(leaderOf(missionA)).toBe(paneA);
    expect(leaderOf(missionB)).toBe(paneB);
    expect(getPaneAuthzInfo("pane-a")).toMatchObject({ missionId: missionA, role: "orchestrator" });
    expect(getPaneAuthzInfo("pane-b")).toMatchObject({ missionId: missionB, role: "orchestrator" });

    // 2º helper do A reusa a missão do A.
    const again = (await paneSpawnTool.handler(
      { adapterId: "codex", prompt: "Revise a sessão", readOnly: true },
      ctxA,
    )) as Record<string, unknown>;
    expect(again.tabMission).toBeUndefined();
    expect(physical.spawned[2]).toMatchObject({ missionId: missionA, role: "worker" });
    expect(suite.missions.list()).toHaveLength(2);
    expect(leaderOf(missionB)).toBe(paneB);

    // "Tornar orquestrador" explícito do B na missão do A: aí sim a coroa muda.
    const swapped = main.promoteOrchestratorFromRenderer(owner, missionA, { paneId: "pane-b" });
    expect(swapped).toMatchObject({ ok: false, error: "pane_mission_mismatch" });
    const paneC = operatorPane("pane-c");
    syncPanes(
      [
        { paneId: "pane-a", sessionId: paneA, tabKey: "space:login" },
        { paneId: "pane-b", sessionId: paneB, tabKey: "space:login" },
        { paneId: "pane-c", sessionId: paneC, tabKey: "space:login" },
      ].map((entry) => ({ ...entry, title: entry.paneId, kind: "cli-agent" as const, adapterId: "test-cli" })),
      owner,
    );
    expect(main.promoteOrchestratorFromRenderer(owner, missionA, { paneId: "pane-c" })).toMatchObject({ ok: true });
    expect(leaderOf(missionA)).toBe(paneC);
    expect(ctxA).toMatchObject({ role: "user" });
    expect(ctxA.missionId).toBeUndefined();
    expect(leaderOf(missionB)).toBe(paneB);
  });

  it("spawn com argumento inválido ou que falha não deixa missão da aba vazia nem pane promovido", async () => {
    const sessionId = operatorPane("pane-a");
    register([{ paneId: "pane-a", sessionId }]);
    useTabMissionProvider(authority());
    const ctx = getContextBySession(sessionId)!;
    const missions = () => requireProjectDomainStoreRegistry().forScope(scope).missions.list();

    await expect(
      paneSpawnTool.handler({ adapterId: "codex", prompt: "Revise o login", readOnly: true, expect: "json" }, ctx),
    ).rejects.toThrow(/expect inválido/);
    expect(missions()).toEqual([]);
    expect(ctx).toMatchObject({ role: "user" });

    const { spawnPaneAndMaybePrompt } = await import("./tool-util");
    vi.mocked(spawnPaneAndMaybePrompt).mockRejectedValueOnce(new Error("CLI não abriu"));
    await expect(
      paneSpawnTool.handler({ adapterId: "codex", prompt: "Revise o login", readOnly: true }, ctx),
    ).rejects.toThrow(/CLI não abriu/);
    expect(missions()).toEqual([]);
    expect(ctx.role).toBe("user");
    expect(ctx.missionId).toBeUndefined();
    expect(getOwnedAgentSessionInfo(owner, sessionId)).toMatchObject({ role: "user" });
    expect(getPaneAuthzInfo("pane-a")?.missionId).toBeUndefined();
  });

  it("missão encerrada devolve a mão e o pane pode liderar a próxima", async () => {
    const sessionId = operatorPane("pane-a");
    register([{ paneId: "pane-a", sessionId }]);
    const main = authority();
    const first = (await main.createPaneMissionFromRenderer(owner, { paneId: "pane-a", title: "Missão · Login" }));
    requireProjectDomainStoreRegistry().forScope(scope).missions.update(first.mission!.id, { status: "failed" });
    expect(returnOperatorHandFromEndedMission(getContextBySession(sessionId)!)).toBe(true);

    const next = (await main.createPaneMissionFromRenderer(owner, { paneId: "pane-a", title: "Missão · Login 2" }));

    expect(next).toMatchObject({ ok: true });
    expect(getOwnedAgentSessionInfo(owner, sessionId)).toMatchObject({ missionId: next.mission!.id });
  });

  it("pane novo logo após encerrar a missão anterior: o espelho do renderer ainda sem sessão não recusa a adoção", async () => {
    // Exercício canônico do runtime: a missão liderada pela mão do operador
    // acaba, o operador abre um pane novo e o adota no mesmo instante. O PTY
    // já é deste renderer (ficha Main-owned + gate `user`), mas o espelho do
    // layout só leva o sessionId no próximo quadro (rAF do orch-bridge).
    const oldHand = operatorPane("pane-old");
    register([{ paneId: "pane-old", sessionId: oldHand }]);
    const main = authority();
    const previous = await main.createPaneMissionFromRenderer(owner, { paneId: "pane-old", title: "Missão · Padrão", ownGroup: true });
    expect(previous.ok).toBe(true);
    requireProjectDomainStoreRegistry().forScope(scope).missions.update(previous.mission!.id, { status: "failed" });
    expect(returnOperatorHandFromEndedMission(getContextBySession(oldHand)!)).toBe(true);

    const fresh = operatorPane("pane-new");
    syncPanes(
      [
        { paneId: "pane-old", sessionId: oldHand },
        { paneId: "pane-new", sessionId: null },
      ].map((entry) => ({ ...entry, title: entry.paneId, kind: "cli-agent" as const, adapterId: "test-cli" })),
      owner,
    );

    const adopted = await main.createPaneMissionFromRenderer(owner, { paneId: "pane-new", title: "Runtime native", ownGroup: true });

    expect(adopted).toMatchObject({ ok: true, created: true });
    expect(adopted.mission?.id).not.toBe(previous.mission!.id);
    expect(adopted.mission?.squadId).toBeUndefined();
    expect(adopted.mission?.intentContract?.workspaceBinding?.adoptedPaneId).toBe("pane-new");
    expect(adopted.mission?.orchestratorSessionId).toBe(fresh);
    expect(getContextBySession(fresh)).toMatchObject({ role: "orchestrator", missionId: adopted.mission!.id });
    // A mão devolvida da missão anterior não é tocada.
    expect(getContextBySession(oldHand)).toMatchObject({ role: "user" });
    expect(getContextBySession(oldHand)?.missionId).toBeUndefined();
  });

  it("espelho sem sessão não vira atalho: PTY de outro pane, de outra janela ou ambíguo continua recusado", async () => {
    const other = operatorPane("pane-other");
    syncPanes(
      [
        { paneId: "pane-other", sessionId: other },
        { paneId: "pane-ghost", sessionId: null },
      ].map((entry) => ({ ...entry, title: entry.paneId, kind: "cli-agent" as const, adapterId: "test-cli" })),
      owner,
    );
    const main = authority();
    // Nenhum PTY nasceu para o pane-ghost: a sessão do vizinho não serve.
    expect(await main.createPaneMissionFromRenderer(owner, { paneId: "pane-ghost", title: "Missão", ownGroup: true }))
      .toEqual({ ok: false, error: "pane_unavailable" });
    // PTY do mesmo paneId, mas de OUTRA janela: não é deste renderer.
    const foreignOwner = { ...owner, id: 92 } as unknown as WebContents;
    bindResolvedRendererWorkspaceScope(foreignOwner, scope);
    const { sessionId: foreign } = spawnAgentSession(
      foreignOwner,
      { kind: "cli-agent", cols: 80, rows: 24, paneId: "pane-ghost", adapterId: "test-cli" },
      adapter(),
      {},
      { source: "direct-user", context: null, cwd: scope.rootRealPath, scope },
    );
    sessions.push(foreign);
    bindTokenToSession(mintToken({ label: "pane-ghost", role: "user", scope }).token, foreign);
    expect(await main.createPaneMissionFromRenderer(owner, { paneId: "pane-ghost", title: "Missão", ownGroup: true }))
      .toEqual({ ok: false, error: "pane_unavailable" });
    // Dois PTYs vivos deste renderer para o mesmo pane: ambíguo, falha fechado.
    operatorPane("pane-ghost");
    operatorPane("pane-ghost");
    expect(await main.createPaneMissionFromRenderer(owner, { paneId: "pane-ghost", title: "Missão", ownGroup: true }))
      .toEqual({ ok: false, error: "pane_unavailable" });
    expect(requireProjectDomainStoreRegistry().forScope(scope).missions.list()).toEqual([]);
    clearRendererWorkspaceScope(foreignOwner);
  });

  it("exceção no meio da promoção desfaz a missão e responde promotion_failed", async () => {
    const sessionId = operatorPane("pane-a");
    register([{ paneId: "pane-a", sessionId }]);

    const result = (await authority(() => {
      throw new Error("workflow indisponível");
    }).createPaneMissionFromRenderer(owner, { paneId: "pane-a", title: "Missão · Login" }));

    expect(result).toEqual({ ok: false, error: "promotion_failed" });
    const suite = requireProjectDomainStoreRegistry().forScope(scope);
    expect(suite.missions.list()).toEqual([]);
    expect(suite.missionPanes.findByPaneId("pane-a")).toBeNull();
    expect(getContextBySession(sessionId)).toMatchObject({ role: "user", missionId: undefined });
  });

  it("trocar de projeto não encerra o pane do operador que lidera a missão", async () => {
    const sessionId = operatorPane("pane-a");
    register([{ paneId: "pane-a", sessionId }]);
    expect((await authority().createPaneMissionFromRenderer(owner, { paneId: "pane-a", title: "Missão · Login" })).ok).toBe(true);

    bindResolvedRendererWorkspaceScope(owner, { ...scope, projectId: "outro", checkoutId: "outro", rootRealPath: "/outro" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(getAgentSessionInfo(sessionId)).not.toBeNull();
  });

  it("missão sob demanda: o 1º helper cria a missão da aba, o 2º reusa e o pane segue lendo a outra aba", async () => {
    const sessionId = operatorPane("pane-a");
    const otherTab = operatorPane("pane-outra-aba");
    register([
      { paneId: "pane-a", sessionId },
      { paneId: "pane-outra-aba", sessionId: otherTab },
    ]);
    const main = authority();
    useTabMissionProvider(main);
    const ctx = getContextBySession(sessionId)!;
    const missions = () => requireProjectDomainStoreRegistry().forScope(scope).missions.list();
    // Conversar (ler outro pane) não cria missão.
    expect(() => authorizePaneRef(ctx, "pane-outra-aba", "read")).not.toThrow();
    expect(missions()).toEqual([]);

    const first = (await paneSpawnTool.handler(
      { adapterId: "codex", prompt: "Revise o fluxo de login", readOnly: true },
      ctx,
    )) as Record<string, unknown>;

    expect(missions()).toHaveLength(1);
    const missionId = missions()[0]!.id;
    expect(missions()[0]).toMatchObject({ status: "running", orchestratorSessionId: sessionId });
    expect(first).toMatchObject({ tabMission: { missionId } });
    expect(ctx).toMatchObject({ role: "orchestrator", missionId, promotedFromUserSession: true });
    // O helper nasce na missão da aba, como worker dela (handoffs vão ao pane).
    expect(physical.spawned[0]).toMatchObject({ missionId, role: "worker" });
    // O pane não perdeu o alcance que tinha como mão do operador.
    expect(() => authorizePaneRef(ctx, "pane-outra-aba", "read")).not.toThrow();
    expect(panes.listVisiblePaneSnapshots(ctx).map((pane) => pane.paneId)).toContain("pane-outra-aba");

    // 2º helper, writer, com um writer ativo no mesmo checkout: reusa a missão
    // e vai para worktree própria em vez de ser recusado.
    const snapshots = panes.listPaneSnapshots();
    vi.spyOn(panes, "listPaneSnapshots").mockReturnValue([
      ...snapshots,
      {
        paneId: "helper-writer",
        sessionId: "pty-helper-writer",
        title: "writer",
        kind: "cli-agent",
        state: "busy",
        role: "worker",
        missionId,
        executionScope: scope,
      } as ReturnType<typeof panes.listPaneSnapshots>[number],
    ]);
    const second = (await paneSpawnTool.handler(
      { adapterId: "codex", prompt: "Implemente a validação do login" },
      ctx,
    )) as Record<string, unknown>;

    expect(missions()).toHaveLength(1);
    expect(physical.spawned[1]).toMatchObject({ missionId, role: "worker", isolatedWriter: true });
    expect(second).toMatchObject({ isolatedWorktree: { branch: "nexus/aba/1" } });
    expect(second.tabMission).toBeUndefined();
  });

  // F-810: a missão da aba existe para HOSPEDAR helpers. O texto livre do
  // pedido ou do nome da aba nunca a rebaixa a consult/plan/ops (maxWorkers 0):
  // o pane virava orquestrador de uma missão que recusava todo nexus_pane_spawn.
  it.each([
    ["análise (campo do relatório)", "Analise o fluxo de login e liste os riscos"],
    ["investigação", "Investigue por que o build falha"],
    ["auditoria de dependências", "Audite as dependências do projeto"],
    ["mapeamento", "Mapeie os endpoints da API"],
    ["planejamento", "Planejar a arquitetura do módulo de pagamentos"],
    ["operação", "Faça o deploy do site no servidor"],
    ["sincronização git", "Atualiza o repositório local com o GitHub"],
  ])("missão sob demanda (+ Pane): helper de %s abre, com missão standard e maxWorkers > 0", async (_label, prompt) => {
    const sessionId = operatorPane("pane-a");
    register([{ paneId: "pane-a", sessionId }]);
    useTabMissionProvider(authority());
    const ctx = getContextBySession(sessionId)!;

    const result = (await paneSpawnTool.handler(
      { adapterId: "codex", prompt, readOnly: true },
      ctx,
    )) as Record<string, unknown>;

    const mission = requireProjectDomainStoreRegistry().forScope(scope).missions.list()[0]!;
    expect(result).toMatchObject({ tabMission: { missionId: mission.id } });
    expect(physical.spawned[0]).toMatchObject({ missionId: mission.id, role: "worker" });
    expect(mission.intentContract?.lane).toBe("standard");
    expect(mission.intentContract?.budgets.maxWorkers).toBeGreaterThan(0);
  });

  it.each([
    "Missão · Deploy",
    "Missão · Backups",
    "Missão · Servidor",
    "Missão · Publicar site",
    "Missão · Migrar banco",
    "Missão · Atualizar repo",
    "Missão · Auditoria",
    "Missão · Análise de logs",
    "Missão · Diagnóstico do app",
    "Missão · Planejamento",
  ])("Tornar orquestrador na aba \"%s\": o helper seguinte abre (maxWorkers > 0)", async (title) => {
    const sessionId = operatorPane("pane-a");
    register([{ paneId: "pane-a", sessionId }]);
    const created = (await authority().createPaneMissionFromRenderer(owner, { paneId: "pane-a", title }));
    expect(created).toMatchObject({ ok: true });
    const missionId = created.mission!.id;
    const ctx = getContextBySession(sessionId)!;
    expect(ctx).toMatchObject({ role: "orchestrator", missionId });

    await paneSpawnTool.handler(
      { adapterId: "codex", prompt: "Revise o fluxo de login", readOnly: true },
      ctx,
    );

    expect(physical.spawned[0]).toMatchObject({ missionId, role: "worker" });
    const mission = requireProjectDomainStoreRegistry().forScope(scope).missions.get(missionId)!;
    expect(mission.intentContract?.lane).toBe("standard");
    expect(mission.intentContract?.budgets.maxWorkers).toBeGreaterThan(0);
  });
});

describe("missionId órfão do layout — a autoridade selada do Main vence (F: pane reiniciar preso)", () => {
  it("spec persistido Y + renderer alega missão X inexistente com resume → canonical carrega Y", async () => {
    const sessionId = operatorPane("pane-a");
    register([{ paneId: "pane-a", sessionId }]);
    const missionY = (await authority().createPaneMissionFromRenderer(owner, {
      paneId: "pane-a",
      title: "Missão · Persistida",
    })).mission!.id;

    const authorized = authorizeMainOwnedAgentSpawn(
      owner,
      {
        kind: "cli-agent",
        cols: 80,
        rows: 24,
        paneId: "pane-a",
        adapterId: "test-cli",
        model: "default",
        cwd: scope.rootRealPath,
        missionId: "mission-que-nao-existe",
        resume: true,
      },
      manager,
    );

    expect(authorized.persistedPane?.missionId).toBe(missionY);
    expect(authorized.request.missionId).toBe(missionY);
  });

  it("spec persistido Y + restorePersistedAuthority com missão X inexistente → fresh selado de Y", async () => {
    const sessionId = operatorPane("pane-a");
    register([{ paneId: "pane-a", sessionId }]);
    const missionY = (await authority().createPaneMissionFromRenderer(owner, {
      paneId: "pane-a",
      title: "Missão · Persistida",
    })).mission!.id;
    // Sessão morta: o fresh explícito só é honrado sem sessão viva.
    await orchTerminateSession(sessionId);

    const authorized = authorizeMainOwnedAgentSpawn(
      owner,
      {
        kind: "cli-agent",
        cols: 80,
        rows: 24,
        paneId: "pane-a",
        adapterId: "test-cli",
        model: "default",
        cwd: scope.rootRealPath,
        missionId: "mission-que-nao-existe",
        restorePersistedAuthority: true,
      },
      manager,
    );

    expect(authorized.request).toMatchObject({
      missionId: missionY,
      restorePersistedAuthority: true,
    });
  });

  it("renderer alega missão Z que EXISTE → a fence de divergência continua fechada", async () => {
    const sessionA = operatorPane("pane-a");
    const sessionB = operatorPane("pane-b");
    register([
      { paneId: "pane-a", sessionId: sessionA },
      { paneId: "pane-b", sessionId: sessionB },
    ]);
    const main = authority();
    (await main.createPaneMissionFromRenderer(owner, { paneId: "pane-a", title: "Missão A", tabKey: "space:a" }));
    const missionZ = (await main.createPaneMissionFromRenderer(owner, { paneId: "pane-b", title: "Missão Z", tabKey: "space:z" })).mission!.id;

    expect(() =>
      authorizeMainOwnedAgentSpawn(
        owner,
        {
          kind: "cli-agent",
          cols: 80,
          rows: 24,
          paneId: "pane-a",
          adapterId: "test-cli",
          model: "default",
          cwd: scope.rootRealPath,
          missionId: missionZ,
          resume: true,
        },
        manager,
      ),
    ).toThrow(/persisted pane request.*missionId/i);
  });

  it("sem spec persistido + missão alegada inexistente → spawns como pane direto, sem missionId", () => {
    const authorized = authorizeMainOwnedAgentSpawn(
      owner,
      {
        kind: "cli-agent",
        cols: 80,
        rows: 24,
        paneId: "pane-fantasma",
        adapterId: "test-cli",
        cwd: scope.rootRealPath,
        missionId: "mission-que-nao-existe",
        orchRequestId: "orchspawn-stale-do-layout",
      },
      manager,
    );

    expect(authorized.persistedPane).toBeNull();
    expect(authorized.request.missionId).toBeUndefined();
    expect(authorized.request.orchRequestId).toBeUndefined();
  });

  it("sem spec persistido + missão alegada que EXISTE → continua 'no longer registered'", async () => {
    const sessionB = operatorPane("pane-b");
    register([{ paneId: "pane-b", sessionId: sessionB }]);
    const missionZ = (await authority().createPaneMissionFromRenderer(owner, {
      paneId: "pane-b",
      title: "Missão Z",
      tabKey: "space:z",
    })).mission!.id;

    expect(() =>
      authorizeMainOwnedAgentSpawn(
        owner,
        {
          kind: "cli-agent",
          cols: 80,
          rows: 24,
          paneId: "pane-fantasma",
          adapterId: "test-cli",
          cwd: scope.rootRealPath,
          missionId: missionZ,
        },
        manager,
      ),
    ).toThrow(/no longer registered/i);
  });
});

describe("F-231 — '+ Pane' dentro da missão (spawnOperatorPaneFromRenderer)", () => {
  async function liveMission(): Promise<string> {
    const sessionId = operatorPane("pane-host");
    register([{ paneId: "pane-host", sessionId }]);
    const created = (await authority().createPaneMissionFromRenderer(owner, {
      paneId: "pane-host",
      title: "Missão · Operador",
    }));
    expect(created).toMatchObject({ ok: true });
    return created.mission!.id;
  }

  it("spawna worker do operador na missão viva: Main-owned, selado, operatorOpened", async () => {
    const missionId = await liveMission();

    const result = await authority().spawnOperatorPaneFromRenderer(owner, {
      missionId,
      adapterId: "test-cli",
      model: "default",
    });

    expect(result).toEqual({
      ok: true,
      paneId: "pane-op-1",
      sessionId: "pty-op-1",
    });
    const options = operatorSpawn.calls[0]!;
    expect(options).toMatchObject({
      missionId,
      adapterId: "test-cli",
      role: "worker",
      operatorOpened: true,
      cwd: expect.any(String),
    });
    expect(options.authoritySeal).toBeTruthy();
    // A linha durável da composição carrega a marca (Quadro/list/authz).
    const specs = requireProjectDomainStoreRegistry()
      .forScope(scope)
      .missionPanes.list(missionId);
    const spec = specs.find((entry) => entry.paneId === "pane-op-1");
    expect(spec).toMatchObject({
      role: "worker",
      operatorOpened: true,
      adapterId: "test-cli",
    });
  });

  it("F-398 presents the operator pane only after recording its durable composition", async () => {
    const missionId = await liveMission();
    operatorSpawn.present.mockImplementation((renderer, paneId) => {
      expect(renderer).toBe(owner);
      expect(requireProjectDomainStoreRegistry().forScope(scope).missionPanes.list(missionId))
        .toContainEqual(expect.objectContaining({ paneId, operatorOpened: true }));
    });
    const result = await authority().spawnOperatorPaneFromRenderer(owner, { missionId, adapterId: 'test-cli' });
    expect(result.ok).toBe(true);
    expect(operatorSpawn.present).toHaveBeenCalledExactlyOnceWith(owner, 'pane-op-1');
  });

  it("F-398 never presents a pane whose durable composition failed to record", async () => {
    const missionId = await liveMission();
    const suite = requireProjectDomainStoreRegistry().forScope(scope);
    vi.spyOn(suite.missionPanes, 'record').mockImplementationOnce(() => { throw new Error('record failed'); });
    const result = await authority().spawnOperatorPaneFromRenderer(owner, { missionId, adapterId: 'test-cli' });
    expect(result).toEqual({ ok: false, error: 'mission_pane_record_failed: record failed' });
    expect(operatorSpawn.present).not.toHaveBeenCalled();
  });

  it("F-1002: a linha durável sela a conta do PTY e a adoção pelo renderer passa na cerca", async () => {
    // Campo 07/10: "Claude · operador" nasceu na conta acct-mrqvpdwz-1 (Main
    // escolheu), a linha ficou com account_id NULL e a apresentação — que lê
    // o PTY — pedia a adoção com a conta. A cerca recusava em 1 ms, 49 vezes.
    const missionId = await liveMission();
    operatorPhysical.set("pty-op-1", {
      sessionId: "pty-op-1",
      paneId: "pane-op-1",
      missionId,
      adapterId: "test-cli",
      role: "worker",
      accountId: "acct-sealed-1",
      effort: "high",
      cwd: scope.rootRealPath,
    });

    const result = await authority().spawnOperatorPaneFromRenderer(owner, {
      missionId,
      adapterId: "test-cli",
      model: "default",
    });
    expect(result).toMatchObject({ ok: true, paneId: "pane-op-1" });

    const spec = requireProjectDomainStoreRegistry()
      .forScope(scope)
      .missionPanes.findByPaneId("pane-op-1");

    // O pedido que a apresentação Main-owned produz (pane = ficha do PTY).
    // Antes: "renderer payload does not match main-sealed persisted pane
    // request — divergências: accountId[acct-sealed-1 != undefined]".
    const authorized = authorizeMainOwnedAgentSpawn(
      owner,
      {
        kind: "cli-agent",
        cols: 80,
        rows: 24,
        paneId: "pane-op-1",
        adapterId: "test-cli",
        model: "default",
        accountId: "acct-sealed-1",
        effort: "high",
        cwd: spec!.cwd,
        missionId,
        restorePersistedAuthority: true,
      },
      manager,
    );
    expect(authorized.persistedPane).toMatchObject({
      paneId: "pane-op-1",
      accountId: "acct-sealed-1",
    });
    expect(authorized.request.accountId).toBe("acct-sealed-1");
    expect(spec).toMatchObject({
      accountId: "acct-sealed-1",
      effort: "high",
      operatorOpened: true,
    });
  });

  it("transporta o pin por id e conserva conta e esforço físicos no selo", async () => {
    const missionId = await liveMission();
    operatorPhysical.set("pty-op-1", {
      sessionId: "pty-op-1", paneId: "pane-op-1", missionId,
      adapterId: "test-cli", role: "worker", accountId: "acct-no-email",
      effort: "high", cwd: scope.rootRealPath,
    });
    const result = await authority().spawnOperatorPaneFromRenderer(owner, {
      missionId, adapterId: "test-cli", accountId: "acct-no-email",
    });
    expect(result).toMatchObject({ ok: true });
    expect(operatorSpawn.calls[0]).toMatchObject({ accountId: "acct-no-email" });
    expect(requireProjectDomainStoreRegistry().forScope(scope).missionPanes
      .findByPaneId("pane-op-1")).toMatchObject({
        accountId: "acct-no-email", effort: "high", workerIncarnationId: expect.any(String),
      });
  });

  it.each(["acct-other", undefined])("recusa pin sem prova física exata (%s)", async (accountId) => {
    const missionId = await liveMission();
    operatorPhysical.set("pty-op-1", {
      sessionId: "pty-op-1", paneId: "pane-op-1", missionId,
      adapterId: "test-cli", role: "worker", accountId, cwd: scope.rootRealPath,
    });
    const result = await authority().spawnOperatorPaneFromRenderer(owner, {
      missionId, adapterId: "test-cli", accountId: "acct-selected",
    });
    expect(result).toEqual({ ok: false, error: "selected account diverges from the authorized account pin" });
    expect(requireProjectDomainStoreRegistry().forScope(scope).missionPanes
      .findByPaneId("pane-op-1")).toBeNull();
  });

  it.each(["paneId", "missionId", "adapterId"])("recusa pin com identidade física estrangeira: %s", async (field) => {
    const missionId = await liveMission();
    operatorPhysical.set("pty-op-1", {
      sessionId: "pty-op-1", paneId: "pane-op-1", missionId,
      adapterId: "test-cli", role: "worker", accountId: "acct-selected",
      cwd: scope.rootRealPath, [field]: "foreign",
    });
    const result = await authority().spawnOperatorPaneFromRenderer(owner, {
      missionId, adapterId: "test-cli", accountId: "acct-selected",
    });
    expect(result).toMatchObject({ ok: false });
    expect(requireProjectDomainStoreRegistry().forScope(scope).missionPanes
      .findByPaneId("pane-op-1")).toBeNull();
  });

  it("F-1661: aceita CLI fora do roster como participante explícito do operador", async () => {
    const squadStore = await import("./squad-store");
    const { PET_STUDIO_SQUAD } = await import("../../shared/pet-studio");
    const getSquad = squadStore.getSquad;
    vi.spyOn(squadStore, "getSquad").mockImplementation((id) =>
      id === PET_STUDIO_SQUAD.id ? PET_STUDIO_SQUAD : getSquad(id),
    );
    expect(PET_STUDIO_SQUAD.agents.some((agent) => agent.cli === "test-cli")).toBe(false);
    const suite = requireProjectDomainStoreRegistry().forScope(scope);
    const templateMissionId = await liveMission();
    const template = suite.missions.get(templateMissionId)!;
    const mission = suite.missions.create({
      title: "Selada",
      squadId: "nexus-pet-studio",
      orchestratorSessionId: template.orchestratorSessionId,
      intentState: "dispatched",
      intentVersion: template.intentVersion,
      intentContract: {
        ...template.intentContract!,
        freeAgentChoice: false,
      },
    });
    suite.missions.update(mission.id, { status: "running" });
    const approved = suite.missions.get(mission.id)!;

    const result = await authority().spawnOperatorPaneFromRenderer(owner, {
      missionId: mission.id,
      adapterId: "test-cli",
    });

    expect(result).toEqual({
      ok: true,
      paneId: "pane-op-1",
      sessionId: "pty-op-1",
    });
    expect(operatorSpawn.calls[0]).toMatchObject({
      missionId: mission.id,
      adapterId: "test-cli",
      operatorOpened: true,
      authoritySeal: expect.objectContaining({ intentVersion: 1 }),
    });
    expect(suite.missionPanes.findByPaneId("pane-op-1")).toMatchObject({
      missionId: mission.id,
      adapterId: "test-cli",
      operatorOpened: true,
    });
    expect(operatorSpawn.present).toHaveBeenCalledExactlyOnceWith(owner, "pane-op-1");
    expect(suite.missions.get(mission.id)).toEqual(approved);
  });

  it("recusa missão que não está em execução", async () => {
    const missionId = await liveMission();
    const suite = requireProjectDomainStoreRegistry().forScope(scope);
    suite.missions.block(missionId, "technical");

    const result = await authority().spawnOperatorPaneFromRenderer(owner, {
      missionId,
      adapterId: "test-cli",
    });

    expect(result).toEqual({ ok: false, error: "mission_not_running" });
    expect(operatorSpawn.calls).toHaveLength(0);
  });

  it("recusa adapter inexistente e adapter api-provider (não abre pane)", async () => {
    const missionId = await liveMission();

    await expect(
      authority().spawnOperatorPaneFromRenderer(owner, {
        missionId,
        adapterId: "nao-existe-x",
      }),
    ).resolves.toEqual({ ok: false, error: "adapter_not_installed" });

    await expect(
      authority().spawnOperatorPaneFromRenderer(owner, {
        missionId,
        adapterId: "api-only-x",
      }),
    ).resolves.toEqual({ ok: false, error: "adapter_not_spawnable" });
    expect(operatorSpawn.calls).toHaveLength(0);
  });
});


describe('baseline before renderer mission creation', () => {
  function delayedAuthority() {
    const pending: Array<(value: Awaited<ReturnType<typeof captureMissionCodeBaseline>>) => void> = [];
    const capture = vi.fn(() => new Promise<Awaited<ReturnType<typeof captureMissionCodeBaseline>>>(resolve => pending.push(resolve)));
    const main = new RendererMissionAuthority(requireProjectDomainStoreRegistry(), () => undefined, undefined, capture);
    return { main, pending, capture };
  }

  it('rejects a workspace switch during HEAD capture before creating/adopting anything', async () => {
    const sessionId = operatorPane('baseline-pane'); register([{ paneId: 'baseline-pane', sessionId }]);
    const captured = await captureMissionCodeBaseline(dir);
    const { main, pending } = delayedAuthority();
    const result = main.createPaneMissionFromRenderer(owner, { paneId: 'baseline-pane', title: 'New mission' });
    expect(requireProjectDomainStoreRegistry().forScope(scope).missions.list()).toEqual([]);
    bindResolvedRendererWorkspaceScope(owner, { ...scope, checkoutId: 'other', rootRealPath: '/other' });
    pending[0]!(captured);
    expect(await result).toMatchObject({ ok: false });
    expect(requireProjectDomainStoreRegistry().forScope(scope).missions.list()).toEqual([]);
    expect(getContextBySession(sessionId)?.role).toBe('user');
  });

  it('rejects physical pane replacement while HEAD capture waits', async () => {
    const sessionId = operatorPane('baseline-pane'); register([{ paneId: 'baseline-pane', sessionId }]);
    const captured = await captureMissionCodeBaseline(dir);
    const { main, pending } = delayedAuthority();
    const result = main.createPaneMissionFromRenderer(owner, { paneId: 'baseline-pane', title: 'New mission' });
    syncPanes([], owner);
    pending[0]!(captured);
    expect(await result).toMatchObject({ ok: false });
    expect(requireProjectDomainStoreRegistry().forScope(scope).missions.list()).toEqual([]);
  });

  it('concurrent captures for the same pane create once and retain the first baseline', async () => {
    const sessionId = operatorPane('baseline-pane'); register([{ paneId: 'baseline-pane', sessionId }]);
    const first = await captureMissionCodeBaseline(dir, { now: () => 100 });
    const second = await captureMissionCodeBaseline(dir, { now: () => 200 });
    const { main, pending } = delayedAuthority();
    const a = main.createPaneMissionFromRenderer(owner, { paneId: 'baseline-pane', title: 'New mission', ownGroup: true });
    const b = main.createPaneMissionFromRenderer(owner, { paneId: 'baseline-pane', title: 'New mission', ownGroup: true });
    pending[0]!(first); const created = await a;
    pending[1]!(second); const reused = await b;
    expect(created).toMatchObject({ ok: true, created: true });
    expect(reused).toMatchObject({ ok: true, mission: { id: created.mission!.id } });
    expect(reused.created).toBeUndefined();
    const missions = requireProjectDomainStoreRegistry().forScope(scope).missions;
    expect(missions.list()).toHaveLength(1);
    expect(missions.codeBaseline.read(created.mission!.id, dir)).toEqual(first);
  });

  it('two different panes racing in the same tab reuse the first mission and baseline', async () => {
    const aSession = operatorPane('baseline-a'); const bSession = operatorPane('baseline-b');
    register([{ paneId: 'baseline-a', sessionId: aSession }, { paneId: 'baseline-b', sessionId: bSession }]);
    const first = await captureMissionCodeBaseline(dir, { now: () => 100 });
    const second = await captureMissionCodeBaseline(dir, { now: () => 200 });
    const { main, pending } = delayedAuthority();
    const a = main.createPaneMissionFromRenderer(owner, { paneId: 'baseline-a', title: 'New mission', tabKey: 'space:base' });
    const b = main.createPaneMissionFromRenderer(owner, { paneId: 'baseline-b', title: 'New mission', tabKey: 'space:base' });
    pending[0]!(first); const created = await a;
    pending[1]!(second); const reused = await b;
    expect(reused).toMatchObject({ ok: true, mission: { id: created.mission!.id } });
    const missions = requireProjectDomainStoreRegistry().forScope(scope).missions;
    expect(missions.list()).toHaveLength(1);
    expect(missions.codeBaseline.read(created.mission!.id, dir)).toEqual(first);
  });

  it('execution scope changing under the same coordination scope vetoes adoption', async () => {
    const sessionId = operatorPane('baseline-pane'); register([{ paneId: 'baseline-pane', sessionId }]);
    const captured = await captureMissionCodeBaseline(dir);
    const { main, pending } = delayedAuthority();
    const result = main.createPaneMissionFromRenderer(owner, { paneId: 'baseline-pane', title: 'New mission' });
    const api = await import('../pty/pty-manager');
    const info = getOwnedAgentSessionInfo(owner, sessionId)!;
    const other = { ...scope, rootRealPath: path.join(dir, 'new-execution') };
    getContextBySession(sessionId)!.executionScope = other;
    const spy = vi.spyOn(api, 'getOwnedAgentSessionInfo').mockReturnValue({ ...info, scope: other });
    pending[0]!(captured);
    expect(await result).toMatchObject({ ok: false });
    expect(requireProjectDomainStoreRegistry().forScope(scope).missions.list()).toEqual([]);
    spy.mockRestore(); getContextBySession(sessionId)!.executionScope = undefined;
  });

  it('unknown baseline permits startup and ledger failure rolls creation back atomically', async () => {
    const sessionId = operatorPane('baseline-pane'); register([{ paneId: 'baseline-pane', sessionId }]);
    const main = authority();
    const suite = requireProjectDomainStoreRegistry().forScope(scope);
    const fail = vi.spyOn(suite.missions.codeBaseline, 'record').mockImplementationOnce(() => { throw new Error('ledger failed'); });
    await expect(main.createPaneMissionFromRenderer(owner, { paneId: 'baseline-pane', title: 'New mission' })).rejects.toThrow('ledger failed');
    expect(suite.missions.list()).toEqual([]);
    expect(getContextBySession(sessionId)?.role).toBe('user');
    fail.mockRestore();
    const created = await main.createPaneMissionFromRenderer(owner, { paneId: 'baseline-pane', title: 'New mission' });
    expect(created.ok).toBe(true);
    expect(suite.missions.codeBaseline.read(created.mission!.id, dir)).toMatchObject({ status: 'unknown' });
  });
});
