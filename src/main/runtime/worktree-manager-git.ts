/**
 * Git identity proofs and interrupted-reservation reconciliation.
 */

import fs from "node:fs";
import path from "node:path";
import type { ProjectExecutionScope } from "../../shared/types";
import {
  assertSafeLocalGitConfig,
  assertSafeLocalGitConfigAsync,
  type AsyncGitRunner,
  type GitRunner,
} from "./git-command";
import {
  POOL_WORKTREES_SUBDIR,
  WorktreeStateConflictError,
  assertSha,
  cloneWorktreeRecord as cloneRecord,
  type WorktreeRecord,
  type WorktreeStateSnapshot,
  type IntegrationCheckoutInspection,
} from "./worktree-contract";
import { validateWorktreeStateSnapshot } from "./worktree-state";
import { INTERRUPTED_WORKTREE_RESERVATION_FAILURE_MARKER } from "./worktree-manager-markers";
import { areWorktreePathsEqual } from "./worktree-path-compare";
import { isPathInsideOrEqual } from "./worktree-removal-safety";

const MAX_CAS_ATTEMPTS = 16;

/** Stable contract reason shared with the scheduler merge lane. */
export const TASK_WORKTREE_NOT_CLEAN_MESSAGE = "task worktree must be clean";

/**
 * HEAD solto na prova de integração. A mensagem diz QUAL checkout falhou e o
 * que fazer: no checkout de coordenação é voltar para a branch de integração;
 * na pasta isolada de uma aba o HEAD solto é por desenho (F-980) — quem cai
 * aqui com ela tem a prova de vínculo quebrada e deve reabrir pela aba/missão.
 */
export function integrationBranchError(rootRealPath: string, cause: unknown): Error {
  return new Error(
    `primary checkout must be on an integration branch: HEAD solto em ${rootRealPath}. ` +
      `Se é o checkout de coordenação, volte para a branch de integração nele ` +
      `(ex.: git -C "${rootRealPath}" switch <branch>) e repita; ` +
      "se é a pasta isolada de uma aba, reabra o writer pela missão da aba ou use readOnly:true.",
    { cause },
  );
}

export type RepositorySnapshot = IntegrationCheckoutInspection;

/**
 * F-1509: a raiz do workspace é gravada com `fs.realpathSync`, que mantém a
 * caixa digitada e o nome 8.3 (`c:\users\…`, `ADMINI~1`); o Git devolve a
 * grafia do disco. No Windows compara a forma canônica do sistema (nome longo,
 * caixa do disco) pelo comparador de worktree; no darwin o APFS case-
 * insensitive tem o mesmo sintoma (deep-link/atalho com outra caixa), e as
 * formas native já vêm na caixa do disco, então a comparação dele é igualdade
 * exata (com o desvio /tmp ↔ /private/tmp); Linux continua exato.
 * Continua exigindo o MESMO diretório: subpasta ou outro repositório não passa.
 */
function isGitTopLevel(topLevel: string, root: string): boolean {
  if (topLevel === root) return true;
  if (process.platform !== "win32" && process.platform !== "darwin") return false;
  try {
    return areWorktreePathsEqual(
      fs.realpathSync.native(topLevel),
      fs.realpathSync.native(root),
      process.platform,
    );
  } catch {
    return false;
  }
}

export function gitOutput(
  runner: GitRunner,
  cwd: string,
  args: readonly string[],
): string {
  return runner.run(cwd, args).stdout.trim();
}

