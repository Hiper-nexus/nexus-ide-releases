import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  REAL_MISSION_E2E_ADVISORS,
  REAL_MISSION_E2E_GOAL,
  REAL_MISSION_E2E_PRODUCT_WIZARD_ACCEPTANCE_CRITERIA,
  REAL_MISSION_E2E_RESULT_CONTENT,
  REAL_MISSION_E2E_RESULT_FILE,
  REAL_MISSION_E2E_SQUAD_ID,
  parseRealMissionE2EEvidence,
  realMissionE2EAdvisorSkipClis,
  type RealMissionE2EAdvisorCli,
  type RealMissionE2EEvidence,
} from "../shared/real-mission-e2e";
import type { Adapter } from "../shared/adapter-types";
import type { Mission } from "../shared/orch-types";
import {
  getAdapter,
  taskHandoffCapabilityForAdapter,
} from "./adapters/adapter-registry";
import { getSquad } from "./orch/squad-store";
import {
  isExactRealMissionE2ESquadFixture,
  resolveProductWizardRealMissionE2ESquadBinding,
  type RealMissionE2ESquadBinding,
} from "./real-mission-e2e-fixture";
import { stageRealMissionE2EContextCorpus } from "./real-mission-e2e-prevc";

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;

export interface ScratchRepository {
  readonly workspacePath: string;
  readonly initialHeadSha: string;
}

