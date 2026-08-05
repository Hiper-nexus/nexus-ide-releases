import { describe, expect, it } from "vitest";

import { missionApprovalAlreadyCurrent } from "./mission-approval-already-current";
import type { MissionOrchestratorRuntimeSnapshot } from "../../shared/mission-intent";
import type { Mission } from "../../shared/orch-types";

const RUNTIME: MissionOrchestratorRuntimeSnapshot = Object.freeze({
  adapterId: "codex",
  model: "gpt-5.6-sol",
  accountId: "account-a",
  effort: "high",
  readOnly: false,
  nativeReadOnly: true,
});

function runningMission(patch: Partial<Mission> = {}): Mission {
  return {
    id: "mission-1",
    title: "Corrigir o golden path",
    description: "",
    status: "running",
    createdAt: "1",
    squadId: "mission-runtime-1",
    intentState: "dispatched",
    intentVersion: 4,
    intentContract: {
      goal: "Implementar, testar e entregar a missão real",
      acceptanceCriteria: ["Teste real passa"],
      risk: "normal",
      executionMode: "autopilot",
      contextPolicy: "on-demand",
      budgets: { planningTokens: 1_000, executionTokens: 4_000, maxWorkers: 2 },
      intentVersion: 4,
      approvedAt: 1_700_000_000_000,
      orchestratorRuntime: { ...RUNTIME },
    },
    ...patch,
  } as Mission;
}

describe("missionApprovalAlreadyCurrent", () => {
  it("é verdadeiro para missão viva cujo contrato aprovado ainda vale", () => {
    expect(missionApprovalAlreadyCurrent(runningMission(), RUNTIME)).toBe(true);
    expect(
      missionApprovalAlreadyCurrent(
        runningMission({ intentState: "executing" }),
        RUNTIME,
      ),
    ).toBe(true);
  });

  it("é falso antes do primeiro approve — o operador ainda precisa decidir", () => {
    expect(
      missionApprovalAlreadyCurrent(
        runningMission({
          status: "pending",
          intentState: "ready_to_start",
          intentContract: {
            ...runningMission().intentContract!,
            approvedAt: undefined,
          },
        }),
        RUNTIME,
      ),
    ).toBe(false);
  });

  it("é falso quando a aprovação é de outra revisão do intent", () => {
    expect(
      missionApprovalAlreadyCurrent(
        runningMission({ intentVersion: 5 }),
        RUNTIME,
      ),
    ).toBe(false);
  });

  it("é falso quando o runtime do orquestrador mudou desde a aprovação", () => {
    expect(
      missionApprovalAlreadyCurrent(runningMission(), {
        ...RUNTIME,
        model: "outro-modelo",
      }),
    ).toBe(false);
  });

  it("é falso quando a missão não está mais executando", () => {
    for (const patch of [
      { status: "blocked" as const, intentState: "blocked_technical" as const },
      { status: "pending" as const },
      { status: "failed" as const },
    ]) {
      expect(missionApprovalAlreadyCurrent(runningMission(patch), RUNTIME)).toBe(
        false,
      );
    }
  });

  it("é falso em estados que ainda esperam a decisão do operador", () => {
    for (const intentState of [
      "awaiting_approval",
      "awaiting_goal",
      "ready_to_start",
      "draft",
    ] as const) {
      expect(
        missionApprovalAlreadyCurrent(runningMission({ intentState }), RUNTIME),
      ).toBe(false);
    }
  });
});
