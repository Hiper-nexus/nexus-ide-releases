import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { resumeTaskDispatchMissionAfterTechnicalFailure } from "./task-dispatch-persistence";

function dbWithMission(description: string): Database.Database {
  const db = new Database(":memory:");
  db.exec(
    `CREATE TABLE missions (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      intent_state TEXT,
      description TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL DEFAULT 0
    )`,
  );
  db.prepare(
    `INSERT INTO missions (id, status, intent_state, description)
     VALUES ('mission-1', 'blocked', 'blocked_technical', ?)`,
  ).run(description);
  return db;
}

describe("resumeTaskDispatchMissionAfterTechnicalFailure", () => {
  it("reopens a genuine retryable technical block and strips the canonical block", () => {
    const detail = "falha técnica transitória no bootstrap do worker";
    const suffix =
      `[NEXUS_TASK_DISPATCH_BLOCKED]\n## Worker bloqueado\n${detail}\n` +
      "Clique em “Retomar missão” para revisar a tarefa e escolher a próxima ação.";
    const db = dbWithMission(`objetivo da missão\n\n${suffix}`);
    resumeTaskDispatchMissionAfterTechnicalFailure(
      db as never,
      "mission-1",
      detail,
      Date.now(),
    );
    const row = db
      .prepare(
        `SELECT status, intent_state, description FROM missions WHERE id = 'mission-1'`,
      )
      .get() as { status: string; intent_state: string; description: string };
    expect(row.status).toBe("running");
    expect(row.intent_state).toBe("executing");
    expect(row.description).not.toContain("NEXUS_TASK_DISPATCH_BLOCKED");
  });
});
