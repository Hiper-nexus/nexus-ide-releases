import { createHash } from "node:crypto";
import path from "node:path";
import type { ProjectExecutionScope } from "../../shared/types";
import type { ProjectRuntimeManager } from "./project-runtime-manager";
import {
  DEAD_OWNER_WORKTREE_RELEASE_MARKER,
  WorktreeManager,
  type CreateWorktreeInput,
  type PaneWorktreeGcReport,
  type WorktreeRecord,
} from "./worktree-manager";
import {
  MergeQueue,
  type EnqueueMergeInput,
  type MergeQueueBlock,
  type MergeQueueReconciliationResult,
  type MergeQueueResult,
  type MergeQueueStateSnapshot,
  type RetryMergeInput,
} from "./merge-queue";
import type {
  PreparedWorktreeIntegration,
  PreparedWorktreeNoChangeValidation,
} from "./worktree-contract";
import {
  SqliteMergeQueueStateStore,
  SqliteWorktreeStateStore,
} from "./sqlite-workflow-state-stores";
import { ScopedStoreBinding } from "../orch/scoped-store";
import { sweepPtysInsideWorktree, worktreeHasLiveSession } from "./worktree-pty-sweep";
import { scheduleWorktreeSalvage } from "../orch/isolated-writer-salvage";
import { listProcessCwds } from "./process-cwds";
import { isPathInsideOrEqual } from "./worktree-removal-safety";
import {
  managedCandidatesRoot,
  managedWorktreesRoot,
} from "./managed-worktree-layout";
import { inspectGitBinding } from "../context/git-binding";
import type { IntegratedMissionResult } from "../context/context-workflow-service";

interface ScopeRuntime {
  readonly scope: ProjectExecutionScope;
  readonly worktreeState: SqliteWorktreeStateStore;
  readonly mergeState: SqliteMergeQueueStateStore;
  readonly worktrees: WorktreeManager;
  readonly queue: MergeQueue;
}

function scopeKey(scope: ProjectExecutionScope): string {
  return `${scope.projectId}\0${scope.checkoutId}`;
}

function sameScope(
  left: ProjectExecutionScope,
  right: ProjectExecutionScope,
): boolean {
  return (
    left.installationId === right.installationId &&
    left.projectId === right.projectId &&
    left.checkoutId === right.checkoutId &&
    left.rootRealPath === right.rootRealPath
  );
}

/**
 * A worktree record exerts ownership only while the work that owns it can
 * still run: a schedulable task (`pending`/`running`) under a non-terminal
 * mission (`pending`/`running`). Terminal task states (`done`/`failed`) and
 * terminal mission states (`blocked`/`done`/`failed`) make the record
 * eligible for the dead-owner release sweep.
 */
const LIVE_TASK_STATUSES = new Set(["pending", "running"]);
const LIVE_MISSION_STATUSES = new Set(["pending", "running"]);

const DEAD_OWNER_WORKTREE_RELEASE_REASON =
  `${DEAD_OWNER_WORKTREE_RELEASE_MARKER} owning task or mission is terminal; ` +
  "ownership released, physical worktree kept for resume";

/**
 * F-908: coleta de worktrees de writers paradas. Roda depois do boot (nunca
 * no caminho de abertura do escopo), no máximo uma vez a cada REARM por
 * escopo, com teto de itens e de tempo por rodada.
 */
export const AGED_PANE_WORKTREE_GC: Readonly<Record<
  "delayMs" | "rearmMs" | "minIdleMs" | "maxCandidates" | "budgetMs" |
  "continuationDelayMs" | "maxContinuations", number
>> = Object.freeze({
  delayMs: 30_000,
  /** Rodada que bateu no teto continua logo, sem esperar o re-arme. */
  continuationDelayMs: 60_000,
  maxContinuations: 5,
  rearmMs: 6 * 60 * 60_000,
  minIdleMs: 24 * 60 * 60_000,
  maxCandidates: 12,
  budgetMs: 3 * 60_000,
});

export type AgedPaneWorktreeGcReport = PaneWorktreeGcReport & {
  readonly prune: { readonly pruned: number } | { readonly skipped: string };
};

