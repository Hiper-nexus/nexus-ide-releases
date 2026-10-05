import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ProjectExecutionScope } from "../../shared/types";
import {
  GitCommandError,
  assertSafeLocalGitConfig,
  assertSafeLocalGitConfigAsync,
  AsyncProcessGitRunner,
  ProcessGitRunner,
  type AsyncGitRunner,
  type GitRunner,
} from "./git-command";
import {
  ACTIVE_WORKTREE_STATUSES as ACTIVE_STATUSES,
  OwnershipOverlapError,
  WorktreeStateConflictError,
  WorktreeWorkerConflictError,
  assertIdentifier,
  assertSha,
  cloneWorktreeRecord as cloneRecord,
  digest,
  exclusiveOwnershipOverlap as exclusiveOverlap,
  hasOwnershipOverlap as hasOverlap,
  MAX_PANE_BINDINGS,
  normalizeOwnership,
  sameValues,
  worktreeTaskKey,
  worktreeBranchRef,
  type CreateWorktreeInput,
  type IntegrationCheckoutSnapshot,
  type IntegrationCheckoutInspection,
  type PreparedWorktreeIntegration,
  type PreparedWorktreeNoChangeValidation,
  type WorktreeManagerOptions,
  type WorktreeOwnership,
  type WorktreeRecord,
  type WorktreeStateSnapshot,
  type WorktreeStateStore,
} from "./worktree-contract";
import { validateWorktreeStateSnapshot } from "./worktree-state";
import {
  legacyWorktreesRoot,
  managedWorktreeRelativePath,
} from "./managed-worktree-layout";
import { materializeGitWorktree } from "./worktree-cow";
import {
  findRegisteredDeletableWorktree,
  isDangerousWorktreeRemovalPath,
  isPathInsideOrEqual,
  type RegisteredWorktreeInfo,
} from "./worktree-removal-safety";
import { DEAD_OWNER_WORKTREE_RELEASE_MARKER } from "./worktree-manager-markers";
import {
  assertRepositoryUnchangedAsync,
  assertTaskWorktreeAsync,
  readRepositorySnapshotAsync,
  assertTaskWorktree,
  readRepositorySnapshot,
  reconcileInterruptedReservation,
} from "./worktree-manager-git";
import {
  markDiscardedNoChange as markDiscardedNoChangeFn,
  markValidatedNoChange as markValidatedNoChangeFn,
  prepareIntegrationInternal,
  prepareDiscardedNoChangeValidation as prepareDiscardedNoChangeValidationFn,
  prepareNoChangeValidation as prepareNoChangeValidationFn,
  type IntegrationHost,
} from "./worktree-manager-integration";

export * from "./git-command";
export * from "./worktree-contract";
export { cowWorktreeAvailable, materializeGitWorktree } from "./worktree-cow";
export {
  DEAD_OWNER_WORKTREE_RELEASE_MARKER,
  INTERRUPTED_WORKTREE_RESERVATION_FAILURE_MARKER,
} from "./worktree-manager-markers";

const MAX_CAS_ATTEMPTS = 16;
/** Remover ~2 GB de node_modules clonado passa fácil dos 30 s padrão do Git. */
const WORKTREE_REMOVE_TIMEOUT_MS = 10 * 60_000;
/**
 * Inventário de uma passada: alterações (rastreadas, staged, novas) e
 * ignorados, com diretórios inteiramente ignorados colapsados (`dir/`).
 * O Git não segue links aqui.
 */
const WORKTREE_STATUS_ARGS = [
  "status", "--porcelain=v1", "-z", "--ignored", "--untracked-files=normal",
] as const;

/**
 * F-908: caches regeneráveis. Um ignorado só deixa a worktree sair quando é
 * ou mora dentro de um destes, em qualquer nível (`mobile/node_modules/`, o
 * clone CoW). `out`/`dist`/`build`/`target`/`coverage`, `__pycache__` e
 * qualquer outro ignorado (`.env`, dumps, `.next/` inteiro) mantêm a
 * worktree: podem guardar entregável.
 */
const REGENERABLE_IGNORED = new Set([
  "node_modules", ".vite", ".turbo", ".cache", ".pytest_cache",
]);

function regenerableIgnored(entry: string): boolean {
  const segments = entry.replace(/\/$/, "").split("/");
  return segments.some((segment, index) => REGENERABLE_IGNORED.has(segment) ||
    (segment === ".next" && segments[index + 1] === "cache"));
}

export interface PaneWorktreeGcOptions {
  /** Chaves do registry (missão ou `operator-hand`) cujos writers podem sair. */
  readonly owner: (missionId: string) => boolean;
  readonly inUse: (worktreePath: string) => boolean;
  /** Prova assíncrona de uso, repetida logo antes de remover; erro = em uso. */
  readonly confirmUnused?: (worktreePath: string) => Promise<boolean>;
  /** Idade mínima desde a última mudança do registro (`updatedAt`). */
  readonly minIdleMs?: number;
  /** Teto de candidatos examinados nesta rodada. */
  readonly maxCandidates?: number;
  /** Hora (Date.now) a partir da qual nenhum candidato novo começa. */
  readonly deadlineAt?: number;
  /**
   * Coleta de paradas: worktree limpa sai mesmo com a branch não mesclada (a
   * branch fica); worktree suja recebe esta salvaguarda e FICA.
   */
  readonly salvageDirty?: (record: WorktreeRecord) => Promise<unknown>;
}

export interface PaneWorktreeGcReport {
  readonly removed: readonly WorktreeRecord[];
  /** Candidatos mantidos, por motivo (recusa de prova ou falha). */
  readonly kept: Readonly<Record<string, number>>;
  /** Candidatos não examinados por teto de itens/tempo. */
  readonly deferred: number;
}

/** `git worktree list --porcelain`; a primeira entrada é a principal. */
function parseWorktreeList(
  stdout: string,
): Array<RegisteredWorktreeInfo & { readonly prunable: boolean }> {
  return stdout.split("\n\n").filter((block) => block.trim()).map((block, index) => {
    const lines = block.split("\n");
    return {
      path: lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length) ?? "",
      isMainWorktree: index === 0,
      prunable: lines.some((line) => line === "prunable" || line.startsWith("prunable ")),
    };
  });
}