export function readRepositorySnapshot(
  git: GitRunner,
  scope: Pick<
    ProjectExecutionScope,
    "projectId" | "checkoutId" | "rootRealPath"
  >,
  requireClean: boolean,
): RepositorySnapshot {
  const expectedRoot = path.resolve(scope.rootRealPath);
  const rootRealPath = fs.realpathSync(expectedRoot);
  if (
    scope.rootRealPath !== expectedRoot ||
    rootRealPath !== expectedRoot ||
    !fs.statSync(rootRealPath).isDirectory()
  ) {
    throw new Error("scope root is not canonical");
  }
  const topLevel = fs.realpathSync(
    gitOutput(git, rootRealPath, ["rev-parse", "--show-toplevel"]),
  );
  if (!isGitTopLevel(topLevel, rootRealPath)) {
    throw new Error("scope root must equal the canonical Git top-level");
  }
  assertSafeLocalGitConfig(git, rootRealPath);
  let integrationRef: string;
  try {
    integrationRef = gitOutput(git, rootRealPath, [
      "symbolic-ref",
      "--quiet",
      "HEAD",
    ]);
  } catch (error) {
    throw integrationBranchError(rootRealPath, error);
  }
  if (!integrationRef.startsWith("refs/heads/")) {
    throw new Error("primary checkout has an invalid integration ref");
  }
  const headSha = assertSha(
    gitOutput(git, rootRealPath, [
      "rev-parse",
      "--verify",
      "HEAD^{commit}",
    ]),
    "integration HEAD",
  );
  // `--untracked-files=all` é o passo caro (varre untracked em árvores
  // grandes). O booleano `clean` não muda com `=normal` (qualquer untracked
  // file/dir aparece); `=all` só seria necessário para listar os arquivos.
  // Quando `requireClean` é false o chamador não pode querer lançar — mas
  // `inspectIntegration` lê `clean` mesmo assim, então o status continua,
  // só sem descer em diretórios untracked.
  const clean =
    git.run(rootRealPath, [
      "status",
      "--porcelain=v1",
      "-z",
      requireClean ? "--untracked-files=all" : "--untracked-files=normal",
    ]).stdout.length === 0;
  if (requireClean && !clean) {
    throw new Error("primary checkout must be clean");
  }
  return Object.freeze({ rootRealPath, integrationRef, headSha, clean });
}

export function assertRepositoryUnchanged(
  git: GitRunner,
  expected: RepositorySnapshot,
  requireClean: boolean,
): void {
  const current = readRepositorySnapshot(
    git,
    {
      projectId: "",
      checkoutId: "",
      rootRealPath: expected.rootRealPath,
    } as ProjectExecutionScope,
    requireClean,
  );
  if (
    current.integrationRef !== expected.integrationRef ||
    current.headSha !== expected.headSha
  ) {
    throw new WorktreeStateConflictError(
      "primary checkout changed after base SHA was frozen",
    );
  }
}

export function assertTaskWorktree(
  git: GitRunner,
  record: WorktreeRecord,
): string {
  const real = fs.realpathSync(record.worktreePath);
  if (real !== record.worktreePath || !fs.statSync(real).isDirectory()) {
    throw new WorktreeStateConflictError("task worktree path changed");
  }
  const topLevel = fs.realpathSync(
    gitOutput(git, real, ["rev-parse", "--show-toplevel"]),
  );
  if (topLevel !== real) {
    throw new WorktreeStateConflictError("task worktree Git root changed");
  }
  const branchRef = gitOutput(git, real, [
    "symbolic-ref",
    "--quiet",
    "HEAD",
  ]);
  if (branchRef !== record.branchRef) {
    throw new WorktreeStateConflictError("task worktree branch changed");
  }
  const repositoryCommonDirectory = fs.realpathSync(
    gitOutput(git, record.rootRealPath, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]),
  );
  const worktreeCommonDirectory = fs.realpathSync(
    gitOutput(git, real, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]),
  );
  if (worktreeCommonDirectory !== repositoryCommonDirectory) {
    throw new WorktreeStateConflictError(
      "task worktree is not linked to the frozen repository",
    );
  }
  assertSafeLocalGitConfig(git, real);
  const status = git.run(real, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]).stdout;
  if (status.length > 0) {
    throw new WorktreeStateConflictError(TASK_WORKTREE_NOT_CLEAN_MESSAGE);
  }
  return assertSha(
    gitOutput(git, real, ["rev-parse", "--verify", "HEAD^{commit}"]),
    "task HEAD",
  );
}

/** F-764: same Git proofs as the synchronous integration/recovery lane;
 * creation must yield for EVERY child process, including status/config probes. */
export async function gitOutputAsync(
  runner: AsyncGitRunner,
  cwd: string,
  args: readonly string[],
): Promise<string> {
  return (await runner.run(cwd, args)).stdout.trim();
}

