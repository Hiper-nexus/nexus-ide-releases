import { z } from "zod";

import { isMissionRuntimeSquadId } from "./orch-types";
import {
  REAL_MISSION_E2E_ACCEPTANCE_CRITERIA,
  REAL_MISSION_E2E_EVIDENCE_SCHEMA_VERSION,
  REAL_MISSION_E2E_EXECUTOR_ID,
  REAL_MISSION_E2E_EXECUTOR_NAME,
  REAL_MISSION_E2E_ORCHESTRATOR_ID,
  REAL_MISSION_E2E_QA_ID,
  REAL_MISSION_E2E_QA_NAME,
  REAL_MISSION_E2E_REVIEWER_ID,
  REAL_MISSION_E2E_REVIEWER_NAME,
  REAL_MISSION_E2E_SQUAD_ID,
} from "./real-mission-e2e-contract";
import {
  dependencyConsumptionProofSchema,
  dispatchProofSchema,
  durableHandoffSetSchema,
  failureSchema,
  handoffProofSchema,
  kickoffProofSchema,
  missionDriverCompletionProofSchema,
  missionInventoryProofSchema,
  missionProofSchema,
  paneProofSchema,
  physicalPtySetSchema,
  planProofSchema,
  repositoryProofSchema,
} from "./real-mission-e2e-proof-schemas";
import {
  coverageTierSchema,
  idSchema,
  launchSurfaceSchema,
  planOriginSchema,
  prevcOriginSchema,
  qaOriginSchema,
  reviewOriginSchema,
  sha256Schema,
  timestampSchema,
  wizardCoverageSchema,
} from "./real-mission-e2e-wire";

