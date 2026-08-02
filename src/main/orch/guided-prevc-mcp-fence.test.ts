import { beforeEach, describe, expect, it, vi } from "vitest";
import { testProjectScope } from "./__tests__/scope-fixture";
import { TEAM_READ_ONLY_FANOUT_DOMAIN } from "../../shared/mission-topology";
import { encodeTaskScheduleDetail } from "./mission-scheduler-meta";

const h = vi.hoisted(() => ({
  getStores: vi.fn(),
  getWorkflowService: vi.fn(),
}));

vi.mock("./project-domain-store-registry", () => ({
  getProjectDomainStores: h.getStores,
}));

vi.mock("../context/context-workflow-registry", () => ({
  getContextWorkflowService: h.getWorkflowService,
}));

import {
  assertGuidedPrevcMcpFence,
  resolveProductionGuidedPrevcMcpFence,
  type GuidedPrevcMcpFenceSnapshot,
} from "./guided-prevc-mcp-fence";
import type { AgentGateContext } from "./gate";

const scope = testProjectScope();
const mission = {
  id: "mission-fence-production",
  title: "Production fence",
  description: "",
  status: "running" as const,
  squadId: "agentic-production-fence",
  milestones: [],
  learnings: "",
  intentState: "dispatched" as const,
  intentVersion: 1,
  intentContract: {
    version: 1 as const,
    source: "typed" as const,
    goal: "Ship exact workflow",
    acceptanceCriteria: ["Accepted"],
    risk: "sensitive" as const,
    executionMode: "autopilot" as const,
    lane: "standard" as const,
    contextPolicy: "on-demand" as const,
    intentVersion: 1,
    budgets: {
      planningTokens: 1_000,
      executionTokens: 8_000,
      maxWorkers: 3,
    },
  },
  createdAt: 1,
  updatedAt: 1,
};
const route = [
  "planning",
  "review-primary",
  "execution",
  "validation-primary",
  "confirmation",
] as const;
const contract = {
  schemaVersion: 1 as const,
  projectId: scope.projectId,
  checkoutId: scope.checkoutId,
  missionId: mission.id,
  baseCommit: "a".repeat(40),
  contextRevision: "b".repeat(64),
  goal: mission.intentContract.goal,
  nonGoals: [],
  acceptanceCriteria: [
    {
      id: "criterion-0001",
      statement: "Accepted",
      requiredSensorIds: [],
      invariantRefs: [],
      requiredArtifactIds: [],
    },
  ],
  businessInvariantRefs: [],
  impactedDomains: [],
  impactedSymbols: [],
  requiredSensors: [],
  requiredArtifacts: [],
  reviewerPolicy: {
    minimumReviewers: 1,
    requireIndependentAuthor: true as const,
    requireDifferentProvider: true,
    blockingSeverities: ["critical", "high"] as const,
  },
  risk: "high" as const,
  phase: "planning" as const,
  route,
  contractHash: "c".repeat(64),
};

function workflowAt(
  stage: (typeof route)[number] | "complete",
  completedStages: readonly (typeof route)[number][],
) {
  return {
    risk: "high" as const,
    binding: {
      projectId: scope.projectId,
      checkoutId: scope.checkoutId,
      missionId: mission.id,
      contractHash: contract.contractHash,
      contextHash: contract.contextRevision,
      baseSha: contract.baseCommit,
      headSha: contract.baseCommit,
      diffHash: "d".repeat(64),
    },
    route,
    stage,
    completedStages,
    reviewers: [],
    revision: completedStages.length + 1,
  };
}

beforeEach(() => {
  h.getStores.mockReset();
  h.getWorkflowService.mockReset();
  h.getStores.mockReturnValue({
    missions: { get: () => mission },
    tasks: {
      getPlanReceipt: () => ({
        tasks: [{ detail: "sealed delivery task" }],
      }),
    },
  });
});

