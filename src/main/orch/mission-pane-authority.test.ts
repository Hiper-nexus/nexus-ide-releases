import { describe, expect, it } from "vitest";

import { compileIntentContract } from "../../shared/mission-intent";
import type { Mission, Squad } from "../../shared/orch-types";
import {
  createMissionPaneAuthoritySeal,
  FREE_MODE_NO_SQUAD_REVISION_HASH,
  sameMissionPaneApprovalSeal,
} from "./mission-pane-authority";
import { snapshotSquadAuthority } from "./squad-authority-snapshot";

const squad: Squad = {
  id: "pane-authority-squad",
  name: "Pane authority",
  createdAt: "1",
  builtin: false,
  orchestratorInstructions: "Coordene a missão.",
  agents: [
    {
      id: "orchestrator",
      agentName: "Maestro",
      category: "orchestrator",
      cli: "codex",
    },
  ],
};

function approvedMission(): Mission {
  const contract = compileIntentContract({
    goal: "Executar sem invalidar o pane por telemetria",
    acceptanceCriteria: ["A missão conclui no mesmo contrato aprovado"],
    intentVersion: 1,
  });
  return {
    id: "mission-pane-authority",
    title: "Autoridade estável",
    description: contract.goal,
    status: "running",
    squadId: squad.id,
    milestones: [],
    learnings: "",
    intentState: "executing",
    intentVersion: 1,
    intentContract: {
      ...contract,
      approvedAt: 10,
      dispatchedAt: 11,
      squadRevisionHash: snapshotSquadAuthority(squad).hash,
    },
    createdAt: 1,
    updatedAt: 2,
  };
}

describe("mission pane authority", () => {
  it("does not stale a persisted pane when only the runtime ledger advances", () => {
    const mission = approvedMission();
    const expected = createMissionPaneAuthoritySeal({ mission, squad });
    const afterSiblingTool: Mission = {
      ...mission,
      intentContract: {
        ...mission.intentContract!,
        spentSteps: 4,
        spentTokens: 800,
      },
    };
    const current = createMissionPaneAuthoritySeal({
      mission: afterSiblingTool,
      squad,
    });

    expect(current?.intentContractHash).toBe(expected?.intentContractHash);
    expect(sameMissionPaneApprovalSeal(current, expected)).toBe(true);
  });

  it("seals only an explicitly requested pending start before the PTY exists", () => {
    const running = approvedMission();
    const pending: Mission = {
      ...running,
      status: "pending",
      intentState: "ready_to_start",
      orchestratorSessionId: undefined,
      intentContract: {
        ...running.intentContract!,
        approvalReviewSha256: "a".repeat(64),
        dispatchedAt: 12,
      },
    };

    expect(createMissionPaneAuthoritySeal({ mission: pending, squad })).not.toBeNull();
    expect(
      createMissionPaneAuthoritySeal({
        mission: {
          ...pending,
          intentContract: {
            ...pending.intentContract!,
            dispatchedAt: undefined,
          },
        },
        squad,
      }),
    ).toBeNull();
  });

  it("still revokes a pane when the approved goal changes", () => {
    const mission = approvedMission();
    const expected = createMissionPaneAuthoritySeal({ mission, squad });
    const changedGoal: Mission = {
      ...mission,
      intentContract: {
        ...mission.intentContract!,
        goal: "Outro objetivo",
      },
    };

    expect(
      sameMissionPaneApprovalSeal(
        createMissionPaneAuthoritySeal({ mission: changedGoal, squad }),
        expected,
      ),
    ).toBe(false);
  });
});

describe("missão livre sem squad (o Jev monta o squad)", () => {
  function freeMission(overrides: Partial<Mission> = {}): Mission {
    const mission = approvedMission();
    return {
      ...mission,
      squadId: undefined,
      intentContract: { ...mission.intentContract!, freeAgentChoice: true, squadRevisionHash: undefined },
      ...overrides,
    };
  }

  it("sela a missão livre sem squad e ainda revoga quando a intenção muda", () => {
    const mission = freeMission();
    const seal = createMissionPaneAuthoritySeal({ mission, squad: null });
    expect(seal?.squadRevisionHash).toBe(FREE_MODE_NO_SQUAD_REVISION_HASH);
    const changed = createMissionPaneAuthoritySeal({
      mission: { ...mission, intentContract: { ...mission.intentContract!, goal: "Outro objetivo" } },
      squad: null,
    });
    expect(sameMissionPaneApprovalSeal(changed, seal)).toBe(false);
  });

  it("sem modo livre, ou com squad declarado mas ausente, continua sem selo", () => {
    const mission = freeMission();
    expect(createMissionPaneAuthoritySeal({
      mission: { ...mission, intentContract: { ...mission.intentContract!, freeAgentChoice: undefined } },
      squad: null,
    })).toBeNull();
    expect(createMissionPaneAuthoritySeal({ mission: { ...mission, squadId: squad.id }, squad: null })).toBeNull();
    expect(createMissionPaneAuthoritySeal({ mission: approvedMission(), squad: null })).toBeNull();
  });
});