export async function readRepositorySnapshotAsync(
  git: AsyncGitRunner,
  scope: Pick<
    ProjectExecutionScope,
    "projectId" | "checkoutId" | "rootRealPath"
  >,
  requireClean: boolean,
  /**
   * F-980 (HEAD destacado): só a BASE de um writer (a pasta isolada de uma aba) pode ter HEAD
   * destacado — a worktree durável da aba nasce assim por desenho. O checkout
   * de coordenação continua exigindo branch de integração. Com HEAD solto,
   * `integrationRef` vem de `detachedIntegrationRef` (a do checkout) e a base
   * só contribui com raiz e SHA.
   */
  detachedBase?: { readonly integrationRef: string },
): Promise<RepositorySnapshot> {
  const expectedRoot = path.resolve(scope.rootRealPath);
  const rootRealPath = fs.realpathSync(expectedRoot);
  if (
    scope.rootRealPath !== expectedRoot ||
    rootRealPath !== expectedRoot ||
    !fs.statSync(rootRealPath).isDirectory()
  ) {
    throw new Error("scope root is not canonical");
  }
  const topLevel = fs.realpathSync(
    await gitOutputAsync(git, rootRealPath, ["rev-parse", "--show-toplevel"]),
  );
  if (!isGitTopLevel(topLevel, rootRealPath)) {
    throw new Error("scope root must equal the canonical Git top-level");
  }
  await assertSafeLocalGitConfigAsync(git, rootRealPath);
  let integrationRef: string;
  try {
    integrationRef = await gitOutputAsync(git, rootRealPath, [
      "symbolic-ref",
      "--quiet",
      "HEAD",
    ]);
  } catch (error) {
    if (!detachedBase) {
      throw integrationBranchError(rootRealPath, error);
    }
    // `symbolic-ref --quiet` sai 1 sem saída com HEAD solto. A prova de que é
    // isso (e não um repositório quebrado) é o `rev-parse HEAD^{commit}` abaixo.
    integrationRef = detachedBase.integrationRef;
  }
  if (!integrationRef.startsWith("refs/heads/")) {
    throw new Error("primary checkout has an invalid integration ref");
  }
  const headSha = assertSha(
    await gitOutputAsync(git, rootRealPath, [
      "rev-parse",
      "--verify",
      "HEAD^{commit}",
    ]),
    "integration HEAD",
  );
  // F-980/spawn: `status --untracked-files=all` é o passo mais caro da
  // inspeção e roda em todo spawn de writer. Quando `requireClean` é false
  // nenhum chamador lê `clean` (create, assertRepositoryUnchangedAsync,
  // readLinkedBaseSnapshotAsync, claimPooledPaneWriter e o pool usam só
  // raiz/branch/SHA) — pula a varredura inteira. `clean: false` é o
  // sentinela conservador ("não verificado") para quem ler no futuro.
  // Invariantes de segurança (raiz canônica, top-level, config segura,
  // branch, SHA e o CAS de realpath pós-await) ficam exatamente como antes.
  let clean = false;
  if (requireClean) {
    clean =
      (await git.run(rootRealPath, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ])).stdout.length === 0;
    if (!clean) {
      throw new Error("primary checkout must be clean");
    }
  }
  if (fs.realpathSync(expectedRoot) !== rootRealPath) {
    throw new WorktreeStateConflictError("scope root changed during Git inspection");
  }
  return Object.freeze({ rootRealPath, integrationRef, headSha, clean });
}

export async function assertRepositoryUnchangedAsync(
  git: AsyncGitRunner,
  expected: RepositorySnapshot,
  requireClean: boolean,
  /** F-980: base vinculada (pasta da aba, HEAD possivelmente solto): só o SHA a identifica. */
  linkedBase = false,
): Promise<void> {
  const current = await readRepositorySnapshotAsync(
    git,
    {
      projectId: "",
      checkoutId: "",
      rootRealPath: expected.rootRealPath,
    } as ProjectExecutionScope,
    requireClean,
    linkedBase ? { integrationRef: expected.integrationRef } : undefined,
  );
  if (
    (!linkedBase && current.integrationRef !== expected.integrationRef) ||
    current.headSha !== expected.headSha
  ) {
    throw new WorktreeStateConflictError(
      "primary checkout changed after base SHA was frozen",
    );
  }
}

/**
 * F-980: base de um writer de pane que nasce de outra worktree do MESMO
 * repositório (a pasta isolada de uma aba). Mesmas provas do checkout
 * (raiz canônica = top-level, config local segura, branch, HEAD) mais o
 * diretório comum do Git idêntico ao do checkout de coordenação.
 */