describe("production guided PREVC MCP fence snapshot", () => {
  it("uses sealed task topology instead of reclassifying roundtable-like goal text", () => {
    const roundtableLikeMission = {
      ...mission,
      intentContract: {
        ...mission.intentContract,
        goal: "Todos os agentes devem responder o que fazem nesta missão",
      },
    };
    h.getStores.mockReturnValue({
      missions: { get: () => roundtableLikeMission },
      tasks: {
        getPlanReceipt: () => ({
          tasks: [{ detail: "sealed delivery task" }],
        }),
      },
    });
    h.getWorkflowService.mockReturnValue({
      getMissionWorkflow: () => ({ contract: null, workflow: null }),
    });

    expect(
      resolveProductionGuidedPrevcMcpFence(scope, mission.id),
    ).toMatchObject({
      required: true,
      active: true,
      hasContract: false,
    });
  });

  it("keeps PREVC inactive for an all-marker sealed fan-out receipt", () => {
    const detail = encodeTaskScheduleDetail("Responder.", {
      dependsOn: [],
      ownership: {
        files: [],
        symbols: [],
        domains: [TEAM_READ_ONLY_FANOUT_DOMAIN],
      },
      merged: false,
      parallelEligible: true,
      agentRef: "worker-a",
      agentCategory: "executor",
      executionMode: "read_only",
    });
    h.getStores.mockReturnValue({
      missions: { get: () => mission },
      tasks: {
        getPlanReceipt: () => ({ tasks: [{ detail }] }),
      },
    });

    expect(
      resolveProductionGuidedPrevcMcpFence(scope, mission.id),
    ).toMatchObject({
      required: false,
      active: false,
    });
    expect(h.getWorkflowService).not.toHaveBeenCalled();
  });

  it("fails closed on a mixed sealed topology before resolving workflow authority", () => {
    const fanoutDetail = encodeTaskScheduleDetail("Responder.", {
      dependsOn: [],
      ownership: {
        files: [],
        symbols: [],
        domains: [TEAM_READ_ONLY_FANOUT_DOMAIN],
      },
      merged: false,
      parallelEligible: true,
      agentRef: "worker-a",
      agentCategory: "executor",
      executionMode: "read_only",
    });
    h.getStores.mockReturnValue({
      missions: { get: () => mission },
      tasks: {
        getPlanReceipt: () => ({
          tasks: [
            { detail: fanoutDetail },
            { detail: "sealed delivery task" },
          ],
        }),
      },
    });

    expect(() =>
      resolveProductionGuidedPrevcMcpFence(scope, mission.id),
    ).toThrow(/guided_prevc_contract_stale.*mixes delivery/i);
    expect(h.getWorkflowService).not.toHaveBeenCalled();
  });

  it("is active without a contract and compiles current context before execution", () => {
    const compileMissionSnapshot = vi.fn(() => ({
      contextRevision: contract.contextRevision,
    }));
    const getMissionWorkflow = vi
      .fn()
      .mockReturnValueOnce({ contract: null, workflow: null })
      .mockReturnValueOnce({
        contract: {
          contract,
          author: {
            id: "author",
            sessionId: "session",
            provider: "claude",
          },
          frozenAt: 1,
        },
        workflow: workflowAt("planning", []),
      });
    h.getWorkflowService.mockReturnValue({
      getMissionWorkflow,
      compileMissionSnapshot,
    });

    expect(
      resolveProductionGuidedPrevcMcpFence(scope, mission.id),
    ).toMatchObject({
      required: true,
      active: true,
      hasContract: false,
      stage: null,
    });
    expect(compileMissionSnapshot).not.toHaveBeenCalled();

    expect(
      resolveProductionGuidedPrevcMcpFence(scope, mission.id),
    ).toMatchObject({
      required: true,
      active: true,
      hasContract: true,
      stage: "planning",
      risk: "high",
    });
    expect(compileMissionSnapshot).toHaveBeenCalledWith(mission.id);
  });

  it.each([
    ["execution", ["planning", "review-primary"]],
    [
      "validation-primary",
      ["planning", "review-primary", "execution"],
    ],
    [
      "confirmation",
      [
        "planning",
        "review-primary",
        "execution",
        "validation-primary",
      ],
    ],
    ["complete", [...route]],
  ] as const)(
    "stays disarmed at %s without re-running the bootstrap context compiler",
    (stage, completedStages) => {
      const compileMissionSnapshot = vi.fn(() => {
        throw new Error("must not rearm after execution");
      });
      h.getWorkflowService.mockReturnValue({
        getMissionWorkflow: () => ({
          contract: {
            contract,
            author: {
              id: "author",
              sessionId: "session",
              provider: "claude",
            },
            frozenAt: 1,
          },
          workflow: workflowAt(stage, completedStages),
        }),
        compileMissionSnapshot,
      });

      expect(
        resolveProductionGuidedPrevcMcpFence(scope, mission.id),
      ).toMatchObject({
        required: true,
        active: false,
        stage,
      });
      expect(compileMissionSnapshot).not.toHaveBeenCalled();
    },
  );

  it("fails closed when the frozen contract no longer matches approved intent", () => {
    h.getWorkflowService.mockReturnValue({
      getMissionWorkflow: () => ({
        contract: {
          contract: { ...contract, goal: "lookalike" },
          author: {
            id: "author",
            sessionId: "session",
            provider: "claude",
          },
          frozenAt: 1,
        },
        workflow: workflowAt("planning", []),
      }),
      compileMissionSnapshot: vi.fn(),
    });

    expect(() =>
      resolveProductionGuidedPrevcMcpFence(scope, mission.id),
    ).toThrow(/guided_prevc_contract_stale.*approved goal or criteria/i);
  });

  it("fails closed when only half of the contract/workflow authority exists", () => {
    const frozenContract = {
      contract,
      author: {
        id: "author",
        sessionId: "session",
        provider: "claude",
      },
      frozenAt: 1,
    };
    const compileMissionSnapshot = vi.fn();
    h.getWorkflowService.mockReturnValue({
      getMissionWorkflow: vi
        .fn()
        .mockReturnValueOnce({
          contract: frozenContract,
          workflow: null,
        })
        .mockReturnValueOnce({
          contract: null,
          workflow: workflowAt("planning", []),
        }),
      compileMissionSnapshot,
    });

    expect(() =>
      resolveProductionGuidedPrevcMcpFence(scope, mission.id),
    ).toThrow(/guided_prevc_contract_stale.*atomic authority/i);
    expect(() =>
      resolveProductionGuidedPrevcMcpFence(scope, mission.id),
    ).toThrow(/guided_prevc_contract_stale.*atomic authority/i);
    expect(compileMissionSnapshot).not.toHaveBeenCalled();
  });

  it("fails closed when the compiled context revision diverges before execution", () => {
    const compileMissionSnapshot = vi.fn(() => ({
      contextRevision: "e".repeat(64),
    }));
    h.getWorkflowService.mockReturnValue({
      getMissionWorkflow: () => ({
        contract: {
          contract,
          author: {
            id: "author",
            sessionId: "session",
            provider: "claude",
          },
          frozenAt: 1,
        },
        workflow: workflowAt("review-primary", ["planning"]),
      }),
      compileMissionSnapshot,
    });

    expect(() =>
      resolveProductionGuidedPrevcMcpFence(scope, mission.id),
    ).toThrow(/guided_prevc_contract_stale.*compiled context snapshot/i);
    expect(compileMissionSnapshot).toHaveBeenCalledWith(mission.id);
  });
});

