import { beforeEach, describe, expect, it, vi } from "vitest";
import { testProjectScope } from "./__tests__/scope-fixture";

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

import { resolveProductionGuidedPrevcMcpFence } from "./guided-prevc-mcp-fence";

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
    requireDifferentProvider: false,
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
  });
});

describe("production guided PREVC MCP fence snapshot", () => {
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