export async function readLinkedBaseSnapshotAsync(
  git: AsyncGitRunner,
  repository: RepositorySnapshot,
  baseRootRealPath: string,
): Promise<RepositorySnapshot> {
  if (baseRootRealPath === repository.rootRealPath) return repository;
  const base = await readRepositorySnapshotAsync(
    git,
    { projectId: "", checkoutId: "", rootRealPath: baseRootRealPath },
    false,
    { integrationRef: repository.integrationRef },
  );
  const commonDirectory = async (root: string) => fs.realpathSync(
    await gitOutputAsync(git, root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
  );
  if (await commonDirectory(base.rootRealPath) !== await commonDirectory(repository.rootRealPath)) {
    throw new WorktreeStateConflictError(
      "writer base worktree is not linked to the coordination repository",
    );
  }
  return base;
}

/**
 * F-1320: ref pedida pelo writer (sha, branch ou tag) → sha do commit, na raiz
 * base. `--end-of-options` e a recusa de `-` inicial fecham a porta a opções
 * vindas de argumento de tool; `^{commit}` recusa tree/blob/tag solta.
 */
export async function resolveBaseRefAsync(
  git: AsyncGitRunner,
  baseRootRealPath: string,
  baseRef: string,
  ownerKind: "pane" | undefined,
): Promise<string> {
  const ref = baseRef.trim();
  if (ownerKind !== "pane") throw new Error("baseRef: only pane writers may choose their base");
  if (ref === "" || ref.startsWith("-") || /[\s\0]/.test(ref)) {
    throw new Error(`baseRef inválida: ${JSON.stringify(baseRef)}`);
  }
  const result = await git.run(
    baseRootRealPath,
    ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`],
    { allowFailure: true },
  );
  const sha = result.stdout.trim();
  if (result.status !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) {
    throw new Error(`baseRef inválida: "${ref}" não é um commit deste repositório (sha, branch ou tag)`);
  }
  return sha;
}

export async function assertTaskWorktreeAsync(
  git: AsyncGitRunner,
  record: WorktreeRecord,
): Promise<string> {
  const real = fs.realpathSync(record.worktreePath);
  if (real !== record.worktreePath || !fs.statSync(real).isDirectory()) {
    throw new WorktreeStateConflictError("task worktree path changed");
  }
  const topLevel = fs.realpathSync(
    await gitOutputAsync(git, real, ["rev-parse", "--show-toplevel"]),
  );
  if (topLevel !== real) {
    throw new WorktreeStateConflictError("task worktree Git root changed");
  }
  const branchRef = await gitOutputAsync(git, real, [
    "symbolic-ref",
    "--quiet",
    "HEAD",
  ]);
  if (branchRef !== record.branchRef) {
    throw new WorktreeStateConflictError("task worktree branch changed");
  }
  const repositoryCommonDirectory = fs.realpathSync(
    await gitOutputAsync(git, record.rootRealPath, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]),
  );
  const worktreeCommonDirectory = fs.realpathSync(
    await gitOutputAsync(git, real, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]),
  );
  if (worktreeCommonDirectory !== repositoryCommonDirectory) {
    throw new WorktreeStateConflictError(
      "task worktree is not linked to the frozen repository",
    );
  }
  await assertSafeLocalGitConfigAsync(git, real);
  const status = (await git.run(real, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ])).stdout;
  if (status.length > 0) {
    throw new WorktreeStateConflictError(TASK_WORKTREE_NOT_CLEAN_MESSAGE);
  }
  const headSha = assertSha(
    await gitOutputAsync(git, real, ["rev-parse", "--verify", "HEAD^{commit}"]),
    "task HEAD",
  );
  if (fs.realpathSync(record.worktreePath) !== real) {
    throw new WorktreeStateConflictError("task worktree path changed");
  }
  return headSha;
}

export interface ReservationReconcileDeps {
  readonly git: GitRunner;
  readonly worktreesRoot: string;
  readonly legacyWorktreesRoot?: string;
  snapshot(scopeKey: string): WorktreeStateSnapshot;
  compareAndSwap(
    scopeKey: string,
    expectedRevision: number,
    records: readonly WorktreeRecord[],
  ): boolean;
  failureMessage(error: unknown): string;
  timestamp(): number;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

/** Diretório real (não link) dentro de `parent`, 0700; devolve o caminho real. */
export function ensureDirectory(directory: string, parent?: string): string {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`runtime path is not a real directory: ${directory}`);
  }
  const real = fs.realpathSync(directory);
  if (parent && !isInside(parent, real)) {
    throw new Error(`runtime path escapes its parent: ${directory}`);
  }
  fs.chmodSync(real, 0o700);
  return real;
}

/**
 * A1: a adoção do pool grava a intenção `reserved` (identidade derivada) antes
 * do `branch -m`; um crash entre o rename e o `worktree move` deixa a branch
 * derivada em `pool/…`. Conclui o move para o caminho da intenção — só para
 * uma worktree ligada sob a raiz do pool — e a prova normal decide depois.
 */
function convergeInterruptedPoolAdoption(
  deps: ReservationReconcileDeps,
  record: WorktreeRecord,
): void {
  if (record.ownerKind !== "pane" || fs.existsSync(record.worktreePath)) return;
  const roots = [deps.worktreesRoot, deps.legacyWorktreesRoot]
    .filter((root): root is string => root !== undefined);
  const managedRoot = roots.find((root) => isPathInsideOrEqual(root, record.worktreePath));
  if (!managedRoot) return;
  // Mesma cerca do snapshot antes de qualquer Git: config local insegura não roda.
  assertSafeLocalGitConfig(deps.git, record.rootRealPath);
  const listed = deps.git.run(record.rootRealPath, ["worktree", "list", "--porcelain"], {
    allowFailure: true,
  });
  if (listed.status !== 0) return;
  const holder = listed.stdout.split("\n\n").map((block) => block.split("\n"))
    .find((lines) => lines.includes(`branch ${record.branchRef}`))
    ?.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
  const real = holder && fs.existsSync(holder) ? fs.realpathSync(holder) : "";
  const poolRoots = roots.map((root) => path.join(root, POOL_WORKTREES_SUBDIR));
  if (!real || !poolRoots.some((root) => isPathInsideOrEqual(root, real))) return;
  ensureDirectory(path.dirname(record.worktreePath), managedRoot);
  const moved = deps.git.run(record.rootRealPath, ["worktree", "move", real, record.worktreePath], {
    allowFailure: true,
  });
  if (moved.status !== 0) {
    console.warn("[worktree] adoção do pool interrompida: o move de boot falhou; a intenção falha fechada", {
      status: moved.status,
      from: real,
      to: record.worktreePath,
      stderr: moved.stderr.trim().slice(0, 500),
    });
  }
}

export function reconcileInterruptedReservation(
  deps: ReservationReconcileDeps,
  scope: ProjectExecutionScope,
  scopeKey: string,
  taskKey: string,
): WorktreeRecord {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const snapshot = deps.snapshot(scopeKey);
    const index = snapshot.records.findIndex(
      (record) => record.taskKey === taskKey,
    );
    if (index < 0) {
      throw new WorktreeStateConflictError(
        "reserved worktree state record disappeared",
      );
    }
    const current = snapshot.records[index];
    if (current.status !== "reserved") return cloneRecord(current);

    let next: WorktreeRecord;
    try {
      if (
        current.projectId !== scope.projectId ||
        current.checkoutId !== scope.checkoutId ||
        current.rootRealPath !== scope.rootRealPath
      ) {
        throw new WorktreeStateConflictError(
          "reserved worktree does not belong to the requested scope",
        );
      }
      // Antes do snapshot: ele lança com o checkout em HEAD destacado, e a
      // worktree renomeada ficaria em pool/ sem nenhuma limpeza que a ache.
      convergeInterruptedPoolAdoption(deps, current);
      const repository = readRepositorySnapshot(deps.git, scope, current.ownerKind !== "pane");
      if (
        repository.integrationRef !== current.integrationRef ||
        repository.headSha !== current.baseSha
      ) {
        throw new WorktreeStateConflictError(
          "primary checkout changed after the reserved base was frozen",
        );
      }
      const taskHeadSha = assertTaskWorktree(deps.git, current);
      if (taskHeadSha !== current.baseSha) {
        throw new WorktreeStateConflictError(
          "reserved worktree HEAD diverged from its frozen base",
        );
      }
      next = cloneRecord({
        ...current,
        status: "ready",
        failureReason: undefined,
        updatedAt: deps.timestamp(),
      });
    } catch (error) {
      next = cloneRecord({
        ...current,
        status: "failed",
        failureReason: deps.failureMessage(
          `${INTERRUPTED_WORKTREE_RESERVATION_FAILURE_MARKER} ` +
            `reserved worktree reconciliation failed closed: ` +
            deps.failureMessage(error),
        ),
        updatedAt: deps.timestamp(),
      });
    }

    const records = snapshot.records.map((record, candidateIndex) =>
      candidateIndex === index ? next : record,
    );
    const validated = validateWorktreeStateSnapshot(
      { revision: snapshot.revision, records },
      {
        scopeKey,
        worktreesRoot: deps.worktreesRoot,
        legacyWorktreesRoot: deps.legacyWorktreesRoot,
      },
    ).records;
    if (
      deps.compareAndSwap(scopeKey, snapshot.revision, validated)
    ) {
      return next;
    }
  }
  throw new WorktreeStateConflictError(
    "reserved worktree reconciliation CAS could not converge",
  );
}