export const realMissionE2EEvidenceSchema = z
  .object({
    schemaVersion: z.literal(REAL_MISSION_E2E_EVIDENCE_SCHEMA_VERSION),
    runId: idSchema,
    appVersion: z.string().min(1).max(64),
    startedAt: timestampSchema,
    finishedAt: timestampSchema,
    status: z.enum(["pass", "fail"]),
    workspaceSha256: sha256Schema,
    expectedContentSha256: sha256Schema,
    coverageTier: coverageTierSchema,
    planOrigin: planOriginSchema,
    prevcOrigin: prevcOriginSchema,
    reviewOrigin: reviewOriginSchema,
    qaOrigin: qaOriginSchema,
    launchSurface: launchSurfaceSchema,
    wizardCoverage: wizardCoverageSchema,
    interaction: z
      .object({
        evidenceOrigin: z.literal("main-owned-instrumentation"),
        nativeDialogCount: z.number().int().nonnegative().max(64),
        missionApprovalDialogCount: z.number().int().nonnegative().max(64),
        missionApprovalAcceptedCount: z.number().int().nonnegative().max(64),
        codexMcpPromptCount: z.number().int().nonnegative().max(64),
      })
      .strict(),
    mission: missionProofSchema.nullable(),
    missionInventory: missionInventoryProofSchema,
    kickoff: kickoffProofSchema,
    plan: planProofSchema,
    panes: z.array(paneProofSchema).max(16),
    physicalPty: physicalPtySetSchema,
    dispatches: z.array(dispatchProofSchema).max(64),
    handoffs: z.array(handoffProofSchema).max(64),
    durableHandoffs: durableHandoffSetSchema,
    dependencyConsumptions: z
      .array(dependencyConsumptionProofSchema)
      .max(64),
    completion: missionDriverCompletionProofSchema,
    repository: repositoryProofSchema,
    failure: failureSchema.nullable(),
  })
  .strict()
  .superRefine((evidence, context) => {
    if (evidence.finishedAt < evidence.startedAt) {
      context.addIssue({
        code: "custom",
        path: ["finishedAt"],
        message: "finishedAt precedes startedAt",
      });
    }
    if (
      evidence.launchSurface === "private-runner" &&
      evidence.wizardCoverage !== "not-covered"
    ) {
      context.addIssue({
        code: "custom",
        path: ["wizardCoverage"],
        message: "private runner cannot carry product-wizard authority",
      });
    }
    // This packaged harness exercises the production Guided Planner, four
    // physical PTYs and all three worker handoffs. PREVC remains disposable,
    // so this still cannot claim PRD → design "full-flow".
    if (evidence.coverageTier === "full-flow") {
      context.addIssue({
        code: "custom",
        path: ["coverageTier"],
        message: "the real-mission harness cannot claim full-flow coverage",
      });
    }
    if (evidence.status === "fail") {
      if (!evidence.failure) {
        context.addIssue({
          code: "custom",
          path: ["failure"],
          message: "failed evidence requires a closed failure receipt",
        });
      }
      return;
    }
    const orchestrators = evidence.panes.filter(
      (pane) =>
        pane.role === "orchestrator" &&
        pane.agentRef === REAL_MISSION_E2E_ORCHESTRATOR_ID &&
        pane.adapterId === "codex",
    );
    const executors = evidence.panes.filter(
      (pane) =>
        pane.role === "worker" &&
        pane.agentRef === REAL_MISSION_E2E_EXECUTOR_ID &&
        pane.adapterId === "codex",
    );
    const reviewers = evidence.panes.filter(
      (pane) =>
        pane.role === "worker" &&
        pane.agentRef === REAL_MISSION_E2E_REVIEWER_ID &&
        pane.adapterId === "codex",
    );
    const qualityAssurers = evidence.panes.filter(
      (pane) =>
        pane.role === "worker" &&
        pane.agentRef === REAL_MISSION_E2E_QA_ID &&
        pane.adapterId === "codex",
    );
    const executorPlan = evidence.plan?.tasks.find(
      (task) => task.plannerId === "guided-execution",
    );
    const reviewerPlan = evidence.plan?.tasks.find(
      (task) => task.agentRef === REAL_MISSION_E2E_REVIEWER_ID,
    );
    const qaPlan = evidence.plan?.tasks.find(
      (task) =>
        task.plannerId === "guided-quality-gate" &&
        task.agentRef === REAL_MISSION_E2E_QA_ID,
    );
    const executorDispatch = evidence.dispatches.find(
      (dispatch) => dispatch.plannerId === "guided-execution",
    );
    const reviewerDispatch = evidence.dispatches.find(
      (dispatch) => dispatch.agentRef === REAL_MISSION_E2E_REVIEWER_ID,
    );
    const qaDispatch = evidence.dispatches.find(
      (dispatch) =>
        dispatch.plannerId === "guided-quality-gate" &&
        dispatch.agentRef === REAL_MISSION_E2E_QA_ID,
    );
    const executorHandoff = evidence.handoffs.find(
      (handoff) => handoff.id === executorDispatch?.handoffId,
    );
    const reviewerHandoff = evidence.handoffs.find(
      (handoff) => handoff.id === reviewerDispatch?.handoffId,
    );
    const qaHandoff = evidence.handoffs.find(
      (handoff) => handoff.id === qaDispatch?.handoffId,
    );
    const executorReceipt =
      executorDispatch?.integrationReceipt?.kind === "worktree_integrated"
        ? executorDispatch.integrationReceipt
        : null;
    const reviewerReceipt =
      reviewerDispatch?.integrationReceipt?.kind ===
      "worktree_validated_no_change"
        ? reviewerDispatch.integrationReceipt
        : null;
    const qaReceipt =
      qaDispatch?.integrationReceipt?.kind ===
      "worktree_validated_no_change"
        ? qaDispatch.integrationReceipt
        : null;
    const reviewerNoChangeReference = reviewerReceipt
      ? /^no-change:([a-f0-9]{40,64}):([a-f0-9]{64})$/u.exec(
          reviewerReceipt.reference,
        )
      : null;
    const qaNoChangeReference = qaReceipt
      ? /^no-change:([a-f0-9]{40,64}):([a-f0-9]{64})$/u.exec(
          qaReceipt.reference,
        )
      : null;
    const reviewerDependencyConsumption =
      evidence.dependencyConsumptions.find(
        (receipt) => receipt.consumerTaskId === reviewerDispatch?.taskId,
      );
    const qaDependencyConsumption = evidence.dependencyConsumptions.find(
      (receipt) => receipt.consumerTaskId === qaDispatch?.taskId,
    );
    const completion = evidence.completion;
    const exactMissionInventory =
      evidence.missionInventory.evidenceOrigin ===
        "main-owned-mission-store-inventory" &&
      evidence.missionInventory.selectedMissionId === evidence.mission?.id &&
      evidence.missionInventory.observedMissionCount === 1 &&
      evidence.missionInventory.observedMissionIds.length === 1 &&
      evidence.missionInventory.observedMissionIds[0] === evidence.mission?.id &&
      evidence.missionInventory.finalMissionCount === 1 &&
      evidence.missionInventory.finalMissionIds.length === 1 &&
      evidence.missionInventory.finalMissionIds[0] === evidence.mission?.id &&
      evidence.missionInventory.exactSingleProductMission;
    const completionMilestones = completion?.milestones ?? [];
    const completionReceipts = completion?.stepReceipts ?? [];
    const completionRoute = completion?.workflow.route ?? [];
    const completionEvidenceIds = completionMilestones.flatMap(
      (milestone) => milestone.evidenceIds,
    );
    const receiptMatchesMilestone = (
      receipt: (typeof completionReceipts)[number],
      milestone: (typeof completionMilestones)[number],
      index: number,
    ): boolean => {
      const previous = completionReceipts[index - 1];
      const fromIndex = completionRoute.indexOf(receipt.fromStage);
      const toIndex =
        receipt.toStage === "complete"
          ? completionRoute.length
          : completionRoute.indexOf(receipt.toStage);
      const checkpoint =
        receipt.fromStage === receipt.toStage &&
        receipt.workflowRevisionBefore === receipt.workflowRevisionAfter;
      const transition =
        receipt.workflowRevisionBefore < receipt.workflowRevisionAfter &&
        toIndex > fromIndex;
      return (
        receipt.stepId === milestone.stepId &&
        receipt.evidenceIds.length === milestone.evidenceIds.length &&
        receipt.evidenceIds.every(
          (id, evidenceIndex) => id === milestone.evidenceIds[evidenceIndex],
        ) &&
        receipt.evidenceBinding.missionId === completion?.missionId &&
        receipt.evidenceBinding.contextRevision ===
          completion?.workflow.binding.contextHash &&
        receipt.evidenceBinding.contractHash ===
          completion?.workflow.binding.contractHash &&
        receipt.evidenceBinding.baseSha ===
          completion?.workflow.binding.baseSha &&
        receipt.evidenceBinding.workflowRevision ===
          receipt.workflowRevisionBefore &&
        receipt.fromStage.startsWith("validation") &&
        receipt.evidenceBinding.headSha ===
          completion?.workflow.binding.headSha &&
        receipt.evidenceBinding.diffHash ===
          completion?.workflow.binding.diffHash &&
        (checkpoint || transition) &&
        (!previous ||
          previous.workflowRevisionAfter ===
            receipt.workflowRevisionBefore) &&
        receipt.workflowRevisionAfter <=
          (completion?.workflow.revision ?? -1) &&
        receipt.completedAt <= (completion?.completedAt ?? -1)
      );
    };
    const exactMissionDriverCompletion =
      completion?.origin === "mission-driver-prevc" &&
      completion.missionId === evidence.mission?.id &&
      completion.intentVersion === evidence.mission?.intentVersion &&
      completion.orchestratorSessionId === evidence.kickoff.sessionId &&
      completion.planHash === evidence.plan?.planHash &&
      completion.taskCount === evidence.plan?.tasks.length &&
      completion.workflow.stage === "complete" &&
      completion.workflow.binding.missionId === completion.missionId &&
      completion.workflow.binding.headSha ===
        evidence.repository.finalHeadSha &&
      completionRoute.includes("execution") &&
      !completionRoute.includes("complete") &&
      new Set(completionRoute).size === completionRoute.length &&
      completionMilestones.length ===
        REAL_MISSION_E2E_ACCEPTANCE_CRITERIA.length &&
      completionMilestones.every(
        (milestone, index) =>
          milestone.stepId === `step-${index + 1}` &&
          milestone.label === REAL_MISSION_E2E_ACCEPTANCE_CRITERIA[index] &&
          milestone.status === "done" &&
          milestone.evidenceIds.length === 1 &&
          /^milestone:[a-f0-9]{64}$/u.test(milestone.evidenceIds[0]!),
      ) &&
      completionReceipts.length === completionMilestones.length &&
      completionReceipts.every((receipt, index) =>
        receiptMatchesMilestone(
          receipt,
          completionMilestones[index]!,
          index,
        ),
      ) &&
      completionReceipts.at(-1)?.toStage === "complete" &&
      completionReceipts.at(-1)?.workflowRevisionAfter ===
        completion.workflow.revision &&
      new Set(completionEvidenceIds).size === completionEvidenceIds.length &&
      completion.driver.attemptCount >= completionMilestones.length + 1 &&
      completion.driver.runStartedAt <= completion.driver.lastAttemptAt &&
      completion.driver.lastAttemptAt <= completion.driver.lastSuccessAt &&
      completion.driver.lastSuccessAt === completion.driver.updatedAt &&
      completion.driver.lastSuccessAt === completion.completedAt;
    const physicalPaneIsComplete = (
      pane: (typeof evidence.panes)[number],
    ): boolean =>
      pane.sessionId !== null &&
      pane.readOnly !== null &&
      pane.nativeReadOnly !== null &&
      pane.ptySpawnedAt !== null &&
      pane.ptyDataAt !== null &&
      pane.ptyChunkSha256 !== null &&
      pane.ptySpawnedAt <= pane.ptyDataAt;
    const physicalPtyIds = new Set(evidence.physicalPty.ids);
    const paneSessionIds = evidence.panes.flatMap((pane) =>
      pane.sessionId === null ? [] : [pane.sessionId],
    );
    const exactPhysicalPtySet =
      evidence.physicalPty.count === evidence.physicalPty.ids.length &&
      physicalPtyIds.size === evidence.physicalPty.ids.length &&
      paneSessionIds.length === evidence.panes.length &&
      evidence.panes.length === evidence.physicalPty.count &&
      new Set(paneSessionIds).size === paneSessionIds.length &&
      paneSessionIds.every((sessionId) => physicalPtyIds.has(sessionId));
    const durableHandoffIds = new Set(evidence.durableHandoffs.ids);
    const proofHandoffIds = new Set(
      evidence.handoffs.map((handoff) => handoff.id),
    );
    const exactDurableHandoffSet =
      evidence.durableHandoffs.count ===
        evidence.durableHandoffs.ids.length &&
      durableHandoffIds.size === evidence.durableHandoffs.ids.length &&
      evidence.handoffs.length === evidence.durableHandoffs.count &&
      proofHandoffIds.size === evidence.handoffs.length &&
      evidence.handoffs.every((handoff) =>
        durableHandoffIds.has(handoff.id),
      );
    const completedDispatchIsPhysical = (
      dispatch: (typeof evidence.dispatches)[number] | undefined,
    ): boolean =>
      dispatch?.state === "completed" &&
      dispatch.routeReservationId !== null &&
      dispatch.routeConsumedAt !== null &&
      dispatch.routeConsumerMatches &&
      dispatch.workerIncarnationId !== null &&
      dispatch.sessionId !== null &&
      dispatch.handoffId !== null &&
      dispatch.handoffAcceptedAt !== null &&
      dispatch.completedAt !== null;
    const exactAcceptedAttempt = (
      handoff: (typeof evidence.handoffs)[number],
    ) => {
      const accepted = handoff.deliveryAttempts.filter(
        (attempt) => attempt.state === "accepted",
      );
      if (accepted.length !== 1) return null;
      const attempt = accepted[0]!;
      const identities = new Set<string>();
      const attemptNumbers = new Set<number>();
      if (
        handoff.deliveryAttempts.some((candidate) => {
          if (
            identities.has(candidate.id) ||
            attemptNumbers.has(candidate.attemptNo)
          ) {
            return true;
          }
          identities.add(candidate.id);
          attemptNumbers.add(candidate.attemptNo);
          return (
            candidate.handoffId !== handoff.id ||
            candidate.missionId !== evidence.mission?.id ||
            candidate.orchestratorSessionId !== evidence.kickoff.sessionId
          );
        })
      ) {
        return null;
      }
      return attempt;
    };
    const handoffMatchesDispatch = (
      handoff: (typeof evidence.handoffs)[number] | undefined,
      dispatch: (typeof evidence.dispatches)[number] | undefined,
      fromAgent: string,
    ): boolean => {
      if (!handoff || !dispatch) return false;
      const physical = handoff.physicalReceipt;
      const audit = handoff.auditIntent;
      const accepted = exactAcceptedAttempt(handoff);
      return Boolean(
        physical &&
          audit &&
          accepted &&
          handoff.authorityOrigin === "agent" &&
          physical.handoffId === handoff.id &&
          physical.receiptId === physical.toolCallId &&
          physical.missionId === evidence.mission?.id &&
          physical.sessionId === handoff.sessionId &&
          physical.workerIncarnationId === handoff.workerIncarnationId &&
          physical.worktreeHeadSha !== null &&
          physical.worktreeHeadIntegrated &&
          audit.invocationId === physical.toolCallId &&
          audit.toolName === physical.toolName &&
          audit.source === physical.source &&
          audit.missionId === physical.missionId &&
          audit.sessionId === physical.sessionId &&
          audit.occurredAt <= physical.issuedAt &&
          physical.issuedAt <= (dispatch.handoffAcceptedAt ?? -1) &&
          physical.issuedAt <= (accepted.acceptedAt ?? -1) &&
          handoff.fromAgent === fromAgent &&
          handoff.sessionId === dispatch.sessionId &&
          handoff.workerIncarnationId === dispatch.workerIncarnationId &&
          handoff.status === "success" &&
          handoff.delivered &&
          handoff.deliveryState === "consumed" &&
          accepted.acceptedAt !== null &&
          accepted.failedAt === null &&
          accepted.failureCode === null &&
          accepted.acceptDeadlineAt !== null &&
          accepted.startedAt <= accepted.acceptedAt &&
          accepted.acceptedAt <= accepted.acceptDeadlineAt &&
          handoff.consumedAt !== null &&
          accepted.acceptedAt <= handoff.consumedAt &&
          handoff.consumedBySessionId === evidence.kickoff.sessionId &&
          handoff.consumedDeliveryAttemptId === accepted.id,
      );
    };
    const pass =
      evidence.failure === null &&
      evidence.coverageTier === "guided-delivery-core" &&
      evidence.planOrigin === "production-guided-planner" &&
      evidence.prevcOrigin === "e2e-fixture" &&
      evidence.reviewOrigin === "production-physical-worker" &&
      evidence.qaOrigin === "production-physical-worker" &&
      ((evidence.launchSurface === "private-runner" &&
        evidence.wizardCoverage === "not-covered") ||
        (evidence.launchSurface === "product-wizard" &&
          evidence.wizardCoverage === "main-owned-product-sequence")) &&
      evidence.interaction.evidenceOrigin ===
        "main-owned-instrumentation" &&
      evidence.interaction.nativeDialogCount === 1 &&
      evidence.interaction.missionApprovalDialogCount === 1 &&
      evidence.interaction.missionApprovalAcceptedCount === 1 &&
      evidence.interaction.codexMcpPromptCount === 0 &&
      evidence.mission?.status === "done" &&
      exactMissionInventory &&
      evidence.mission.intentState === "done" &&
      evidence.mission.intentVersion === 1 &&
      evidence.plan?.squadId === evidence.mission.squadId &&
      ((evidence.launchSurface === "private-runner" &&
        evidence.mission.squadId === REAL_MISSION_E2E_SQUAD_ID &&
        evidence.mission.squadSourceRevisionHash ===
          evidence.mission.squadRevisionHash) ||
        (evidence.launchSurface === "product-wizard" &&
          isMissionRuntimeSquadId(evidence.mission.squadId) &&
          evidence.mission.squadSourceRevisionHash !==
            evidence.mission.squadRevisionHash)) &&
      evidence.mission.approvedAt !== null &&
      evidence.mission.dispatchedAt !== null &&
      evidence.mission.approvedAt <= evidence.mission.dispatchedAt &&
      evidence.mission.dispatchedAt <= (evidence.kickoff.idleAt ?? -1) &&
      evidence.kickoff.sessionId !== null &&
      evidence.kickoff.idleAt !== null &&
      evidence.kickoff.busyAt !== null &&
      evidence.kickoff.ptyDataAt !== null &&
      evidence.kickoff.ptyChunkSha256 !== null &&
      evidence.kickoff.idleAt <= evidence.kickoff.busyAt &&
      evidence.kickoff.idleAt <= evidence.kickoff.ptyDataAt &&
      evidence.plan !== null &&
      evidence.plan.tasks.length === 3 &&
      executorPlan?.agentRef === REAL_MISSION_E2E_EXECUTOR_ID &&
      executorPlan.agentCategory === "executor" &&
      executorPlan.executionMode === "isolated_worktree" &&
      executorPlan.dependsOn.length === 0 &&
      reviewerPlan?.agentRef === REAL_MISSION_E2E_REVIEWER_ID &&
      reviewerPlan.agentCategory === "reviewer" &&
      reviewerPlan.executionMode === "read_only" &&
      reviewerPlan.plannerId.startsWith("guided-review-") &&
      reviewerPlan.dependsOn.length === 1 &&
      reviewerPlan.dependsOn[0] === executorPlan.taskId &&
      qaPlan?.agentRef === REAL_MISSION_E2E_QA_ID &&
      qaPlan.agentCategory === "reviewer" &&
      qaPlan.executionMode === "read_only" &&
      qaPlan.dependsOn.length === 1 &&
      qaPlan.dependsOn[0] === reviewerPlan.taskId &&
      evidence.panes.length === 4 &&
      orchestrators.length === 1 &&
      executors.length === 1 &&
      reviewers.length === 1 &&
      qualityAssurers.length === 1 &&
      evidence.panes.every(physicalPaneIsComplete) &&
      exactPhysicalPtySet &&
      orchestrators[0]?.readOnly === false &&
      orchestrators[0]?.nativeReadOnly === true &&
      executors[0]?.readOnly === false &&
      executors[0]?.nativeReadOnly === false &&
      reviewers[0]?.readOnly === true &&
      reviewers[0]?.nativeReadOnly === true &&
      qualityAssurers[0]?.readOnly === true &&
      qualityAssurers[0]?.nativeReadOnly === true &&
      executors[0]?.workerIncarnationId !== null &&
      reviewers[0]?.workerIncarnationId !== null &&
      qualityAssurers[0]?.workerIncarnationId !== null &&
      new Set(evidence.panes.map((pane) => pane.sessionId)).size === 4 &&
      evidence.dispatches.length === 3 &&
      executorDispatch?.taskId === executorPlan.taskId &&
      executorDispatch.agentRef === REAL_MISSION_E2E_EXECUTOR_ID &&
      executorDispatch.agentCategory === "executor" &&
      executorDispatch.executionMode === "isolated_worktree" &&
      executorDispatch.dependsOn.length === 0 &&
      completedDispatchIsPhysical(executorDispatch) &&
      executorReceipt !== null &&
      reviewerDispatch?.taskId === reviewerPlan.taskId &&
      reviewerDispatch.agentRef === REAL_MISSION_E2E_REVIEWER_ID &&
      reviewerDispatch.agentCategory === "reviewer" &&
      reviewerDispatch.executionMode === "read_only" &&
      reviewerDispatch.dependsOn.length === 1 &&
      reviewerDispatch.dependsOn[0] === executorDispatch.taskId &&
      completedDispatchIsPhysical(reviewerDispatch) &&
      reviewerReceipt !== null &&
      reviewerNoChangeReference !== null &&
      qaDispatch?.taskId === qaPlan.taskId &&
      qaDispatch.agentRef === REAL_MISSION_E2E_QA_ID &&
      qaDispatch.agentCategory === "reviewer" &&
      qaDispatch.executionMode === "read_only" &&
      qaDispatch.dependsOn.length === 1 &&
      qaDispatch.dependsOn[0] === reviewerDispatch.taskId &&
      completedDispatchIsPhysical(qaDispatch) &&
      qaReceipt !== null &&
      qaNoChangeReference !== null &&
      evidence.handoffs.length === 3 &&
      exactDurableHandoffSet &&
      handoffMatchesDispatch(
        executorHandoff,
        executorDispatch,
        REAL_MISSION_E2E_EXECUTOR_NAME,
      ) &&
      handoffMatchesDispatch(
        reviewerHandoff,
        reviewerDispatch,
        REAL_MISSION_E2E_REVIEWER_NAME,
      ) &&
      handoffMatchesDispatch(
        qaHandoff,
        qaDispatch,
        REAL_MISSION_E2E_QA_NAME,
      ) &&
      new Set(
        [executorHandoff, reviewerHandoff, qaHandoff].map(
          (handoff) => handoff?.id,
        ),
      ).size === 3 &&
      new Set(
        [executorHandoff, reviewerHandoff, qaHandoff].map(
          (handoff) => handoff?.sessionId,
        ),
      ).size === 3 &&
      new Set(
        [executorHandoff, reviewerHandoff, qaHandoff].map(
          (handoff) => handoff?.workerIncarnationId,
        ),
      ).size === 3 &&
      new Set(
        [executorHandoff, reviewerHandoff, qaHandoff].map(
          (handoff) => handoff?.physicalReceipt?.receiptId,
        ),
      ).size === 3 &&
      new Set(
        [executorHandoff, reviewerHandoff, qaHandoff].map(
          (handoff) => handoff?.physicalReceipt?.toolCallId,
        ),
      ).size === 3 &&
      executorHandoff?.auditIntent?.scope.projectId ===
        reviewerHandoff?.auditIntent?.scope.projectId &&
      reviewerHandoff?.auditIntent?.scope.projectId ===
        qaHandoff?.auditIntent?.scope.projectId &&
      executorHandoff?.auditIntent?.scope.checkoutId ===
        reviewerHandoff?.auditIntent?.scope.checkoutId &&
      reviewerHandoff?.auditIntent?.scope.checkoutId ===
        qaHandoff?.auditIntent?.scope.checkoutId &&
      evidence.dependencyConsumptions.length === 2 &&
      reviewerDependencyConsumption?.missionId === evidence.mission?.id &&
      reviewerDependencyConsumption.consumerTaskId === reviewerDispatch.taskId &&
      reviewerDependencyConsumption.dependencyTaskId === executorDispatch.taskId &&
      reviewerDependencyConsumption.handoffId === executorHandoff?.id &&
      reviewerDependencyConsumption.consumerSessionId ===
        reviewerDispatch.sessionId &&
      reviewerDependencyConsumption.consumerWorkerIncarnationId ===
        reviewerDispatch.workerIncarnationId &&
      reviewerDependencyConsumption.handoffSummarySha256 ===
        executorHandoff?.summarySha256 &&
      (executorDispatch.completedAt ?? Number.MAX_SAFE_INTEGER) <=
        reviewerDependencyConsumption.consumedAt &&
      reviewerDependencyConsumption.consumedAt <=
        (reviewerDispatch.handoffAcceptedAt ?? -1) &&
      reviewerDependencyConsumption.consumedAt <=
        (reviewerHandoff?.auditIntent?.occurredAt ?? -1) &&
      qaDependencyConsumption?.missionId === evidence.mission?.id &&
      qaDependencyConsumption.consumerTaskId === qaDispatch.taskId &&
      qaDependencyConsumption.dependencyTaskId === reviewerDispatch.taskId &&
      qaDependencyConsumption.handoffId === reviewerHandoff?.id &&
      qaDependencyConsumption.consumerSessionId === qaDispatch.sessionId &&
      qaDependencyConsumption.consumerWorkerIncarnationId ===
        qaDispatch.workerIncarnationId &&
      qaDependencyConsumption.handoffSummarySha256 ===
        reviewerHandoff?.summarySha256 &&
      (reviewerDispatch.completedAt ?? Number.MAX_SAFE_INTEGER) <=
        qaDependencyConsumption.consumedAt &&
      qaDependencyConsumption.consumedAt <=
        (qaDispatch.handoffAcceptedAt ?? -1) &&
      qaDependencyConsumption.consumedAt <=
        (qaHandoff?.auditIntent?.occurredAt ?? -1) &&
      exactMissionDriverCompletion &&
      (qaDispatch.completedAt ?? Number.MAX_SAFE_INTEGER) <=
        completion.completedAt &&
      (executorHandoff?.consumedAt ?? Number.MAX_SAFE_INTEGER) <=
        completion.completedAt &&
      (reviewerHandoff?.consumedAt ?? Number.MAX_SAFE_INTEGER) <=
        completion.completedAt &&
      (qaHandoff?.consumedAt ?? Number.MAX_SAFE_INTEGER) <=
        completion.completedAt &&
      evidence.repository.finalHeadSha !== null &&
      evidence.repository.initialHeadSha !== null &&
      evidence.repository.resultSha256 === evidence.expectedContentSha256 &&
      // Fast-forward (2) or real merge commit (3); exactSingleCommit already
      // proved HEAD descends from the initial commit with only resultado.txt
      // changed, so both integration shapes are the same logical result.
      (evidence.repository.commitCount === 2 ||
        evidence.repository.commitCount === 3) &&
      evidence.repository.clean &&
      !evidence.repository.changedBeforeWorker &&
      evidence.repository.exactSingleCommit &&
      evidence.repository.initialHeadSha !== evidence.repository.finalHeadSha &&
      executorHandoff?.physicalReceipt?.worktreeHeadSha !==
        evidence.repository.initialHeadSha &&
      executorReceipt.reference === evidence.repository.finalHeadSha &&
      reviewerHandoff?.physicalReceipt?.worktreeHeadSha ===
        evidence.repository.finalHeadSha &&
      qaHandoff?.physicalReceipt?.worktreeHeadSha ===
        evidence.repository.finalHeadSha &&
      reviewerNoChangeReference[1] === evidence.repository.finalHeadSha &&
      qaNoChangeReference[1] === evidence.repository.finalHeadSha &&
      executors[0]?.sessionId === executorDispatch.sessionId &&
      executors[0]?.workerIncarnationId ===
        executorDispatch.workerIncarnationId &&
      reviewers[0]?.sessionId === reviewerDispatch.sessionId &&
      reviewers[0]?.workerIncarnationId ===
        reviewerDispatch.workerIncarnationId &&
      qualityAssurers[0]?.sessionId === qaDispatch.sessionId &&
      qualityAssurers[0]?.workerIncarnationId ===
        qaDispatch.workerIncarnationId &&
      executorReceipt.completedAt <= (reviewerDispatch.routeConsumedAt ?? -1) &&
      executorReceipt.completedAt <=
        (reviewerHandoff?.physicalReceipt?.issuedAt ?? -1) &&
      executorReceipt.completedAt === executorDispatch.completedAt &&
      reviewerReceipt.completedAt === reviewerDispatch.completedAt &&
      (reviewerHandoff?.physicalReceipt?.issuedAt ??
        Number.MAX_SAFE_INTEGER) <= reviewerReceipt.completedAt &&
      reviewerReceipt.completedAt <= (qaDispatch.routeConsumedAt ?? -1) &&
      reviewerReceipt.completedAt <=
        (qaHandoff?.physicalReceipt?.issuedAt ?? -1) &&
      qaReceipt.completedAt === qaDispatch.completedAt &&
      (qaHandoff?.physicalReceipt?.issuedAt ??
        Number.MAX_SAFE_INTEGER) <= qaReceipt.completedAt &&
      orchestrators[0]?.sessionId === evidence.kickoff.sessionId;
    if (!pass) {
      context.addIssue({
        code: "custom",
        message: "PASS evidence is missing one or more real-mission invariants",
      });
    }
  });

