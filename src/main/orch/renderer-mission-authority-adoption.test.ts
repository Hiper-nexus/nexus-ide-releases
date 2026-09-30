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
  realUserHome: () => "/mock/home",
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
import { RendererMissionAuthority } from "./renderer-mission-authority";
import * as panes from "./pane-registry";
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
  setOperatorTabMissionProvider((ctx, task) => {
    const result = main.adoptOperatorHandForSpawn(ctx.sessionId!, task);
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

  it("ownGroup cria a missão do GRUPO: a coroa da aba não se move e o clique explícito ainda acha a 1ª", () => {
    const first = operatorPane("pane-a");
    const second = operatorPane("pane-b");
    register([
      { paneId: "pane-a", sessionId: first },
      { paneId: "pane-b", sessionId: second },
    ]);
    const main = authority();

    const a = main.createPaneMissionFromRenderer(owner, { paneId: "pane-a", title: "Missão · Login", tabKey: "space:login" });
    expect(a.ok).toBe(true);
    const missionId = a.mission!.id;

    const b = main.createPaneMissionFromRenderer(owner, { paneId: "pane-b", title: "Missão · Codex B", tabKey: "space:login", ownGroup: true });
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
    const c = main.createPaneMissionFromRenderer(owner, { paneId: "pane-c", title: "Missão · Login", tabKey: "space:login" });
    expect(c).toMatchObject({ ok: true, mission: { id: missionId } });
  });

  it("Astra 7: a associação aba→missão sobrevive ao reinício do Main (store reaberto, mapa em memória vazio)", () => {
    const first = operatorPane("pane-a");
    const second = operatorPane("pane-b");
    register([
      { paneId: "pane-a", sessionId: first },
      { paneId: "pane-b", sessionId: second },
    ]);
    const a = authority().createPaneMissionFromRenderer(owner, { paneId: "pane-a", title: "Missão · Login", tabKey: "__loose__" });
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
    const b = restarted.createPaneMissionFromRenderer(owner, { paneId: "pane-b", title: "Missão · Login", tabKey: "__loose__" });

    expect(b).toMatchObject({ ok: true, mission: { id: a.mission!.id } });
    expect(reopened.missions.list()).toHaveLength(1);
    // Outra aba, depois do reinício, continua ganhando a sua.
    const third = operatorPane("pane-c");
    register([
      { paneId: "pane-a", sessionId: first },
      { paneId: "pane-b", sessionId: second },
      { paneId: "pane-c", sessionId: third },
    ]);
    const c = restarted.createPaneMissionFromRenderer(owner, { paneId: "pane-c", title: "Missão · Pagamento", tabKey: "space:pay" });
    expect(c.ok && c.mission!.id !== a.mission!.id).toBe(true);
    // Missão da aba encerrada: o próximo clique explícito cria outra, sem ressuscitar a antiga.
    reopened.missions.update(a.mission!.id, { status: "failed" });
    expect(returnOperatorHandFromEndedMission(getContextBySession(second)!)).toBe(true);
    const next = authority().createPaneMissionFromRenderer(owner, { paneId: "pane-b", title: "Missão · Login 2", tabKey: "__loose__" });
    expect(next.ok && next.mission!.id !== a.mission!.id).toBe(true);
  });

  it("Astra 1: missão do próprio grupo já em uso (worker gravado) nunca é desfeita pela compensação de um spawn que falhou", () => {
    const first = operatorPane("pane-a");
    syncPanes(
      [{ paneId: "pane-a", sessionId: first, tabKey: "__loose__", title: "pane-a", kind: "cli-agent" as const, adapterId: "test-cli" }],
      owner,
    );
    const main = authority();
    const adopted = main.adoptOperatorHandForSpawn(first, "revise o login");
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
    const own = main.adoptOperatorHandForSpawn(second, "teste o login");
    expect(own.ok && own.created && own.mission!.id !== missionId).toBe(true);
    expect(main.discardUnusedTabMission(second, own.mission!.id)).toBe(true);
    expect(suite.missions.get(own.mission!.id)).toBeNull();
    expect(getContextBySession(second)).toMatchObject({ role: "user" });
  });

  it("troca de coroa na aba devolve o líder anterior a `user` com tudo que tinha, nunca worker sem tools", () => {
    const first = operatorPane("pane-a");
    const second = operatorPane("pane-b");
    register([
      { paneId: "pane-a", sessionId: first },
      { paneId: "pane-b", sessionId: second },
    ]);
    getContextBySession(first)!.allowedTools = ["nexus_pane_list"];
    const main = authority();
    const a = main.createPaneMissionFromRenderer(owner, { paneId: "pane-a", title: "Missão · Login", tabKey: "space:login" });
    const missionId = a.mission!.id;

    const b = main.createPaneMissionFromRenderer(owner, { paneId: "pane-b", title: "Missão · Login", tabKey: "space:login" });

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
    const again = main.createPaneMissionFromRenderer(owner, { paneId: "pane-a", title: "Missão · Login", tabKey: "space:login" });
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

    const a = main.adoptOperatorHandForSpawn(first, "revise o login");
    const b = main.adoptOperatorHandForSpawn(second, "teste o login");
    const c = main.adoptOperatorHandForSpawn(other, "revise o pagamento");

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
    const explicit = main.createPaneMissionFromRenderer(owner, { paneId: "pane-d", title: "Missão · Terminais", tabKey: "__loose__" });
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
});

describe("missionId órfão do layout — a autoridade selada do Main vence (F: pane reiniciar preso)", () => {
  it("spec persistido Y + renderer alega missão X inexistente com resume → canonical carrega Y", () => {
    const sessionId = operatorPane("pane-a");
    register([{ paneId: "pane-a", sessionId }]);
    const missionY = authority().createPaneMissionFromRenderer(owner, {
      paneId: "pane-a",
      title: "Missão · Persistida",
    }).mission!.id;

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
    const missionY = authority().createPaneMissionFromRenderer(owner, {
      paneId: "pane-a",
      title: "Missão · Persistida",
    }).mission!.id;
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

  it("renderer alega missão Z que EXISTE → a fence de divergência continua fechada", () => {
    const sessionA = operatorPane("pane-a");
    const sessionB = operatorPane("pane-b");
    register([
      { paneId: "pane-a", sessionId: sessionA },
      { paneId: "pane-b", sessionId: sessionB },
    ]);
    const main = authority();
    main.createPaneMissionFromRenderer(owner, { paneId: "pane-a", title: "Missão A", tabKey: "space:a" });
    const missionZ = main.createPaneMissionFromRenderer(owner, { paneId: "pane-b", title: "Missão Z", tabKey: "space:z" }).mission!.id;

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

  it("sem spec persistido + missão alegada que EXISTE → continua 'no longer registered'", () => {
    const sessionB = operatorPane("pane-b");
    register([{ paneId: "pane-b", sessionId: sessionB }]);
    const missionZ = authority().createPaneMissionFromRenderer(owner, {
      paneId: "pane-b",
      title: "Missão Z",
      tabKey: "space:z",
    }).mission!.id;

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
