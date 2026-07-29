import { describe, expect, it, vi } from "vitest";
import { compileIntentContract } from "../../shared/mission-intent";
import type { Mission } from "../../shared/orch-types";
import type { ProjectExecutionScope } from "../../shared/types";
import {
  classifyPrevcMergeFailure,
  ensurePrevcMergeReady,
  prepareOpportunisticPrevcContext,
  type PrevcMergePreparationDependencies,
} from "./prevc-merge-preparation";

const scope: ProjectExecutionScope = Object.freeze({
  version: 1,
  installationId: "install-a",
  projectId: "project-a",
  checkoutId: "checkout-a",
  rootRealPath: "/workspace/a",
  identitySource: "manifest",
});

function mission(): Mission {
  const intent = compileIntentContract({
    goal: "Corrigir autenticação",
    acceptanceCriteria: ["Login continua funcionando"],
    intentVersion: 1,
    source: "typed",
    lane: "standard",
  });
  return {
    id: "mission-a",
    title: "Corrigir autenticação",
    description: "Corrigir autenticação",
    status: "running",
    milestones: [],
    learnings: "",
    intentState: "executing",
    intentVersion: 1,
    intentContract: {
      ...intent,
      approvedAt: 1,
      dispatchedAt: 2,
    },
    createdAt: 1,
    updatedAt: 2,
  };
}

function ready(revision = "context-current") {
  return {
    ready: true,
    contextRevision: revision,
    blockers: [],
    warnings: [],
    sensorIds: ["typecheck", "unit"],
  } as never;
}

function approvedFrozenContract(
  overrides: Record<string, unknown> = {},
) {
  return {
    missionId: "mission-a",
    goal: "Corrigir autenticação",
    acceptanceCriteria: [
      { statement: "Login continua funcionando" },
    ],
    contextRevision: "context-current",
    requiredSensors: [],
    businessInvariantRefs: [],
    ...overrides,
  };
}

