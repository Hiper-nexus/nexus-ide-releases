import type { MissionPaneSpec } from "../../shared/orch-types";
import type { ProjectExecutionScope } from "../../shared/types";
import type {
  TaskDispatchRecord,
  TaskDispatchState,
} from "./task-dispatch-codec";

const ACTIVE_WORKER_STATES = new Set<TaskDispatchState>([
  "claimed",
  "routed",
  "spawning",
  "running",
  "handoff_ready",
  "merging",
  "suspended",
]);

// Only terminal states. Retiring during handoff_ready/merging races the
// merge-council author pane (still needed for resolveAuthor) and throws
// worker_retirement_exit_unproven while the PTY is legitimately alive.
const RETIRABLE_WORKER_STATES = new Set<TaskDispatchState>([
  "completed",
  "blocked",
  "failed",
  "superseded",
]);

type WorkerDispatchIdentity = Pick<
  TaskDispatchRecord,
  | "taskId"
  | "missionId"
  | "state"
  | "paneId"
  | "sessionId"
  | "workerIncarnationId"
>;

export interface MissionWorkerPaneRetirementRequest {
  readonly paneId: string;
  readonly sessionId: string;
  readonly missionId: string;
  readonly taskId: string;
  readonly workerIncarnationId: string;
  readonly scope: Readonly<ProjectExecutionScope>;
}

export interface TaskDispatchWorkerRetirementDeps {
  getDispatch(taskId: string): WorkerDispatchIdentity | null;
  closeWorker(
    input: MissionWorkerPaneRetirementRequest,
  ): boolean | Promise<boolean>;
}

export interface TaskDispatchWorkerRetirementResult {
  readonly retiredTaskIds: readonly string[];
  readonly alreadyRetiredTaskIds: readonly string[];
  readonly unboundTaskIds: readonly string[];
}

function hasPhysicalWorkerIdentity(
  dispatch: WorkerDispatchIdentity,
): dispatch is WorkerDispatchIdentity & {
  readonly paneId: string;
  readonly sessionId: string;
  readonly workerIncarnationId: string;
} {
  return Boolean(
    dispatch.paneId &&
      dispatch.sessionId &&
      dispatch.workerIncarnationId,
  );
}

function samePhysicalWorker(
  left: WorkerDispatchIdentity,
  right: WorkerDispatchIdentity,
): boolean {
  return (
    left.taskId === right.taskId &&
    left.missionId === right.missionId &&
    left.paneId === right.paneId &&
    left.sessionId === right.sessionId &&
    left.workerIncarnationId === right.workerIncarnationId
  );
}

function retirementKey(
  scope: Readonly<ProjectExecutionScope>,
  dispatch: WorkerDispatchIdentity & {
    readonly paneId: string;
    readonly sessionId: string;
    readonly workerIncarnationId: string;
  },
): string {
  return [
    scope.installationId,
    scope.projectId,
    scope.checkoutId,
    scope.rootRealPath,
    dispatch.missionId,
    dispatch.taskId,
    dispatch.paneId,
    dispatch.sessionId,
    dispatch.workerIncarnationId,
  ].join("\0");
}

function assertCurrentRetirementAuthority(
  expected: WorkerDispatchIdentity,
  current: WorkerDispatchIdentity | null,
  phase: "before" | "after",
): asserts current is WorkerDispatchIdentity {
  if (
    !current ||
    !samePhysicalWorker(expected, current) ||
    !RETIRABLE_WORKER_STATES.has(current.state)
  ) {
    throw new Error(
      `worker_retirement_stale_${phase}: ${expected.missionId}/${expected.taskId} ` +
        "não conserva task, pane, sessão, encarnação e estado aposentável",
    );
  }
}

/**
 * Main-owned retirement singleflight.
 *
 * A successful key is immutable because task dispatch worker incarnations and
 * session ids are one-shot. Replays therefore neither signal nor terminate a
 * second process. A failed/ambiguous close is never cached and remains
 * fail-closed for the next scheduler pass.
 */
export class TaskDispatchWorkerRetirementCoordinator {
  readonly #retired = new Set<string>();
  readonly #flights = new Map<string, Promise<void>>();

