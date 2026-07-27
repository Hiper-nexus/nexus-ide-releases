import {
  EVIDENCE_ID_PATTERN,
  GIT_SHA_PATTERN,
  MISSION_DRIVER_WORKFLOW_STAGES,
  REAL_MISSION_ACCEPTANCE_CRITERIA,
  REAL_MISSION_CHILD_PHASES,
  REAL_MISSION_CTA,
  REAL_MISSION_EVIDENCE_SCHEMA_VERSION,
  REAL_MISSION_EXPECTED_CONTENT,
  REAL_MISSION_FAILURE_CODES,
  REAL_MISSION_FAILURE_REASONS,
  REAL_MISSION_PRODUCT_WIZARD_ACCEPTANCE_CRITERIA,
  REAL_MISSION_STATUSES,
  RELEASE_IDENTITY_PATTERN,
  SHA256_PATTERN,
  hasExactKeys,
  milestoneAttestationId,
  record,
  sha256,
} from "./e2e-real-mission-contract.mjs";

function assertNoSecretFields(value, pathParts = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertNoSecretFields(item, [...pathParts, String(index)]),
    );
    return;
  }
  const item = record(value);
  if (!item) return;
  for (const [key, child] of Object.entries(item)) {
    if (
      /^(?:prompt|rawOutput|outputText|token|secret|credential|password|apiKey)$/iu.test(
        key,
      )
    ) {
      throw new Error(
        `forbidden evidence field: ${[...pathParts, key].join(".")}`,
      );
    }
    assertNoSecretFields(child, [...pathParts, key]);
  }
}

