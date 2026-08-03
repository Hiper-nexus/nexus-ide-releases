import { describe, expect, it, vi } from "vitest";
import { compileIntentContract } from "../../shared/mission-intent";
import type { Mission } from "../../shared/orch-types";
import { TEAM_READ_ONLY_FANOUT_DOMAIN } from "../../shared/mission-topology";
import { ContextReadinessError } from "../context/context-workflow-service";
import { testProjectScope } from "./__tests__/scope-fixture";
import {
  assertGuidedPrevcExecutionReady,
  ensureGuidedMissionPrevc,
  ensureGuidedMissionPrevcAtBootstrapBoundary,
  taskDetailsRequireGuidedPrevc,
  type GuidedMissionPrevcBootstrapDeps,
  type GuidedMissionPrevcDeps,
} from "./guided-mission-prevc";
import { missionRequiresGuidedPrevc } from "./guided-mission-authority";
import { encodeTaskScheduleDetail } from "./mission-scheduler-meta";

function guidedDetail(): string {
  return encodeTaskScheduleDetail("Implementar", {
    dependsOn: [],
    ownership: {
      files: ["src"],
      symbols: [],
      domains: ["guided-implementation", "sequential-only"],
    },
    merged: false,
    agentRef: "executor",
    agentCategory: "executor",
    executionMode: "isolated_worktree",
  });
}

