import { describe, expect, it } from "vitest";
import { compileIntentContract } from "../../shared/mission-intent";
import type { Mission } from "../../shared/orch-types";
import { decodeTaskScheduleDetail } from "./mission-scheduler-meta";
import { ensureGuidedMissionPlan } from "./guided-mission-planner";
import {
  harness,
  mission,
  scope,
  squad,
} from "./guided-mission-planner-test-harness";
import { plannedTaskId, snapshotTaskPlanRoster } from "./task-store";
import { snapshotSquadAuthority } from "./squad-authority-snapshot";

const ROUND_TABLE_GOAL =
  "teste de todos panes cada um me fala oque ele faz na missao";

function coordinationMission(): Mission {
  const contract = compileIntentContract({
    goal: ROUND_TABLE_GOAL,
    intentVersion: 3,
    source: "typed",
    lane: "standard",
  });
  return mission({
    title: "Teste de todos os panes",
    description: contract.goal,
    intentContract: {
      ...contract,
      approvedAt: 10,
      dispatchedAt: 10,
      squadRevisionHash: snapshotSquadAuthority(squad).hash,
    },
  });
}

describe("guided team coordination topology", () => {
  it("seals the same deterministic roundtable for a saved manual squad", () => {
    const customSquad = {
      ...squad,
      id: "saved-roundtable-squad",
      builtin: false,
    };
    const currentMission = coordinationMission();
    const customMission: Mission = {
      ...currentMission,
      squadId: customSquad.id,
      intentContract: {
        ...currentMission.intentContract!,
        squadRevisionHash: snapshotSquadAuthority(customSquad).hash,
      },
    };
    const h = harness({
      currentMission: customMission,
      liveSquad: customSquad,
    });

    expect(
      ensureGuidedMissionPlan(h.suite, customMission.id, h.deps),
    ).toMatchObject({
      applicable: true,
      sealed: true,
      reason: "sealed",
      topology: "team-read-only-fanout",
    });
    expect(h.createPlanAtomically).toHaveBeenCalledOnce();

    const rows = h.createPlanAtomically.mock.calls[0]![0].rows;
    const rosterHash = snapshotTaskPlanRoster(customSquad.agents).hash;
    const existing = rows.map((row, index) => {
      const taskId = plannedTaskId(
        customMission.id,
        customMission.intentVersion ?? 0,
        row.plannerId,
      );
      return {
        plannerId: row.plannerId,
        taskId,
        missionId: customMission.id,
        intentVersion: customMission.intentVersion ?? 0,
        squadId: customSquad.id,
        rosterHash,
        agentRef: row.agentRef,
        agentCategory: row.agentCategory,
        agent: customSquad.agents.find(
          (agent) => agent.id === row.agentRef,
        )!,
        plannedTitle: row.title,
        plannedDetail: row.detail,
        task: {
          id: taskId,
          missionId: customMission.id,
          title: row.title,
          detail: row.detail,
          status: "pending" as const,
          createdAt: index + 1,
          updatedAt: index + 1,
          ...scope,
        },
      };
    });
    const recovered = harness({
      currentMission: customMission,
      liveSquad: customSquad,
      existing,
    });

    expect(
      ensureGuidedMissionPlan(
        recovered.suite,
        customMission.id,
        recovered.deps,
      ),
    ).toMatchObject({
      applicable: true,
      sealed: false,
      reason: "already-sealed",
      topology: "team-read-only-fanout",
    });
    expect(recovered.createPlanAtomically).not.toHaveBeenCalled();
  });

  it("seals one parallel read-only root per non-orchestrator", () => {
    const h = harness({ currentMission: coordinationMission() });

    expect(
      ensureGuidedMissionPlan(h.suite, "mission-guided", h.deps),
    ).toMatchObject({
      applicable: true,
      sealed: true,
      reason: "sealed",
      topology: "team-read-only-fanout",
    });

    const rows = h.createPlanAtomically.mock.calls[0]![0].rows;
    const workers = squad.agents.filter(
      (agent) => agent.category !== "orchestrator",
    );
    expect(rows).toHaveLength(workers.length);
    expect(new Set(rows.map((row) => row.agentRef))).toEqual(
      new Set(workers.map((agent) => agent.id)),
    );
    for (const row of rows) {
      const decoded = decodeTaskScheduleDetail(row.detail);
      expect(decoded.meta).toMatchObject({
        dependsOn: [],
        executionMode: "read_only",
        parallelEligible: true,
        ownership: {
          files: [],
          symbols: [],
        },
      });
      expect(decoded.meta?.ownership.domains).toContain(
        "team-read-only-fanout",
      );
      expect(decoded.body).toContain("rodada paralela");
      expect(decoded.body).not.toContain("Implemente integralmente");
    }
    expect(h.deps.listRepositoryOwnership).not.toHaveBeenCalled();
  });

  it("recovers the exact roster-complete fan-out without rewriting it", () => {
    const currentMission = coordinationMission();
    const first = harness({ currentMission });
    ensureGuidedMissionPlan(first.suite, currentMission.id, first.deps);
    const rows = first.createPlanAtomically.mock.calls[0]![0].rows;
    const rosterHash = snapshotTaskPlanRoster(squad.agents).hash;
    const existing = rows.map((row, index) => {
      const taskId = plannedTaskId(
        currentMission.id,
        currentMission.intentVersion ?? 0,
        row.plannerId,
      );
      const task = {
        id: taskId,
        missionId: currentMission.id,
        title: row.title,
        detail: row.detail,
        status: "pending" as const,
        createdAt: index + 1,
        updatedAt: index + 1,
        ...scope,
      };
      return {
        plannerId: row.plannerId,
        taskId,
        missionId: currentMission.id,
        intentVersion: currentMission.intentVersion ?? 0,
        squadId: squad.id,
        rosterHash,
        agentRef: row.agentRef,
        agentCategory: row.agentCategory,
        agent: squad.agents.find((agent) => agent.id === row.agentRef)!,
        plannedTitle: row.title,
        plannedDetail: row.detail,
        task,
      };
    });
    const recovered = harness({
      currentMission,
      existing,
    });

    expect(
      ensureGuidedMissionPlan(
        recovered.suite,
        currentMission.id,
        recovered.deps,
      ),
    ).toMatchObject({
      applicable: true,
      sealed: false,
      reason: "already-sealed",
      topology: "team-read-only-fanout",
    });
    expect(recovered.createPlanAtomically).not.toHaveBeenCalled();
  });

  it("keeps mutating team requests on the delivery graph", () => {
    const contract = compileIntentContract({
      goal: "Todos os agentes implementem uma parte da feature de login",
      intentVersion: 3,
      source: "typed",
      lane: "standard",
    });
    const currentMission = mission({
      description: contract.goal,
      intentContract: {
        ...contract,
        approvedAt: 10,
        dispatchedAt: 10,
        squadRevisionHash: snapshotSquadAuthority(squad).hash,
      },
    });
    const h = harness({ currentMission });

    ensureGuidedMissionPlan(h.suite, currentMission.id, h.deps);
    const rows = h.createPlanAtomically.mock.calls[0]![0].rows;

    expect(
      rows.some(
        (row) =>
          decodeTaskScheduleDetail(row.detail).meta?.executionMode ===
          "isolated_worktree",
      ),
    ).toBe(true);
    expect(
      rows.some((row) =>
        decodeTaskScheduleDetail(row.detail).meta?.ownership.domains.includes(
          "team-read-only-fanout",
        ),
      ),
    ).toBe(false);
  });

  it("copies validated attachment paths into every sealed specialist task", () => {
    const currentMission = coordinationMission();
    const withAttachment: Mission = {
      ...currentMission,
      intentContract: {
        ...currentMission.intentContract!,
        attachmentPaths: ["/safe/brief.pdf"],
      },
    };
    const h = harness({ currentMission: withAttachment });

    ensureGuidedMissionPlan(h.suite, withAttachment.id, h.deps);

    const rows = h.createPlanAtomically.mock.calls[0]![0].rows;
    expect(rows).not.toHaveLength(0);
    for (const row of rows) {
      expect(decodeTaskScheduleDetail(row.detail).body).toContain(
        "/safe/brief.pdf",
      );
    }
  });
});
