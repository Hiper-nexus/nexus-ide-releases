import { describe, expect, it } from "vitest";

import { resolveCodeAuthors } from "./prevc-autopilot-coordinator";

// REGRESSÃO (gate run 8 da 0.27.0): a validação final resolvia "autores" só de
// worktrees integradas — no caminho simples os únicos worktrees integrados são
// os no-change dos LEITORES (scouts/QA), então a review do council nascia com
// autor errado e com nome humano ("E2E Advisor GLM") que estoura o IDENTIFIER
// na submissão → review morre por timeout e a missão fica running para sempre.
describe("resolveCodeAuthors nas duas formas de entrega", () => {
  const MISSION = "mission-simple";

  function suiteStub(input: {
    readonly panes?: readonly unknown[];
    readonly dispatches?: readonly unknown[];
  }) {
    return {
      missionPanes: { list: () => input.panes ?? [] },
      taskDispatches: { list: () => input.dispatches ?? [] },
    } as never;
  }

  it("autoria do caminho simples vem do dispatch same_checkout concluído, normalizada", () => {
    const authors = resolveCodeAuthors({
      suite: suiteStub({
        dispatches: [
          {
            taskId: "task-delivery",
            state: "completed",
            executionMode: "same_checkout",
            workerId: "E2E Executor",
            sessionId: "pty-executor-1",
            adapterId: "codex",
          },
          {
            taskId: "task-scout",
            state: "completed",
            executionMode: "read_only",
            workerId: "E2E Advisor GLM",
            sessionId: "pty-glm-1",
            adapterId: "glm",
          },
        ],
      }),
      missionId: MISSION,
      worktrees: [],
      taskIds: new Set(["task-delivery", "task-scout"]),
    });

    expect(authors).toHaveLength(1);
    // "E2E Executor" tem espaço: precisa sair como identificador estável, não
    // como texto humano que o submissionSchema do council rejeita.
    expect(authors[0]!.id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
    expect(authors[0]!.sessionId).toBe("pty-executor-1");
    expect(authors[0]!.provider).toBe("codex");
  });

  it("worktree no-change de leitor (taskHead == base) não vira autor de código", () => {
    const authors = resolveCodeAuthors({
      suite: suiteStub({
        panes: [
          {
            role: "worker",
            agentName: "E2E Advisor GLM",
            cwd: "/worktrees/scout-glm",
            paneId: "pane-glm",
            id: "pane-glm",
            adapterId: "glm",
          },
        ],
      }),
      missionId: MISSION,
      worktrees: [
        {
          missionId: MISSION,
          taskId: "task-scout",
          status: "integrated",
          workerId: "E2E Advisor GLM",
          worktreePath: "/worktrees/scout-glm",
          baseSha: "a".repeat(40),
          taskHeadSha: "a".repeat(40),
        } as never,
      ],
      taskIds: new Set(["task-scout"]),
    });

    expect(authors).toHaveLength(0);
  });

  it("mundo isolado segue: worktree integrada COM diff continua autora", () => {
    const authors = resolveCodeAuthors({
      suite: suiteStub({
        panes: [
          {
            role: "worker",
            agentName: "Executor",
            cwd: "/worktrees/delivery",
            paneId: "pane-executor",
            id: "pane-executor",
            adapterId: "codex",
          },
        ],
      }),
      missionId: MISSION,
      worktrees: [
        {
          missionId: MISSION,
          taskId: "task-delivery",
          status: "integrated",
          workerId: "Executor",
          worktreePath: "/worktrees/delivery",
          baseSha: "a".repeat(40),
          taskHeadSha: "b".repeat(40),
        } as never,
      ],
      taskIds: new Set(["task-delivery"]),
    });

    expect(authors).toHaveLength(1);
    expect(authors[0]!.id).toBe("Executor");
    expect(authors[0]!.sessionId).toBe("pane-executor");
  });
});
