import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { testProjectScope } from "./__tests__/scope-fixture";
import {
  blockTaskDispatchMission,
  resumeTaskDispatchMissionAfterTechnicalFailure,
} from "./task-dispatch-persistence";

function dbWithMission(description: string): Database.Database {
  const db = new Database(":memory:");
  db.exec(
    `CREATE TABLE missions (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      intent_state TEXT,
      description TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL DEFAULT 0,
      intent_version INTEGER NOT NULL DEFAULT 1
    )`,
  );
  db.prepare(
    `INSERT INTO missions (id, status, intent_state, description)
     VALUES ('mission-1', 'blocked', 'blocked_technical', ?)`,
  ).run(description);
  return db;
}

describe("resumeTaskDispatchMissionAfterTechnicalFailure", () => {
  it("delegates exact technical recovery to the engine without lifecycle SQL", () => {
    const detail = "falha técnica transitória no bootstrap do worker";
    const suffix =
      `[NEXUS_TASK_DISPATCH_BLOCKED]\n## Worker bloqueado\n${detail}\n` +
      "Clique em “Retomar missão” para revisar a tarefa e escolher a próxima ação.";
    const db = dbWithMission(`objetivo da missão\n\n${suffix}`);
    const resumeTechnical = vi.fn();

    resumeTaskDispatchMissionAfterTechnicalFailure(
      db,
      "mission-1",
      detail,
      Date.now(),
      { resumeTechnical },
      testProjectScope(),
    );

    const row = db
      .prepare(
        `SELECT status, intent_state, description FROM missions WHERE id = 'mission-1'`,
      )
      .get() as { status: string; intent_state: string; description: string };
    expect(resumeTechnical).toHaveBeenCalledWith(testProjectScope(), {
      missionId: "mission-1",
      expectedStatus: "blocked",
      expectedIntentState: "blocked_technical",
      expectedUpdatedAt: 0,
      expectedIntentVersion: 1,
      description: "objetivo da missão",
    });
    expect(row).toMatchObject({
      status: "blocked",
      intent_state: "blocked_technical",
      description: `objetivo da missão\n\n${suffix}`,
    });
  });

  it("delegates a technical block to the engine without lifecycle SQL", () => {
    const db = dbWithMission("objetivo");
    db.prepare(
      `UPDATE missions SET status = 'running', intent_state = 'executing' WHERE id = 'mission-1'`,
    ).run();
    const blockTechnical = vi.fn();

    blockTaskDispatchMission(
      db,
      "mission-1",
      "provider indisponível",
      Date.now(),
      "technical",
      { blockTechnical },
      testProjectScope(),
    );

    expect(blockTechnical).toHaveBeenCalledOnce();
    expect(
      db
        .prepare(`SELECT status FROM missions WHERE id = 'mission-1'`)
        .pluck()
        .get(),
    ).toBe("running");
  });
});
