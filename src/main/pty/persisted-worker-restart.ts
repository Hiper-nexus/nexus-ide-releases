import { TASK_DISPATCH_MISSING_RUNTIME_REASON } from "../orch/task-dispatch-store";
import { TASK_DISPATCH_SESSION_EXIT_REASON } from "../orch/task-dispatch-persistence";

/**
 * Restart de worker persistido após Reabrir panes / restore.
 *
 * Via Rápida: o pane gravado pelo main é autoridade de apresentação. Sem
 * incarnation no spec (comum depois de restart) NÃO se recusa a equipe —
 * reconcilia-se o dispatch atual daquele pane. Falhar com
 * "missing pane/incarnation restart authority" deixava Interface/Motor/
 * Verificar mortos e o operador sem time.
 */

export interface RestartableWorkerDispatch {
  readonly paneId?: string;
  readonly sessionId?: string;
  readonly state: string;
  readonly lastError?: string;
  readonly workerIncarnationId?: string;
  readonly revision: number;
}

export function isRestartableWorkerDispatch(
  dispatch: RestartableWorkerDispatch,
): boolean {
  return (
    dispatch.state === "running" ||
    (dispatch.state === "superseded" &&
      (dispatch.lastError === TASK_DISPATCH_MISSING_RUNTIME_REASON ||
        dispatch.lastError === TASK_DISPATCH_SESSION_EXIT_REASON))
  );
}

export function selectPersistedWorkerRestartDispatch<
  T extends RestartableWorkerDispatch,
>(input: {
  readonly paneId: string | undefined;
  readonly workerIncarnationId: string | undefined;
  readonly dispatches: readonly T[];
}): T | null {
  const paneId = input.paneId;
  if (!paneId) return null;
  const restartable = input.dispatches.filter(
    (dispatch) =>
      isRestartableWorkerDispatch(dispatch) &&
      dispatch.paneId === paneId &&
      Boolean(dispatch.sessionId),
  );
  if (restartable.length === 0) return null;
  const exact = input.workerIncarnationId
    ? restartable.filter(
        (dispatch) =>
          dispatch.workerIncarnationId === input.workerIncarnationId,
      )
    : [];
  if (exact.length === 1) return exact[0]!;
  return pickPreferredRestart(exact.length > 0 ? exact : restartable);
}

function pickPreferredRestart<T extends RestartableWorkerDispatch>(
  rows: readonly T[],
): T {
  return [...rows].sort((left, right) => {
    if (left.state === "running" && right.state !== "running") return -1;
    if (right.state === "running" && left.state !== "running") return 1;
    return right.revision - left.revision;
  })[0]!;
}