describe("PREVC merge preparation", () => {
  it("keeps repairable PREVC findings and missing project checks non-terminal", () => {
    expect(
      classifyPrevcMergeFailure(
        new Error("prevc_merge_context_pending: reviewer capacity"),
      ),
    ).toBe("retryable");
    expect(
      classifyPrevcMergeFailure(
        new Error("prevc_merge_not_ready: workflow ended at review-primary"),
      ),
    ).toBe("retryable");
    expect(
      classifyPrevcMergeFailure(
        new Error("prevc_merge_review_blocked: blocking-findings"),
      ),
    ).toBe("retryable");
    expect(
      classifyPrevcMergeFailure(
        new Error("prevc_merge_requirements_pending: sensors=security-audit"),
      ),
    ).toBe("retryable");
    for (const code of [
      "prevc_merge_workflow_corrupt",
      "prevc_merge_contract_stale",
      "prevc_merge_stage_invalid",
    ]) {
      expect(classifyPrevcMergeFailure(new Error(code))).toBe("terminal");
    }
  });

  it("prepares only project context opportunistically without rotating worker authority", async () => {
    let readiness = {
      ready: false,
      contextRevision: null,
      blockers: [{ code: "missing-product-context" }],
      warnings: [],
      sensorIds: [],
    } as never;
    let workflow: {
      contract: {
        contract: ReturnType<typeof approvedFrozenContract>;
      } | null;
      workflow: { stage: string } | null;
    } = { contract: null, workflow: null };
    const freezeContract = vi.fn();
    const bootstrapContext = vi.fn(async () => ({
      readiness: (readiness = ready()),
      blockingError: null,
      autopilotHint: "ready",
    }));
    const prepareExecution = vi.fn();
    const deps: PrevcMergePreparationDependencies = {
      getMission: () => mission(),
      workflowForScope: () =>
        ({
          inspectReadiness: () => readiness,
          getMissionWorkflow: () => workflow,
          freezeContract,
          refreezeContract: vi.fn(),
        }) as never,
      bootstrapContext,
      prepareExecution,
      inspectRequirements: () => ({
        sensorIds: new Set(["typecheck", "unit"]),
        invariantRefs: new Set(),
      }),
    };

    await expect(
      prepareOpportunisticPrevcContext(scope, "mission-a", deps),
    ).resolves.toMatchObject({ prepared: true, ready: true });
    expect(bootstrapContext).toHaveBeenCalledOnce();
    expect(freezeContract).not.toHaveBeenCalled();
    expect(prepareExecution).not.toHaveBeenCalled();
    expect(workflow).toEqual({ contract: null, workflow: null });
  });

  it("keeps promotion retryable while opportunistic context bootstrap is running", async () => {
    let readiness = {
      ready: false,
      contextRevision: null,
      blockers: [{ code: "missing-product-context" }],
      warnings: [],
      sensorIds: [],
    } as never;
    let workflow: {
      contract: {
        contract: ReturnType<typeof approvedFrozenContract>;
      } | null;
      workflow: { stage: string } | null;
    } = { contract: null, workflow: null };
    let finishBootstrap!: () => void;
    const bootstrapContext = vi.fn(
      () =>
        new Promise<
          Awaited<
            ReturnType<PrevcMergePreparationDependencies["bootstrapContext"]>
          >
        >((resolve) => {
          finishBootstrap = () => {
            readiness = ready();
            resolve({
              readiness,
              blockingError: null,
              autopilotHint: "ready",
            });
          };
        }),
    );
    const freezeContract = vi.fn(() => {
      workflow = {
        contract: { contract: approvedFrozenContract() },
        workflow: { stage: "planning" },
      };
    });
    const prepareExecution = vi.fn(async () => {
      workflow = {
        ...workflow,
        workflow: { stage: "execution" },
      };
    });
    const deps: PrevcMergePreparationDependencies = {
      getMission: () => mission(),
      workflowForScope: () =>
        ({
          inspectReadiness: () => readiness,
          getMissionWorkflow: () => workflow,
          freezeContract,
          refreezeContract: vi.fn(),
        }) as never,
      bootstrapContext,
      prepareExecution,
      inspectRequirements: () => ({
        sensorIds: new Set(["typecheck", "unit"]),
        invariantRefs: new Set(),
      }),
    };

    const background = prepareOpportunisticPrevcContext(
      scope,
      "mission-a",
      deps,
    );
    await vi.waitFor(() => expect(bootstrapContext).toHaveBeenCalledOnce());

    await expect(
      ensurePrevcMergeReady(scope, "mission-a", {}, deps),
    ).rejects.toThrow(/prevc_merge_context_pending.*background/i);
    expect(freezeContract).not.toHaveBeenCalled();
    expect(prepareExecution).not.toHaveBeenCalled();

    finishBootstrap();
    await expect(background).resolves.toMatchObject({
      prepared: true,
      ready: true,
    });
    await expect(
      ensurePrevcMergeReady(scope, "mission-a", {}, deps),
    ).resolves.toMatchObject({ stage: "execution" });
    expect(freezeContract).toHaveBeenCalledOnce();
    expect(prepareExecution).toHaveBeenCalledOnce();
  });

  it("prepares context, freezes the approved intent and reaches execution only at promotion", async () => {
    let readiness = {
      ready: false,
      contextRevision: null,
      blockers: [{ code: "missing-product-context" }],
      warnings: [],
      sensorIds: [],
    } as never;
    let workflow: {
      contract: {
        contract: {
          contextRevision: string;
          requiredSensors: string[];
          businessInvariantRefs: string[];
        };
      } | null;
      workflow: { stage: string } | null;
    } = { contract: null, workflow: null };
    const freezeContract = vi.fn(() => {
      workflow = {
        contract: {
          contract: approvedFrozenContract(),
        },
        workflow: { stage: "planning" },
      };
    });
    const prepareExecution = vi.fn(async () => {
      workflow = {
        ...workflow,
        workflow: { stage: "execution" },
      };
    });
    const bootstrapContext = vi.fn(async () => {
      readiness = ready();
      return {
        readiness,
        blockingError: null,
        autopilotHint: "ready",
      };
    });
    const deps: PrevcMergePreparationDependencies = {
      getMission: () => mission(),
      workflowForScope: () =>
        ({
          inspectReadiness: () => readiness,
          getMissionWorkflow: () => workflow,
          freezeContract,
          refreezeContract: vi.fn(),
        }) as never,
      bootstrapContext,
      prepareExecution,
      inspectRequirements: () => ({
        sensorIds: new Set(["typecheck", "unit"]),
        invariantRefs: new Set(),
      }),
    };

    await expect(
      ensurePrevcMergeReady(scope, "mission-a", {}, deps),
    ).resolves.toMatchObject({ stage: "execution", frozenNow: true });

    expect(bootstrapContext).toHaveBeenCalledOnce();
    expect(freezeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: "mission-a",
        goal: "Corrigir autenticação",
        acceptanceCriteria: [
          expect.objectContaining({ statement: "Login continua funcionando" }),
        ],
      }),
      expect.objectContaining({ provider: "nexus-main" }),
    );
    expect(prepareExecution).toHaveBeenCalledOnce();
  });

  it("reuses a current execution workflow without repeating preparation", async () => {
    const bootstrapContext = vi.fn();
    const prepareExecution = vi.fn();
    const freezeContract = vi.fn();
    const deps: PrevcMergePreparationDependencies = {
      getMission: () => mission(),
      workflowForScope: () =>
        ({
          inspectReadiness: () => ready(),
          getMissionWorkflow: () => ({
            contract: {
              contract: approvedFrozenContract(),
            },
            workflow: { stage: "execution" },
          }),
          freezeContract,
          refreezeContract: vi.fn(),
        }) as never,
      bootstrapContext,
      prepareExecution,
      inspectRequirements: () => ({
        sensorIds: new Set(["typecheck", "unit"]),
        invariantRefs: new Set(),
      }),
    };

    await expect(
      ensurePrevcMergeReady(scope, "mission-a", {}, deps),
    ).resolves.toMatchObject({ stage: "execution", frozenNow: false });
    expect(bootstrapContext).not.toHaveBeenCalled();
    expect(freezeContract).not.toHaveBeenCalled();
    expect(prepareExecution).not.toHaveBeenCalled();
  });

  it("keeps final promotion pending when context cannot become authoritative", async () => {
    const deps: PrevcMergePreparationDependencies = {
      getMission: () => mission(),
      workflowForScope: () =>
        ({
          inspectReadiness: () => ({
            ready: false,
            contextRevision: null,
            blockers: [{ code: "missing-business-context" }],
            warnings: [],
            sensorIds: [],
          }),
          getMissionWorkflow: () => ({ contract: null, workflow: null }),
          freezeContract: vi.fn(),
          refreezeContract: vi.fn(),
        }) as never,
      bootstrapContext: async () => ({
        readiness: {
          ready: false,
          contextRevision: null,
          blockers: [{ code: "missing-business-context" }],
          warnings: [],
          sensorIds: [],
        } as never,
        blockingError: "independent review unavailable",
        autopilotHint: "configure a second reviewer",
      }),
      prepareExecution: vi.fn(),
      inspectRequirements: () => ({
        sensorIds: new Set(),
        invariantRefs: new Set(),
      }),
    };

    await expect(
      ensurePrevcMergeReady(scope, "mission-a", {}, deps),
    ).rejects.toThrow(
      /prevc_merge_context_pending.*missing-business-context.*independent review unavailable/i,
    );
  });

  it("keeps an explicit unknown sensor pending instead of silently weakening the contract", async () => {
    const prepareExecution = vi.fn();
    const deps: PrevcMergePreparationDependencies = {
      getMission: () => mission(),
      workflowForScope: () =>
        ({
          inspectReadiness: () => ready(),
          getMissionWorkflow: () => ({
            contract: {
              contract: approvedFrozenContract({
                requiredSensors: ["security-audit"],
              }),
            },
            workflow: { stage: "execution" },
          }),
          freezeContract: vi.fn(),
          refreezeContract: vi.fn(),
        }) as never,
      bootstrapContext: vi.fn(),
      prepareExecution,
      inspectRequirements: () => ({
        sensorIds: new Set(["typecheck", "unit"]),
        invariantRefs: new Set(),
      }),
    };

    await expect(
      ensurePrevcMergeReady(scope, "mission-a", {}, deps),
    ).rejects.toThrow(
      /prevc_merge_requirements_pending.*security-audit/i,
    );
    expect(prepareExecution).not.toHaveBeenCalled();
  });

  it("rejects a frozen workflow from an older approved intent", async () => {
    const prepareExecution = vi.fn();
    const deps: PrevcMergePreparationDependencies = {
      getMission: () => mission(),
      workflowForScope: () =>
        ({
          inspectReadiness: () => ready(),
          getMissionWorkflow: () => ({
            contract: {
              contract: approvedFrozenContract({
                goal: "Objetivo aprovado anteriormente",
              }),
            },
            workflow: { stage: "execution" },
          }),
          freezeContract: vi.fn(),
          refreezeContract: vi.fn(),
        }) as never,
      bootstrapContext: vi.fn(),
      prepareExecution,
      inspectRequirements: () => ({
        sensorIds: new Set(["typecheck", "unit"]),
        invariantRefs: new Set(),
      }),
    };

    await expect(
      ensurePrevcMergeReady(scope, "mission-a", {}, deps),
    ).rejects.toThrow(/prevc_merge_contract_stale/i);
    expect(prepareExecution).not.toHaveBeenCalled();
  });
});
