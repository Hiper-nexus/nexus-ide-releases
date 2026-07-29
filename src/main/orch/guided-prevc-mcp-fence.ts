import type {
  MissionRisk,
  WorkflowStage,
} from "../context/contract-compiler";
import { getContextWorkflowService } from "../context/context-workflow-registry";
import type { ProjectExecutionScope } from "../../shared/types";
import {
  canonicalToolName,
  isInternalPrevcReviewerToolAllowed,
  type AgentGateContext,
} from "./gate";
import { missionRequiresGuidedPrevc } from "./guided-mission-authority";
import { effectPolicyForTool } from "./mcp-effect-policy";
import { getProjectDomainStores } from "./project-domain-store-registry";

export interface GuidedPrevcMcpFenceSnapshot {
  readonly required: boolean;
  readonly active: boolean;
  readonly hasContract: boolean;
  readonly stage: WorkflowStage | null;
  readonly risk: MissionRisk | null;
  readonly contractHash: string | null;
  readonly workflowRevision: number | null;
}

export type GuidedPrevcMcpFenceResolver = (
  scope: ProjectExecutionScope,
  missionId: string,
) => GuidedPrevcMcpFenceSnapshot;

export const INACTIVE_GUIDED_PREVC_MCP_FENCE: GuidedPrevcMcpFenceSnapshot =
  Object.freeze({
    required: false,
    active: false,
    hasContract: false,
    stage: null,
    risk: null,
    contractHash: null,
    workflowRevision: null,
  });

function stale(detail: string): never {
  throw new Error(`guided_prevc_contract_stale: ${detail}`);
}

/**
 * Compile the current production fence from the exact approved intent,
 * scheduled guided ownership, frozen contract, workflow binding, and current
 * context snapshot. There is no cached/prompt-derived authority in this path.
 */
export function resolveProductionGuidedPrevcMcpFence(
  scope: ProjectExecutionScope,
  missionId: string,
): GuidedPrevcMcpFenceSnapshot {
  const stores = getProjectDomainStores(scope);
  const mission = stores.missions.get(missionId);
  if (!mission) throw new Error("guided_prevc_mission_missing");
  const approved = mission.intentContract;
  if (!approved) return INACTIVE_GUIDED_PREVC_MCP_FENCE;
  if (
    mission.intentVersion !== undefined &&
    mission.intentVersion !== approved.intentVersion
  ) {
    stale("approved intent version is no longer current");
  }
  if (!missionRequiresGuidedPrevc(mission)) {
    return INACTIVE_GUIDED_PREVC_MCP_FENCE;
  }

  const service = getContextWorkflowService(scope);
  const current = service.getMissionWorkflow(missionId);
  if (!current.contract && !current.workflow) {
    return Object.freeze({
      required: true,
      active: true,
      hasContract: false,
      stage: null,
      risk: null,
      contractHash: null,
      workflowRevision: null,
    });
  }
  if (!current.contract || !current.workflow) {
    stale("contract and workflow must exist as one atomic authority");
  }

  const contract = current.contract.contract;
  const workflow = current.workflow;
  const exactIntent =
    contract.missionId === missionId &&
    contract.projectId === scope.projectId &&
    contract.checkoutId === scope.checkoutId &&
    contract.goal === approved.goal &&
    contract.acceptanceCriteria.length ===
      approved.acceptanceCriteria.length &&
    contract.acceptanceCriteria.every(
      (criterion, index) =>
        criterion.statement === approved.acceptanceCriteria[index],
    );
  if (!exactIntent) {
    stale("frozen contract differs from the current approved goal or criteria");
  }
  if (
    workflow.binding.missionId !== contract.missionId ||
    workflow.binding.projectId !== contract.projectId ||
    workflow.binding.checkoutId !== contract.checkoutId ||
    workflow.binding.contractHash !== contract.contractHash ||
    workflow.binding.contextHash !== contract.contextRevision ||
    workflow.binding.baseSha !== contract.baseCommit ||
    workflow.risk !== contract.risk ||
    JSON.stringify(workflow.route) !== JSON.stringify(contract.route)
  ) {
    stale("workflow binding differs from its frozen contract");
  }

  const executionIndex = workflow.route.indexOf("execution");
  const currentIndex =
    workflow.stage === "complete"
      ? workflow.route.length
      : workflow.route.indexOf(workflow.stage);
  if (executionIndex < 0 || currentIndex < 0) {
    stale("workflow route does not contain its current execution authority");
  }
  const reachedExecution =
    workflow.stage === "execution" ||
    workflow.completedStages.includes("execution") ||
    currentIndex >= executionIndex;
  if (!reachedExecution) {
    const compiled = service.compileMissionSnapshot(missionId);
    if (compiled.contextRevision !== contract.contextRevision) {
      stale("compiled context snapshot differs from the frozen revision");
    }
  }
  return Object.freeze({
    required: true,
    active: !reachedExecution,
    hasContract: true,
    stage: workflow.stage,
    risk: contract.risk,
    contractHash: contract.contractHash,
    workflowRevision: workflow.revision,
  });
}