describe("assertGuidedPrevcMcpFence Overclock-order delegation", () => {
  const activeFence: GuidedPrevcMcpFenceSnapshot = Object.freeze({
    required: true,
    active: true,
    hasContract: true,
    stage: "planning",
    risk: "high",
    contractHash: "c".repeat(64),
    workflowRevision: 1,
  });

  function maestroCtx(): AgentGateContext {
    return {
      token: "token-maestro",
      label: "Maestro",
      role: "orchestrator",
      missionId: mission.id,
      sessionId: "session-maestro",
      providerId: "codex",
      scope,
      allowedTools: null,
      allowedSkills: null,
      stopAttempts: 0,
      handoffSubmitted: false,
    };
  }

  function workerCtx(): AgentGateContext {
    return {
      token: "token-worker",
      label: "Worker",
      role: "worker",
      missionId: mission.id,
      sessionId: "session-worker",
      workerIncarnationId: "incarnation-1",
      providerId: "codex",
      scope,
      allowedTools: null,
      allowedSkills: null,
      stopAttempts: 0,
      handoffSubmitted: false,
    };
  }

  it("lets the physical Maestro route and spawn read-only before execution", () => {
    expect(() =>
      assertGuidedPrevcMcpFence(
        activeFence,
        "nexus_route_task",
        { task: "delegate" },
        maestroCtx(),
      ),
    ).not.toThrow();
    expect(() =>
      assertGuidedPrevcMcpFence(
        activeFence,
        "nexus_pane_spawn",
        { readOnly: true },
        maestroCtx(),
      ),
    ).not.toThrow();
  });

  it("still blocks workers, writable panes, and code mutation before execution", () => {
    expect(() =>
      assertGuidedPrevcMcpFence(
        activeFence,
        "nexus_pane_spawn",
        { readOnly: true },
        workerCtx(),
      ),
    ).toThrow(/physical mission Maestro/i);
    expect(() =>
      assertGuidedPrevcMcpFence(
        activeFence,
        "nexus_pane_spawn",
        {},
        maestroCtx(),
      ),
    ).toThrow(/readOnly=true/i);
    expect(() =>
      assertGuidedPrevcMcpFence(
        activeFence,
        "nexus_file_write",
        { path: "a.ts", content: "x" },
        maestroCtx(),
      ),
    ).toThrow(/unavailable before stage=execution/i);
  });
});