export function buildRepositoryProof(
  scratch: ScratchRepository,
  changedBeforeWorker: boolean,
): RealMissionE2EEvidence["repository"] {
  let finalHeadSha: string | null = null;
  let resultSha256: string | null = null;
  let commitCount = 0;
  let clean = false;
  let exactSingleCommit = false;
  try {
    finalHeadSha = runGit(scratch.workspacePath, ["rev-parse", "HEAD"]);
    commitCount = Number(
      runGit(scratch.workspacePath, ["rev-list", "--count", "HEAD"]),
    );
    // Product runtime may drop `.nexus/` metadata under the scratch tree;
    // that is not operator work and must not trip the release-gate "dirty
    // before worker" fence (repository proof still verifies resultado.txt).
    const porcelain = runGit(scratch.workspacePath, [
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]);
    clean = porcelain
      .split(/\r?\n/u)
      .filter((line) => line.length > 0)
      .every((line) => {
        const pathPart = line.slice(3).trim();
        return (
          pathPart === ".nexus" ||
          pathPart.startsWith(".nexus/") ||
          pathPart.endsWith("/.nexus") ||
          pathPart.includes("/.nexus/")
        );
      });
    const firstParentSha = runGit(scratch.workspacePath, [
      "rev-parse",
      `${finalHeadSha}^`,
    ]);
    const changedPaths = runGit(scratch.workspacePath, [
      "diff",
      "--name-only",
      "--no-renames",
      scratch.initialHeadSha,
      finalHeadSha,
    ]);
    // The integration may land as a fast-forward (initial + result = 2
    // commits) or as a real merge commit (initial + worker result + merge =
    // 3 commits). Either is valid as long as HEAD descends from the initial
    // commit and the only change against the initial tree is resultado.txt.
    let headDescendsFromInitial = firstParentSha === scratch.initialHeadSha;
    if (!headDescendsFromInitial && commitCount === 3) {
      const secondParentSha = runGit(scratch.workspacePath, [
        "rev-parse",
        `${finalHeadSha}^2`,
      ]);
      headDescendsFromInitial = secondParentSha === scratch.initialHeadSha;
    }
    exactSingleCommit =
      (commitCount === 2 || commitCount === 3) &&
      headDescendsFromInitial &&
      changedPaths === REAL_MISSION_E2E_RESULT_FILE;
    const resultPath = path.join(
      scratch.workspacePath,
      REAL_MISSION_E2E_RESULT_FILE,
    );
    const stat = fs.lstatSync(resultPath);
    if (stat.isFile() && !stat.isSymbolicLink()) {
      const disk = fs.readFileSync(resultPath);
      const committed = runGit(scratch.workspacePath, [
        "show",
        `HEAD:${REAL_MISSION_E2E_RESULT_FILE}`,
      ]);
      // git strips the trailing newline from stdout.trim() in runGit; hash
      // the on-disk file only after independently proving HEAD has the exact
      // expected logical line.
      if (
        committed === REAL_MISSION_E2E_RESULT_CONTENT.trimEnd() &&
        disk.equals(Buffer.from(REAL_MISSION_E2E_RESULT_CONTENT))
      ) {
        resultSha256 = sha256(disk);
      }
    }
  } catch {
    // Closed failure snapshot: null/false values cannot satisfy PASS.
  }
  return {
    initialHeadSha: scratch.initialHeadSha,
    finalHeadSha,
    resultSha256,
    commitCount: Number.isSafeInteger(commitCount) ? commitCount : 0,
    clean,
    changedBeforeWorker: changedBeforeWorker,
    exactSingleCommit,
  };
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function runGit(
  cwd: string,
  args: readonly string[],
  timeout = 30_000,
): string {
  const result = spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
    timeout,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  if (result.status !== 0 || result.error) {
    throw new Error("local git command failed");
  }
  return result.stdout.trim();
}

export function gitCommitIsAncestor(
  cwd: string,
  ancestor: string,
  descendant: string,
): boolean {
  if (
    !/^[a-f0-9]{40,64}$/u.test(ancestor) ||
    !/^[a-f0-9]{40,64}$/u.test(descendant)
  ) {
    return false;
  }
  const result = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", ancestor, descendant],
    {
      cwd,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  );
  return result.status === 0 && !result.error;
}

export function setupScratchRepository(userData: string): ScratchRepository {
  fs.mkdirSync(userData, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  fs.chmodSync(userData, PRIVATE_DIRECTORY_MODE);
  const workspacePath = fs.mkdtempSync(
    path.join(userData, "real-mission-workspace-"),
  );
  fs.chmodSync(workspacePath, PRIVATE_DIRECTORY_MODE);
  runGit(workspacePath, ["init", "--quiet"]);
  // Persist identity in the repository so the real worker worktree can commit
  // without inheriting or prompting for host-global Git configuration.
  runGit(workspacePath, [
    "config",
    "--local",
    "user.name",
    "Nexus Release Gate",
  ]);
  runGit(workspacePath, [
    "config",
    "--local",
    "user.email",
    "release-gate@nexus.invalid",
  ]);
  runGit(workspacePath, ["config", "--local", "commit.gpgSign", "false"]);
  fs.writeFileSync(
    path.join(workspacePath, "README.md"),
    "# Nexus real mission release gate\n",
    { encoding: "utf8", mode: PRIVATE_FILE_MODE },
  );
  // Product may drop runtime metadata under `.nexus/`; merge requires a clean
  // primary checkout, so ignore it from the disposable gate repo.
  fs.writeFileSync(
    path.join(workspacePath, ".gitignore"),
    // Attestations are written at freeze time with the real projectId (unknown
    // at init). Ignore them so merge still sees a clean primary checkout.
    ".nexus/\n.context/nexus/attestations/\n",
    { encoding: "utf8", mode: PRIVATE_FILE_MODE },
  );
  // Operational PREVC corpus before the single baseline commit so the
  // integration history stays the initial commit plus the worker result
  // (fast-forward: 2 commits, or a real merge commit: 3 commits).
  stageRealMissionE2EContextCorpus(workspacePath);
  runGit(workspacePath, [
    "add",
    "--",
    "README.md",
    ".gitignore",
    ".context",
    "package.json",
  ]);
  runGit(workspacePath, [
    "commit",
    "--quiet",
    "-m",
    "test: initialize real mission workspace",
  ]);
  const initialHeadSha = runGit(workspacePath, ["rev-parse", "HEAD"]);
  if (!/^[a-f0-9]{40,64}$/u.test(initialHeadSha)) {
    throw new Error("scratch repository did not produce a valid HEAD");
  }
  return { workspacePath: fs.realpathSync(workspacePath), initialHeadSha };
}

export function atomicWriteEvidence(
  file: string,
  evidence: RealMissionE2EEvidence,
): void {
  const validated = parseRealMissionE2EEvidence(evidence);
  const candidate = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = fs.openSync(candidate, "wx", PRIVATE_FILE_MODE);
    fs.writeFileSync(fd, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(candidate, file);
    fs.chmodSync(file, PRIVATE_FILE_MODE);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(candidate, { force: true });
  }
}

export function validateHarnessSquad(): boolean {
  return isExactRealMissionE2ESquadFixture(getSquad(REAL_MISSION_E2E_SQUAD_ID));
}

export function productWizardSquadBinding(
  mission: Pick<Mission, "squadId" | "intentContract">,
): RealMissionE2ESquadBinding | null {
  if (typeof mission.squadId !== "string") return null;
  return resolveProductWizardRealMissionE2ESquadBinding(mission.squadId);
}

export function isProductWizardPreApprovalMission(
  mission: Mission | null | undefined,
): mission is Mission {
  const contract = mission?.intentContract;
  const binding = mission ? productWizardSquadBinding(mission) : null;
  return Boolean(
    mission &&
    binding &&
    mission.status === "pending" &&
    (mission.intentState === "ready_to_start" ||
      mission.intentState === "awaiting_approval") &&
    mission.intentVersion === 1 &&
    mission.orchestratorSessionId == null &&
    contract?.version === 1 &&
    contract.source === "typed" &&
    contract.goal === REAL_MISSION_E2E_GOAL &&
    contract.executionMode === "autopilot" &&
    (contract.lane ?? "standard") === "standard" &&
    contract.contextPolicy === "on-demand" &&
    contract.intentVersion === 1 &&
    contract.approvedAt === undefined &&
    contract.dispatchedAt === undefined &&
    contract.squadRevisionHash === undefined &&
    contract.orchestratorRuntime === undefined &&
    contract.acceptanceCriteria.length ===
      REAL_MISSION_E2E_PRODUCT_WIZARD_ACCEPTANCE_CRITERIA.length &&
    contract.acceptanceCriteria.every(
      (criterion, index) =>
        criterion ===
        REAL_MISSION_E2E_PRODUCT_WIZARD_ACCEPTANCE_CRITERIA[index],
    ),
  );
}

export function validateHarnessCodexAdapter(): boolean {
  const adapter = getAdapter("codex");
  if (!adapter || adapter.kind !== "cli-pty") return false;
  const permission = adapter.control.permission;
  return (
    adapter.id === "codex" &&
    adapter.bin === "codex" &&
    adapter.auth.method === "api_key" &&
    adapter.auth.envVarFallback === "OPENAI_API_KEY" &&
    JSON.stringify(adapter.spawn.interactive) === JSON.stringify(["codex"]) &&
    adapter.spawn.ptyRequired &&
    adapter.spawn.extraArgs.length === 0 &&
    Object.keys(adapter.env.static).length === 0 &&
    JSON.stringify(adapter.env.passthrough) ===
      JSON.stringify(["OPENAI_API_KEY", "OPENAI_BASE_URL"]) &&
    adapter.promptInjection.method === "arg" &&
    adapter.promptInjection.bracketedPaste === false &&
    adapter.quirks.nexusMcp === "codex" &&
    permission?.arg === "--ask-for-approval" &&
    permission.modes.auto === "never" &&
    JSON.stringify(permission.yolo) ===
      JSON.stringify(["--dangerously-bypass-approvals-and-sandbox"]) &&
    JSON.stringify(permission.safe) ===
      JSON.stringify([
        "--sandbox",
        "workspace-write",
        "--ask-for-approval",
        "on-request",
      ])
  );
}

/**
 * Cada CLI advisor **presente** no roster (após NEXUS_REAL_MISSION_ADVISOR_SKIP)
 * precisa de um adapter cli-pty real com PTY obrigatório e uma rota física de
 * handoff. Essa rota pode ser MCP ou o marcador observado no stream PTY; AGY
 * 1.1 usa intencionalmente a segunda porque ignora projeções MCP privadas.
 * Advisors pulados por env não entram na prova desta rodada.
 */
/**
 * Host binary name for advisors that share another CLI's executable.
 * GLM (and LongCat) run `claude` pointed at a third-party Anthropic-compatible
 * endpoint — adapter.id stays `glm`, adapter.bin is `claude`.
 */
function realMissionAdvisorHostBin(cli: string): string {
  if (cli === "glm" || cli === "longcat") return "claude";
  return cli;
}

export function isHarnessAdvisorAdapter(
  cli: RealMissionE2EAdvisorCli,
  adapter: Adapter | null,
): boolean {
  const hostBin = realMissionAdvisorHostBin(cli);
  return Boolean(
    adapter &&
      adapter.kind === "cli-pty" &&
      adapter.id === cli &&
      adapter.bin === hostBin &&
      adapter.spawn.ptyRequired &&
      taskHandoffCapabilityForAdapter(adapter, "builtin"),
  );
}

export function validateHarnessAdvisorAdapters(): boolean {
  const skipped = new Set(realMissionE2EAdvisorSkipClis());
  return REAL_MISSION_E2E_ADVISORS.filter(
    (advisor) => !skipped.has(advisor.cli),
  ).every((advisor) =>
    isHarnessAdvisorAdapter(advisor.cli, getAdapter(advisor.cli)),
  );
}

/**
 * Roster completo do harness multi-CLI: o squad persistido é o fixture exato
 * (ids/categorias/CLIs, env-skip aplicado), o adapter codex mantém o shape
 * release-pinado e cada CLI advisor tem caminho físico de prompt, observação e
 * handoff (MCP ou marcador no stream PTY).
 */
export function validateHarnessRoster(): boolean {
  return (
    validateHarnessSquad() &&
    validateHarnessCodexAdapter() &&
    validateHarnessAdvisorAdapters()
  );
}