function assertMissionArgument(
  args: Readonly<Record<string, unknown>>,
  missionId: string,
): void {
  if (args.missionId !== missionId) {
    throw new Error(
      "guided_prevc_mcp_fence: requested mission differs from bearer authority",
    );
  }
}

function assertOptionalMissionArgument(
  args: Readonly<Record<string, unknown>>,
  missionId: string,
): void {
  if (args.missionId !== undefined && args.missionId !== missionId) {
    throw new Error(
      "guided_prevc_mcp_fence: requested mission differs from bearer authority",
    );
  }
}

function assertPhysicalWorker(ctx: AgentGateContext): void {
  if (
    ctx.role !== "worker" ||
    !ctx.missionId ||
    !ctx.sessionId ||
    !ctx.workerIncarnationId
  ) {
    throw new Error(
      "guided_prevc_mcp_fence: lifecycle call requires the current physical mission worker",
    );
  }
}

function assertPhysicalMaestro(ctx: AgentGateContext): void {
  if (ctx.role !== "orchestrator" || !ctx.missionId || !ctx.sessionId) {
    throw new Error(
      "guided_prevc_mcp_fence: lifecycle call requires the current physical mission Maestro",
    );
  }
}

/**
 * PREVC is prepared in parallel and gates execution effects/promotion, not
 * mission coordination. Ordinary calls still pass through the independent
 * allowlist, role, read-only, intent, workflow and handler authorities in
 * mcp-dispatch. This fence owns only the exact PREVC bootstrap/reviewer phase
 * and a narrow pre-execution policy boundary.
 */
