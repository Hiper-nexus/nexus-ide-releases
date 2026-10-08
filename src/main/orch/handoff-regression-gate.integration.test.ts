/**
 * Portão de regressão na fronteira COMUM do handoff: gate, stores SQLite,
 * registry de worktrees, git e o sandbox do runner são reais. O único dublê é
 * o binário do runner (um script que detecta a regressão da fixture), executado de
 * verdade no sandbox.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compileIntentContract } from "../../shared/mission-intent";
import type { ProjectExecutionScope } from "../../shared/types";
import {
  configureAuditLogRuntime,
  disposeAuditLogRuntime,
} from "../jarvis/audit-log";
import { processSandboxRuntimeAvailable } from "../runtime/process-sandbox-capability";
import { setPtyHost } from "../pty/pty-manager";
import { currentDarwinPtySupervisorRuntime, supervisedJobCommand } from "../pty/darwin-pty-supervisor";
import { ProjectRuntimeManager } from "../runtime/project-runtime-manager";
import {
  configureWorktreeRuntimeRegistry,
  disposeWorktreeRuntimeRegistry,
} from "../runtime/worktree-runtime-registry";
import { __resetRegressionGateForTests } from "../regression-gate/regression-gate";
import { __resetRegressionHandoffBouncesForTests } from "../regression-gate/regression-gate-handoff";
import { testProjectScope } from "./__tests__/scope-fixture";
import { bindTokenToSession, mintToken, resetGateForTests } from "./gate";
import {
  configureProjectDomainStoreRegistry,
  disposeProjectDomainStoreRegistry,
  getProjectDomainStores,
} from "./project-domain-store-registry";
import {
  __resetTurnEndHandoffForTests,
  handleTurnEndMechanicalHandoff,
} from "./turn-end-handoff";
import { evaluateWriterHandoffRegression } from "./handoff-regression-gate";
import {
  allocateIsolatedWriterWorktree,
  resumeIsolatedWriterWorktree,
} from "./isolated-writer-worktree";

const spawnedAt = vi.hoisted(() => new Map<string, number>());

// Sem PTY neste teste: o horário de spawn da sessão vem daqui; o resto do
// pty-manager é o real. A UI/entrega ao Maestro fica fora.
vi.mock('../license-access', async () => (await import('../__tests__/licensed-access')).licensedAccessMock);

vi.mock("../pty/pty-manager", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../pty/pty-manager")>()),
  getLastSessionInputOrigin: () => "system",
  getSessionSpawnedAtMs: (sessionId: string) => spawnedAt.get(sessionId) ?? null,
}));
vi.mock("./idle-delivery", () => ({ onHandoffSubmitted: vi.fn() }));
vi.mock("./mission-story-plan", () => ({
  advanceFastLaneStoryTaskFromHandoff: vi.fn(),
}));
vi.mock("./worker-delivery-board", () => ({
  recordWorkerDeliveryIfDelivered: vi.fn(),
  markSessionSealedBoardCredited: vi.fn(),
  initWorkerDeliveryBoard: vi.fn(),
  shutdownWorkerDeliveryBoard: vi.fn(),
}));

/** "vitest" do projeto alvo: B passa; mudar a para 2 introduz a regressão. */
const FAILING_RUNNER = `#!/bin/sh
out=""
files=""
status=failed
exit_code=1
if grep -q '^export const a = 1;$' src/a.ts; then status=passed; exit_code=0; fi
for a in "$@"; do
  case "$a" in
    --outputFile=*) out="\${a#--outputFile=}" ;;
    *.test.ts) files="$files $a" ;;
  esac
done
sep=""
printf '{"testResults":[' > "$out"
for f in $files; do
  printf '%s{"name":"%s/%s","status":"%s","assertionResults":[{"status":"%s","fullName":"soma","failureMessages":["expected 2 to be 1"]}]}' "$sep" "$PWD" "$f" "$status" "$status" >> "$out"
  sep=","
done
printf ']}' >> "$out"
exit "$exit_code"
`;

let temp: string;
let manager: ProjectRuntimeManager;

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function installRunner(root: string): void {
  const bin = path.join(root, "node_modules", ".bin", "vitest");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, FAILING_RUNNER, { mode: 0o755 });
}