export function assertRealMissionPassEvidence(raw) {
  assertNoSecretFields(raw);
  const evidence = record(raw);
  const expectedAcceptanceCriteria =
    evidence?.launchSurface === "product-wizard"
      ? REAL_MISSION_PRODUCT_WIZARD_ACCEPTANCE_CRITERIA
      : REAL_MISSION_ACCEPTANCE_CRITERIA;
  const mission = record(evidence?.mission);
  const missionInventory = record(evidence?.missionInventory);
  const observedMissionIds = Array.isArray(
    missionInventory?.observedMissionIds,
  )
    ? missionInventory.observedMissionIds
    : [];
  const finalMissionIds = Array.isArray(missionInventory?.finalMissionIds)
    ? missionInventory.finalMissionIds
    : [];
  const exactSingleMissionInventory =
    hasExactKeys(missionInventory, [
      "evidenceOrigin",
      "selectedMissionId",
      "observedMissionCount",
      "observedMissionIds",
      "finalMissionCount",
      "finalMissionIds",
      "exactSingleProductMission",
    ]) &&
    missionInventory?.evidenceOrigin ===
      "main-owned-mission-store-inventory" &&
    missionInventory?.selectedMissionId === mission?.id &&
    missionInventory?.observedMissionCount === 1 &&
    observedMissionIds.length === 1 &&
    new Set(observedMissionIds).size === 1 &&
    observedMissionIds[0] === mission?.id &&
    missionInventory?.finalMissionCount === 1 &&
    finalMissionIds.length === 1 &&
    new Set(finalMissionIds).size === 1 &&
    finalMissionIds[0] === mission?.id &&
    missionInventory?.exactSingleProductMission === true;
  const kickoff = record(evidence?.kickoff);
  const plan = record(evidence?.plan);
  const repository = record(evidence?.repository);
  const completion = record(evidence?.completion);
  const interaction = record(evidence?.interaction);
  const release = record(evidence?.release);
  const artifact = record(release?.artifact);
  const startedAt = Date.parse(release?.startedAt ?? "");
  const finishedAt = Date.parse(release?.finishedAt ?? "");
  const canonicalStartedAt =
    Number.isFinite(startedAt) &&
    new Date(startedAt).toISOString() === release?.startedAt;
  const canonicalFinishedAt =
    Number.isFinite(finishedAt) &&
    new Date(finishedAt).toISOString() === release?.finishedAt;
  const panes = Array.isArray(evidence?.panes) ? evidence.panes : [];
  const physicalPty = record(evidence?.physicalPty);
  const physicalPtyIds = Array.isArray(physicalPty?.ids)
    ? physicalPty.ids
    : [];
  const physicalPtyIdSet = new Set(physicalPtyIds);
  const paneSessionIds = panes
    .map((pane) => pane?.sessionId)
    .filter((sessionId) => typeof sessionId === "string");
  const exactPhysicalPtySet =
    hasExactKeys(physicalPty, ["count", "ids"]) &&
    Number.isInteger(physicalPty?.count) &&
    physicalPty.count >= 0 &&
    physicalPty.count <= 16 &&
    physicalPty.count === physicalPtyIds.length &&
    physicalPtyIdSet.size === physicalPtyIds.length &&
    physicalPtyIds.every((id) =>
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(id ?? ""),
    ) &&
    paneSessionIds.length === panes.length &&
    panes.length === physicalPty.count &&
    new Set(paneSessionIds).size === paneSessionIds.length &&
    paneSessionIds.every((sessionId) => physicalPtyIdSet.has(sessionId));
  const dispatches = Array.isArray(evidence?.dispatches)
    ? evidence.dispatches
    : [];
  const handoffs = Array.isArray(evidence?.handoffs) ? evidence.handoffs : [];
  const durableHandoffs = record(evidence?.durableHandoffs);
  const durableHandoffIds = Array.isArray(durableHandoffs?.ids)
    ? durableHandoffs.ids
    : [];
  const durableHandoffIdSet = new Set(durableHandoffIds);
  const proofHandoffIds = handoffs.map((handoff) => handoff?.id);
  const exactDurableHandoffSet =
    hasExactKeys(durableHandoffs, ["count", "ids"]) &&
    Number.isInteger(durableHandoffs?.count) &&
    durableHandoffs.count >= 0 &&
    durableHandoffs.count <= 64 &&
    durableHandoffs.count === durableHandoffIds.length &&
    durableHandoffIdSet.size === durableHandoffIds.length &&
    durableHandoffIds.every((id) =>
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(id ?? ""),
    ) &&
    handoffs.length === durableHandoffs.count &&
    new Set(proofHandoffIds).size === handoffs.length &&
    proofHandoffIds.every((id) => durableHandoffIdSet.has(id));
  const dependencyConsumptions = Array.isArray(
    evidence?.dependencyConsumptions,
  )
    ? evidence.dependencyConsumptions
    : [];
  const planTasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
  const expectedSha = sha256(REAL_MISSION_EXPECTED_CONTENT);
  const executorPlan = planTasks.find(
    (task) => task?.plannerId === "guided-execution",
  );
  const reviewerPlan = planTasks.find(
    (task) => task?.agentRef === "e2e-reviewer",
  );
  const qaPlan = planTasks.find(
    (task) =>
      task?.plannerId === "guided-quality-gate" &&
      task?.agentRef === "e2e-qa",
  );
  const executorDispatch = dispatches.find(
    (dispatch) => dispatch?.plannerId === "guided-execution",
  );
  const reviewerDispatch = dispatches.find(
    (dispatch) => dispatch?.agentRef === "e2e-reviewer",
  );
  const qaDispatch = dispatches.find(
    (dispatch) =>
      dispatch?.plannerId === "guided-quality-gate" &&
      dispatch?.agentRef === "e2e-qa",
  );
  const executorReceipt = record(executorDispatch?.integrationReceipt);
  const reviewerReceipt = record(reviewerDispatch?.integrationReceipt);
  const qaReceipt = record(qaDispatch?.integrationReceipt);
  const executorHandoff = handoffs.find(
    (handoff) => handoff?.id === executorDispatch?.handoffId,
  );
  const reviewerHandoff = handoffs.find(
    (handoff) => handoff?.id === reviewerDispatch?.handoffId,
  );
  const qaHandoff = handoffs.find(
    (handoff) => handoff?.id === qaDispatch?.handoffId,
  );
  const reviewerDependencyConsumption = record(
    dependencyConsumptions.find(
      (receipt) => receipt?.consumerTaskId === reviewerDispatch?.taskId,
    ),
  );
  const qaDependencyConsumption = record(
    dependencyConsumptions.find(
      (receipt) => receipt?.consumerTaskId === qaDispatch?.taskId,
    ),
  );
  const reviewerNoChangeMatch =
    typeof reviewerReceipt?.reference === "string"
      ? /^no-change:([a-f0-9]{40,64}):([a-f0-9]{64})$/u.exec(
          reviewerReceipt.reference,
        )
      : null;
  const qaNoChangeMatch =
    typeof qaReceipt?.reference === "string"
      ? /^no-change:([a-f0-9]{40,64}):([a-f0-9]{64})$/u.exec(
          qaReceipt.reference,
        )
      : null;
  const paneIsPhysical = (pane) =>
    typeof pane?.sessionId === "string" &&
    typeof pane?.readOnly === "boolean" &&
    typeof pane?.nativeReadOnly === "boolean" &&
    Number.isInteger(pane?.ptySpawnedAt) &&
    Number.isInteger(pane?.ptyDataAt) &&
    pane.ptySpawnedAt <= pane.ptyDataAt &&
    /^[a-f0-9]{64}$/u.test(pane?.ptyChunkSha256 ?? "");
  const dispatchIsPhysical = (dispatch) =>
    dispatch?.state === "completed" &&
    typeof dispatch?.routeReservationId === "string" &&
    Number.isInteger(dispatch?.routeConsumedAt) &&
    dispatch?.routeConsumerMatches === true &&
    typeof dispatch?.workerIncarnationId === "string" &&
    typeof dispatch?.sessionId === "string" &&
    typeof dispatch?.handoffId === "string" &&
    Number.isInteger(dispatch?.handoffAcceptedAt) &&
    Number.isInteger(dispatch?.completedAt);
  const exactAcceptedAttempt = (handoff) => {
    const attempts = Array.isArray(handoff?.deliveryAttempts)
      ? handoff.deliveryAttempts
      : [];
    const ids = new Set();
    const attemptNumbers = new Set();
    const structurallyValid =
      attempts.length > 0 &&
      attempts.length <= 32 &&
      attempts.every((attempt) => {
        const valid =
          /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(attempt?.id ?? "") &&
          attempt?.handoffId === handoff?.id &&
          attempt?.missionId === mission?.id &&
          attempt?.orchestratorSessionId === kickoff?.sessionId &&
          Number.isInteger(attempt?.attemptNo) &&
          attempt.attemptNo > 0 &&
          Number.isInteger(attempt?.startedAt) &&
          (attempt?.acceptDeadlineAt === null ||
            Number.isInteger(attempt?.acceptDeadlineAt)) &&
          (attempt?.acceptedAt === null ||
            Number.isInteger(attempt?.acceptedAt)) &&
          (attempt?.failedAt === null || Number.isInteger(attempt?.failedAt)) &&
          (attempt?.failureCode === null ||
            typeof attempt?.failureCode === "string") &&
          ["reserved", "pasted", "accepted", "failed"].includes(
            attempt?.state,
          ) &&
          !ids.has(attempt.id) &&
          !attemptNumbers.has(attempt.attemptNo);
        ids.add(attempt?.id);
        attemptNumbers.add(attempt?.attemptNo);
        return valid;
      });
    if (!structurallyValid) return null;
    const accepted = attempts.filter((attempt) => attempt?.state === "accepted");
    if (accepted.length !== 1) return null;
    const attempt = accepted[0];
    if (
      !Number.isInteger(attempt?.acceptedAt) ||
      !Number.isInteger(attempt?.acceptDeadlineAt) ||
      attempt?.failedAt !== null ||
      attempt?.failureCode !== null ||
      attempt.startedAt > attempt.acceptedAt ||
      attempt.acceptedAt > attempt.acceptDeadlineAt
    ) {
      return null;
    }
    return attempt;
  };
  const handoffMatches = (handoff, dispatch, fromAgent) => {
    const physical = record(handoff?.physicalReceipt);
    const audit = record(handoff?.auditIntent);
    const scope = record(audit?.scope);
    const accepted = exactAcceptedAttempt(handoff);
    return (
      physical !== null &&
      audit !== null &&
      scope !== null &&
      accepted !== null &&
      handoff?.authorityOrigin === "agent" &&
      /^[a-f0-9]{64}$/u.test(handoff?.summarySha256 ?? "") &&
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(
        physical?.receiptId ?? "",
      ) &&
      physical?.handoffId === handoff?.id &&
      physical?.receiptId === physical?.toolCallId &&
      physical?.toolName === "nexus_handoff_submit" &&
      physical?.source === "http-mcp" &&
      physical?.missionId === mission?.id &&
      physical?.sessionId === handoff?.sessionId &&
      physical?.workerIncarnationId === handoff?.workerIncarnationId &&
      /^[a-f0-9]{64}$/u.test(physical?.authoritySha256 ?? "") &&
      /^[a-f0-9]{40,64}$/u.test(physical?.worktreeHeadSha ?? "") &&
      physical?.worktreeHeadIntegrated === true &&
      Number.isInteger(physical?.issuedAt) &&
      audit?.invocationId === physical?.toolCallId &&
      audit?.toolName === "nexus_handoff_submit" &&
      audit?.source === physical?.source &&
      audit?.missionId === physical?.missionId &&
      audit?.sessionId === physical?.sessionId &&
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(
        scope?.projectId ?? "",
      ) &&
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(
        scope?.checkoutId ?? "",
      ) &&
      Number.isInteger(audit?.occurredAt) &&
      audit.occurredAt <= physical.issuedAt &&
      physical.issuedAt <= accepted.acceptedAt &&
      physical.issuedAt <= dispatch?.handoffAcceptedAt &&
      handoff?.fromAgent === fromAgent &&
      handoff?.sessionId === dispatch?.sessionId &&
      handoff?.workerIncarnationId === dispatch?.workerIncarnationId &&
      handoff?.status === "success" &&
      handoff?.delivered === true &&
      handoff?.deliveryState === "consumed" &&
      Number.isInteger(handoff?.consumedAt) &&
      accepted.acceptedAt <= handoff.consumedAt &&
      handoff?.consumedBySessionId === kickoff?.sessionId &&
      handoff?.consumedDeliveryAttemptId === accepted.id
    );
  };
  const executorAcceptedAttempt = exactAcceptedAttempt(executorHandoff);
  const reviewerAcceptedAttempt = exactAcceptedAttempt(reviewerHandoff);
  const qaAcceptedAttempt = exactAcceptedAttempt(qaHandoff);
  const completionDriver = record(completion?.driver);
  const completionWorkflow = record(completion?.workflow);
  const completionWorkflowBinding = record(completionWorkflow?.binding);
  const completionRoute = Array.isArray(completionWorkflow?.route)
    ? completionWorkflow.route
    : [];
  const completionMilestones = Array.isArray(completion?.milestones)
    ? completion.milestones
    : [];
  const completionStepReceipts = Array.isArray(completion?.stepReceipts)
    ? completion.stepReceipts
    : [];
  const completionEvidenceIds = completionMilestones.flatMap((milestone) =>
    Array.isArray(milestone?.evidenceIds) ? milestone.evidenceIds : [],
  );
  const completionScope = record(executorHandoff?.auditIntent?.scope);
  const canonicalCompletionBinding = {
    projectId: completionScope?.projectId,
    checkoutId: completionScope?.checkoutId,
    missionId: completion?.missionId,
    contextHash: completionWorkflowBinding?.contextHash,
    contractHash: completionWorkflowBinding?.contractHash,
    baseSha: completionWorkflowBinding?.baseSha,
    headSha: completionWorkflowBinding?.headSha,
    diffHash: completionWorkflowBinding?.diffHash,
  };
  const receiptMatchesMilestone = (receipt, milestone, index) => {
    const evidenceBinding = record(receipt?.evidenceBinding);
    const evidenceIds = Array.isArray(receipt?.evidenceIds)
      ? receipt.evidenceIds
      : [];
    const milestoneEvidenceIds = Array.isArray(milestone?.evidenceIds)
      ? milestone.evidenceIds
      : [];
    const previous = completionStepReceipts[index - 1];
    const fromIndex = completionRoute.indexOf(receipt?.fromStage);
    const toIndex =
      receipt?.toStage === "complete"
        ? completionRoute.length
        : completionRoute.indexOf(receipt?.toStage);
    const checkpoint =
      receipt?.fromStage === receipt?.toStage &&
      receipt?.workflowRevisionBefore === receipt?.workflowRevisionAfter;
    const transition =
      Number.isInteger(receipt?.workflowRevisionBefore) &&
      Number.isInteger(receipt?.workflowRevisionAfter) &&
      receipt.workflowRevisionBefore < receipt.workflowRevisionAfter &&
      toIndex > fromIndex;
    return (
      hasExactKeys(receipt, [
        "stepId",
        "fromStage",
        "toStage",
        "workflowRevisionBefore",
        "workflowRevisionAfter",
        "evidenceIds",
        "evidenceBinding",
        "completedAt",
      ]) &&
      hasExactKeys(evidenceBinding, [
        "missionId",
        "contextRevision",
        "contractHash",
        "baseSha",
        "headSha",
        "diffHash",
        "workflowRevision",
      ]) &&
      MISSION_DRIVER_WORKFLOW_STAGES.has(receipt?.fromStage) &&
      MISSION_DRIVER_WORKFLOW_STAGES.has(receipt?.toStage) &&
      receipt?.stepId === milestone?.stepId &&
      evidenceIds.length === milestoneEvidenceIds.length &&
      milestoneEvidenceIds.length === 1 &&
      evidenceIds.every(
        (id, evidenceIndex) =>
          EVIDENCE_ID_PATTERN.test(id ?? "") &&
          id === milestoneEvidenceIds[evidenceIndex],
      ) &&
      milestoneEvidenceIds[0] ===
        milestoneAttestationId(
          completion?.missionId,
          milestone?.stepId,
          canonicalCompletionBinding,
        ) &&
      evidenceBinding?.missionId === completion?.missionId &&
      evidenceBinding?.contextRevision ===
        completionWorkflowBinding?.contextHash &&
      evidenceBinding?.contractHash ===
        completionWorkflowBinding?.contractHash &&
      evidenceBinding?.baseSha === completionWorkflowBinding?.baseSha &&
      GIT_SHA_PATTERN.test(evidenceBinding?.headSha ?? "") &&
      SHA256_PATTERN.test(evidenceBinding?.diffHash ?? "") &&
      Number.isInteger(evidenceBinding?.workflowRevision) &&
      evidenceBinding.workflowRevision > 0 &&
      evidenceBinding.workflowRevision === receipt?.workflowRevisionBefore &&
      receipt?.fromStage.startsWith("validation") &&
      evidenceBinding?.headSha === completionWorkflowBinding?.headSha &&
      evidenceBinding?.diffHash === completionWorkflowBinding?.diffHash &&
      (checkpoint || transition) &&
      (!previous ||
        previous?.workflowRevisionAfter === receipt?.workflowRevisionBefore) &&
      Number.isInteger(receipt?.workflowRevisionBefore) &&
      receipt.workflowRevisionBefore > 0 &&
      Number.isInteger(receipt?.workflowRevisionAfter) &&
      receipt.workflowRevisionAfter > 0 &&
      receipt.workflowRevisionAfter <= (completionWorkflow?.revision ?? -1) &&
      Number.isInteger(receipt?.completedAt) &&
      receipt.completedAt >= 0 &&
      receipt.completedAt <= (completion?.completedAt ?? -1)
    );
  };
  const exactMissionDriverCompletion =
    hasExactKeys(completion, [
      "origin",
      "missionId",
      "intentVersion",
      "orchestratorSessionId",
      "planHash",
      "taskCount",
      "completedAt",
      "driver",
      "workflow",
      "milestones",
      "stepReceipts",
    ]) &&
    hasExactKeys(completionDriver, [
      "revision",
      "runStartedAt",
      "attemptCount",
      "lastAttemptAt",
      "lastSuccessAt",
      "lastActionKind",
      "lastOutcome",
      "updatedAt",
    ]) &&
    hasExactKeys(completionWorkflow, [
      "stage",
      "revision",
      "route",
      "binding",
    ]) &&
    hasExactKeys(completionWorkflowBinding, [
      "missionId",
      "contractHash",
      "contextHash",
      "baseSha",
      "headSha",
      "diffHash",
    ]) &&
    completion?.origin === "mission-driver-prevc" &&
    completion?.missionId === mission?.id &&
    completion?.intentVersion === mission?.intentVersion &&
    completion?.orchestratorSessionId === kickoff?.sessionId &&
    completion?.planHash === plan?.planHash &&
    completion?.taskCount === planTasks.length &&
    Number.isInteger(completion?.completedAt) &&
    completion.completedAt >= 0 &&
    completionWorkflow?.stage === "complete" &&
    Number.isInteger(completionWorkflow?.revision) &&
    completionWorkflow.revision > 0 &&
    completionWorkflowBinding?.missionId === completion?.missionId &&
    SHA256_PATTERN.test(completionWorkflowBinding?.contractHash ?? "") &&
    SHA256_PATTERN.test(completionWorkflowBinding?.contextHash ?? "") &&
    GIT_SHA_PATTERN.test(completionWorkflowBinding?.baseSha ?? "") &&
    GIT_SHA_PATTERN.test(completionWorkflowBinding?.headSha ?? "") &&
    SHA256_PATTERN.test(completionWorkflowBinding?.diffHash ?? "") &&
    completionWorkflowBinding?.headSha === repository?.finalHeadSha &&
    completionRoute.length >= 2 &&
    completionRoute.length <= 8 &&
    completionRoute.every((stage) =>
      MISSION_DRIVER_WORKFLOW_STAGES.has(stage),
    ) &&
    completionRoute.includes("execution") &&
    !completionRoute.includes("complete") &&
    new Set(completionRoute).size === completionRoute.length &&
    completionMilestones.length === expectedAcceptanceCriteria.length &&
    completionMilestones.every(
      (milestone, index) =>
        hasExactKeys(milestone, [
          "stepId",
          "label",
          "status",
          "evidenceIds",
        ]) &&
        milestone?.stepId === `step-${index + 1}` &&
        milestone?.label === expectedAcceptanceCriteria[index] &&
        milestone?.status === "done" &&
        Array.isArray(milestone?.evidenceIds) &&
        milestone.evidenceIds.length === 1 &&
        /^milestone:[a-f0-9]{64}$/u.test(milestone.evidenceIds[0] ?? ""),
    ) &&
    completionStepReceipts.length === completionMilestones.length &&
    completionStepReceipts.every((receipt, index) =>
      receiptMatchesMilestone(receipt, completionMilestones[index], index),
    ) &&
    completionStepReceipts.at(-1)?.toStage === "complete" &&
    completionStepReceipts.at(-1)?.workflowRevisionAfter ===
      completionWorkflow?.revision &&
    new Set(completionEvidenceIds).size === completionEvidenceIds.length &&
    Number.isInteger(completionDriver?.revision) &&
    completionDriver.revision > 0 &&
    Number.isInteger(completionDriver?.runStartedAt) &&
    completionDriver.runStartedAt >= 0 &&
    Number.isInteger(completionDriver?.attemptCount) &&
    completionDriver.attemptCount >= completionMilestones.length + 1 &&
    Number.isInteger(completionDriver?.lastAttemptAt) &&
    Number.isInteger(completionDriver?.lastSuccessAt) &&
    completionDriver.lastAttemptAt >= 0 &&
    completionDriver.lastSuccessAt >= 0 &&
    completionDriver?.lastActionKind === "complete" &&
    completionDriver?.lastOutcome === "success" &&
    Number.isInteger(completionDriver?.updatedAt) &&
    completionDriver.updatedAt >= 0 &&
    completionDriver.runStartedAt <= completionDriver.lastAttemptAt &&
    completionDriver.lastAttemptAt <= completionDriver.lastSuccessAt &&
    completionDriver.lastSuccessAt === completionDriver.updatedAt &&
    completionDriver.lastSuccessAt === completion.completedAt;
  const valid =
    evidence?.schemaVersion === REAL_MISSION_EVIDENCE_SCHEMA_VERSION &&
    evidence?.status === "pass" &&
    evidence?.failure === null &&
    evidence?.expectedContentSha256 === expectedSha &&
    evidence?.coverageTier === "guided-delivery-core" &&
    evidence?.planOrigin === "production-guided-planner" &&
    evidence?.prevcOrigin === "e2e-fixture" &&
    evidence?.reviewOrigin === "production-physical-worker" &&
    evidence?.qaOrigin === "production-physical-worker" &&
    ((evidence?.launchSurface === "private-runner" &&
      evidence?.wizardCoverage === "not-covered") ||
      (evidence?.launchSurface === "product-wizard" &&
        evidence?.wizardCoverage === "main-owned-product-sequence")) &&
    hasExactKeys(interaction, [
      "evidenceOrigin",
      "nativeDialogCount",
      "missionApprovalDialogCount",
      "missionApprovalAcceptedCount",
      "codexMcpPromptCount",
    ]) &&
    interaction?.evidenceOrigin === "main-owned-instrumentation" &&
    interaction?.nativeDialogCount === 1 &&
    interaction?.missionApprovalDialogCount === 1 &&
    interaction?.missionApprovalAcceptedCount === 1 &&
    interaction?.codexMcpPromptCount === 0 &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(release?.appVersion ?? "") &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      release?.runId ?? "",
    ) &&
    canonicalStartedAt &&
    canonicalFinishedAt &&
    finishedAt > startedAt &&
    /^[a-f0-9]{40}$/u.test(release?.commitSha ?? "") &&
    /^[a-f0-9]{64}$/u.test(artifact?.sha256 ?? "") &&
    RELEASE_IDENTITY_PATTERN.test(artifact?.identity ?? "") &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(mission?.id ?? "") &&
    exactSingleMissionInventory &&
    mission?.status === "done" &&
    mission?.intentState === "done" &&
    mission?.intentVersion === 1 &&
    mission?.squadSourceId === "agentic-nexus-real-mission-e2e" &&
    SHA256_PATTERN.test(mission?.squadSourceRevisionHash ?? "") &&
    SHA256_PATTERN.test(mission?.squadRevisionHash ?? "") &&
    ((evidence?.launchSurface === "private-runner" &&
      mission?.squadId === "agentic-nexus-real-mission-e2e" &&
      mission?.squadSourceRevisionHash === mission?.squadRevisionHash) ||
      (evidence?.launchSurface === "product-wizard" &&
        /^agentic-runtime-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          mission?.squadId ?? "",
        ) &&
        mission?.squadSourceRevisionHash !== mission?.squadRevisionHash)) &&
    Number.isInteger(mission?.approvedAt) &&
    Number.isInteger(mission?.dispatchedAt) &&
    mission.approvedAt >= 0 &&
    mission.dispatchedAt >= 0 &&
    mission.approvedAt <= mission.dispatchedAt &&
    typeof kickoff?.sessionId === "string" &&
    Number.isInteger(kickoff?.idleAt) &&
    Number.isInteger(kickoff?.busyAt) &&
    Number.isInteger(kickoff?.ptyDataAt) &&
    mission.dispatchedAt <= kickoff.idleAt &&
    kickoff.idleAt <= kickoff.busyAt &&
    kickoff.idleAt <= kickoff.ptyDataAt &&
    /^[a-f0-9]{64}$/u.test(kickoff?.ptyChunkSha256 ?? "") &&
    plan?.version === 1 &&
    plan?.squadId === mission?.squadId &&
    /^[a-f0-9]{64}$/u.test(plan?.planHash ?? "") &&
    /^[a-f0-9]{64}$/u.test(plan?.rosterHash ?? "") &&
    planTasks.length === 3 &&
    executorPlan?.agentRef === "e2e-executor" &&
    executorPlan?.agentCategory === "executor" &&
    executorPlan?.executionMode === "isolated_worktree" &&
    Array.isArray(executorPlan?.dependsOn) &&
    executorPlan.dependsOn.length === 0 &&
    reviewerPlan?.agentRef === "e2e-reviewer" &&
    reviewerPlan?.agentCategory === "reviewer" &&
    reviewerPlan?.executionMode === "read_only" &&
    /^guided-review-[A-Za-z0-9._:-]{1,220}$/u.test(
      reviewerPlan?.plannerId ?? "",
    ) &&
    Array.isArray(reviewerPlan?.dependsOn) &&
    reviewerPlan.dependsOn.length === 1 &&
    reviewerPlan.dependsOn[0] === executorPlan?.taskId &&
    qaPlan?.agentRef === "e2e-qa" &&
    qaPlan?.agentCategory === "reviewer" &&
    qaPlan?.executionMode === "read_only" &&
    Array.isArray(qaPlan?.dependsOn) &&
    qaPlan.dependsOn.length === 1 &&
    qaPlan.dependsOn[0] === reviewerPlan?.taskId &&
    panes.length === 4 &&
    exactPhysicalPtySet &&
    panes.every(paneIsPhysical) &&
    new Set(panes.map((pane) => pane?.sessionId)).size === 4 &&
    panes.filter(
      (pane) =>
        pane?.role === "orchestrator" &&
        pane?.adapterId === "codex" &&
        pane?.agentRef === "e2e-orchestrator" &&
        pane?.readOnly === false &&
        pane?.nativeReadOnly === true,
    ).length === 1 &&
    panes.filter(
      (pane) =>
        pane?.role === "worker" &&
        pane?.adapterId === "codex" &&
        pane?.agentRef === "e2e-executor" &&
        pane?.readOnly === false &&
        pane?.nativeReadOnly === false &&
        typeof pane?.workerIncarnationId === "string",
    ).length === 1 &&
    panes.filter(
      (pane) =>
        pane?.role === "worker" &&
        pane?.adapterId === "codex" &&
        pane?.agentRef === "e2e-reviewer" &&
        pane?.readOnly === true &&
        pane?.nativeReadOnly === true &&
        typeof pane?.workerIncarnationId === "string",
    ).length === 1 &&
    panes.filter(
      (pane) =>
        pane?.role === "worker" &&
        pane?.adapterId === "codex" &&
        pane?.agentRef === "e2e-qa" &&
        pane?.readOnly === true &&
        pane?.nativeReadOnly === true &&
        typeof pane?.workerIncarnationId === "string",
    ).length === 1 &&
    dispatches.length === 3 &&
    executorDispatch?.taskId === executorPlan?.taskId &&
    executorDispatch?.agentRef === "e2e-executor" &&
    executorDispatch?.agentCategory === "executor" &&
    executorDispatch?.executionMode === "isolated_worktree" &&
    Array.isArray(executorDispatch?.dependsOn) &&
    executorDispatch.dependsOn.length === 0 &&
    dispatchIsPhysical(executorDispatch) &&
    executorDispatch?.completedAt === executorReceipt?.completedAt &&
    executorReceipt?.kind === "worktree_integrated" &&
    /^[a-f0-9]{40,64}$/u.test(executorReceipt?.reference ?? "") &&
    Number.isInteger(executorReceipt?.completedAt) &&
    reviewerDispatch?.taskId === reviewerPlan?.taskId &&
    reviewerDispatch?.agentRef === "e2e-reviewer" &&
    reviewerDispatch?.agentCategory === "reviewer" &&
    reviewerDispatch?.executionMode === "read_only" &&
    Array.isArray(reviewerDispatch?.dependsOn) &&
    reviewerDispatch.dependsOn.length === 1 &&
    reviewerDispatch.dependsOn[0] === executorDispatch?.taskId &&
    dispatchIsPhysical(reviewerDispatch) &&
    reviewerDispatch?.completedAt === reviewerReceipt?.completedAt &&
    reviewerReceipt?.kind === "worktree_validated_no_change" &&
    reviewerNoChangeMatch !== null &&
    Number.isInteger(reviewerReceipt?.completedAt) &&
    Array.isArray(reviewerReceipt?.evidenceIds) &&
    reviewerReceipt.evidenceIds.length > 0 &&
    qaDispatch?.taskId === qaPlan?.taskId &&
    qaDispatch?.agentRef === "e2e-qa" &&
    qaDispatch?.agentCategory === "reviewer" &&
    qaDispatch?.executionMode === "read_only" &&
    Array.isArray(qaDispatch?.dependsOn) &&
    qaDispatch.dependsOn.length === 1 &&
    qaDispatch.dependsOn[0] === reviewerDispatch?.taskId &&
    dispatchIsPhysical(qaDispatch) &&
    qaDispatch?.completedAt === qaReceipt?.completedAt &&
    qaReceipt?.kind === "worktree_validated_no_change" &&
    qaNoChangeMatch !== null &&
    Number.isInteger(qaReceipt?.completedAt) &&
    Array.isArray(qaReceipt?.evidenceIds) &&
    qaReceipt.evidenceIds.length > 0 &&
    handoffs.length === 3 &&
    exactDurableHandoffSet &&
    handoffMatches(executorHandoff, executorDispatch, "E2E Executor") &&
    handoffMatches(reviewerHandoff, reviewerDispatch, "E2E Revisor") &&
    handoffMatches(qaHandoff, qaDispatch, "E2E QA") &&
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
    executorHandoff?.auditIntent?.scope?.projectId ===
      reviewerHandoff?.auditIntent?.scope?.projectId &&
    reviewerHandoff?.auditIntent?.scope?.projectId ===
      qaHandoff?.auditIntent?.scope?.projectId &&
    executorHandoff?.auditIntent?.scope?.checkoutId ===
      reviewerHandoff?.auditIntent?.scope?.checkoutId &&
    reviewerHandoff?.auditIntent?.scope?.checkoutId ===
      qaHandoff?.auditIntent?.scope?.checkoutId &&
    dependencyConsumptions.length === 2 &&
    reviewerDependencyConsumption?.missionId === mission?.id &&
    reviewerDependencyConsumption?.consumerTaskId === reviewerDispatch?.taskId &&
    reviewerDependencyConsumption?.dependencyTaskId === executorDispatch?.taskId &&
    reviewerDependencyConsumption?.handoffId === executorHandoff?.id &&
    reviewerDependencyConsumption?.consumerSessionId ===
      reviewerDispatch?.sessionId &&
    reviewerDependencyConsumption?.consumerWorkerIncarnationId ===
      reviewerDispatch?.workerIncarnationId &&
    /^[a-f0-9]{64}$/u.test(
      reviewerDependencyConsumption?.promptSha256 ?? "",
    ) &&
    reviewerDependencyConsumption?.handoffSummarySha256 ===
      executorHandoff?.summarySha256 &&
    Number.isInteger(reviewerDependencyConsumption?.consumedAt) &&
    executorDispatch?.completedAt <=
      reviewerDependencyConsumption?.consumedAt &&
    reviewerDependencyConsumption?.consumedAt <=
      reviewerDispatch?.handoffAcceptedAt &&
    reviewerDependencyConsumption?.consumedAt <=
      reviewerHandoff?.auditIntent?.occurredAt &&
    qaDependencyConsumption?.missionId === mission?.id &&
    qaDependencyConsumption?.consumerTaskId === qaDispatch?.taskId &&
    qaDependencyConsumption?.dependencyTaskId === reviewerDispatch?.taskId &&
    qaDependencyConsumption?.handoffId === reviewerHandoff?.id &&
    qaDependencyConsumption?.consumerSessionId === qaDispatch?.sessionId &&
    qaDependencyConsumption?.consumerWorkerIncarnationId ===
      qaDispatch?.workerIncarnationId &&
    /^[a-f0-9]{64}$/u.test(qaDependencyConsumption?.promptSha256 ?? "") &&
    qaDependencyConsumption?.handoffSummarySha256 ===
      reviewerHandoff?.summarySha256 &&
    Number.isInteger(qaDependencyConsumption?.consumedAt) &&
    reviewerDispatch?.completedAt <= qaDependencyConsumption?.consumedAt &&
    qaDependencyConsumption?.consumedAt <= qaDispatch?.handoffAcceptedAt &&
    qaDependencyConsumption?.consumedAt <=
      qaHandoff?.auditIntent?.occurredAt &&
    exactMissionDriverCompletion &&
    qaDispatch?.completedAt <= completion?.completedAt &&
    executorHandoff?.consumedAt <= completion?.completedAt &&
    reviewerHandoff?.consumedAt <= completion?.completedAt &&
    qaHandoff?.consumedAt <= completion?.completedAt &&
    /^[a-f0-9]{40,64}$/u.test(repository?.initialHeadSha ?? "") &&
    /^[a-f0-9]{40,64}$/u.test(repository?.finalHeadSha ?? "") &&
    repository?.resultSha256 === expectedSha &&
    Number.isInteger(repository?.commitCount) &&
    // Fast-forward (2) or real merge commit (3); exactSingleCommit already
    // proved HEAD descends from the initial commit with only resultado.txt
    // changed, so both integration shapes are the same logical result.
    (repository.commitCount === 2 || repository.commitCount === 3) &&
    repository?.clean === true &&
    repository?.changedBeforeWorker === false &&
    repository?.exactSingleCommit === true &&
    repository?.initialHeadSha !== repository?.finalHeadSha &&
    executorHandoff?.physicalReceipt?.worktreeHeadSha !==
      repository?.initialHeadSha &&
    executorReceipt?.reference === repository?.finalHeadSha &&
    reviewerHandoff?.physicalReceipt?.worktreeHeadSha ===
      repository?.finalHeadSha &&
    qaHandoff?.physicalReceipt?.worktreeHeadSha ===
      repository?.finalHeadSha &&
    reviewerNoChangeMatch?.[1] === repository?.finalHeadSha &&
    qaNoChangeMatch?.[1] === repository?.finalHeadSha &&
    panes.find((pane) => pane?.agentRef === "e2e-orchestrator")?.sessionId ===
      kickoff?.sessionId &&
    panes.find((pane) => pane?.agentRef === "e2e-executor")?.sessionId ===
      executorDispatch?.sessionId &&
    panes.find((pane) => pane?.agentRef === "e2e-executor")
      ?.workerIncarnationId === executorDispatch?.workerIncarnationId &&
    panes.find((pane) => pane?.agentRef === "e2e-reviewer")?.sessionId ===
      reviewerDispatch?.sessionId &&
    panes.find((pane) => pane?.agentRef === "e2e-reviewer")
      ?.workerIncarnationId === reviewerDispatch?.workerIncarnationId &&
    panes.find((pane) => pane?.agentRef === "e2e-qa")?.sessionId ===
      qaDispatch?.sessionId &&
    panes.find((pane) => pane?.agentRef === "e2e-qa")
      ?.workerIncarnationId === qaDispatch?.workerIncarnationId &&
    executorReceipt?.completedAt <= reviewerDispatch?.routeConsumedAt &&
    executorReceipt?.completedAt <=
      reviewerHandoff?.physicalReceipt?.issuedAt &&
    reviewerHandoff?.physicalReceipt?.issuedAt <=
      reviewerReceipt?.completedAt &&
    reviewerReceipt?.completedAt <= qaDispatch?.routeConsumedAt &&
    reviewerReceipt?.completedAt <= qaHandoff?.physicalReceipt?.issuedAt &&
    qaHandoff?.physicalReceipt?.issuedAt <= qaReceipt?.completedAt &&
    executorAcceptedAttempt?.acceptedAt <= executorHandoff?.consumedAt &&
    reviewerAcceptedAttempt?.acceptedAt <= reviewerHandoff?.consumedAt &&
    qaAcceptedAttempt?.acceptedAt <= qaHandoff?.consumedAt;
  if (!valid) {
    throw new Error("real mission evidence is incomplete or not a PASS");
  }
  return evidence;
}