function assertExecutorOwnershipIsNotAuthority(files: readonly string[]): void {
  const protectedFile = files.find((file) => {
    const normalized = file.replaceAll("\\", "/");
    return (
      normalized === ".nexus/project.json" ||
      normalized === ".context" ||
      normalized.startsWith(".context/")
    );
  });
  if (protectedFile) {
    throw new Error(
      `executor worktrees cannot own context authority: ${protectedFile}`,
    );
  }
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

function ensureDirectory(directory: string, parent?: string): string {
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


export class WorktreeManager {
  readonly runtimeRoot: string;
  readonly worktreesRoot: string;
  /** Raiz histórica; no win32 só valida registros de antes do F-654. */
  readonly legacyWorktreesRoot: string;
  readonly #stateStore: WorktreeStateStore;
  readonly #git: GitRunner;
  readonly #asyncGit: AsyncGitRunner;
  /** Writers de pane com remoção em curso: `reopenPaneWriter` não os reabre. */
  readonly #collecting = new Set<string>();
  /** Ordem do último exame por taskKey: mantidos não bloqueiam o teto. */
  readonly #lastExamined = new Map<string, number>();
  #examinations = 0;
  readonly #now: () => number;

  constructor(options: WorktreeManagerOptions) {
    if (
      !options.stateStore ||
      typeof options.stateStore.read !== "function" ||
      typeof options.stateStore.compareAndSwap !== "function"
    ) {
      throw new Error("a durable worktree state store is required");
    }
    this.runtimeRoot = ensureDirectory(path.resolve(options.runtimeRoot));
    this.worktreesRoot = options.worktreesRoot
      ? ensureDirectory(path.resolve(options.worktreesRoot))
      : ensureDirectory(
          path.join(this.runtimeRoot, "worktrees"),
          this.runtimeRoot,
        );
    this.legacyWorktreesRoot = legacyWorktreesRoot(this.runtimeRoot);
    this.#stateStore = options.stateStore;
    this.#git = options.gitRunner ?? new ProcessGitRunner();
    this.#asyncGit = options.asyncGitRunner ?? new AsyncProcessGitRunner();
    this.#now = options.now ?? Date.now;
  }

  /**
   * Throws when `candidate` overlaps another active record. Dependency links
   * in either direction never conflict.
   *
   * The scope here is the whole checkout, so this is the fence that decides
   * whether two MISSIONS can run at once. It measures exclusivity, not
   * permission: a coverage permit (`OWNERSHIP_COVERAGE_DOMAIN`) contributes no
   * file exclusivity, otherwise every guided mission would veto every other
   * one over an inventory superset neither of them wrote.
   */
  #assertNoOwnershipConflict(
    records: readonly WorktreeRecord[],
    candidate: {
      readonly taskKey: string;
      readonly missionId: string;
      readonly ownership: WorktreeOwnership;
      readonly dependencies: readonly string[];
    },
  ): void {
    for (const record of records) {
      if (record.taskKey === candidate.taskKey) continue;
      if (!ACTIVE_STATUSES.has(record.status)) continue;
      if (candidate.dependencies.includes(record.taskKey)) continue;
      if (record.dependencies.includes(candidate.taskKey)) continue;
      const claimOverlap = exclusiveOverlap(
        candidate.ownership,
        record.ownership,
        { sameMission: record.missionId === candidate.missionId },
      );
      if (hasOverlap(claimOverlap)) {
        throw new OwnershipOverlapError(record.taskKey, claimOverlap, {
          missionId: record.missionId,
          taskId: record.taskId,
        });
      }
    }
  }

  scopeKey(
    scope: Pick<ProjectExecutionScope, "projectId" | "checkoutId">,
  ): string {
    return digest(
      "worktree-scope",
      assertIdentifier(scope.projectId, "projectId"),
      assertIdentifier(scope.checkoutId, "checkoutId"),
    );
  }

  /**
   * Startup-only recovery for reservations persisted before `git worktree add`
   * and the final `ready` CAS completed. A reservation is promoted only when
   * the primary checkout and linked worktree still prove the exact frozen
   * branch/base/common Git directory. Every other state is terminally failed
   * without deleting any path or ref.
   *
   * Re-running this method is a no-op once every record is non-reserved.
   */
  reconcileInterruptedReservations(
    scope: ProjectExecutionScope,
  ): readonly WorktreeRecord[] {
    const scopeKey = this.scopeKey(scope);
    const taskKeys = this.#snapshot(scopeKey)
      .records.filter((record) => record.status === "reserved")
      .map((record) => record.taskKey);
    return Object.freeze(
      taskKeys.map((taskKey) =>
        reconcileInterruptedReservation(
          {
            git: this.#git,
            worktreesRoot: this.worktreesRoot,
            legacyWorktreesRoot: this.legacyWorktreesRoot,
            snapshot: (key) => this.#snapshot(key),
            compareAndSwap: (key, rev, records) =>
              this.#stateStore.compareAndSwap(key, rev, records),
            failureMessage: (error) => this.#failureMessage(error),
            timestamp: () => this.#timestamp(),
          },
          scope,
          scopeKey,
          taskKey,
        ),
      ),
    );
  }

  /**
   * Drops records whose task row no longer exists.
   *
   * Ownership overlap is checked against every live non-terminal record, so a
   * record left behind by a deleted mission keeps claiming files forever and
   * blocks the next mission with "worktree ownership overlaps active task
   * &lt;id&gt;" — pointing at a task that cannot be inspected because it is gone.
   * `reconcileInterruptedReservations` only converges `reserved` rows and
   * never noticed these.
   *
   * Only the record is removed; no Git path, ref or worktree is touched, and a
   * record whose task still exists is never considered.
   */
  purgeRecordsWithoutTask(
    scope: ProjectExecutionScope,
    liveTaskIds: ReadonlySet<string>,
  ): readonly WorktreeRecord[] {
    const scopeKey = this.scopeKey(scope);
    return this.#mutate(scopeKey, (records) => {
      const orphans = records.filter(
        (record) => record.ownerKind !== "pane" && !liveTaskIds.has(record.taskId),
      );
      if (orphans.length === 0) return { records, result: [] };
      return {
        records: records.filter((record) => record.ownerKind === "pane" || liveTaskIds.has(record.taskId)),
        result: orphans,
      };
    });
  }

  async create(input: CreateWorktreeInput): Promise<WorktreeRecord> {
    const assertCurrentAuthority = () => {
      input.assertCurrentAuthority?.();
      input.signal?.throwIfAborted();
    };
    assertCurrentAuthority();
    const requireClean = input.ownerKind !== "pane";
    const repository = await readRepositorySnapshotAsync(this.#asyncGit, input.scope, requireClean);
    assertCurrentAuthority();
    const missionId = assertIdentifier(input.missionId, "missionId");
    const taskId = assertIdentifier(input.taskId, "taskId");
    const workerId = assertIdentifier(input.workerId, "workerId");
    const taskKey = worktreeTaskKey(missionId, taskId);
    const scopeKey = this.scopeKey(input.scope);
    const ownership = normalizeOwnership(input.ownership);
    assertExecutorOwnershipIsNotAuthority(ownership.files);
    const dependencies = Object.freeze(
      [
        ...new Set(
          (input.dependsOn ?? []).map((dependency) =>
            worktreeTaskKey(dependency.missionId, dependency.taskId),
          ),
        ),
      ].sort(),
    );
    if (dependencies.includes(taskKey)) {
      throw new Error("a task cannot depend on itself");
    }

    const worktreePath = path.join(
      this.worktreesRoot,
      managedWorktreeRelativePath(
        input.scope.projectId,
        input.scope.checkoutId,
        taskKey,
      ),
    );
    ensureDirectory(path.dirname(worktreePath), this.worktreesRoot);
    const branchRef = worktreeBranchRef({ ...input, projectId: input.scope.projectId });
    const now = this.#timestamp();
    const candidate = cloneRecord({
      ...(input.ownerKind ? { ownerKind: input.ownerKind } : {}),
      reservationGeneration: randomUUID(),
      id: `worktree-${taskKey}`,
      scopeKey,
      projectId: input.scope.projectId,
      checkoutId: input.scope.checkoutId,
      missionId,
      taskId,
      taskKey,
      workerId,
      rootRealPath: repository.rootRealPath,
      worktreePath,
      branchRef,
      integrationRef: repository.integrationRef,
      baseSha: repository.headSha,
      ownership,
      dependencies,
      status: "reserved",
      createdAt: now,
      updatedAt: now,
    });

    const reservation = this.#mutate(scopeKey, (records) => {
      const existing = records.find((record) => record.taskKey === taskKey);
      if (existing) {
        if (
          existing.ownerKind !== input.ownerKind ||
          existing.rootRealPath !== repository.rootRealPath ||
          existing.integrationRef !== repository.integrationRef
        ) {
          throw new WorktreeStateConflictError(
            "task worktree belongs to another checkout root",
          );
        }
        // Um registro liberado pelo marcador de dono-morto é SEM DONO por
        // definição — o reroute de provider grava exatamente esse marcador
        // para que o agente substituto do MESMO roster reclame a mesma
        // reserva. Sem esta exceção, o claim re-roteado morria para sempre em
        // WorktreeWorkerConflictError (flagrado ao vivo: attempt 59 no gate
        // da 0.20.0). Qualquer outro caso de worker divergente continua
        // recusado.
        const releasedByDeadOwner =
          existing.status === "failed" &&
          existing.taskHeadSha === undefined &&
          existing.integratedSha === undefined &&
          existing.failureReason?.startsWith(
            DEAD_OWNER_WORKTREE_RELEASE_MARKER,
          ) === true;
        if (existing.workerId !== workerId && !releasedByDeadOwner) {
          throw new WorktreeWorkerConflictError();
        }
        if (
          !sameValues(existing.ownership.files, ownership.files) ||
          !sameValues(existing.ownership.symbols, ownership.symbols) ||
          !sameValues(existing.ownership.domains, ownership.domains) ||
          !sameValues(existing.dependencies, dependencies)
        ) {
          throw new WorktreeStateConflictError(
            "task ownership and dependencies are immutable after reservation",
          );
        }
        if (existing.status === "ready" || existing.status === "queued") {
          // Adopt legacy records once, without changing path/base or bindings.
          const reused = existing.reservationGeneration ? existing : cloneRecord({
            ...existing, reservationGeneration: randomUUID(),
          });
          return {
            records: reused === existing ? records : records.map((record) =>
              record.taskKey === taskKey ? reused : record),
            result: { record: reused, isNew: false, resurrected: false },
          };
        }
        if (releasedByDeadOwner) {
          // The record was released only because its owner went terminal; the
          // physical worktree was kept exactly for this resume/retry lane.
          // Reclaim the slot under the same ownership exclusivity as a fresh
          // reservation, then prove the physical identity below before
          // promoting it back to ready.
          this.#assertNoOwnershipConflict(records, {
            taskKey,
            missionId,
            ownership,
            dependencies,
          });
          const resurrected = cloneRecord({
            ...existing,
            // Reatribuição: no reroute o reclamante é OUTRO agente do roster;
            // no resume clássico é o mesmo worker e isto é um no-op.
            workerId,
            reservationGeneration: candidate.reservationGeneration,
            status: "reserved" as const,
            failureReason: undefined,
            updatedAt: now,
          });
          return {
            records: records.map((record) =>
              record.taskKey === taskKey ? resurrected : record,
            ),
            result: { record: resurrected, isNew: true, resurrected: true },
          };
        }
        throw new WorktreeStateConflictError(
          `task worktree is already ${existing.status}`,
        );
      }

      for (const dependency of dependencies) {
        const dependencyRecord = records.find(
          (record) => record.taskKey === dependency,
        );
        if (
          !dependencyRecord ||
          dependencyRecord.status === "failed" ||
          dependencyRecord.status === "abandoned"
        ) {
          throw new WorktreeStateConflictError(
            `explicit dependency is unavailable: ${dependency}`,
          );
        }
      }

      this.#assertNoOwnershipConflict(records, {
        taskKey,
        missionId,
        ownership,
        dependencies,
      });
      if (
        records.some(
          (record) =>
            record.worktreePath === worktreePath ||
            record.branchRef === branchRef,
        )
      ) {
        throw new WorktreeStateConflictError(
          "derived worktree path or branch is already reserved",
        );
      }
      return {
        records: [...records, candidate],
        result: { record: candidate, isNew: true, resurrected: false },
      };
    });

    if (!reservation.isNew) {
      await assertTaskWorktreeAsync(this.#asyncGit, reservation.record);
      assertCurrentAuthority();
      const current = this.#snapshot(scopeKey).records.find((record) => record.taskKey === taskKey);
      if (!current || !["ready", "queued"].includes(current.status) ||
          current.workerId !== workerId || current.baseSha !== reservation.record.baseSha ||
          current.reservationGeneration !== reservation.record.reservationGeneration) {
        throw new WorktreeStateConflictError("worktree reservation changed during reuse");
      }
      return cloneRecord(current);
    }

    try {
      await assertRepositoryUnchangedAsync(this.#asyncGit, repository, requireClean);
      assertCurrentAuthority();
      if (reservation.resurrected) {
        // The derived path and branch exist by design: the slot was released
        // without touching Git. Prove the exact physical identity instead of
        // materializing, mirroring the ready/queued reuse contract.
        await assertTaskWorktreeAsync(this.#asyncGit, reservation.record);
      } else {
        if (fs.existsSync(worktreePath)) {
          throw new Error("derived worktree path already exists");
        }
        const branchExists = await this.#asyncGit.run(
          repository.rootRealPath,
          ["show-ref", "--verify", "--quiet", branchRef],
          { allowFailure: true },
        );
        if (branchExists.status === 0) {
          throw new Error("derived Nexus branch already exists");
        }
        if (branchExists.status !== 1) {
          throw new GitCommandError(
            "Git could not verify the derived branch",
            ["show-ref", "--verify", "--quiet", branchRef],
            branchExists,
          );
        }
        assertCurrentAuthority();
        const current = this.#snapshot(scopeKey).records.find((record) => record.taskKey === taskKey);
        if (current?.status !== "reserved" ||
            current.reservationGeneration !== reservation.record.reservationGeneration) {
          throw new WorktreeStateConflictError("worktree reservation changed during creation");
        }
        // CoW-aware materialization (APFS clonefile path when enabled; else git).
        const materialized = await materializeGitWorktree({
          repositoryRoot: repository.rootRealPath,
          worktreePath,
          branchRef,
          headSha: repository.headSha,
          git: this.#asyncGit,
        });
        assertCurrentAuthority();
        input.onMaterialized?.(materialized);
        assertCurrentAuthority();
        await assertTaskWorktreeAsync(this.#asyncGit, candidate);
      }
      assertCurrentAuthority();
      await assertRepositoryUnchangedAsync(this.#asyncGit, repository, requireClean);
      assertCurrentAuthority();
      return this.#transition(scopeKey, taskKey, (record) => {
        if (record.status !== "reserved" || record.workerId !== workerId ||
            record.reservationGeneration !== reservation.record.reservationGeneration) {
          throw new WorktreeStateConflictError("worktree reservation changed during creation");
        }
        return { ...record, status: "ready", updatedAt: this.#timestamp() };
      });
    } catch (error) {
      try {
        this.#transition(scopeKey, taskKey, (record) => {
          // A close/reroute that happened during Git owns its terminal state.
          if (record.status !== "reserved" || record.workerId !== workerId ||
              record.reservationGeneration !== reservation.record.reservationGeneration) return record;
          return {
            ...record,
            status: "failed",
            failureReason: this.#failureMessage(error),
            updatedAt: this.#timestamp(),
          };
        });
      } catch {
        // Prefer the materialize/create failure; transition races must not
        // mask the original cause for callers.
      }
      throw error;
    }
  }

  /**
   * Re-anchor a proven output-free `ready` worktree to the current
   * integration HEAD.
   *
   * Advisory (read_only) lanes are claimed in the kickoff wave — the claim
   * transaction materializes the task worktree at the HEAD of that moment —
   * but the worker session may only be (re)bound after a sibling executor
   * integrated. Bound to the claim-time tree, the advisor would validate a
   * checkout that does not contain the mission result and its physical
   * handoff receipt would seal the stale base with a post-integration
   * timestamp, which the completion chronology invariant rejects.
   *
   * This is a fast-forward, never a blind reset: the exact physical identity
   * and cleanliness are proven by `assertTaskWorktree` (same proof as the
   * ready/queued reuse contract), the task HEAD must still equal the frozen
   * base (any worker commit means physical output exists and re-anchoring is
   * refused), the integration HEAD must be a descendant of that base, and
   * the durable base SHA only advances through the same CAS used by every
   * other transition. Records that are not `ready` (a queued/integrated task
   * already produced output; a reserved/failed one has no proven tree) are
   * returned untouched.
   *
   * Returns the current record — re-anchored or not — or null when the task
   * has no worktree record.
   */
  reanchorReadyWorktreeToIntegrationHead(
    scope: ProjectExecutionScope,
    missionId: string,
    taskId: string,
  ): WorktreeRecord | null {
    const record = this.get(scope, missionId, taskId);
    if (!record || record.status !== "ready") return record;
    const snapshot = this.inspectIntegration(record);
    if (snapshot.headSha === record.baseSha) return record;
    const taskHeadSha = assertTaskWorktree(this.#git, record);
    if (taskHeadSha !== record.baseSha) {
      throw new WorktreeStateConflictError(
        "task worktree HEAD diverged from its frozen base",
      );
    }
    const ancestry = this.#git.run(
      record.worktreePath,
      ["merge-base", "--is-ancestor", record.baseSha, snapshot.headSha],
      { allowFailure: true },
    );
    if (ancestry.status === 1) {
      throw new WorktreeStateConflictError(
        "integration HEAD is not a descendant of the frozen worktree base",
      );
    }
    if (ancestry.status !== 0) {
      throw new GitCommandError(
        "Git could not prove the integration HEAD ancestry",
        ["merge-base", "--is-ancestor", record.baseSha, snapshot.headSha],
        ancestry,
      );
    }
    this.#git.run(record.worktreePath, [
      "reset",
      "--hard",
      snapshot.headSha,
    ]);
    const reanchoredHead = assertTaskWorktree(this.#git, record);
    if (reanchoredHead !== snapshot.headSha) {
      throw new WorktreeStateConflictError(
        "re-anchored worktree HEAD diverged from the integration HEAD",
      );
    }
    return this.#transition(
      this.scopeKey(scope),
      record.taskKey,
      (current) => {
        if (
          current.status !== "ready" ||
          current.baseSha !== record.baseSha
        ) {
          throw new WorktreeStateConflictError(
            "worktree state changed during the re-anchor",
          );
        }
        return {
          ...current,
          baseSha: snapshot.headSha,
          updatedAt: this.#timestamp(),
        };
      },
    );
  }

  get(
    scope: ProjectExecutionScope,
    missionId: string,
    taskId: string,
  ): WorktreeRecord | null {
    const key = worktreeTaskKey(missionId, taskId);
    const record =
      this.#snapshot(this.scopeKey(scope)).records.find(
        (candidate) => candidate.taskKey === key,
      ) ?? null;
    if (!record) return null;
    const expectedRoot = path.resolve(scope.rootRealPath);
    const actualRoot = fs.realpathSync(expectedRoot);
    if (
      scope.rootRealPath !== expectedRoot ||
      actualRoot !== expectedRoot ||
      record.rootRealPath !== actualRoot ||
      record.projectId !== scope.projectId ||
      record.checkoutId !== scope.checkoutId
    ) {
      throw new WorktreeStateConflictError(
        "worktree record does not belong to the requested scope root",
      );
    }
    return record;
  }

  prepareIntegration(
    scope: ProjectExecutionScope,
    missionId: string,
    taskId: string,
  ): PreparedWorktreeIntegration {
    return this.#prepareIntegration(scope, missionId, taskId, false);
  }

  prepareRecoveryIntegration(
    scope: ProjectExecutionScope,
    missionId: string,
    taskId: string,
  ): PreparedWorktreeIntegration {
    return this.#prepareIntegration(scope, missionId, taskId, true);
  }

  /**
   * Inspect the honest "QA passed without a correction" branch.
   *
   * `null` means there are real committed changes and the ordinary MergeQueue
   * must handle them. A dirty worktree, empty commit, dependency drift, or
   * primary-HEAD drift is an error — none can be reclassified as no-change.
   */
  prepareNoChangeValidation(
    scope: ProjectExecutionScope,
    missionId: string,
    taskId: string,
  ): PreparedWorktreeNoChangeValidation | null {
    return prepareNoChangeValidationFn(this.#integrationHost(), scope, missionId, taskId);
  }

  prepareDiscardedNoChangeValidation(
    scope: ProjectExecutionScope,
    missionId: string,
    taskId: string,
  ): PreparedWorktreeNoChangeValidation | null {
    return prepareDiscardedNoChangeValidationFn(
      this.#integrationHost(),
      scope,
      missionId,
      taskId,
    );
  }

  markValidatedNoChange(
    scope: ProjectExecutionScope,
    missionId: string,
    taskId: string,
    expectedTaskHeadSha: string,
    expectedIntegrationHeadSha: string,
  ): WorktreeRecord {
    return markValidatedNoChangeFn(
      this.#integrationHost(),
      scope,
      missionId,
      taskId,
      expectedTaskHeadSha,
      expectedIntegrationHeadSha,
    );
  }

  markDiscardedNoChange(
    scope: ProjectExecutionScope,
    missionId: string,
    taskId: string,
    expectedTaskHeadSha: string,
    expectedIntegrationHeadSha: string,
  ): WorktreeRecord {
    return markDiscardedNoChangeFn(
      this.#integrationHost(),
      scope,
      missionId,
      taskId,
      expectedTaskHeadSha,
      expectedIntegrationHeadSha,
    );
  }

  #prepareIntegration(
    scope: ProjectExecutionScope,
    missionId: string,
    taskId: string,
    allowTerminalRecovery: boolean,
  ): PreparedWorktreeIntegration {
    return prepareIntegrationInternal(
      this.#integrationHost(),
      scope,
      missionId,
      taskId,
      allowTerminalRecovery,
    );
  }

  #integrationHost(): IntegrationHost {
    return {
      git: this.#git,
      get: (scope, missionId, taskId) => this.get(scope, missionId, taskId),
      snapshot: (scopeKey) => this.#snapshot(scopeKey),
      transition: (scopeKey, taskKey, update) =>
        this.#transition(scopeKey, taskKey, update),
      timestamp: () => this.#timestamp(),
      scopeKey: (scope) => this.scopeKey(scope),
      integrationSnapshot: (record, options) =>
        this.integrationSnapshot(record, options),
      prepareRecoveryIntegration: (scope, missionId, taskId) =>
        this.prepareRecoveryIntegration(scope, missionId, taskId),
    };
  }

  reopenFailedForRetry(
    scope: ProjectExecutionScope,
    missionId: string,
    taskId: string,
    expectedTaskHeadSha: string,
  ): WorktreeRecord {
    const expectedHead = assertSha(expectedTaskHeadSha, "task head SHA");
    const prepared = this.prepareRecoveryIntegration(scope, missionId, taskId);
    if (prepared.taskHeadSha !== expectedHead) {
      throw new WorktreeStateConflictError(
        "task HEAD changed before the retry could be reopened",
      );
    }
    const taskKey = worktreeTaskKey(missionId, taskId);
    return this.#transition(this.scopeKey(scope), taskKey, (record) => {
      if (record.status !== "failed" || record.integratedSha !== undefined) {
        throw new WorktreeStateConflictError(
          "only a failed, non-integrated task can be reopened for retry",
        );
      }
      return {
        ...record,
        reservationGeneration: randomUUID(),
        status: "ready",
        taskHeadSha: undefined,
        integratedSha: undefined,
        failureReason: undefined,
        updatedAt: this.#timestamp(),
      };
    });
  }

  finalizeRecoveredIntegration(
    scope: ProjectExecutionScope,
    missionId: string,
    taskId: string,
    expectedTaskHeadSha: string,
    integratedSha: string,
  ): WorktreeRecord {
    const expectedHead = assertSha(expectedTaskHeadSha, "task head SHA");
    const exactIntegratedSha = assertSha(integratedSha, "integrated SHA");
    const taskKey = worktreeTaskKey(missionId, taskId);
    return this.#transition(this.scopeKey(scope), taskKey, (record) => {
      if (
        record.taskHeadSha !== expectedHead ||
        (record.integratedSha !== undefined &&
          record.integratedSha !== exactIntegratedSha) ||
        (record.status !== "failed" &&
          record.status !== "queued" &&
          record.status !== "integrated")
      ) {
        throw new WorktreeStateConflictError(
          "worktree state does not match the recovered integration",
        );
      }
      return {
        ...record,
        status: "integrated",
        integratedSha: exactIntegratedSha,
        failureReason: undefined,
        updatedAt: this.#timestamp(),
      };
    });
  }

  integrationSnapshot(
    record: WorktreeRecord,
    options?: { readonly requireClean?: boolean },
  ): IntegrationCheckoutSnapshot {
    const snapshot = this.inspectIntegration(record);
    // Limpeza é pré-condição de MERGE (escrever no checkout primário), não de
    // leitura do HEAD: validações no-change consultam este snapshot enquanto o
    // escritor same_checkout legitimamente suja o checkout (caminho simples).
    if (!snapshot.clean && options?.requireClean !== false) {
      throw new WorktreeStateConflictError("primary checkout must be clean");
    }
    const { rootRealPath, integrationRef, headSha } = snapshot;
    return Object.freeze({ rootRealPath, integrationRef, headSha });
  }

  inspectIntegration(record: WorktreeRecord): IntegrationCheckoutInspection {
    const snapshot = readRepositorySnapshot(
      this.#git,
      {
        projectId: record.projectId,
        checkoutId: record.checkoutId,
        rootRealPath: record.rootRealPath,
      } as ProjectExecutionScope,
      false,
    );
    if (snapshot.integrationRef !== record.integrationRef) {
      throw new WorktreeStateConflictError("integration branch changed");
    }
    return Object.freeze({ ...snapshot });
  }

  assertIntegrationUnchanged(
    record: WorktreeRecord,
    expectedHeadSha: string,
  ): IntegrationCheckoutSnapshot {
    const snapshot = this.integrationSnapshot(record);
    if (snapshot.headSha !== expectedHeadSha) {
      throw new WorktreeStateConflictError(
        "integration HEAD changed during validation",
      );
    }
    return snapshot;
  }

  markQueued(
    scope: ProjectExecutionScope,
    missionId: string,
    taskId: string,
    taskHeadSha: string,
  ): WorktreeRecord {
    const taskKey = worktreeTaskKey(missionId, taskId);
    return this.#transition(this.scopeKey(scope), taskKey, (record) => {
      if (record.status !== "ready" && record.status !== "queued") {
        throw new WorktreeStateConflictError("task cannot enter merge queue");
      }
      return {
        ...record,
        status: "queued",
        taskHeadSha: assertSha(taskHeadSha, "task head SHA"),
        updatedAt: this.#timestamp(),
      };
    });
  }

  markIntegrated(
    scope: ProjectExecutionScope,
    missionId: string,
    taskId: string,
    integratedSha: string,
  ): WorktreeRecord {
    const taskKey = worktreeTaskKey(missionId, taskId);
    return this.#transition(this.scopeKey(scope), taskKey, (record) => {
      if (record.status !== "queued" || !record.taskHeadSha) {
        throw new WorktreeStateConflictError(
          "only a queued task can be marked integrated",
        );
      }
      return {
        ...record,
        status: "integrated",
        integratedSha: assertSha(integratedSha, "integrated SHA"),
        failureReason: undefined,
        updatedAt: this.#timestamp(),
      };
    });
  }

  /**
   * Mirrors an exact main-checkout CAS rollback in durable worktree state.
   * The task branch remains intact and queued so a technical retry or a repair
   * commit can be validated again; no integrated receipt survives the rollback.
   */
  restoreQueuedAfterIntegrationRollback(
    scope: ProjectExecutionScope,
    missionId: string,
    taskId: string,
    expectedTaskHeadSha: string,
    rolledBackCandidateSha: string,
  ): WorktreeRecord {
    const taskKey = worktreeTaskKey(missionId, taskId);
    const taskHeadSha = assertSha(expectedTaskHeadSha, "task head SHA");
    const candidateSha = assertSha(
      rolledBackCandidateSha,
      "rolled back candidate SHA",
    );
    return this.#transition(this.scopeKey(scope), taskKey, (record) => {
      const { integratedSha: currentIntegratedSha, ...withoutIntegration } =
        record;
      const isQueued =
        record.status === "queued" &&
        record.taskHeadSha === taskHeadSha &&
        currentIntegratedSha === undefined;
      const isIntegrated =
        record.status === "integrated" &&
        record.taskHeadSha === taskHeadSha &&
        currentIntegratedSha === candidateSha;
      if (!isQueued && !isIntegrated) {
        throw new WorktreeStateConflictError(
          "worktree state diverged from the rolled-back integration",
        );
      }
      return {
        ...withoutIntegration,
        // Integration ended this attempt. Queued-only rollback is a replay.
        ...(isIntegrated ? { reservationGeneration: randomUUID() } : {}),
        status: "queued",
        taskHeadSha,
        failureReason: undefined,
        updatedAt: this.#timestamp(),
      };
    });
  }

  /**
   * Retomada de um writer de pane: reabre o registro liberado (`failed`) da
   * MESMA worktree/branch, sem materializar nada. Prova a identidade física
   * (raiz Git + branch); WIP não commitado é permitido — é do próprio writer.
   */
  reopenPaneWriter(
    scope: ProjectExecutionScope,
    missionId: string,
    taskId: string,
  ): WorktreeRecord {
    const record = this.get(scope, missionId, taskId);
    if (!record || record.ownerKind !== "pane") {
      throw new WorktreeStateConflictError("pane writer worktree record is missing");
    }
    if (this.#collecting.has(record.taskKey)) {
      throw new WorktreeStateConflictError("pane writer worktree is being collected");
    }
    if (record.status !== "ready" && (record.status !== "failed" || record.integratedSha !== undefined)) {
      throw new WorktreeStateConflictError(`pane writer worktree is ${record.status}`);
    }
    const real = fs.existsSync(record.worktreePath) ? fs.realpathSync(record.worktreePath) : "";
    if (real !== record.worktreePath) {
      throw new WorktreeStateConflictError("pane writer worktree path is gone");
    }
    assertSafeLocalGitConfig(this.#git, real);
    const top = this.#git.run(real, ["rev-parse", "--show-toplevel"], { allowFailure: true });
    const head = this.#git.run(real, ["symbolic-ref", "--quiet", "HEAD"], { allowFailure: true });
    if (top.status !== 0 || fs.realpathSync(top.stdout.trim()) !== real ||
        head.status !== 0 || head.stdout.trim() !== record.branchRef) {
      throw new WorktreeStateConflictError("pane writer worktree no longer holds its branch");
    }
    if (record.status === "ready") return record;
    return this.#transition(this.scopeKey(scope), record.taskKey, (current) => {
      if (current.status !== "failed" || current.integratedSha !== undefined) {
        throw new WorktreeStateConflictError(`pane writer worktree is ${current.status}`);
      }
      return { ...current, reservationGeneration: randomUUID(), status: "ready",
        failureReason: undefined, updatedAt: this.#timestamp() };
    });
  }

  /**
   * Vincula um pane/sessão (mintados pelo Main) ao writer de pane, de forma
   * durável: `resume` depois de reiniciar o app acha a worktree por eles.
   */
  bindPaneWriter(
    scope: ProjectExecutionScope,
    missionId: string,
    taskId: string,
    binding: { readonly paneId?: string; readonly sessionId?: string },
  ): WorktreeRecord {
    const append = (ids: readonly string[] | undefined, id: string | undefined) =>
      id === undefined || ids?.includes(id)
        ? ids
        : [...(ids ?? []), assertIdentifier(id, "pane binding")].slice(-MAX_PANE_BINDINGS);
    return this.#transition(this.scopeKey(scope), worktreeTaskKey(missionId, taskId), (record) => {
      if (record.ownerKind !== "pane") {
        throw new WorktreeStateConflictError("only pane writer worktrees bind panes");
      }
      const paneIds = append(record.paneIds, binding.paneId);
      const sessionIds = append(record.sessionIds, binding.sessionId);
      return paneIds === record.paneIds && sessionIds === record.sessionIds
        ? record
        : { ...record, ...(paneIds ? { paneIds } : {}), ...(sessionIds ? { sessionIds } : {}),
          updatedAt: this.#timestamp() };
    });
  }

  /**
   * GC dos writers de pane liberados: remove worktree, branch e registro só
   * quando a branch já está contida no HEAD do checkout, avançou além da base
   * (um writer sem commit continua retomável) E a worktree está limpa (nada
   * que exista só ali). Trabalho não integrado nunca é apagado; qualquer
   * dúvida de identidade mantém tudo.
   */
  async collectIntegratedPaneWorktrees(
    scope: ProjectExecutionScope,
    missionId: string,
    inUse: (worktreePath: string) => boolean,
    confirmUnused?: (worktreePath: string) => Promise<boolean>,
  ): Promise<readonly WorktreeRecord[]> {
    return (await this.collectReleasedPaneWorktrees(scope, {
      owner: (owner) => owner === missionId,
      inUse,
      ...(confirmUnused ? { confirmUnused } : {}),
    })).removed;
  }

  /**
   * F-908: coleta configurável dos writers de pane liberados (`failed` ou
   * `integrated`). Só remove worktree LIMPA, sem `--force`, cujos ignorados
   * sejam todos caches regeneráveis e sem flags de índice nem gitlink. Sem
   * `salvageDirty` vale a regra estrita acima; com ele (coleta de paradas), a
   * worktree limpa sai mesmo com a branch não mesclada — a branch nunca é
   * apagada (`branch -d`) — e a suja ganha salvaguarda e fica. Git e fs
   * assíncronos; cada recusa ou falha é contada por motivo em `kept`.
   */
  async collectReleasedPaneWorktrees(
    scope: ProjectExecutionScope,
    options: PaneWorktreeGcOptions,
  ): Promise<PaneWorktreeGcReport> {
    const scopeKey = this.scopeKey(scope);
    const now = this.#timestamp();
    const released = (record: WorktreeRecord) => record.ownerKind === "pane" &&
      // `tab` (abas isoladas) também é pane, mas não é writer: nunca coletada.
      record.taskId.startsWith("pane-") &&
      (record.status === "failed" || record.status === "integrated") &&
      options.owner(record.missionId) &&
      now - record.updatedAt >= (options.minIdleMs ?? 0) &&
      !options.inUse(record.worktreePath);
    // Rotação: quem foi examinado há mais tempo (ou nunca) vai primeiro.
    const candidates = this.#snapshot(scopeKey).records.filter(released).sort((left, right) =>
      (this.#lastExamined.get(left.taskKey) ?? -1) - (this.#lastExamined.get(right.taskKey) ?? -1));
    const maxCandidates = options.maxCandidates ?? Number.POSITIVE_INFINITY;
    const removed: WorktreeRecord[] = [];
    const kept: Record<string, number> = {};
    let deferred = 0;
    for (const [index, candidate] of candidates.entries()) {
      if (index >= maxCandidates || (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt)) {
        deferred = candidates.length - index;
        break;
      }
      this.#lastExamined.set(candidate.taskKey, this.#examinations++);
      let reason: string | null;
      try {
        reason = this.#collecting.has(candidate.taskKey)
          ? "collecting"
          : await this.#collectReleasedPaneWorktree(scopeKey, candidate, released, options);
      } catch (error) {
        // Identidade incerta mantém worktree, branch e registro — mas conta.
        reason = `error: ${this.#failureMessage(error).slice(0, 120)}`;
      }
      if (reason === null) {
        removed.push(candidate);
        this.#lastExamined.delete(candidate.taskKey);
      }
      else kept[reason] = (kept[reason] ?? 0) + 1;
    }
    return Object.freeze({ removed: Object.freeze(removed), kept: Object.freeze(kept), deferred });
  }

  // Entre dois awaits o estado pode mudar (resume, pane novo): antes de
  // remover, revalida registro e uso e marca o writer como "em coleta" para
  // `reopenPaneWriter` recusá-lo. Devolve o motivo de manter, ou null.
  async #collectReleasedPaneWorktree(
    scopeKey: string,
    candidate: WorktreeRecord,
    released: (record: WorktreeRecord) => boolean,
    options: PaneWorktreeGcOptions,
  ): Promise<string | null> {
    const git = this.#asyncGit;
    const root = candidate.rootRealPath;
    const aged = options.salvageDirty !== undefined;
    // Toda prova abaixo é sobre ESTE commit; a ref é conferida de novo antes de remover.
    const tip = await this.#branchTip(root, candidate.branchRef);
    if (!tip) return "branch-missing";
    const isMerged = async () => (await git.run(root,
      ["merge-base", "--is-ancestor", tip, "HEAD"], { allowFailure: true })).status === 0;
    const merged = await isMerged();
    if (!merged && !aged) return "unmerged";
    if (!aged && tip === candidate.baseSha) return "no-commits";
    const entry = await fs.promises.lstat(candidate.worktreePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    let real: string | undefined;
    let statusBefore = "";
    if (entry) {
      // Nunca segue symlink nem sai da raiz gerenciada.
      if (entry.isSymbolicLink() || !entry.isDirectory()) return "not-a-directory";
      real = await fs.promises.realpath(candidate.worktreePath);
      if (real !== candidate.worktreePath) return "path-mismatch";
      const managed = [this.worktreesRoot, this.legacyWorktreesRoot].some((managedRoot) =>
        real !== managedRoot && isPathInsideOrEqual(managedRoot, real!));
      if (!managed || isDangerousWorktreeRemovalPath(real, root)) return "outside-managed-root";
      await assertSafeLocalGitConfigAsync(git, real);
      const top = await git.run(real, ["rev-parse", "--show-toplevel"], { allowFailure: true });
      const head = await git.run(real, ["symbolic-ref", "--quiet", "HEAD"], { allowFailure: true });
      if (top.status !== 0 || await fs.promises.realpath(top.stdout.trim()) !== real ||
          head.status !== 0 || head.stdout.trim() !== candidate.branchRef) return "identity";
      const listed = await git.run(root, ["worktree", "list", "--porcelain"]);
      if (!findRegisteredDeletableWorktree(root, real, parseWorktreeList(listed.stdout))) return "unregistered";
      statusBefore = (await git.run(real, WORKTREE_STATUS_ARGS)).stdout;
      const entries = statusBefore.split("\0").filter(Boolean);
      // Suja (inclusive staged distinto): nunca sai. A coleta de paradas só registra a salvaguarda.
      if (entries.some((field) => !field.startsWith("!! "))) {
        if (!aged) return "dirty";
        await options.salvageDirty!(candidate);
        return "dirty-kept";
      }
      if (!entries.every((field) => regenerableIgnored(field.slice(3)))) return "ignored-kept";
      // `assume-unchanged`/`skip-worktree` escondem edições do status (e da
      // re-checagem do próprio `worktree remove`); gitlink guarda outro repositório.
      for (const line of (await git.run(real, ["ls-files", "-s", "-v", "-z"])).stdout.split("\0")) {
        if (!line) continue;
        if (line[0] !== line[0].toUpperCase() || line[0] === "S") return "index-flags";
        if (line.slice(2, 8) === "160000") return "gitlink";
      }
    }
    // Revalidação síncrona + marca: nada reabre este writer daqui em diante.
    const record = this.#snapshot(scopeKey).records.find((current) =>
      current.taskKey === candidate.taskKey);
    if (!record || !released(record) || record.updatedAt !== candidate.updatedAt) return "changed";
    // Marca exclusiva: outro coletor (fim do pane × paradas) que entrou antes
    // da marca não a toma nem a apaga ao sair, senão a retomada passaria.
    if (this.#collecting.has(record.taskKey)) return "collecting";
    this.#collecting.add(record.taskKey);
    try {
      // Revalida depois dos awaits da prova: ref da branch, ancestralidade,
      // HEAD, status e uso da worktree têm de ser os que foram provados.
      if (await this.#branchTip(root, record.branchRef) !== tip || (merged && !await isMerged())) {
        return "changed";
      }
      if (real !== undefined) {
        if (options.confirmUnused && !await options.confirmUnused(real).catch(() => false)) return "in-use";
        // Inventário (alterações + ignorados) refeito por último, logo antes da
        // remoção: o que surgiu durante a prova de uso mantém tudo. Janela
        // residual: o que for escrito entre esta leitura e o `worktree remove`.
        const head = await git.run(real, ["symbolic-ref", "--quiet", "HEAD"], { allowFailure: true });
        const status = await git.run(real, WORKTREE_STATUS_ARGS);
        if (head.stdout.trim() !== record.branchRef || status.stdout !== statusBefore) return "changed";
        // Nunca --force: o Git re-checa a limpeza na própria remoção e recusa
        // worktree trancada (`git worktree lock`).
        await git.run(root, ["worktree", "remove", real], { timeoutMs: WORKTREE_REMOVE_TIMEOUT_MS });
      }
      // -d (não -D): o Git só apaga a branch se ela estiver mesclada.
      if (await this.#branchTip(root, record.branchRef) !== tip) return "changed";
      await git.run(root, ["branch", "-d", record.branchRef.slice("refs/heads/".length)], { allowFailure: true });
      this.#mutate(scopeKey, (records) => ({
        records: records.filter((current) => current.taskKey !== record.taskKey),
        result: undefined,
      }));
      return null;
    } finally {
      this.#collecting.delete(record.taskKey);
    }
  }

  async #branchTip(root: string, branchRef: string): Promise<string> {
    const tip = await this.#asyncGit.run(root,
      ["rev-parse", "--verify", "--quiet", `${branchRef}^{commit}`], { allowFailure: true });
    return tip.status === 0 ? tip.stdout.trim() : "";
  }

  /**
   * F-908: `git worktree prune` assíncrono, só quando TODA entrada `prunable`
   * do repositório é caminho de um registro Nexus atual (prune é tudo-ou-nada;
   * não esquecemos a worktree de outro volume desmontado do operador).
   */
  async pruneManagedWorktrees(
    scope: ProjectExecutionScope,
  ): Promise<{ readonly pruned: number } | { readonly skipped: string }> {
    const listed = await this.#asyncGit.run(scope.rootRealPath, ["worktree", "list", "--porcelain"]);
    const prunable = parseWorktreeList(listed.stdout).filter((worktree) => worktree.prunable);
    if (prunable.length === 0) return { pruned: 0 };
    // Só caminhos de registros Nexus atuais deste runtime; formato de caminho
    // não é proveniência (worktree manual do operador nunca é esquecida).
    const known = new Set(this.#snapshot(this.scopeKey(scope)).records.map((record) => record.worktreePath));
    if (!prunable.every((worktree) => known.has(worktree.path))) return { skipped: "prunable-not-nexus" };
    await this.#asyncGit.run(scope.rootRealPath, ["worktree", "prune"]);
    return { pruned: prunable.length };
  }

  markFailed(
    scope: ProjectExecutionScope,
    missionId: string,
    taskId: string,
    reason: string,
    integratedSha?: string,
  ): WorktreeRecord {
    const taskKey = worktreeTaskKey(missionId, taskId);
    return this.#transition(this.scopeKey(scope), taskKey, (record) => {
      if (record.status === "integrated" || record.status === "abandoned") {
        throw new WorktreeStateConflictError(
          `cannot fail a task that is already ${record.status}`,
        );
      }
      return {
        ...record,
        status: "failed",
        ...(integratedSha
          ? { integratedSha: assertSha(integratedSha, "integrated SHA") }
          : {}),
        failureReason: this.#failureMessage(reason),
        updatedAt: this.#timestamp(),
      };
    });
  }


  #snapshot(scopeKey: string): WorktreeStateSnapshot {
    try {
      return validateWorktreeStateSnapshot(this.#stateStore.read(scopeKey), {
        scopeKey,
        worktreesRoot: this.worktreesRoot,
        legacyWorktreesRoot: this.legacyWorktreesRoot,
      });
    } catch (error) {
      throw new WorktreeStateConflictError(
        error instanceof Error ? error.message : "invalid worktree state",
      );
    }
  }

  #mutate<T>(
    scopeKey: string,
    update: (records: readonly WorktreeRecord[]) => {
      records: readonly WorktreeRecord[];
      result: T;
    },
  ): T {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const snapshot = this.#snapshot(scopeKey);
      const next = update(snapshot.records);
      if (next.records === snapshot.records) {
        return next.result;
      }
      let records: readonly WorktreeRecord[];
      try {
        records = validateWorktreeStateSnapshot(
          { revision: snapshot.revision, records: next.records },
          {
            scopeKey,
            worktreesRoot: this.worktreesRoot,
            legacyWorktreesRoot: this.legacyWorktreesRoot,
          },
        ).records;
      } catch (error) {
        throw new WorktreeStateConflictError(
          error instanceof Error ? error.message : "invalid worktree state",
        );
      }
      if (
        this.#stateStore.compareAndSwap(scopeKey, snapshot.revision, records)
      ) {
        return next.result;
      }
    }
    throw new WorktreeStateConflictError(
      "worktree persistence CAS could not converge",
    );
  }

  #transition(
    scopeKey: string,
    taskKey: string,
    update: (record: WorktreeRecord) => WorktreeRecord,
  ): WorktreeRecord {
    return this.#mutate(scopeKey, (records) => {
      const index = records.findIndex((record) => record.taskKey === taskKey);
      if (index < 0) {
        throw new WorktreeStateConflictError(
          "worktree state record disappeared",
        );
      }
      const updated = cloneRecord(update(records[index]));
      return {
        records: records.map((record, candidateIndex) =>
          candidateIndex === index ? updated : record,
        ),
        result: updated,
      };
    });
  }

  #timestamp(): number {
    const value = this.#now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("worktree clock returned an invalid timestamp");
    }
    return value;
  }

  #failureMessage(error: unknown): string {
    try {
      const value = error instanceof Error ? error.message : error;
      const message = (typeof value === "string" ? value : String(value))
        .replaceAll("\0", " ")
        .slice(0, 2_048);
      return message.trim().length > 0
        ? message
        : "worktree operation failed with an unknown error";
    } catch {
      return "worktree operation failed with an unknown error";
    }
  }
}