/** Repo com `src/a.ts` e o teste que o importa; runner instalado e ignorado. */
function fixtureRepo(): string {
  const root = path.join(temp, "repo");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  git(root, "init", "-q");
  git(root, "config", "user.name", "Nexus Test");
  git(root, "config", "user.email", "nexus@example.test");
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ devDependencies: { vitest: "*" } }),
  );
  fs.writeFileSync(path.join(root, ".gitignore"), "node_modules\n");
  fs.writeFileSync(path.join(root, "src/a.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(root, "src/a.test.ts"), "import { a } from './a';\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  installRunner(root);
  return root;
}

beforeEach(() => {
  if (process.platform === 'darwin') setPtyHost({
    spawn: () => { throw new Error('command fixture allocates no PTY'); },
    prepareCommandSupervisor: async (file, args) => supervisedJobCommand(currentDarwinPtySupervisorRuntime(process.cwd()), file, args),
  });
  temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-handoff-gate-")));
  manager = new ProjectRuntimeManager({
    baseDir: path.join(temp, "runtime"),
    appVersion: "handoff-gate-test",
  });
  configureProjectDomainStoreRegistry(manager);
  configureAuditLogRuntime(manager);
  resetGateForTests();
  __resetTurnEndHandoffForTests();
  __resetRegressionGateForTests();
  __resetRegressionHandoffBouncesForTests();
  spawnedAt.clear();
});

afterEach(() => {
  disposeWorktreeRuntimeRegistry();
  disposeProjectDomainStoreRegistry();
  disposeAuditLogRuntime();
  resetGateForTests();
  __resetTurnEndHandoffForTests();
  __resetRegressionGateForTests();
  __resetRegressionHandoffBouncesForTests();
  manager.closeAll();
  fs.rmSync(temp, { recursive: true, force: true });
});

const darwinOnly = process.platform === "darwin" && processSandboxRuntimeAvailable() ? describe : describe.skip;

darwinOnly("portão de regressão na fronteira comum do handoff", () => {
  it("fechamento mecânico (nasce success) com teste impactado falhando entra blocked — mesmo depois de o MCP recusar", async () => {
    const scope = testProjectScope();
    const repo = fixtureRepo();
    const executionScope: ProjectExecutionScope = { ...scope, rootRealPath: repo };
    const suite = getProjectDomainStores(scope);
    const mission = suite.missions.create({
      title: "Entrega com regressão",
      intentVersion: 1,
      intentState: "executing",
      intentContract: {
        ...compileIntentContract({ goal: "Mudar a", intentVersion: 1 }),
        approvedAt: 1,
      },
    });
    suite.missions.setStatus(mission.id, "running");
    const ctx = mintToken({
      label: "Worker",
      role: "worker",
      providerId: "codex",
      missionId: mission.id,
      workerIncarnationId: "inc-1",
      contextRevision: "c".repeat(64),
      scope,
      executionScope,
      allowedTools: ["nexus_handoff_submit"],
    });
    bindTokenToSession(ctx.token, "worker-session");
    fs.writeFileSync(path.join(repo, "src/a.ts"), "export const a = 2;\n");

    // Via MCP a entrega é devolvida ao worker...
    const mcp = await evaluateWriterHandoffRegression(ctx, { mission });
    expect(mcp.kind).toBe("retry");
    // ...e o worker só encerra o turno: o fechamento mecânico não a aceita.
    await handleTurnEndMechanicalHandoff({
      sessionId: "worker-session",
      body: { last_agent_message: "Pronto, mudei o valor de a para 2." },
    });

    const [handoff] = suite.handoffs.list({ missionId: mission.id, includeDelivered: true });
    expect(handoff).toMatchObject({ status: "blocked", sessionId: "worker-session" });
    expect(handoff!.summary).toMatch(/^\[testes impactados falhando\] /u);
    const artifact = handoff!.artifacts?.find(
      (item) => (item as { kind?: string }).kind === "nexus.regressionGate",
    ) as { payload: { status: string; failures: { file: string }[] } } | undefined;
    expect(artifact?.payload.status).toBe("failed");
    expect(artifact?.payload.failures.map((failure) => failure.file)).toEqual(["src/a.test.ts"]);
  }, 60_000);

  it("resume depois de reiniciar: a base é a do registro do writer isolado (B..H), não o HEAD no novo spawn", async () => {
    const root = fixtureRepo();
    const scope = testProjectScope({ rootRealPath: root });
    configureWorktreeRuntimeRegistry(manager);
    const first = await allocateIsolatedWriterWorktree(scope, undefined);
    first.link("pane-1", "session-1");
    installRunner(first.worktreePath);
    // Writer parte de B e commita a regressão em H; árvore limpa.
    fs.writeFileSync(path.join(first.worktreePath, "src/a.ts"), "export const a = 2;\n");
    git(first.worktreePath, "commit", "-qam", "regressão");
    first.release();

    // Reinício do app: registry novo sobre o mesmo banco; resume do pane.
    disposeWorktreeRuntimeRegistry();
    manager.closeAll();
    manager = new ProjectRuntimeManager({
      baseDir: path.join(temp, "runtime"),
      appVersion: "handoff-gate-test",
    });
    configureProjectDomainStoreRegistry(manager);
    configureWorktreeRuntimeRegistry(manager);
    const resumed = resumeIsolatedWriterWorktree(scope, undefined, "pane-1")!;
    expect(resumed.worktreePath).toBe(first.worktreePath);
    resumed.link("pane-2", "session-2");
    // O novo spawn acontece depois de H: pelo horário, a base seria H.
    spawnedAt.set("session-2", Date.now() + 2_000);

    const verdict = await evaluateWriterHandoffRegression({
      sessionId: "session-2",
      scope,
      executionScope: { ...scope, rootRealPath: resumed.worktreePath },
    });

    expect(verdict.kind).toBe("retry");
    expect(verdict.kind === "retry" && verdict.message).toContain("src/a.test.ts");
  }, 60_000);
});