export function assertGuidedPrevcMcpFence(
  snapshot: GuidedPrevcMcpFenceSnapshot,
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  ctx: AgentGateContext,
): void {
  const canonical = canonicalToolName(toolName);

  if (ctx.internalPrevcReviewerAuthority) {
    if (!isInternalPrevcReviewerToolAllowed(ctx, toolName)) {
      throw new Error(
        `guided_prevc_mcp_fence: ${toolName} is outside the exact internal reviewer profile`,
      );
    }
    const reviewerAuthority = ctx.internalPrevcReviewerAuthority;
    if (
      reviewerAuthority.kind === "context-draft" &&
      (canonical === "context_draft_get" ||
        canonical === "context_draft_review") &&
      args.draftId !== reviewerAuthority.draftId
    ) {
      throw new Error(
        "guided_prevc_mcp_fence: context reviewer is bound to another draft",
      );
    }
    if (
      reviewerAuthority.kind === "automated-review" &&
      canonical === "merge_review_submit" &&
      args.reviewSessionId !== reviewerAuthority.reviewSessionId
    ) {
      throw new Error(
        "guided_prevc_mcp_fence: automated reviewer is bound to another review session",
      );
    }
    if (!snapshot.required) return;
    if (
      reviewerAuthority.kind === "context-draft" &&
      snapshot.active &&
      !snapshot.hasContract
    ) {
      return;
    }
    if (reviewerAuthority.kind === "context-draft") {
      throw new Error(
        "guided_prevc_mcp_fence: context draft review authority ends when the contract freezes",
      );
    }
    if (
      reviewerAuthority.kind === "automated-review" &&
      reviewerAuthority.issuedFor === "pre-execution" &&
      snapshot.active &&
      (snapshot.risk === "high" || snapshot.risk === "critical") &&
      (snapshot.stage === "review-primary" ||
        snapshot.stage === "review-secondary")
    ) {
      return;
    }
    if (
      reviewerAuthority.kind === "automated-review" &&
      reviewerAuthority.issuedFor === "post-execution" &&
      !snapshot.active &&
      (snapshot.stage === "execution" ||
        snapshot.stage === "validation-primary" ||
        snapshot.stage === "validation-secondary" ||
        snapshot.stage === "confirmation")
    ) {
      return;
    }
    throw new Error(
      "guided_prevc_mcp_fence: automated reviewer authority does not match the current review phase",
    );
  }

  if (!snapshot.required || !snapshot.active) return;

  if (!ctx.missionId) {
    throw new Error(
      "guided_prevc_mcp_fence: pre-execution call requires a mission-bound bearer",
    );
  }

  switch (canonical) {
    case "handoff_submit":
    case "worker_heartbeat":
      assertPhysicalWorker(ctx);
      return;
    case "handoff_list":
      assertOptionalMissionArgument(args, ctx.missionId);
      return;
    case "handoff_ack":
      assertPhysicalMaestro(ctx);
      return;
    case "browser_open":
    case "browser_navigate":
      assertPhysicalMaestro(ctx);
      return;
    case "task":
      assertOptionalMissionArgument(args, ctx.missionId);
      if (args.action === "list") return;
      throw new Error(
        "guided_prevc_mcp_fence: task mutation is unavailable before stage=execution",
      );
    case "todo_manager":
      if (args.listId !== undefined && args.listId !== ctx.missionId) {
        throw new Error(
          "guided_prevc_mcp_fence: requested todo list differs from bearer mission",
        );
      }
      if (args.action === "read_list") return;
      throw new Error(
        "guided_prevc_mcp_fence: todo mutation is unavailable before stage=execution",
      );
    case "memory_retain":
      return;
    case "context_doctor":
      if (ctx.role !== "orchestrator") {
        throw new Error(
          "guided_prevc_mcp_fence: Doctor requires the mission Maestro",
        );
      }
      if (snapshot.hasContract) {
        throw new Error(
          "guided_prevc_mcp_fence: Doctor authority ends when the contract freezes",
        );
      }
      if (args.autoReview === false || args.autoCommit === false) {
        throw new Error(
          "guided_prevc_mcp_fence: Doctor requires autoReview and autoCommit",
        );
      }
      return;
    case "mission_freeze_contract":
      if (ctx.role !== "orchestrator") {
        throw new Error(
          "guided_prevc_mcp_fence: contract freeze requires the mission Maestro",
        );
      }
      assertMissionArgument(args, ctx.missionId);
      return;
    case "workflow_prepare_execution":
      if (ctx.role !== "orchestrator") {
        throw new Error(
          "guided_prevc_mcp_fence: prepare_execution requires the mission Maestro",
        );
      }
      assertMissionArgument(args, ctx.missionId);
      if (!snapshot.hasContract) {
        throw new Error(
          "guided_prevc_mcp_fence: prepare_execution requires a frozen contract",
        );
      }
      return;
    case "mission_get":
    case "workflow_get":
      assertMissionArgument(args, ctx.missionId);
      return;
    case "mission_set_status":
      if (ctx.role !== "orchestrator") {
        throw new Error(
          "guided_prevc_mcp_fence: status transition requires the mission Maestro",
        );
      }
      assertMissionArgument(args, ctx.missionId);
      if (args.status !== "blocked" && args.status !== "failed") {
        throw new Error(
          "guided_prevc_mcp_fence: pre-execution status may only be blocked or failed",
        );
      }
      return;
    default: {
      const policy = effectPolicyForTool(canonical);
      if (policy === "read-only") {
        return;
      }
      throw new Error(
        `guided_prevc_mcp_fence: ${toolName} is unavailable before stage=execution`,
      );
    }
  }
}
