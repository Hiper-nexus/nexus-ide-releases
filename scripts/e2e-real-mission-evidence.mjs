import {
  EVIDENCE_ID_PATTERN,
  GIT_SHA_PATTERN,
  MISSION_DRIVER_WORKFLOW_STAGES,
  REAL_MISSION_ADVISORS,
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
  productWizardReceiptChainSha256,
  realMissionAcceptanceCriteria,
  realMissionExpectedTaskChain,
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
  const exactTopLevelEnvelope = hasExactKeys(evidence, [
    "schemaVersion",
    "runId",
    "appVersion",
    "startedAt",
    "finishedAt",
    "status",
    "workspaceSha256",
    "expectedContentSha256",
    "coverageTier",
    "planOrigin",
    "prevcOrigin",
    "reviewOrigin",
    "qaOrigin",
    "launchSurface",
    "wizardCoverage",
    "wizardReceipt",
    "runtimeAttestation",
    "interaction",
    "mission",
    "missionInventory",
    "kickoff",
    "plan",
    "panes",
    "physicalPty",
    "dispatches",
    "handoffs",
    "durableHandoffs",
    "dependencyConsumptions",
    "participation",
    "completion",
    "repository",
    "failure",
    "release",
  ]);
  const mission = record(evidence?.mission);
  const exactMission =
    hasExactKeys(mission, [
      "id",
      "status",
      "intentState",
      "intentVersion",
      "squadId",
      "squadSourceId",
      "squadSourceRevisionHash",
      "squadRevisionHash",
      "approvedAt",
      "dispatchedAt",
    ]);
  const wizardReceipt = record(evidence?.wizardReceipt);
  const runtimeAttestation = record(evidence?.runtimeAttestation);
  const exactRuntimeAttestation =
    hasExactKeys(runtimeAttestation, [
      "version",
      "algorithm",
      "challengeSha256",
      "bindingSha256",
      "evidenceSha256",
      "macSha256",
    ]) &&
    runtimeAttestation?.version === 1 &&
    runtimeAttestation?.algorithm === "hmac-sha256" &&
    SHA256_PATTERN.test(runtimeAttestation?.challengeSha256 ?? "") &&
    SHA256_PATTERN.test(runtimeAttestation?.bindingSha256 ?? "") &&
    SHA256_PATTERN.test(runtimeAttestation?.evidenceSha256 ?? "") &&
    SHA256_PATTERN.test(runtimeAttestation?.macSha256 ?? "");
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
  const exactProductWizardReceipt =
    hasExactKeys(wizardReceipt, [
      "origin",
      "missionId",
      "workspaceSha256",
      "sourceSquadRevisionHash",
      "squadRevisionHash",
      "submittedContractSha256",
      "approvedContractSha256",
      "armedAt",
      "intentSubmittedAt",
      "nativeDialogOpenedAt",
      "nativeDialogAcceptedAt",
      "approvalReturnedAt",
      "chainSha256",
    ]) &&
    wizardReceipt?.origin === "main-owned-product-wizard-causal-chain" &&
    wizardReceipt?.missionId === mission?.id &&
    SHA256_PATTERN.test(evidence?.workspaceSha256 ?? "") &&
    wizardReceipt?.workspaceSha256 === evidence?.workspaceSha256 &&
    wizardReceipt?.sourceSquadRevisionHash ===
      mission?.squadSourceRevisionHash &&
    wizardReceipt?.squadRevisionHash === mission?.squadRevisionHash &&
    SHA256_PATTERN.test(wizardReceipt?.submittedContractSha256 ?? "") &&
    SHA256_PATTERN.test(wizardReceipt?.approvedContractSha256 ?? "") &&
    wizardReceipt?.submittedContractSha256 !==
      wizardReceipt?.approvedContractSha256 &&
    Number.isInteger(wizardReceipt?.armedAt) &&
    wizardReceipt.armedAt >= 0 &&
    Number.isInteger(wizardReceipt?.intentSubmittedAt) &&
    wizardReceipt?.nativeDialogOpenedAt === null &&
    wizardReceipt?.nativeDialogAcceptedAt === null &&
    Number.isInteger(wizardReceipt?.approvalReturnedAt) &&
    wizardReceipt.armedAt <= wizardReceipt.intentSubmittedAt &&
    wizardReceipt.intentSubmittedAt <= wizardReceipt.approvalReturnedAt &&
    wizardReceipt.intentSubmittedAt <= (mission?.approvedAt ?? -1) &&
    (mission?.approvedAt ?? -1) <= wizardReceipt.approvalReturnedAt &&
    (mission?.dispatchedAt ?? -1) <= wizardReceipt.approvalReturnedAt &&
    Number.isInteger(evidence?.finishedAt) &&
    wizardReceipt.approvalReturnedAt <= evidence.finishedAt &&
    SHA256_PATTERN.test(wizardReceipt?.chainSha256 ?? "") &&
    wizardReceipt?.chainSha256 ===
      productWizardReceiptChainSha256(wizardReceipt);
  const exactWizardSurfaceEvidence =
    (evidence?.launchSurface === "private-runner" &&
      evidence?.wizardCoverage === "not-covered" &&
      Object.hasOwn(evidence, "wizardReceipt") &&
      evidence.wizardReceipt === null) ||
    (evidence?.launchSurface === "product-wizard" &&
      evidence?.wizardCoverage === "main-owned-product-sequence" &&
      exactProductWizardReceipt);
  const kickoff = record(evidence?.kickoff);
  const plan = record(evidence?.plan);
  const repository = record(evidence?.repository);
  const completion = record(evidence?.completion);
  const interaction = record(evidence?.interaction);
  const release = record(evidence?.release);
  const artifact = record(release?.artifact);
  const exactReleaseBinding =
    hasExactKeys(release, [
      "appVersion",
      "runId",
      "startedAt",
      "finishedAt",
      "commitSha",
      "artifact",
    ]) &&
    hasExactKeys(artifact, ["sha256", "identity"]);
  const exactRepository =
    hasExactKeys(repository, [
      "initialHeadSha",
      "finalHeadSha",
      "resultSha256",
      "commitCount",
      "clean",
      "changedBeforeWorker",
      "exactSingleCommit",
    ]);
  const startedAt = Date.parse(release?.startedAt ?? "");
  const finishedAt = Date.parse(release?.finishedAt ?? "");
  const canonicalStartedAt =
    Number.isFinite(startedAt) &&
    new Date(startedAt).toISOString() === release?.startedAt;
  const canonicalFinishedAt =
    Number.isFinite(finishedAt) &&
    new Date(finishedAt).toISOString() === release?.finishedAt;
  const panes = Array.isArray(evidence?.panes) ? evidence.panes : [];
  // A lista de critérios da variante deriva do orquestrador físico provado
  // nos panes: Claude carrega o critério extra de variante; codex, a base.
  const orchestratorPanes = panes.filter(
    (pane) =>
      record(pane)?.role === "orchestrator" &&
      record(pane)?.agentRef === "e2e-orchestrator",
  );
  const orchestratorCli =
    orchestratorPanes.length === 1 &&
    orchestratorPanes[0]?.adapterId === "claude"
      ? "claude"
      : "codex";
  const participation = Array.isArray(evidence?.participation)
    ? evidence.participation
    : [];
  // Advisor re-roteado permanece na cadeia: a task selada dele existe e foi
  // entregue pelo substituto (diretiva durável); só a participação pessoal é
  // dispensada — mesma regra do validador in-app.
  const presentAdvisorClis = participation
    .filter((row) => {
      const skipped = record(row)?.skipped;
      return skipped === null || skipped === "provider-rerouted";
    })
    .map((row) => row.cli);
  const expectedAcceptanceCriteria =
    evidence?.launchSurface === "product-wizard"
      ? REAL_MISSION_PRODUCT_WIZARD_ACCEPTANCE_CRITERIA
      : realMissionAcceptanceCriteria(orchestratorCli, presentAdvisorClis);
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
  const exactPlan =
    hasExactKeys(plan, [
      "version",
      "squadId",
      "planHash",
      "rosterHash",
      "tasks",
    ]) &&
    planTasks.every((task) =>
      hasExactKeys(task, [
        "plannerId",
        "taskId",
        "agentRef",
        "agentCategory",
        "executionMode",
        "dependsOn",
      ]),
    );
  const exactKickoff = hasExactKeys(kickoff, [
    "sessionId",
    "idleAt",
    "busyAt",
    "ptyDataAt",
    "ptyChunkSha256",
  ]);
  const expectedSha = sha256(REAL_MISSION_EXPECTED_CONTENT);
  // O DAG selado deriva do roster realmente admitido: advisors e executor são
  // raízes; a cadeia codex segue executor → revisor → QA.
  const chain = realMissionExpectedTaskChain(presentAdvisorClis);
  const chainPlans = chain.map((member) =>
    planTasks.find(
      (task) =>
        task?.plannerId === member.plannerId &&
        task?.agentRef === member.agentRef,
    ),
  );
  const chainDispatches = chain.map((member) =>
    dispatches.find(
      (dispatch) =>
        dispatch?.plannerId === member.plannerId &&
        (dispatch?.agentRef === member.agentRef ||
          record(dispatch?.providerReroute)?.fromAgentRef ===
            member.agentRef),
    ),
  );
  const chainReceipts = chainDispatches.map((dispatch) =>
    record(dispatch?.integrationReceipt),
  );
  const chainIndexByPlannerId = new Map(
    chain.map((member, index) => [member.plannerId, index]),
  );
  const expectedDependencyTaskIds = (member) => {
    const ids = member.dependsOnPlannerIds.map((plannerId) => {
      const dependencyIndex = chainIndexByPlannerId.get(plannerId);
      return dependencyIndex === undefined
        ? undefined
        : chainPlans[dependencyIndex]?.taskId;
    });
    return ids.every((taskId) => typeof taskId === "string") ? ids : null;
  };
  const exactDependencies = (actual, member) => {
    const expected = expectedDependencyTaskIds(member);
    return (
      expected !== null &&
      Array.isArray(actual) &&
      actual.length === expected.length &&
      actual.every((taskId, index) => taskId === expected[index])
    );
  };
  const chainHandoffs = chainDispatches.map((dispatch) =>
    handoffs.find((handoff) => handoff?.id === dispatch?.handoffId),
  );
  const chainNoChangeMatches = chainReceipts.map((receipt) =>
    receipt?.kind === "worktree_validated_no_change" &&
    typeof receipt?.reference === "string"
      ? /^no-change:([a-f0-9]{40,64}):([a-f0-9]{64})$/u.exec(receipt.reference)
      : null,
  );
  const isNonExecutionValidationReceipt = (receipt) =>
    (receipt?.kind === "worktree_validated_no_change" &&
      typeof receipt?.reference === "string" &&
      /^no-change:[a-f0-9]{40,64}:[a-f0-9]{64}$/u.test(receipt.reference) &&
      Array.isArray(receipt.evidenceIds) &&
      receipt.evidenceIds.length > 0) ||
    (receipt?.kind === "read_only_validated" &&
      typeof receipt?.reference === "string" &&
      /^[a-f0-9]{64}$/u.test(receipt.reference) &&
      Array.isArray(receipt.evidenceIds) &&
      receipt.evidenceIds.length > 0);
  const executorIndex = chain.findIndex(
    (member) => member.kind === "execution",
  );
  const reviewerIndex = chain.findIndex(
    (member) => member.agentRef === "e2e-reviewer",
  );
  const qaIndex = chain.length - 1;
  const executorDispatch = chainDispatches[executorIndex];
  const reviewerDispatch = chainDispatches[reviewerIndex];
  const qaDispatch = chainDispatches[qaIndex];
  const executorHandoff = chainHandoffs[executorIndex];
  const executorReceipt = chainReceipts[executorIndex];
  const paneIsPhysical = (pane) =>
    hasExactKeys(pane, [
      "role",
      "paneId",
      "sessionId",
      "adapterId",
      "agentRef",
      "workerIncarnationId",
      "readOnly",
      "nativeReadOnly",
      "ptySpawnedAt",
      "ptyDataAt",
      "ptyChunkSha256",
    ]) &&
    EVIDENCE_ID_PATTERN.test(pane?.paneId ?? "") &&
    typeof pane?.sessionId === "string" &&
    typeof pane?.readOnly === "boolean" &&
    typeof pane?.nativeReadOnly === "boolean" &&
    Number.isInteger(pane?.ptySpawnedAt) &&
    Number.isInteger(pane?.ptyDataAt) &&
    pane.ptySpawnedAt <= pane.ptyDataAt &&
    /^[a-f0-9]{64}$/u.test(pane?.ptyChunkSha256 ?? "");
  const integrationReceiptHasExactKeys = (rawReceipt) => {
    const receipt = record(rawReceipt);
    if (receipt?.kind === "worktree_integrated") {
      return (
        hasExactKeys(receipt, ["kind", "reference", "completedAt"]) ||
        hasExactKeys(receipt, [
          "kind",
          "reference",
          "completedAt",
          "evidenceIds",
        ])
      );
    }
    if (receipt?.kind === "same_checkout_validated") {
      return hasExactKeys(receipt, [
        "kind",
        "reference",
        "completedAt",
        "evidenceIds",
      ]);
    }
    if (receipt?.kind === "worktree_validated_no_change") {
      return hasExactKeys(receipt, [
        "kind",
        "reference",
        "completedAt",
        "evidenceIds",
      ]);
    }
    if (receipt?.kind === "read_only_validated") {
      return hasExactKeys(receipt, [
        "kind",
        "reference",
        "completedAt",
        "evidenceIds",
      ]);
    }
    return false;
  };
  const dispatchIsPhysical = (dispatch) =>
    hasExactKeys(dispatch, [
      "taskId",
      "plannerId",
      "agentRef",
      "providerReroute",
      "agentCategory",
      "executionMode",
      "dependsOn",
      "state",
      "routeReservationId",
      "routeConsumedAt",
      "routeConsumerMatches",
      "workerIncarnationId",
      "sessionId",
      "handoffId",
      "handoffAcceptedAt",
      "completedAt",
      "integrationReceipt",
    ]) &&
    integrationReceiptHasExactKeys(dispatch?.integrationReceipt) &&
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
          hasExactKeys(attempt, [
            "id",
            "handoffId",
            "missionId",
            "orchestratorSessionId",
            "attemptNo",
            "state",
            "startedAt",
            "acceptDeadlineAt",
            "acceptedAt",
            "failedAt",
            "failureCode",
          ]) &&
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
      attempt?.failedAt !== null ||
      attempt?.failureCode !== null ||
      attempt.startedAt > attempt.acceptedAt ||
      // Espelha real-mission-e2e-evidence.ts: entrega scheduler-owned não abre
      // janela de ack manual, então acceptDeadlineAt vem ausente. Quando o
      // produto carimba o prazo, ele continua sendo exigido.
      (Number.isInteger(attempt.acceptDeadlineAt) &&
        attempt.acceptedAt > attempt.acceptDeadlineAt)
    ) {
      return null;
    }
    return attempt;
  };
  const deliveryAuthorityMatches = (handoff, accepted) => {
    const hasNoManualConsumption =
      handoff?.consumedAt === null &&
      handoff?.consumedBySessionId === null &&
      handoff?.consumedDeliveryAttemptId === null;
    if (
      handoff?.deliveryState === "submitted" ||
      handoff?.deliveryState === "acknowledged"
    ) {
      return hasNoManualConsumption;
    }
    return (
      handoff?.deliveryState === "consumed" &&
      Number.isInteger(handoff?.consumedAt) &&
      accepted.acceptedAt <= handoff.consumedAt &&
      handoff?.consumedBySessionId === kickoff?.sessionId &&
      handoff?.consumedDeliveryAttemptId === accepted.id
    );
  };
  const handoffMatches = (handoff, dispatch, member) => {
    const physical = record(handoff?.physicalReceipt);
    const audit = record(handoff?.auditIntent);
    const scope = record(audit?.scope);
    const accepted = exactAcceptedAttempt(handoff);
    // Substituição por reroute: nome e superfície esperados são do SUBSTITUTO,
    // provado pela diretiva durável — espelho exato do validador in-app.
    const reroute = record(dispatch?.providerReroute);
    const substitute =
      reroute && reroute.fromAgentRef === member?.agentRef
        ? (REAL_MISSION_ADVISORS.find(
            (candidate) => candidate.id === reroute.toAgentRef,
          ) ?? null)
        : null;
    const expectedFromAgent = substitute?.name ?? member?.agentName;
    const expectedCli = substitute?.cli ?? member?.cli;
    const expectedSource =
      member?.kind === "execution" ||
      (member?.kind === "advisory" && expectedCli === "agy")
        ? "mission-shim"
        : "http-mcp";
    return (
      hasExactKeys(handoff, [
        "id",
        "sessionId",
        "workerIncarnationId",
        "fromAgent",
        "authorityOrigin",
        "summarySha256",
        "physicalReceipt",
        "auditIntent",
        "status",
        "deliveryState",
        "delivered",
        "consumedAt",
        "consumedBySessionId",
        "consumedDeliveryAttemptId",
        "deliveryAttempts",
      ]) &&
      hasExactKeys(physical, [
        "receiptId",
        "handoffId",
        "toolCallId",
        "toolName",
        "source",
        "missionId",
        "sessionId",
        "workerIncarnationId",
        "authoritySha256",
        "worktreeHeadSha",
        "issuedAt",
        "worktreeHeadIntegrated",
      ]) &&
      hasExactKeys(audit, [
        "invocationId",
        "toolName",
        "source",
        "sessionId",
        "missionId",
        "scope",
        "occurredAt",
      ]) &&
      hasExactKeys(scope, ["projectId", "checkoutId"]) &&
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
      physical?.source === expectedSource &&
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
      handoff?.fromAgent === expectedFromAgent &&
      handoff?.sessionId === dispatch?.sessionId &&
      handoff?.workerIncarnationId === dispatch?.workerIncarnationId &&
      handoff?.status === "success" &&
      handoff?.delivered === true &&
      deliveryAuthorityMatches(handoff, accepted)
    );
  };
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
      // The current PREVC lifecycle records mission-driver checkpoints only
      // after final validation advances to the last stage of the sealed risk
      // route ("confirmation" on high/critical, "validation-primary" on
      // low/medium).
      receipt?.fromStage === completionRoute[completionRoute.length - 1] &&
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
        milestone?.status === 'done' &&
        Array.isArray(milestone?.evidenceIds) &&
        milestone.evidenceIds.length === 1 &&
        /^milestone:[a-f0-9]{64}$/u.test(milestone.evidenceIds[0] ?? ''),
    ) &&
    completionStepReceipts.length === completionMilestones.length &&
    completionStepReceipts.every((receipt, index) =>
      receiptMatchesMilestone(receipt, completionMilestones[index], index),
    ) &&
    completionStepReceipts.at(-1)?.toStage === 'complete' &&
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
    completionDriver?.lastActionKind === 'complete' &&
    completionDriver?.lastOutcome === 'success' &&
    Number.isInteger(completionDriver?.updatedAt) &&
    completionDriver.updatedAt >= 0 &&
    completionDriver.runStartedAt <= completionDriver.lastAttemptAt &&
    completionDriver.lastAttemptAt <= completionDriver.lastSuccessAt &&
    completionDriver.lastSuccessAt === completionDriver.updatedAt &&
    completionDriver.lastSuccessAt === completion.completedAt;
  const dependencyConsumptionHasExactKeys = (receipt) =>
    hasExactKeys(receipt, [
      'missionId',
      'consumerTaskId',
      'dependencyTaskId',
      'handoffId',
      'consumerSessionId',
      'consumerWorkerIncarnationId',
      'promptSha256',
      'handoffSummarySha256',
      'consumedAt',
    ]);
  const chainPlanIsExact =
    planTasks.length === chain.length &&
    chain.every((member, index) => {
      const task = record(chainPlans[index]);
      return (
        task !== null &&
        task.agentCategory === member.agentCategory &&
        task.executionMode === member.executionMode &&
        exactDependencies(task.dependsOn, member)
      );
    });
  const chainDispatchIsExact =
    dispatches.length === chain.length &&
    chain.every((member, index) => {
      const dispatch = chainDispatches[index];
      const receipt = chainReceipts[index];
      return (
        dispatchIsPhysical(dispatch) &&
        dispatch.taskId === chainPlans[index]?.taskId &&
        dispatch.agentCategory === member.agentCategory &&
        dispatch.executionMode === member.executionMode &&
        exactDependencies(dispatch.dependsOn, member) &&
        (member.kind === 'execution'
          ? // A forma do receipt casa com o modo selado: same_checkout
            // conclui com o receipt próprio (reference = tokenHash sha256);
            // escritor isolado segue exigindo worktree_integrated.
            (member.executionMode === 'same_checkout'
              ? receipt?.kind === 'same_checkout_validated' &&
                /^[a-f0-9]{64}$/u.test(receipt.reference ?? '')
              : receipt?.kind === 'worktree_integrated' &&
                GIT_SHA_PATTERN.test(receipt.reference ?? '')) &&
            Number.isInteger(receipt.completedAt)
          : isNonExecutionValidationReceipt(receipt) &&
            Number.isInteger(receipt.completedAt))
      );
    });
  const chainHandoffIsExact =
    chainHandoffs.length === chain.length &&
    exactDurableHandoffSet &&
    chain.every((member, index) =>
      handoffMatches(chainHandoffs[index], chainDispatches[index], member),
    ) &&
    new Set(chainHandoffs.map((handoff) => handoff?.id)).size ===
      chain.length &&
    new Set(chainHandoffs.map((handoff) => handoff?.sessionId)).size ===
      chain.length &&
    new Set(chainHandoffs.map((handoff) => handoff?.workerIncarnationId))
      .size === chain.length &&
    new Set(
      chainHandoffs.map(
        (handoff) => record(handoff?.physicalReceipt)?.receiptId,
      ),
    ).size === chain.length &&
    new Set(
      chainHandoffs.map(
        (handoff) => record(handoff?.physicalReceipt)?.toolCallId,
      ),
    ).size === chain.length &&
    chainHandoffs.every((handoff) => {
      const scope = record(record(handoff?.auditIntent)?.scope);
      const first = record(record(chainHandoffs[0]?.auditIntent)?.scope);
      return (
        scope !== null &&
        scope.projectId === first?.projectId &&
        scope.checkoutId === first?.checkoutId
      );
    });
  // Advisors e executor são raízes independentes: com capacidade limitada,
  // um advisor pode observar o HEAD inicial até a integração ou o HEAD final
  // somente a partir do receipt de integração. O SHA e o issuedAt precisam
  // contar a mesma história causal; nenhum terceiro HEAD é aceito. O revisor
  // codex e o QA dependem da cadeia e validam sempre o HEAD final integrado.
  // worktree_validated_no_change ainda precisa selar exatamente o mesmo HEAD
  // observado fisicamente; read_only_validated exige só esse HEAD.
  const chainHeadIsExact = chain.every((member, index) => {
    const physicalReceipt = record(chainHandoffs[index]?.physicalReceipt);
    const head = physicalReceipt?.worktreeHeadSha;
    const receipt = chainReceipts[index];
    const noChangeHead = chainNoChangeMatches[index]?.[1];
    if (member.kind === 'advisory') {
      // Espelho do TS: head inicial é sempre plausível para advisory (leitor
      // paralelo observa pré-entrega e submete depois); head final exige
      // issuedAt >= integração do executor.
      const executorIntegratedAt = executorReceipt?.completedAt;
      const headMatchesIntegrationChronology =
        Number.isInteger(executorIntegratedAt) &&
        (head === repository?.initialHeadSha ||
          (head === repository?.finalHeadSha &&
            Number.isInteger(physicalReceipt?.issuedAt) &&
            physicalReceipt.issuedAt >= executorIntegratedAt));
      if (receipt?.kind === 'read_only_validated') {
        return headMatchesIntegrationChronology;
      }
      return headMatchesIntegrationChronology && noChangeHead === head;
    }
    if (member.kind === 'execution') {
      return typeof head === 'string' && head !== repository?.initialHeadSha;
    }
    if (receipt?.kind === 'read_only_validated') {
      return head === repository?.finalHeadSha;
    }
    return (
      head === repository?.finalHeadSha &&
      noChangeHead === repository?.finalHeadSha
    );
  });
  const dependencyEdges = chain.flatMap((member, consumerIndex) =>
    member.dependsOnPlannerIds.map((plannerId) => ({
      consumerIndex,
      dependencyIndex: chainIndexByPlannerId.get(plannerId) ?? -1,
    })),
  );
  const chainConsumptionIsExact =
    dependencyConsumptions.length === dependencyEdges.length &&
    dependencyConsumptions.every(dependencyConsumptionHasExactKeys) &&
    dependencyEdges.every(({ consumerIndex, dependencyIndex }) => {
      if (dependencyIndex < 0) return false;
      const dispatch = chainDispatches[consumerIndex];
      const dependencyDispatch = chainDispatches[dependencyIndex];
      const dependencyHandoff = record(chainHandoffs[dependencyIndex]);
      const receipt = record(
        dependencyConsumptions.find(
          (candidate) =>
            candidate?.consumerTaskId === dispatch?.taskId &&
            candidate?.dependencyTaskId === dependencyDispatch?.taskId,
        ),
      );
      return (
        receipt !== null &&
        receipt.missionId === mission?.id &&
        receipt.dependencyTaskId === dependencyDispatch?.taskId &&
        receipt.handoffId === dependencyHandoff?.id &&
        receipt.consumerSessionId === dispatch?.sessionId &&
        receipt.consumerWorkerIncarnationId === dispatch?.workerIncarnationId &&
        SHA256_PATTERN.test(receipt.promptSha256 ?? '') &&
        receipt.handoffSummarySha256 === dependencyHandoff?.summarySha256 &&
        Number.isInteger(receipt.consumedAt) &&
        dependencyDispatch?.completedAt <= receipt.consumedAt &&
        receipt.consumedAt <= dispatch?.handoffAcceptedAt &&
        receipt.consumedAt <=
          record(chainHandoffs[consumerIndex]?.auditIntent)?.occurredAt
      );
    });
  const chainTimingIsExact =
    chain.every((member, index) => {
      const receipt = chainReceipts[index];
      const dispatch = chainDispatches[index];
      const physical = record(chainHandoffs[index]?.physicalReceipt);
      const dependencies = member.dependsOnPlannerIds.map((plannerId) => {
        const dependencyIndex = chainIndexByPlannerId.get(plannerId);
        return dependencyIndex === undefined
          ? null
          : chainReceipts[dependencyIndex];
      });
      return (
        receipt !== null &&
        receipt.completedAt === dispatch?.completedAt &&
        physical?.issuedAt <= receipt.completedAt &&
        dependencies.every(
          (dependencyReceipt) =>
            dependencyReceipt !== null &&
            dependencyReceipt.completedAt <= dispatch?.routeConsumedAt &&
            dependencyReceipt.completedAt <= physical?.issuedAt,
        )
      );
    }) &&
    chainHandoffs.every((handoff) => {
      const accepted = exactAcceptedAttempt(handoff);
      const deliveredAt = Number.isInteger(handoff?.consumedAt)
        ? handoff.consumedAt
        : accepted?.acceptedAt;
      return (
        Number.isInteger(deliveredAt) && deliveredAt <= completion?.completedAt
      );
    });
  // O roster advisor é canônico: as CLIs na ordem do contrato, com o
  // tier exato; skipped não pode carregar recibo físico.
  const participationIsCanonical =
    participation.length === REAL_MISSION_ADVISORS.length &&
    participation.every((rawRow, index) => {
      const row = record(rawRow);
      const advisor = REAL_MISSION_ADVISORS[index];
      return (
        hasExactKeys(row, [
          'cli',
          'tier',
          'skipped',
          'spawnedAt',
          'firstNexusToolAt',
          'handoffAt',
        ]) &&
        row?.cli === advisor.cli &&
        row?.tier === advisor.tier &&
        (row?.skipped === null ||
          row?.skipped === 'no-credential' ||
          row?.skipped === 'orchestrator-reserved' ||
          row?.skipped === 'provider-rerouted') &&
        (row?.skipped === null ||
          (row?.spawnedAt === null &&
            row?.firstNexusToolAt === null &&
            row?.handoffAt === null))
      );
    });
  // Cada advisor credenciada prova PTY físico, primeira tool nexus_* e o
  // handoff físico; handoffAt casa exatamente com o receipt Main-owned.
  const participationIsComplete = participation.every((rawRow) => {
    const row = record(rawRow);
    if (row === null || row.skipped !== null) return row !== null;
    const advisor = REAL_MISSION_ADVISORS.find(
      (candidate) => candidate.cli === row.cli,
    );
    const index = chain.findIndex((member) => member.agentRef === advisor?.id);
    const physical =
      index >= 0 ? record(chainHandoffs[index]?.physicalReceipt) : null;
    return (
      index >= 0 &&
      Number.isInteger(row.spawnedAt) &&
      Number.isInteger(row.firstNexusToolAt) &&
      Number.isInteger(row.handoffAt) &&
      row.spawnedAt <= row.firstNexusToolAt &&
      row.firstNexusToolAt <= row.handoffAt &&
      row.handoffAt === physical?.issuedAt
    );
  });
  const valid =
    exactTopLevelEnvelope &&
    evidence?.schemaVersion === REAL_MISSION_EVIDENCE_SCHEMA_VERSION &&
    EVIDENCE_ID_PATTERN.test(evidence?.runId ?? '') &&
    evidence?.status === 'pass' &&
    evidence?.failure === null &&
    evidence?.expectedContentSha256 === expectedSha &&
    evidence?.coverageTier === 'guided-delivery-core' &&
    evidence?.planOrigin === 'production-guided-planner' &&
    evidence?.prevcOrigin === 'e2e-fixture' &&
    evidence?.reviewOrigin === 'production-physical-worker' &&
    evidence?.qaOrigin === 'production-physical-worker' &&
    exactRuntimeAttestation &&
    exactWizardSurfaceEvidence &&
    hasExactKeys(interaction, [
      'evidenceOrigin',
      'nativeDialogCount',
      'missionApprovalDialogCount',
      'missionApprovalAcceptedCount',
      'codexMcpPromptCount',
    ]) &&
    interaction?.evidenceOrigin === 'main-owned-instrumentation' &&
    interaction?.nativeDialogCount === 0 &&
    interaction?.missionApprovalDialogCount === 0 &&
    interaction?.missionApprovalAcceptedCount === 0 &&
    interaction?.codexMcpPromptCount === 0 &&
    exactReleaseBinding &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(release?.appVersion ?? '') &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      release?.runId ?? '',
    ) &&
    canonicalStartedAt &&
    canonicalFinishedAt &&
    finishedAt > startedAt &&
    /^[a-f0-9]{40}$/u.test(release?.commitSha ?? '') &&
    /^[a-f0-9]{64}$/u.test(artifact?.sha256 ?? '') &&
    RELEASE_IDENTITY_PATTERN.test(artifact?.identity ?? '') &&
    exactMission &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(mission?.id ?? '') &&
    exactSingleMissionInventory &&
    mission?.status === 'done' &&
    mission?.intentState === 'done' &&
    mission?.intentVersion === 1 &&
    mission?.squadSourceId === 'agentic-nexus-real-mission-e2e' &&
    SHA256_PATTERN.test(mission?.squadSourceRevisionHash ?? '') &&
    SHA256_PATTERN.test(mission?.squadRevisionHash ?? '') &&
    ((evidence?.launchSurface === 'private-runner' &&
      ((mission?.squadId === 'agentic-nexus-real-mission-e2e' &&
        mission?.squadSourceRevisionHash === mission?.squadRevisionHash) ||
        (/^agentic-runtime-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          mission?.squadId ?? '',
        ) &&
          mission?.squadSourceRevisionHash !== mission?.squadRevisionHash))) ||
      (evidence?.launchSurface === 'product-wizard' &&
        /^agentic-runtime-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          mission?.squadId ?? '',
        ) &&
        mission?.squadSourceRevisionHash !== mission?.squadRevisionHash)) &&
    Number.isInteger(mission?.approvedAt) &&
    Number.isInteger(mission?.dispatchedAt) &&
    mission.approvedAt >= 0 &&
    mission.dispatchedAt >= 0 &&
    mission.approvedAt <= mission.dispatchedAt &&
    exactKickoff &&
    typeof kickoff?.sessionId === 'string' &&
    Number.isInteger(kickoff?.idleAt) &&
    Number.isInteger(kickoff?.busyAt) &&
    Number.isInteger(kickoff?.ptyDataAt) &&
    mission.dispatchedAt <= kickoff.idleAt &&
    kickoff.idleAt <= kickoff.busyAt &&
    kickoff.idleAt <= kickoff.ptyDataAt &&
    /^[a-f0-9]{64}$/u.test(kickoff?.ptyChunkSha256 ?? '') &&
    exactPlan &&
    plan?.version === 1 &&
    plan?.squadId === mission?.squadId &&
    /^[a-f0-9]{64}$/u.test(plan?.planHash ?? '') &&
    /^[a-f0-9]{64}$/u.test(plan?.rosterHash ?? '') &&
    chainPlanIsExact &&
    participationIsCanonical &&
    panes.length === 4 &&
    exactPhysicalPtySet &&
    panes.every(paneIsPhysical) &&
    new Set(panes.map((pane) => pane?.sessionId)).size === 4 &&
    panes.filter(
      (pane) =>
        pane?.role === 'orchestrator' &&
        (pane?.adapterId === 'codex' || pane?.adapterId === 'claude') &&
        pane?.agentRef === 'e2e-orchestrator' &&
        pane?.readOnly === false &&
        pane?.nativeReadOnly === false,
    ).length === 1 &&
    // Variante coerente: orquestrador Claude exige a advisor claude marcada
    // orchestrator-reserved (reserveClaude); orquestrador codex proíbe a marca.
    ((orchestratorCli === 'claude' &&
      participation.find((row) => record(row)?.cli === 'claude')?.skipped ===
        'orchestrator-reserved') ||
      (orchestratorCli === 'codex' &&
        participation.find((row) => record(row)?.cli === 'claude')?.skipped !==
          'orchestrator-reserved')) &&
    panes.filter(
      (pane) =>
        pane?.role === 'worker' &&
        pane?.adapterId === 'codex' &&
        pane?.agentRef === 'e2e-executor' &&
        pane?.readOnly === false &&
        pane?.nativeReadOnly === false &&
        typeof pane?.workerIncarnationId === 'string',
    ).length === 1 &&
    panes.filter(
      (pane) =>
        pane?.role === 'worker' &&
        pane?.adapterId === 'codex' &&
        pane?.agentRef === 'e2e-reviewer' &&
        pane?.readOnly === true &&
        pane?.nativeReadOnly === false &&
        typeof pane?.workerIncarnationId === 'string',
    ).length === 1 &&
    panes.filter(
      (pane) =>
        pane?.role === 'worker' &&
        pane?.adapterId === 'codex' &&
        pane?.agentRef === 'e2e-qa' &&
        pane?.readOnly === true &&
        pane?.nativeReadOnly === false &&
        typeof pane?.workerIncarnationId === 'string',
    ).length === 1 &&
    chainDispatchIsExact &&
    chainHandoffIsExact &&
    chainHeadIsExact &&
    chainConsumptionIsExact &&
    chainTimingIsExact &&
    participationIsComplete &&
    exactMissionDriverCompletion &&
    qaDispatch?.completedAt <= completion?.completedAt &&
    exactRepository &&
    /^[a-f0-9]{40,64}$/u.test(repository?.initialHeadSha ?? '') &&
    /^[a-f0-9]{40,64}$/u.test(repository?.finalHeadSha ?? '') &&
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
    // Binding do receipt à geometria por forma: no mundo isolado a reference
    // É o head integrado; no caminho simples ela é o tokenHash do binding
    // serialized-writer e o vínculo verificável é a consistência com o modo
    // selado do dispatch (a geometria já foi provada acima).
    (executorReceipt?.kind === 'worktree_integrated'
      ? executorReceipt?.reference === repository?.finalHeadSha
      : executorReceipt?.kind === 'same_checkout_validated' &&
        executorDispatch?.executionMode === 'same_checkout' &&
        /^[a-f0-9]{64}$/u.test(executorReceipt?.reference ?? '')) &&
    panes.find((pane) => pane?.agentRef === 'e2e-orchestrator')?.sessionId ===
      kickoff?.sessionId &&
    panes.find((pane) => pane?.agentRef === 'e2e-executor')?.sessionId ===
      executorDispatch?.sessionId &&
    panes.find((pane) => pane?.agentRef === 'e2e-executor')
      ?.workerIncarnationId === executorDispatch?.workerIncarnationId &&
    panes.find((pane) => pane?.agentRef === 'e2e-reviewer')?.sessionId ===
      reviewerDispatch?.sessionId &&
    panes.find((pane) => pane?.agentRef === 'e2e-reviewer')
      ?.workerIncarnationId === reviewerDispatch?.workerIncarnationId &&
    panes.find((pane) => pane?.agentRef === 'e2e-qa')?.sessionId ===
      qaDispatch?.sessionId &&
    panes.find((pane) => pane?.agentRef === 'e2e-qa')?.workerIncarnationId ===
      qaDispatch?.workerIncarnationId;
  if (!valid) {
    if (process.env.NEXUS_E2E_EVIDENCE_DEBUG === '1') {
      console.error(
        '[evidence-debug]',
        JSON.stringify({
          exactTopLevelEnvelope,
          exactMission,
          exactRuntimeAttestation,
          exactSingleMissionInventory,
          exactWizardSurfaceEvidence,
          exactReleaseBinding,
          exactRepository,
          exactPhysicalPtySet,
          exactDurableHandoffSet,
          exactPlan,
          exactKickoff,
          exactMissionDriverCompletion,
          chainPlanIsExact,
          chainDispatchIsExact,
        }),
      );
    }
    throw new Error('real mission evidence is incomplete or not a PASS');
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
    evidence?.launchSurface !== 'product-wizard' ||
    evidence?.wizardCoverage !== 'main-owned-product-sequence' ||
    record(evidence?.wizardReceipt) === null ||
    record(evidence?.missionInventory)?.exactSingleProductMission !== true
  ) {
    throw new Error(
      'real mission release evidence requires product-wizard physical coverage; private-runner evidence is diagnostic-only',
    );
  }
  // Release exige participação completa das advisors credenciadas: PTY
  // físico, primeira tool nexus_* e handoff — skipped (sem credencial) fica
  // fora da exigência, mas precisa estar registrada como skipped.
  const participationRows = Array.isArray(evidence?.participation)
    ? evidence.participation
    : [];
  const participationComplete =
    participationRows.length === REAL_MISSION_ADVISORS.length &&
    participationRows.every((rawRow) => {
      const row = record(rawRow);
      if (row === null) return false;
      if (
        row.skipped === 'no-credential' ||
        row.skipped === 'orchestrator-reserved' ||
        row.skipped === 'provider-rerouted'
      ) {
        return (
          row.spawnedAt === null &&
          row.firstNexusToolAt === null &&
          row.handoffAt === null
        );
      }
      return (
        row.skipped === null &&
        Number.isInteger(row.spawnedAt) &&
        Number.isInteger(row.firstNexusToolAt) &&
        Number.isInteger(row.handoffAt)
      );
    });
  if (!participationComplete) {
    throw new Error(
      'real mission release evidence requires complete participation of every credentialed advisor CLI',
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
    : 'spawned';
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
    : 'invalid-evidence';
  const failureReason = REAL_MISSION_FAILURE_REASONS.has(failure?.reason)
    ? failure.reason
    : null;
  const failureDetail =
    typeof failure?.detail === 'string' && failure.detail.trim().length > 0
      ? failure.detail.trim().slice(0, 4_000)
      : null;
  const missionStatus = REAL_MISSION_STATUSES.has(snapshot?.missionStatus)
    ? snapshot.missionStatus
    : null;
  return {
    child,
    failure: {
      code: failureCode,
      reason: failureReason,
      detail: failureDetail,
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
  launchSurface = 'private-runner',
) {
  const { child, failure } = safeRealMissionFailureParts(raw, result);
  const release = record(releaseBinding);
  const artifact = record(release?.artifact);
  return {
    schemaVersion: REAL_MISSION_EVIDENCE_SCHEMA_VERSION,
    status: 'fail',
    coverageTier: 'guided-delivery-core',
    planOrigin: 'production-guided-planner',
    prevcOrigin: 'e2e-fixture',
    reviewOrigin: 'production-physical-worker',
    qaOrigin: 'production-physical-worker',
    launchSurface:
      launchSurface === 'product-wizard' ? 'product-wizard' : 'private-runner',
    wizardCoverage: 'not-covered',
    wizardReceipt: null,
    interaction: {
      evidenceOrigin: 'main-owned-instrumentation',
      nativeDialogCount: 0,
      missionApprovalDialogCount: 0,
      missionApprovalAcceptedCount: 0,
      codexMcpPromptCount: 0,
    },
    release: {
      appVersion: /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(
        release?.appVersion ?? '',
      )
        ? release.appVersion
        : null,
      commitSha: /^[a-f0-9]{40}$/u.test(release?.commitSha ?? '')
        ? release.commitSha
        : null,
      artifact: {
        sha256: /^[a-f0-9]{64}$/u.test(artifact?.sha256 ?? '')
          ? artifact.sha256
          : null,
        identity: RELEASE_IDENTITY_PATTERN.test(artifact?.identity ?? '')
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
  const detailPart =
    typeof failure.detail === 'string' && failure.detail.length > 0
      ? ` detail=${JSON.stringify(failure.detail.slice(0, 240))}`
      : "";
  return (
    `[real-mission] FAIL code=${failure.code} ` +
    `reason=${failure.reason ?? "none"} ` +
    `exit=${child.exitCode} phase=${child.phase} ` +
    `status=${snapshot.missionStatus ?? "none"} ` +
    `panes=${snapshot.paneCount} ` +
    `dispatches=${snapshot.dispatchCount} ` +
    `handoffs=${snapshot.handoffCount}` +
    `${detailPart} ` +
    `CTA: ${REAL_MISSION_CTA}`
  );
}