export class WorktreeRuntimeRegistry {
  readonly #manager: ProjectRuntimeManager;
  readonly #runtimes = new Map<string, ScopeRuntime>();
  readonly #agedGcNextAt = new Map<string, number>();
  readonly #agedGcTimers = new Set<NodeJS.Timeout>();
  #agedGcGeneration = 0;

  constructor(manager: ProjectRuntimeManager) {
    this.#manager = manager;
  }

  forScope(scope: ProjectExecutionScope): ScopeRuntime {
    const key = scopeKey(scope);
    const existing = this.#runtimes.get(key);
    if (existing) {
      if (!sameScope(existing.scope, scope))
        throw new Error("worktree runtime scope collision");
      return existing;
    }
    const immutableScope = Object.freeze({ ...scope });
    const runtimeRoot = this.#manager.locationFor(scope).directory;
    // F-654: no win32 as worktrees saem do diretório de runtime (~219 chars)
    // para raízes curtas; o layout é o mesmo que o estado valida.
    const layoutLocation = {
      runtimeDirectory: runtimeRoot,
      baseDirectory: this.#manager.baseDirectory,
    };
    const worktreeState = new SqliteWorktreeStateStore(
      this.#manager,
      immutableScope,
    );
    const mergeState = new SqliteMergeQueueStateStore(
      this.#manager,
      immutableScope,
    );
    const worktrees = new WorktreeManager({
      runtimeRoot,
      worktreesRoot: managedWorktreesRoot(layoutLocation),
      stateStore: worktreeState,
    });
    const worktreeRecovery = worktreeState.recoverInvalidState(
      worktrees.scopeKey(immutableScope),
    );
    if (worktreeRecovery.action === "quarantined") {
      console.warn(
        `[worktree-runtime] archived ${worktreeRecovery.recordCount} invalid ` +
          `worktree record(s) as ${worktreeRecovery.quarantineId} ` +
          `(${worktreeRecovery.reason}); no Git path or ref was removed`,
      );
    }
    const queue = new MergeQueue({
      runtimeRoot,
      candidatesRoot: managedCandidatesRoot(layoutLocation),
      stateStore: mergeState,
      worktreeManager: worktrees,
    });
    // This registry instance is constructed only after the app's
    // single-instance boundary. Any pre-existing `reserved` row belongs to an
    // interrupted prior process and must converge before scheduler dispatch.
    worktrees.reconcileInterruptedReservations(immutableScope);
    // A record left behind by a deleted mission keeps claiming ownership, and
    // the overlap check then blocks every new mission with "worktree ownership
    // overlaps active task <id>" — naming a task that no longer exists, so the
    // operator cannot inspect or clear it. Reconcile only converges `reserved`
    // rows and never saw these. Drop records whose task row is gone; no Git
    // path, ref or worktree is touched.
    this.#purgeOrphanWorktrees(immutableScope, worktrees);
    // A blocked/failed mission's leftover `ready` record is the other wedge:
    // its task row still exists (so the purge keeps it) yet no dispatch can
    // ever run it again, and the strict no-overlap invariant then blocks
    // every later mission. Release those claims before the first dispatch.
    this.#releaseDeadOwnerWorktrees(immutableScope, {
      worktreeState,
      worktrees,
    });
    // Pane-owned writers have no durable task to resume after process restart.
    // Release only their reservation; retain Git output for manual integration.
    for (const record of worktreeState.read(worktrees.scopeKey(immutableScope)).records) {
      if (record.ownerKind === "pane" && (record.status === "ready" || record.status === "reserved")) {
        worktrees.markFailed(immutableScope, record.missionId, record.taskId,
          "pane writer interrupted by application restart; worktree and branch retained");
      }
    }
    queue.reconcile(immutableScope);
    // A durable merge block can only be acknowledged by its exact blocked
    // task. If that task's mission was deleted, the block is permanently
    // unacknowledgeable and every future mission of this scope inherits
    // MergeQueueBlockedError until its dispatch goes terminal. Lift exactly
    // those orphaned blocks here so a bricked scope heals on open.
    this.#retireOrphanedMissionMergeBlock(immutableScope, queue);
    const value = Object.freeze({
      scope: immutableScope,
      worktreeState,
      mergeState,
      worktrees,
      queue,
    });
    this.#runtimes.set(key, value);
    this.scheduleAgedPaneWriterGc(immutableScope);
    return value;
  }

  /**
   * F-908: agenda a coleta de worktrees paradas deste escopo (boot e, num app
   * aberto por dias, cada alocação nova re-arma a cada `rearmMs`). Nunca
   * lança; o timer não segura o processo vivo.
   */
  scheduleAgedPaneWriterGc(scope: ProjectExecutionScope): void {
    const key = scopeKey(scope);
    if (Date.now() < (this.#agedGcNextAt.get(key) ?? 0)) return;
    this.#agedGcNextAt.set(key, Date.now() + AGED_PANE_WORKTREE_GC.rearmMs);
    this.#armAgedPaneWriterGc(scope, AGED_PANE_WORKTREE_GC.delayMs, AGED_PANE_WORKTREE_GC.maxContinuations);
  }

  #armAgedPaneWriterGc(scope: ProjectExecutionScope, delayMs: number, continuations: number): void {
    const generation = this.#agedGcGeneration;
    const timer = setTimeout(() => {
      this.#agedGcTimers.delete(timer);
      void this.collectAgedPaneWriterWorktrees(scope).then((report) => {
        // Candidatos adiados pelo teto: rodada de continuação, limitada.
        if (report.deferred > 0 && continuations > 0 && generation === this.#agedGcGeneration) {
          this.#armAgedPaneWriterGc(scope, AGED_PANE_WORKTREE_GC.continuationDelayMs, continuations - 1);
        }
      }, (error: unknown) => {
        console.warn('[worktree-runtime] coleta de worktrees paradas adiada', error);
      });
    }, delayMs);
    timer.unref?.();
    this.#agedGcTimers.add(timer);
  }

  /**
   * Prova de uso pelo cwd ATUAL dos processos, para a worktree: cwd
   * desconhecido do mesmo uid (ou de outro uid sem ancestral 0700 do usuário)
   * conta como em uso.
   */
  #unusedByProcesses(): (worktreePath: string) => Promise<boolean> {
    return async (worktreePath) => {
      // Ancestrais do caminho real da worktree: os roots do manager podem ser
      // o caminho não resolvido (/var → /private/var) e não casariam.
      const privateAncestors: string[] = [];
      for (let dir = path.dirname(worktreePath); dir !== path.dirname(dir); dir = path.dirname(dir)) {
        privateAncestors.push(dir);
      }
      const cwds = await listProcessCwds({ privateAncestors });
      return cwds !== null && !worktreeHasLiveSession(worktreePath) &&
        !cwds.some((cwd) => isPathInsideOrEqual(worktreePath, cwd));
    };
  }

  /**
   * F-908: remove worktrees LIMPAS de writers de pane liberados há mais de
   * `minIdleMs`, missão done/failed/ausente, sem sessão viva e sem processo
   * com o cwd ATUAL dentro (sem essa prova, nada sai). Suja ganha a
   * salvaguarda F-794 e fica; branch não mesclada fica. Antes, prune dos
   * `prunable` com layout Nexus. Resultado registrado.
   */
  async collectAgedPaneWriterWorktrees(
    scope: ProjectExecutionScope,
    limits: Partial<typeof AGED_PANE_WORKTREE_GC> = {},
  ): Promise<AgedPaneWorktreeGcReport> {
    const { minIdleMs, maxCandidates, budgetMs } = { ...AGED_PANE_WORKTREE_GC, ...limits };
    const deadlineAt = Date.now() + budgetMs;
    const runtime = this.forScope(scope);
    // Sem o status das missões, nada é coletado (a leitura lança).
    const missionStatus = new Map(
      (
        new ScopedStoreBinding(this.#manager, scope)
          .readDatabase()
          .prepare('SELECT id, status FROM missions')
          .all() as ReadonlyArray<{ id: string; status: string }>
      ).map((row) => [row.id, row.status] as const),
    );
    // `operator-hand` nunca é linha de missão: conta como ausente.
    const finished = (missionId: string) => {
      const status = missionStatus.get(missionId);
      return status === undefined || status === 'done' || status === 'failed';
    };
    // Prune primeiro: libera a branch de pasta sumida para o `branch -d`.
    const prune = await runtime.worktrees.pruneManagedWorktrees(scope);
    const cwds = await listProcessCwds({ privateAncestors: [runtime.worktrees.runtimeRoot] });
    const occupied = (worktreePath: string, current: readonly string[]) =>
      worktreeHasLiveSession(worktreePath) || current.some((cwd) => isPathInsideOrEqual(worktreePath, cwd));
    const report: PaneWorktreeGcReport = cwds === null
      // win32, lsof/procfs indisponível ou com erro: sem prova de uso, nada sai.
      ? { removed: [], kept: { "liveness-unavailable": 1 }, deferred: 0 }
      : await runtime.worktrees.collectReleasedPaneWorktrees(scope, {
        owner: finished,
        inUse: (worktreePath) => occupied(worktreePath, cwds),
        confirmUnused: this.#unusedByProcesses(),
        minIdleMs,
        maxCandidates,
        deadlineAt,
        salvageDirty: (record) => scheduleWorktreeSalvage({
          worktreePath: record.worktreePath,
          branchRef: record.branchRef,
          missionId: record.missionId,
          taskId: record.taskId,
          reason: "gc",
        }, { notify: false }),
      });
    if (report.removed.length > 0 || Object.keys(report.kept).length > 0 ||
        report.deferred > 0 || !('pruned' in prune) || prune.pruned > 0) {
      console.warn(
        `[worktree-runtime] coleta de worktrees paradas: ${report.removed.length} removida(s), ` +
          `mantidas ${JSON.stringify(report.kept)}, ${report.deferred} para a próxima rodada, ` +
          `prune ${JSON.stringify(prune)}`,
      );
    }
    return Object.freeze({ ...report, prune });
  }

  /**
   * Best-effort orphan-block sweep for scope construction. Reads the live
   * mission ids straight from the scoped database — the same trusted source
   * `#purgeOrphanWorktrees` uses — so a block whose mission row disappeared
   * is provably unownable before it is lifted.
   */
  #retireOrphanedMissionMergeBlock(
    scope: ProjectExecutionScope,
    queue: MergeQueue,
  ): void {
    try {
      const liveMissionIds = new Set(
        (
          new ScopedStoreBinding(this.#manager, scope)
            .readDatabase()
            .prepare('SELECT id FROM missions')
            .all() as ReadonlyArray<{ id: string }>
        ).map((row) => row.id),
      );
      const retired = queue.retireOrphanedMissionBlock(scope, (missionId) =>
        liveMissionIds.has(missionId),
      );
      if (retired) {
        console.warn(
          '[worktree-runtime] lifted an orphaned merge block ' +
            `(${retired.errorName}: ${retired.reason.slice(0, 160)}); ` +
            'the owning mission no longer exists',
        );
      }
    } catch (error) {
      // Never block scope construction on an opportunistic cleanup.
      console.warn('[worktree-runtime] orphan merge block sweep skipped', error);
    }
  }

  /**
   * `forScope` only runs this sweep once per process (the ScopeRuntime is
   * memoized), so a mission deleted after that first call left its worktree
   * record orphaned for the rest of the process lifetime. `create` re-runs
   * the sweep before each reservation so the stale row is dropped from disk
   * before the ownership-overlap check evaluates it.
   */
  #purgeOrphanWorktrees(
    scope: ProjectExecutionScope,
    worktrees: WorktreeManager,
  ): readonly WorktreeRecord[] {
    try {
      const liveTaskIds = new Set(
        (
          new ScopedStoreBinding(this.#manager, scope)
            .readDatabase()
            .prepare('SELECT id FROM tasks')
            .all() as ReadonlyArray<{ id: string }>
        ).map((row) => row.id),
      );
      const purged = worktrees.purgeRecordsWithoutTask(scope, liveTaskIds);
      if (purged.length > 0) {
        console.warn(
          `[worktree-runtime] dropped ${purged.length} worktree record(s) ` +
            'whose task no longer exists; no Git path or ref was removed',
        );
      }
      return purged;
    } catch (error) {
      // Never block a dispatch attempt on an opportunistic cleanup.
      console.warn('[worktree-runtime] orphan record sweep skipped', error);
      return [];
    }
  }

  /**
   * Releases the ownership claim of records whose owning work can no longer
   * run — a terminal task (`done`/`failed`) or a task of a terminal mission
   * (`blocked`/`done`/`failed`). The state validator forbids two overlapping
   * active records, so a blocked mission's leftover `ready` row wedges every
   * later dispatch whose ownership overlaps it. The record is terminally
   * failed with a marker reason and stays on disk; the physical worktree is
   * never touched, and `WorktreeManager.create` provably resurrects exactly
   * these marked records when the same taskKey is reserved again, preserving
   * the technical retry lane (`requeueTechnicalBootstrapFailure`) and manual
   * resume. `queued` rows belong to the merge queue's own recovery and are
   * never released here.
   */
  #releaseDeadOwnerWorktrees(
    scope: ProjectExecutionScope,
    runtime: Pick<ScopeRuntime, "worktreeState" | "worktrees">,
  ): readonly WorktreeRecord[] {
    try {
      const rows = new ScopedStoreBinding(this.#manager, scope)
        .readDatabase()
        .prepare(
          `SELECT t.id AS task_id, t.mission_id AS mission_id,
                  t.status AS task_status, m.status AS mission_status
             FROM tasks t LEFT JOIN missions m ON m.id = t.mission_id`,
        )
        .all() as ReadonlyArray<{
        task_id: string;
        mission_id: string | null;
        task_status: string;
        mission_status: string | null;
      }>;
      const workStates = new Map(
        rows.map((row) => [`${row.mission_id}\0${row.task_id}`, row] as const),
      );
      const released: WorktreeRecord[] = [];
      const records = runtime.worktreeState.read(
        runtime.worktrees.scopeKey(scope),
      ).records;
      for (const record of records) {
        if (record.status !== "reserved" && record.status !== "ready") {
          continue;
        }
        const work = workStates.get(`${record.missionId}\0${record.taskId}`);
        // A missing task row is the orphan purge's lane, not this one.
        if (!work) continue;
        const live =
          LIVE_TASK_STATUSES.has(work.task_status) &&
          work.mission_status !== null &&
          LIVE_MISSION_STATUSES.has(work.mission_status);
        if (live) continue;
        try {
          released.push(
            runtime.worktrees.markFailed(
              scope,
              record.missionId,
              record.taskId,
              DEAD_OWNER_WORKTREE_RELEASE_REASON,
            ),
          );
        } catch (error) {
          console.warn(
            `[worktree-runtime] dead-owner worktree release deferred for ` +
              `${record.missionId}/${record.taskId}:`,
            error,
          );
        }
      }
      if (released.length > 0) {
        console.warn(
          `[worktree-runtime] released ${released.length} worktree record(s) ` +
            'whose owning task or mission is terminal; no Git path or ref ' +
            'was removed',
        );
        // Liberar o REGISTRO nunca olhou para os processos: um PTY com cwd
        // dentro do worktree seguia vivo escrevendo num diretório já dado como
        // livre — a origem do worktree órfão que trava a próxima missão.
        for (const record of released) {
          sweepPtysInsideWorktree(record.worktreePath);
        }
      }
      return Object.freeze(released);
    } catch (error) {
      // Never block a dispatch attempt on an opportunistic cleanup.
      console.warn('[worktree-runtime] dead-owner release sweep skipped', error);
      return Object.freeze([]);
    }
  }

  async create(input: CreateWorktreeInput): Promise<WorktreeRecord> {
    input.assertCurrentAuthority?.();
    input.signal?.throwIfAborted();
    const runtime = this.forScope(input.scope);
    this.scheduleAgedPaneWriterGc(input.scope);
    // `forScope` memoizes, so observe both stale-record lanes again before
    // the ownership-overlap check evaluates them.
    this.#purgeOrphanWorktrees(input.scope, runtime.worktrees);
    this.#releaseDeadOwnerWorktrees(input.scope, runtime);
    return runtime.worktrees.create(input);
  }

  get(
    scope: ProjectExecutionScope,
    missionId: string,
    taskId: string,
  ): WorktreeRecord | null {
    return this.forScope(scope).worktrees.get(scope, missionId, taskId);
  }

  /**
   * Scheduler (re)bind hook for advisory lanes: fast-forward a stale,
   * output-free ready worktree to the current integration HEAD. See
   * `WorktreeManager.reanchorReadyWorktreeToIntegrationHead` for the proofs.
   */
  reanchorReadyWorktreeToIntegrationHead(
    scope: ProjectExecutionScope,
    missionId: string,
    taskId: string,
  ): WorktreeRecord | null {
    return this.forScope(scope).worktrees.reanchorReadyWorktreeToIntegrationHead(
      scope,
      missionId,
      taskId,
    );
  }

  reopenPaneWriter(
    scope: ProjectExecutionScope,
    missionId: string,
    taskId: string,
  ): WorktreeRecord {
    return this.forScope(scope).worktrees.reopenPaneWriter(scope, missionId, taskId);
  }

  bindPaneWriter(
    scope: ProjectExecutionScope,
    missionId: string,
    taskId: string,
    binding: { readonly paneId?: string; readonly sessionId?: string },
  ): WorktreeRecord {
    return this.forScope(scope).worktrees.bindPaneWriter(scope, missionId, taskId, binding);
  }

  /** Writer de pane (de qualquer missão do escopo) vinculado a este pane/sessão. */
  findPaneWriter(
    scope: ProjectExecutionScope,
    by: { readonly paneId: string } | { readonly sessionId: string },
  ): WorktreeRecord | null {
    const runtime = this.forScope(scope);
    const matches = runtime.worktreeState
      .read(runtime.worktrees.scopeKey(scope))
      .records.filter((record) => record.ownerKind === "pane" && ("paneId" in by
        ? record.paneIds?.includes(by.paneId)
        : record.sessionIds?.includes(by.sessionId)));
    // Ids são mintados pelo Main e únicos; ambiguidade nunca escolhe um lado.
    if (matches.length > 1) {
      throw new Error("pane writer binding is ambiguous across worktrees");
    }
    return matches[0] ?? null;
  }

  collectIntegratedPaneWorktrees(
    scope: ProjectExecutionScope,
    missionId: string,
    inUse: (worktreePath: string) => boolean,
  ): Promise<readonly WorktreeRecord[]> {
    return this.forScope(scope).worktrees
      .collectIntegratedPaneWorktrees(scope, missionId, inUse, this.#unusedByProcesses());
  }

  listMission(
    scope: ProjectExecutionScope,
    missionId: string,
  ): readonly WorktreeRecord[] {
    const runtime = this.forScope(scope);
    return Object.freeze(
      runtime.worktreeState
        .read(runtime.worktrees.scopeKey(scope))
        .records.filter((record) => record.missionId === missionId),
    );
  }

  /**
   * Mid-process orphan-block retirement for callers that just removed a
   * mission (or observed one missing). The predicate is the caller's mission
   * authority; the queue only lifts the block when it returns false for the
   * blocked entry's mission.
   */
  retireOrphanedMissionMergeBlock(
    scope: ProjectExecutionScope,
    isMissionAlive: (missionId: string) => boolean,
  ): MergeQueueBlock | null {
    return this.forScope(scope).queue.retireOrphanedMissionBlock(
      scope,
      isMissionAlive,
    );
  }

  enqueue(input: EnqueueMergeInput): Promise<MergeQueueResult> {
    return this.forScope(input.scope).queue.enqueue(input);
  }

  prepareIntegration(
    scope: ProjectExecutionScope,
    missionId: string,
    taskId: string,
  ): PreparedWorktreeIntegration {
    return this.forScope(scope).worktrees.prepareIntegration(
      scope,
      missionId,
      taskId,
    );
  }

  prepareNoChangeValidation(
    scope: ProjectExecutionScope,
    missionId: string,
    taskId: string,
  ): PreparedWorktreeNoChangeValidation | null {
    return this.forScope(scope).worktrees.prepareNoChangeValidation(
      scope,
      missionId,
      taskId,
    );
  }

  prepareDiscardedNoChangeValidation(
    scope: ProjectExecutionScope,
    missionId: string,
    taskId: string,
  ): PreparedWorktreeNoChangeValidation | null {
    return this.forScope(scope).worktrees.prepareDiscardedNoChangeValidation(
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
    return this.forScope(scope).worktrees.markValidatedNoChange(
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
    return this.forScope(scope).worktrees.markDiscardedNoChange(
      scope,
      missionId,
      taskId,
      expectedTaskHeadSha,
      expectedIntegrationHeadSha,
    );
  }

  markFailed(
    scope: ProjectExecutionScope,
    missionId: string,
    taskId: string,
    reason: string,
  ): WorktreeRecord {
    return this.forScope(scope).worktrees.markFailed(
      scope,
      missionId,
      taskId,
      reason,
    );
  }

  retry(input: RetryMergeInput): Promise<MergeQueueResult> {
    return this.forScope(input.scope).queue.retry(input);
  }

  retryRecoverable(input: EnqueueMergeInput): Promise<MergeQueueResult> {
    return this.forScope(input.scope).queue.retryRecoverable(input);
  }

  mergeSnapshot(scope: ProjectExecutionScope): MergeQueueStateSnapshot {
    return this.forScope(scope).queue.snapshot(scope);
  }

  reconcile(scope: ProjectExecutionScope): MergeQueueReconciliationResult {
    return this.forScope(scope).queue.reconcile(scope);
  }

  reconcileMergeIfIdle(
    scope: ProjectExecutionScope,
  ): MergeQueueReconciliationResult {
    return this.forScope(scope).queue.reconcileIfIdle(scope);
  }

  reconcileMergeIfStalled(
    scope: ProjectExecutionScope,
  ): MergeQueueReconciliationResult {
    return this.forScope(scope).queue.reconcileIfStalled(scope);
  }

  resolveIntegratedMission(
    scope: ProjectExecutionScope,
    missionId: string,
    baseSha: string,
  ): IntegratedMissionResult | null {
    const runtime = this.forScope(scope);
    const key = runtime.worktrees.scopeKey(scope);
    const records = runtime.worktreeState
      .read(key)
      .records.filter((record) => record.missionId === missionId);
    if (
      records.length === 0 ||
      records.some((record) => record.status !== "integrated")
    ) {
      return null;
    }
    const queue = runtime.mergeState.read(key);
    const integratedEntries = new Map(
      queue.entries
        .filter(
          (entry) =>
            entry.missionId === missionId && entry.status === "integrated",
        )
        .map((entry) => [entry.taskKey, entry] as const),
    );
    const queueLessIntegrationHeads: string[] = [];
    for (const record of records) {
      const integratedEntry = integratedEntries.get(record.taskKey);
      if (integratedEntry) {
        if (
          integratedEntry.taskHeadSha !== record.taskHeadSha ||
          integratedEntry.integratedSha !== record.integratedSha
        ) {
          return null;
        }
        continue;
      }
      if (
        record.taskHeadSha !== record.baseSha ||
        record.integratedSha === undefined
      ) {
        return null;
      }
      try {
        const prepared = runtime.worktrees.prepareDiscardedNoChangeValidation(
          scope,
          record.missionId,
          record.taskId,
        );
        if (
          !prepared ||
          prepared.record.id !== record.id ||
          prepared.taskHeadSha !== record.baseSha ||
          prepared.changedFiles.length !== 0
        ) {
          return null;
        }
        queueLessIntegrationHeads.push(prepared.integrationHeadSha);
      } catch {
        return null;
      }
    }
    const git = inspectGitBinding(scope, baseSha);
    if (
      queueLessIntegrationHeads.some(
        (integrationHeadSha) => integrationHeadSha !== git.headSha,
      )
    ) {
      return null;
    }
    const worktreeId = `mission-worktrees:${createHash("sha256")
      .update(
        records
          .map((record) => record.id)
          .sort()
          .join("\0"),
      )
      .digest("hex")}`;
    return Object.freeze({ worktreeId, ...git });
  }

  dispose(): void {
    this.#agedGcGeneration += 1;
    for (const timer of this.#agedGcTimers) clearTimeout(timer);
    this.#agedGcTimers.clear();
    this.#agedGcNextAt.clear();
    this.#runtimes.clear();
  }
}

let registry: WorktreeRuntimeRegistry | null = null;

export function configureWorktreeRuntimeRegistry(
  manager: ProjectRuntimeManager,
): WorktreeRuntimeRegistry {
  registry?.dispose();
  registry = new WorktreeRuntimeRegistry(manager);
  return registry;
}

export function requireWorktreeRuntimeRegistry(): WorktreeRuntimeRegistry {
  if (!registry)
    throw new Error("worktree runtime registry is not initialized");
  return registry;
}

export function disposeWorktreeRuntimeRegistry(): void {
  registry?.dispose();
  registry = null;
}