  async retireMissionWorkers(input: {
    readonly scope: Readonly<ProjectExecutionScope>;
    readonly missionId: string;
    readonly dispatches: readonly WorkerDispatchIdentity[];
    readonly deps: TaskDispatchWorkerRetirementDeps;
  }): Promise<TaskDispatchWorkerRetirementResult> {
    const retiredTaskIds: string[] = [];
    const alreadyRetiredTaskIds: string[] = [];
    const unboundTaskIds: string[] = [];

    for (const snapshot of input.dispatches) {
      if (
        snapshot.missionId !== input.missionId ||
        !RETIRABLE_WORKER_STATES.has(snapshot.state)
      ) {
        continue;
      }
      if (!hasPhysicalWorkerIdentity(snapshot)) {
        if (snapshot.paneId || snapshot.sessionId) {
          throw new Error(
            `worker_retirement_incomplete_identity: ${snapshot.missionId}/${snapshot.taskId} ` +
              "possui pane/sessão sem a identidade física completa",
          );
        }
        unboundTaskIds.push(snapshot.taskId);
        continue;
      }
      const key = retirementKey(input.scope, snapshot);
      if (this.#retired.has(key)) {
        alreadyRetiredTaskIds.push(snapshot.taskId);
        continue;
      }
      const existingFlight = this.#flights.get(key);
      if (existingFlight) {
        await existingFlight;
        alreadyRetiredTaskIds.push(snapshot.taskId);
        continue;
      }

      const flight = this.#retireOne(input.scope, snapshot, input.deps);
      this.#flights.set(key, flight);
      try {
        await flight;
        this.#retired.add(key);
        retiredTaskIds.push(snapshot.taskId);
      } finally {
        if (this.#flights.get(key) === flight) this.#flights.delete(key);
      }
    }

    return Object.freeze({
      retiredTaskIds: Object.freeze(retiredTaskIds),
      alreadyRetiredTaskIds: Object.freeze(alreadyRetiredTaskIds),
      unboundTaskIds: Object.freeze(unboundTaskIds),
    });
  }

  reset(): void {
    this.#retired.clear();
    this.#flights.clear();
  }

  async #retireOne(
    scope: Readonly<ProjectExecutionScope>,
    expected: WorkerDispatchIdentity & {
      readonly paneId: string;
      readonly sessionId: string;
      readonly workerIncarnationId: string;
    },
    deps: TaskDispatchWorkerRetirementDeps,
  ): Promise<void> {
    assertCurrentRetirementAuthority(
      expected,
      deps.getDispatch(expected.taskId),
      "before",
    );
    const closed = await deps.closeWorker({
      paneId: expected.paneId,
      sessionId: expected.sessionId,
      missionId: expected.missionId,
      taskId: expected.taskId,
      workerIncarnationId: expected.workerIncarnationId,
      scope,
    });
    if (!closed) {
      throw new Error(
        `worker_retirement_exit_unproven: ${expected.missionId}/${expected.taskId} ` +
          "permanece ocupando capacidade até a saída física exata ser provada",
      );
    }
    assertCurrentRetirementAuthority(
      expected,
      deps.getDispatch(expected.taskId),
      "after",
    );
  }
}

export const productionTaskDispatchWorkerRetirement =
  new TaskDispatchWorkerRetirementCoordinator();

export interface MissionSchedulerWorkerSlotProjection {
  readonly activeDispatchCount: number;
  readonly unmanagedRows: readonly MissionPaneSpec[];
}

/**
 * Project maxWorkers without counting a completed dispatch twice forever.
 *
 * Bound scheduler rows are represented by their durable dispatch. Historical
 * rows for a terminal dispatch are excluded only on the scheduler path, whose
 * caller first awaits physical retirement. Rows without an exact dispatch
 * identity remain unmanaged and retain the existing live-pane fail-safe.
 */
export function projectMissionSchedulerWorkerSlots(
  missionId: string,
  rows: readonly MissionPaneSpec[],
  dispatches: readonly WorkerDispatchIdentity[],
): MissionSchedulerWorkerSlotProjection {
  const missionDispatches = dispatches.filter(
    (dispatch) => dispatch.missionId === missionId,
  );
  const managedRows = new Set<string>();
  for (const row of rows) {
    if (
      row.role !== "worker" ||
      !row.paneId ||
      !row.workerIncarnationId
    ) {
      continue;
    }
    const exact = missionDispatches.find(
      (dispatch) =>
        dispatch.paneId === row.paneId &&
        Boolean(dispatch.sessionId) &&
        dispatch.workerIncarnationId === row.workerIncarnationId,
    );
    if (exact) managedRows.add(row.id);
  }
  return Object.freeze({
    activeDispatchCount: missionDispatches.filter((dispatch) =>
      ACTIVE_WORKER_STATES.has(dispatch.state),
    ).length,
    unmanagedRows: Object.freeze(
      rows.filter((row) => row.role !== "worker" || !managedRows.has(row.id)),
    ),
  });
}