function approvedMission(): Mission {
  const intent = compileIntentContract({
    goal: "Entregar o fluxo guiado",
    acceptanceCriteria: ["Fluxo completo e testado"],
    intentVersion: 1,
  });
  return {
    id: "mission-guided",
    title: "Fluxo guiado",
    description: intent.goal,
    status: "running",
    squadId: "agentic-guided-squad",
    milestones: [],
    learnings: "",
    intentState: "dispatched",
    intentVersion: 1,
    intentContract: {
      ...intent,
      approvedAt: 1,
      dispatchedAt: 1,
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("main-owned guided PREVC preflight", () => {
  it("treats only edge whitespace as canonical when checking the approved PREVC text", () => {
    expect(() =>
      assertGuidedPrevcExecutionReady({
        required: true,
        missionId: "mission-guided",
        approvedGoal: " Entregar o fluxo guiado ",
        approvedAcceptanceCriteria: ["Fluxo completo e testado "],
        workflow: {
          contract: {
            contract: {
              missionId: "mission-guided",
              goal: "Entregar o fluxo guiado",
              acceptanceCriteria: [
                { statement: "Fluxo completo e testado" },
              ],
            },
          },
          workflow: { stage: "execution" },
        } as never,
      }),
    ).not.toThrow();

    expect(() =>
      assertGuidedPrevcExecutionReady({
        required: true,
        missionId: "mission-guided",
        approvedGoal: "Entregar outro fluxo",
        approvedAcceptanceCriteria: ["Fluxo completo e testado"],
        workflow: {
          contract: {
            contract: {
              missionId: "mission-guided",
              goal: "Entregar o fluxo guiado",
              acceptanceCriteria: [
                { statement: "Fluxo completo e testado" },
              ],
            },
          },
          workflow: { stage: "execution" },
        } as never,
      }),
    ).toThrow(/guided_prevc_contract_stale/i);
  });

  it("classifies PREVC from the standard human engine-generated mission, never task domains", () => {
    const guided = approvedMission();
    expect(missionRequiresGuidedPrevc(guided)).toBe(true);
    expect(taskDetailsRequireGuidedPrevc([guidedDetail()])).toBe(true);
    expect(
      taskDetailsRequireGuidedPrevc([
        encodeTaskScheduleDetail("Manual", {
          dependsOn: [],
          ownership: {
            files: ["src"],
            symbols: [],
            domains: ["manual-specialty"],
          },
          merged: false,
          agentRef: "executor",
          agentCategory: "executor",
          executionMode: "isolated_worktree",
        }),
      ]),
    ).toBe(false);
    expect(
      missionRequiresGuidedPrevc({
        ...guided,
        intentContract: {
          ...guided.intentContract!,
          source: "automation",
        },
      }),
    ).toBe(false);
    expect(missionRequiresGuidedPrevc(guided, "wave-pack")).toBe(false);
    expect(
      missionRequiresGuidedPrevc({
        ...guided,
        squadId: "saved-specialty-squad",
      }),
    ).toBe(false);
    expect(
      missionRequiresGuidedPrevc({
        ...guided,
        squadId: "nexus-story-impl",
        intentContract: {
          ...guided.intentContract!,
          promotedPlan: {
            version: 1,
            handoffId: "handoff-plan",
            sourceIntentVersion: 1,
            sourceSessionId: "session-plan",
            handoffCreatedAt: 1,
            physicalReceipt: {
              receiptId: "receipt-plan",
              toolCallId: "tool-plan",
              source: "http-mcp",
              authoritySha256: "a".repeat(64),
              issuedAt: 1,
            },
            summary: "# PRD\nPlano aprovado",
            artifacts: [],
            summarySha256: "b".repeat(64),
            artifactsSha256: "c".repeat(64),
            digest: "d".repeat(64),
          },
        },
      }),
    ).toBe(true);
    expect(
      missionRequiresGuidedPrevc({
        ...guided,
        squadId: "nexus-story-impl",
        intentContract: {
          ...guided.intentContract!,
          source: "automation",
          promotedPlan: {
            version: 1,
            handoffId: "handoff-plan",
            sourceIntentVersion: 1,
            sourceSessionId: "session-plan",
            handoffCreatedAt: 1,
            physicalReceipt: {
              receiptId: "receipt-plan",
              toolCallId: "tool-plan",
              source: "http-mcp",
              authoritySha256: "a".repeat(64),
              issuedAt: 1,
            },
            summary: "# PRD\nPlano aprovado",
            artifacts: [],
            summarySha256: "b".repeat(64),
            artifactsSha256: "c".repeat(64),
            digest: "d".repeat(64),
          },
        },
      }),
    ).toBe(false);
  });

  it("skips guided PREVC only for an explicit read-only team fanout", () => {
    const guided = approvedMission();
    const withGoal = (goal: string): Mission => ({
      ...guided,
      description: goal,
      intentContract: {
        ...guided.intentContract!,
        goal,
      },
    });

    expect(
      missionRequiresGuidedPrevc(
        withGoal(
          "Todos os agentes devem responder o que fazem nesta missão",
        ),
      ),
    ).toBe(false);
    expect(
      missionRequiresGuidedPrevc(
        withGoal(
          "Todos os agentes devem revisar e corrigir o código desta missão",
        ),
      ),
    ).toBe(true);
  });

  it.each([
    ["missing", []],
    ["corrupt", ["NEXUS_SCHEDULE_META:{broken}\n---\nExecutar"]],
    [
      "legacy",
      [
        encodeTaskScheduleDetail("Plano legado", {
          dependsOn: [],
          ownership: {
            files: ["src"],
            symbols: [],
            domains: ["manual-specialty"],
          },
          merged: false,
          agentRef: "executor",
          agentCategory: "executor",
          executionMode: "isolated_worktree",
        }),
      ],
    ],
  ] as const)(
    "blocks %s task metadata before workflow/provider materialization",
    (_label, details) => {
      const workflowForScope = vi.fn();
      const deps = {
        getMission: () => approvedMission(),
        listPlannedTaskDetails: () => details,
        hasMaterializedWorkerAuthority: vi.fn(),
        ensureGreenfieldBaseline: vi.fn(),
        workflowForScope,
      } as unknown as GuidedMissionPrevcDeps;

      expect(() =>
        ensureGuidedMissionPrevc(
          testProjectScope(),
          "mission-guided",
          deps,
        ),
      ).toThrow(/guided_plan_(?:receipt_missing|legacy_receipt_blocked)/i);
      expect(workflowForScope).not.toHaveBeenCalled();
      expect(deps.hasMaterializedWorkerAuthority).not.toHaveBeenCalled();
    },
  );

  it("fails closed on mixed sealed topology before workflow/provider materialization", () => {
    const fanoutDetail = encodeTaskScheduleDetail("Responder", {
      dependsOn: [],
      ownership: {
        files: [],
        symbols: [],
        domains: [TEAM_READ_ONLY_FANOUT_DOMAIN],
      },
      merged: false,
      parallelEligible: true,
      agentRef: "reviewer",
      agentCategory: "reviewer",
      executionMode: "read_only",
    });
    const workflowForScope = vi.fn();
    const deps = {
      getMission: () => approvedMission(),
      listPlannedTaskDetails: () => [fanoutDetail, guidedDetail()],
      hasMaterializedWorkerAuthority: vi.fn(),
      ensureGreenfieldBaseline: vi.fn(),
      workflowForScope,
    } as unknown as GuidedMissionPrevcDeps;

    expect(() =>
      ensureGuidedMissionPrevc(
        testProjectScope(),
        "mission-guided",
        deps,
      ),
    ).toThrow(/guided_prevc_contract_stale.*mistura.*replaneje.*reaprove/i);
    expect(workflowForScope).not.toHaveBeenCalled();
    expect(deps.hasMaterializedWorkerAuthority).not.toHaveBeenCalled();
  });

  it("freezes in Main and advances deterministic planning before reporting dispatch readiness", () => {
    const mission = approvedMission();
    let current: {
      contract: null | { contract: Record<string, unknown> };
      workflow: null | {
        stage: "planning" | "execution";
        route: readonly ["planning", "execution", "validation-primary"];
      };
    } = { contract: null, workflow: null };
    const freezeContract = vi.fn((
      draft: { missionId: string; goal: string },
      _author: unknown,
    ) => {
      current = {
        contract: {
          contract: {
            missionId: draft.missionId,
            goal: draft.goal,
            acceptanceCriteria: [
              { statement: "Fluxo completo e testado" },
            ],
          },
        },
        workflow: {
          stage: "planning",
          route: ["planning", "execution", "validation-primary"],
        },
      };
      return {};
    });
    const advance = vi.fn(() => {
      current = {
        ...current,
        workflow: {
          stage: "execution",
          route: ["planning", "execution", "validation-primary"],
        },
      };
      return current.workflow;
    });
    const deps = {
      getMission: () => mission,
      listPlannedTaskDetails: () => [guidedDetail()],
      hasMaterializedWorkerAuthority: () => false,
      ensureGreenfieldBaseline: vi.fn(() => null),
      workflowForScope: () => ({
        getMissionWorkflow: () => current,
        freezeContract,
        advance,
        compileMissionSnapshot: vi.fn(),
      }),
    } as unknown as GuidedMissionPrevcDeps;

    const result = ensureGuidedMissionPrevc(
      testProjectScope(),
      mission.id,
      deps,
    );

    expect(freezeContract).toHaveBeenCalledOnce();
    expect(freezeContract.mock.calls[0]![1]).toEqual({
      id: "nexus-guided-preflight",
      sessionId: "main:mission-guided",
      provider: "nexus-main",
    });
    expect(advance).toHaveBeenCalledWith(mission.id, "execution");
    expect(result).toEqual({
      required: true,
      frozen: true,
      stage: "execution",
      readyForWorkerDispatch: true,
    });
  });

  it("never freezes late after a worker or dispatch authority was materialized", () => {
    const mission = approvedMission();
    const freezeContract = vi.fn();
    const deps = {
      getMission: () => mission,
      listPlannedTaskDetails: () => [guidedDetail()],
      hasMaterializedWorkerAuthority: () => true,
      ensureGreenfieldBaseline: vi.fn(() => null),
      workflowForScope: () => ({
        getMissionWorkflow: () => ({ contract: null, workflow: null }),
        freezeContract,
        advance: vi.fn(),
        compileMissionSnapshot: vi.fn(),
      }),
    } as unknown as GuidedMissionPrevcDeps;

    expect(() =>
      ensureGuidedMissionPrevc(testProjectScope(), mission.id, deps),
    ).toThrow(/late_freeze_blocked.*pane\/claim já materializado/i);
    expect(freezeContract).not.toHaveBeenCalled();
  });

  it("reports only missing-context as pending for the async Main bootstrap boundary", () => {
    const mission = approvedMission();
    const readinessError = new ContextReadinessError({
      ready: false,
      blockers: [],
    } as never);
    const ensureGreenfieldBaseline = vi.fn(() => null);
    const freezeContract = vi.fn(() => {
      throw readinessError;
    });
    const deps = {
      getMission: () => mission,
      listPlannedTaskDetails: () => [guidedDetail()],
      hasMaterializedWorkerAuthority: () => false,
      ensureGreenfieldBaseline,
      workflowForScope: () => ({
        getMissionWorkflow: () => ({ contract: null, workflow: null }),
        freezeContract,
        advance: vi.fn(),
        compileMissionSnapshot: vi.fn(),
      }),
    } as unknown as GuidedMissionPrevcDeps;

    expect(
      ensureGuidedMissionPrevc(testProjectScope(), mission.id, deps),
    ).toEqual({
      required: true,
      frozen: false,
      stage: null,
      readyForWorkerDispatch: false,
    });
    expect(ensureGreenfieldBaseline).toHaveBeenCalledOnce();
    expect(ensureGreenfieldBaseline).toHaveBeenCalledWith(
      testProjectScope(),
      {
        goal: "Entregar o fluxo guiado",
        acceptanceCriteria: ["Fluxo completo e testado"],
      },
    );

    freezeContract.mockImplementationOnce(() => {
      throw new Error("context storage unavailable");
    });
    expect(() =>
      ensureGuidedMissionPrevc(testProjectScope(), mission.id, deps),
    ).toThrow(/context storage unavailable/i);
  });

  it("prepares context in Main and physically retries the freeze before the scheduler boundary", async () => {
    const pending = {
      required: true,
      frozen: false,
      stage: null,
      readyForWorkerDispatch: false,
    } as const;
    const frozen = {
      required: true,
      frozen: true,
      stage: "execution",
      readyForWorkerDispatch: true,
    } as const;
    const ensurePrevc = vi
      .fn()
      .mockReturnValueOnce(pending)
      .mockReturnValueOnce(frozen);
    const bootstrapContext = vi.fn(async () => ({
      readiness: { ready: true, blockers: [] },
      blockingError: null,
      autopilotHint: "Context ready.",
    }));
    const deps = {
      ensurePrevc,
      bootstrapContext,
    } as unknown as GuidedMissionPrevcBootstrapDeps;

    await expect(
      ensureGuidedMissionPrevcAtBootstrapBoundary(
        testProjectScope(),
        "mission-guided",
        deps,
      ),
    ).resolves.toEqual(frozen);
    expect(bootstrapContext).toHaveBeenCalledOnce();
    expect(ensurePrevc).toHaveBeenCalledTimes(2);
    expect(ensurePrevc.mock.invocationCallOrder[0]).toBeLessThan(
      bootstrapContext.mock.invocationCallOrder[0]!,
    );
    expect(bootstrapContext.mock.invocationCallOrder[0]).toBeLessThan(
      ensurePrevc.mock.invocationCallOrder[1]!,
    );
  });

  it("fails closed before scheduler when Main cannot make context freeze-ready", async () => {
    const ensurePrevc = vi.fn(() => ({
      required: true,
      frozen: false,
      stage: null,
      readyForWorkerDispatch: false,
    }) as const);
    const bootstrapContext = vi.fn(async () => ({
      readiness: {
        ready: false,
        blockers: [{ code: "missing-product-context" }],
      },
      blockingError: null,
      autopilotHint: "Product authority is still missing.",
    }));

    await expect(
      ensureGuidedMissionPrevcAtBootstrapBoundary(
        testProjectScope(),
        "mission-guided",
        {
          ensurePrevc,
          bootstrapContext,
        } as unknown as GuidedMissionPrevcBootstrapDeps,
      ),
    ).rejects.toThrow(
      /guided_prevc_context_bootstrap_blocked.*missing-product-context/i,
    );
    expect(ensurePrevc).toHaveBeenCalledOnce();
  });

  it("rejects a ready-context false positive when mission_contracts is still absent", async () => {
    const pending = {
      required: true,
      frozen: false,
      stage: null,
      readyForWorkerDispatch: false,
    } as const;
    const ensurePrevc = vi.fn(() => pending);

    await expect(
      ensureGuidedMissionPrevcAtBootstrapBoundary(
        testProjectScope(),
        "mission-guided",
        {
          ensurePrevc,
          bootstrapContext: vi.fn(async () => ({
            readiness: { ready: true, blockers: [] },
            blockingError: null,
            autopilotHint: "Context ready.",
          })),
        } as unknown as GuidedMissionPrevcBootstrapDeps,
      ),
    ).rejects.toThrow(
      /guided_prevc_freeze_incomplete.*mission_contracts.*scheduler/i,
    );
    expect(ensurePrevc).toHaveBeenCalledTimes(2);
  });

  it("fails before Maestro/Doctor when the canonical greenfield brief belongs to another approved intent", () => {
    const mission = approvedMission();
    const freezeContract = vi.fn(() => {
      throw new ContextReadinessError({
        ready: false,
        blockers: [],
      } as never);
    });
    const ensureGreenfieldBaseline = vi.fn(() => {
      throw new Error(
        "guided_greenfield_brief_intent_mismatch: PRODUCT.md pertence a outra intenção aprovada",
      );
    });
    const deps = {
      getMission: () => mission,
      listPlannedTaskDetails: () => [guidedDetail()],
      hasMaterializedWorkerAuthority: () => false,
      ensureGreenfieldBaseline,
      workflowForScope: () => ({
        getMissionWorkflow: () => ({ contract: null, workflow: null }),
        freezeContract,
        advance: vi.fn(),
        compileMissionSnapshot: vi.fn(),
      }),
    } as unknown as GuidedMissionPrevcDeps;

    expect(() =>
      ensureGuidedMissionPrevc(testProjectScope(), mission.id, deps),
    ).toThrow(/brief_intent_mismatch.*outra intenção aprovada/i);
    expect(freezeContract).toHaveBeenCalledOnce();
    expect(ensureGreenfieldBaseline).toHaveBeenCalledOnce();
  });

  it("fails closed when a guided scheduler reaches claim time without the frozen execution stage", () => {
    expect(() =>
      assertGuidedPrevcExecutionReady({
        required: true,
        missionId: "mission-guided",
        workflow: { contract: null, workflow: null },
      }),
    ).toThrow(/não possui contrato PREVC congelado/i);

    expect(() =>
      assertGuidedPrevcExecutionReady({
        required: true,
        missionId: "mission-guided",
        workflow: {
          contract: {
            contract: {
              missionId: "mission-guided",
            },
          } as never,
          workflow: {
            stage: "review-primary",
          } as never,
        },
      }),
    ).toThrow(/está em review-primary/i);
  });
});
