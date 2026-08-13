import { describe, expect, it } from "vitest";
import { TASK_DISPATCH_MISSING_RUNTIME_REASON } from "../orch/task-dispatch-store";
import { TASK_DISPATCH_SESSION_EXIT_REASON } from "../orch/task-dispatch-persistence";
import {
  isRestartableWorkerDispatch,
  selectPersistedWorkerRestartDispatch,
} from "./persisted-worker-restart";

function dispatch(
  patch: Partial<Parameters<typeof selectPersistedWorkerRestartDispatch>[0]["dispatches"][number]> & {
    paneId?: string;
    sessionId?: string;
    state?: string;
    revision?: number;
    workerIncarnationId?: string;
    lastError?: string;
  },
) {
  return {
    paneId: "pane-3",
    sessionId: "pty-dead",
    state: "running",
    revision: 4,
    workerIncarnationId: "worker-incarnation-a",
    ...patch,
  };
}

describe("selectPersistedWorkerRestartDispatch — Reabrir panes após restart", () => {
  it("nunca produz 'missing pane/incarnation restart authority' — sem paneId devolve null", () => {
    expect(
      selectPersistedWorkerRestartDispatch({
        paneId: undefined,
        workerIncarnationId: undefined,
        dispatches: [dispatch({})],
      }),
    ).toBeNull();
  });

  it("reconcile: pane sem incarnation usa o dispatch atual daquele pane", () => {
    const current = dispatch({
      paneId: "pane-3",
      workerIncarnationId: "worker-incarnation-after-restart",
      revision: 9,
    });
    expect(
      selectPersistedWorkerRestartDispatch({
        paneId: "pane-3",
        workerIncarnationId: undefined,
        dispatches: [
          dispatch({ paneId: "pane-other", revision: 99 }),
          current,
        ],
      }),
    ).toEqual(current);
  });

  it("reconcile: incarnation velha no spec cede ao dispatch running do pane", () => {
    const current = dispatch({
      workerIncarnationId: "worker-incarnation-new",
      revision: 8,
      state: "running",
    });
    expect(
      selectPersistedWorkerRestartDispatch({
        paneId: "pane-3",
        workerIncarnationId: "worker-incarnation-stale",
        dispatches: [current],
      }),
    ).toEqual(current);
  });

  it("prefers the exact incarnation when it still has a restartable dispatch", () => {
    const exact = dispatch({
      workerIncarnationId: "worker-incarnation-a",
      revision: 2,
    });
    const newerOther = dispatch({
      workerIncarnationId: "worker-incarnation-b",
      revision: 9,
    });
    expect(
      selectPersistedWorkerRestartDispatch({
        paneId: "pane-3",
        workerIncarnationId: "worker-incarnation-a",
        dispatches: [newerOther, exact],
      }),
    ).toEqual(exact);
  });

  it("sem dispatch restartable devolve null — o spawn segue sem rebind", () => {
    expect(
      selectPersistedWorkerRestartDispatch({
        paneId: "pane-3",
        workerIncarnationId: "worker-incarnation-a",
        dispatches: [
          dispatch({ state: "done", sessionId: "pty-old" }),
        ],
      }),
    ).toBeNull();
  });

  it("aceita superseded com exit/runtime missing — o processo morreu no restart", () => {
    const exited = dispatch({
      state: "superseded",
      lastError: TASK_DISPATCH_SESSION_EXIT_REASON,
    });
    expect(isRestartableWorkerDispatch(exited)).toBe(true);
    expect(
      isRestartableWorkerDispatch({
        state: "superseded",
        lastError: TASK_DISPATCH_MISSING_RUNTIME_REASON,
        revision: 1,
      }),
    ).toBe(true);
    expect(
      selectPersistedWorkerRestartDispatch({
        paneId: "pane-5",
        workerIncarnationId: undefined,
        dispatches: [{ ...exited, paneId: "pane-5" }],
      }),
    ).toMatchObject({ paneId: "pane-5" });
  });
});