/**
 * Release eligibility is intentionally stricter than the private engine
 * diagnostic. A private runner can prove the scheduler and physical CLIs, but
 * it can never be relabeled as proof that the operator crossed the real
 * MissionWizard.
 */
export function assertRealMissionReleaseEvidence(raw) {
  const evidence = assertRealMissionPassEvidence(raw);
  if (
    evidence?.launchSurface !== "product-wizard" ||
    evidence?.wizardCoverage !== "main-owned-product-sequence" ||
    record(evidence?.missionInventory)?.exactSingleProductMission !== true
  ) {
    throw new Error(
      "real mission release evidence requires product-wizard physical coverage; private-runner evidence is diagnostic-only",
    );
  }
  return evidence;
}

export function safeChildExitSummary(result) {
  const exitCode =
    Number.isInteger(result?.code) && result.code >= 0 && result.code <= 255
      ? result.code
      : 1;
  const phase = REAL_MISSION_CHILD_PHASES.has(result?.phase)
    ? result.phase
    : "spawned";
  return { exitCode, phase };
}

function safeEvidenceCount(value) {
  return Number.isInteger(value) && value >= 0 && value <= 64 ? value : 0;
}

function safeRealMissionFailureParts(raw, result) {
  const evidence = record(raw);
  const failure = record(evidence?.failure);
  const snapshot = record(failure?.snapshot);
  const child = safeChildExitSummary(result);
  const failureCode = REAL_MISSION_FAILURE_CODES.has(failure?.code)
    ? failure.code
    : "invalid-evidence";
  const failureReason = REAL_MISSION_FAILURE_REASONS.has(failure?.reason)
    ? failure.reason
    : null;
  const missionStatus = REAL_MISSION_STATUSES.has(snapshot?.missionStatus)
    ? snapshot.missionStatus
    : null;
  return {
    child,
    failure: {
      code: failureCode,
      reason: failureReason,
      cta: REAL_MISSION_CTA,
      snapshot: {
        missionStatus,
        paneCount: safeEvidenceCount(snapshot?.paneCount),
        dispatchCount: safeEvidenceCount(snapshot?.dispatchCount),
        handoffCount: safeEvidenceCount(snapshot?.handoffCount),
      },
    },
  };
}