export type RealMissionE2EEvidence = z.infer<
  typeof realMissionE2EEvidenceSchema
>;

export function parseRealMissionE2EEvidence(
  raw: unknown,
): RealMissionE2EEvidence {
  return realMissionE2EEvidenceSchema.parse(raw);
}

/**
 * The private runner is an engine diagnostic, never wizard evidence. Release
 * eligibility is deliberately a second, fail-closed decision so a valid
 * physical worker graph cannot be mislabeled as proof of the product UI.
 */
export function parseReleaseEligibleRealMissionE2EEvidence(
  raw: unknown,
): RealMissionE2EEvidence {
  const evidence = parseRealMissionE2EEvidence(raw);
  if (
    evidence.status !== "pass" ||
    evidence.launchSurface !== "product-wizard" ||
    evidence.wizardCoverage !== "main-owned-product-sequence" ||
    !evidence.missionInventory.exactSingleProductMission ||
    evidence.interaction.nativeDialogCount !== 1 ||
    evidence.interaction.missionApprovalDialogCount !== 1 ||
    evidence.interaction.missionApprovalAcceptedCount !== 1 ||
    evidence.interaction.codexMcpPromptCount !== 0
  ) {
    throw new Error(
      "real mission release evidence requires the physical product wizard, exactly one accepted native approval dialog and zero Codex MCP prompts",
    );
  }
  return evidence;
}