export function safeRealMissionFailureReceipt(
  raw,
  result,
  releaseBinding,
  launchSurface = "private-runner",
) {
  const { child, failure } = safeRealMissionFailureParts(raw, result);
  const release = record(releaseBinding);
  const artifact = record(release?.artifact);
  return {
    schemaVersion: REAL_MISSION_EVIDENCE_SCHEMA_VERSION,
    status: "fail",
    coverageTier: "guided-delivery-core",
    planOrigin: "production-guided-planner",
    prevcOrigin: "e2e-fixture",
    reviewOrigin: "production-physical-worker",
    qaOrigin: "production-physical-worker",
    launchSurface:
      launchSurface === "product-wizard"
        ? "product-wizard"
        : "private-runner",
    wizardCoverage: "not-covered",
    interaction: {
      evidenceOrigin: "main-owned-instrumentation",
      nativeDialogCount: 0,
      missionApprovalDialogCount: 0,
      missionApprovalAcceptedCount: 0,
      codexMcpPromptCount: 0,
    },
    release: {
      appVersion: /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(
        release?.appVersion ?? "",
      )
        ? release.appVersion
        : null,
      commitSha: /^[a-f0-9]{40}$/u.test(release?.commitSha ?? "")
        ? release.commitSha
        : null,
      artifact: {
        sha256: /^[a-f0-9]{64}$/u.test(artifact?.sha256 ?? "")
          ? artifact.sha256
          : null,
        identity: RELEASE_IDENTITY_PATTERN.test(artifact?.identity ?? "")
          ? artifact.identity
          : null,
      },
    },
    child,
    failure,
  };
}

export function safeRealMissionFailureSummary(raw, result) {
  const { child, failure } = safeRealMissionFailureParts(raw, result);
  const snapshot = failure.snapshot;
  return (
    `[real-mission] FAIL code=${failure.code} ` +
    `reason=${failure.reason ?? "none"} ` +
    `exit=${child.exitCode} phase=${child.phase} ` +
    `status=${snapshot.missionStatus ?? "none"} ` +
    `panes=${snapshot.paneCount} ` +
    `dispatches=${snapshot.dispatchCount} ` +
    `handoffs=${snapshot.handoffCount} ` +
    `CTA: ${REAL_MISSION_CTA}`
  );
}
