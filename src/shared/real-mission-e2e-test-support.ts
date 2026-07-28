import { createHash } from "node:crypto";

import {
  REAL_MISSION_E2E_ADVISORS,
  REAL_MISSION_E2E_EVIDENCE_SCHEMA_VERSION,
  REAL_MISSION_E2E_ORCHESTRATOR_ID,
  REAL_MISSION_E2E_PRODUCT_WIZARD_ACCEPTANCE_CRITERIA,
  REAL_MISSION_E2E_SQUAD_ID,
  productWizardReceiptChainSha256,
  realMissionE2EAcceptanceCriteria,
  realMissionE2EAdvisorTier,
  realMissionE2EExpectedTaskChain,
  type RealMissionE2EAdvisorCli,
} from "./real-mission-e2e";

export const sha = (value: string) => createHash("sha256").update(value).digest("hex");
export const rendererFailureToken = "f".repeat(64);

const INITIAL_HEAD_SHA = "a".repeat(40);
const FINAL_HEAD_SHA = "b".repeat(40);

/** Slug estável dos ids do roster: e2e-executor → executor, e2e-advisor-kimi → advisor-kimi. */
function memberSlug(agentRef: string): string {
  return agentRef.replace(/^e2e-/u, "");
}

export function validPassEvidence(
  launchSurface: "private-runner" | "product-wizard" = "private-runner",
  options: {
    readonly skipAdvisorClis?: readonly RealMissionE2EAdvisorCli[];
    readonly orchestratorCli?: "codex" | "claude";
  } = {},
): Record<string, unknown> {
  const orchestratorCli = options.orchestratorCli ?? "codex";
  const skippedClis = new Set(options.skipAdvisorClis ?? []);
  // reserveClaude: na variante orquestrador Claude a advisor claude é
  // reservada — nunca vira worker.
  const claudeReserved = orchestratorCli === "claude";
  const presentAdvisorClis = REAL_MISSION_E2E_ADVISORS.filter(
    (advisor) =>
      !skippedClis.has(advisor.cli) &&
      !(claudeReserved && advisor.cli === "claude"),
  ).map((advisor) => advisor.cli);
  const chain = realMissionE2EExpectedTaskChain(presentAdvisorClis);
  const planHash = sha("guided-plan");
  const sourceSquadRevisionHash = sha("source-squad-revision");
  const contextHash = sha("frozen-context");
  const contractHash = sha("frozen-contract");
  const finalDiffHash = sha("integrated-diff");
  const runtimeSquadRevisionHash = sha("runtime-squad-revision");
  const runtimeSquadId =
    "agentic-runtime-11111111-1111-4111-8111-111111111111";
  const productWizardReceiptCore = {
    origin: "main-owned-product-wizard-causal-chain" as const,
    missionId: "mission-e2e",
    workspaceSha256: sha("workspace"),
    sourceSquadRevisionHash,
    squadRevisionHash: runtimeSquadRevisionHash,
    submittedContractSha256: sha("submitted-contract"),
    approvedContractSha256: sha("approved-contract"),
    armedAt: 10,
    intentSubmittedAt: 10,
    nativeDialogOpenedAt: 10,
    nativeDialogAcceptedAt: 10,
    approvalReturnedAt: 11,
  };
  const acceptanceCriteria =
    launchSurface === "product-wizard"
      ? REAL_MISSION_E2E_PRODUCT_WIZARD_ACCEPTANCE_CRITERIA
      : realMissionE2EAcceptanceCriteria(orchestratorCli);
  const workflowRoute = [
    "planning",
    "execution",
    "validation-primary",
  ] as const;

  // Linha do tempo física da cadeia linear: cada membro começa quando o
  // anterior completa (receipt.completedAt === dispatch.completedAt).
  let cursor = 15;
  const timeline = chain.map((member, index) => {
    const base = cursor;
    cursor += 5;
    return {
      member,
      index,
      slug: memberSlug(member.agentRef),
      taskId: `task-${memberSlug(member.agentRef)}`,
      previousTaskId:
        index > 0 ? `task-${memberSlug(chain[index - 1]!.agentRef)}` : null,
      routeConsumedAt: base,
      spawnedAt: base,
      ptyDataAt: base + 1,
      firstNexusToolAt: base + 1,
      auditOccurredAt: base + 1,
      issuedAt: base + 2,
      attemptStartedAt: base + 2,
      acceptedAt: base + 3,
      handoffAcceptedAt: base + 3,
      acceptDeadlineAt: base + 4,
      handoffConsumedAt: base + 4,
      consumedDependencyAt: base,
      completedAt: base + 5,
    };
  });
  const lastCompletedAt = cursor;
  const completionCompletedAt = lastCompletedAt + 1;
  const finishedAt = lastCompletedAt + 2;

  const headFor = (kind: string): string =>
    kind === "advisory" ? INITIAL_HEAD_SHA : FINAL_HEAD_SHA;

  const planTasks = timeline.map((step) => ({
    plannerId: step.member.plannerId,
    taskId: step.taskId,
    agentRef: step.member.agentRef,
    agentCategory: step.member.agentCategory,
    executionMode: step.member.executionMode,
    dependsOn: step.previousTaskId === null ? [] : [step.previousTaskId],
  }));
  const dispatches = timeline.map((step) => ({
    taskId: step.taskId,
    plannerId: step.member.plannerId,
    agentRef: step.member.agentRef,
    agentCategory: step.member.agentCategory,
    executionMode: step.member.executionMode,
    dependsOn: step.previousTaskId === null ? [] : [step.previousTaskId],
    state: "completed",
    routeReservationId: `reservation-${step.slug}`,
    routeConsumedAt: step.routeConsumedAt,
    routeConsumerMatches: true,
    workerIncarnationId: `incarnation-${step.slug}`,
    sessionId: `session-${step.slug}`,
    handoffId: `handoff-${step.slug}`,
    handoffAcceptedAt: step.handoffAcceptedAt,
    completedAt: step.completedAt,
    integrationReceipt:
      step.member.kind === "execution"
        ? {
            kind: "worktree_integrated",
            reference: FINAL_HEAD_SHA,
            completedAt: step.completedAt,
          }
        : {
            kind: "worktree_validated_no_change",
            reference: `no-change:${headFor(step.member.kind)}:${sha(`${step.slug}-clean-diff`)}`,
            completedAt: step.completedAt,
            evidenceIds: [`sensor-${step.slug}`],
          },
  }));
  const handoffs = timeline.map((step) => ({
    id: `handoff-${step.slug}`,
    sessionId: `session-${step.slug}`,
    workerIncarnationId: `incarnation-${step.slug}`,
    fromAgent: step.member.agentName,
    authorityOrigin: "agent",
    summarySha256: sha(`${step.slug}-handoff-summary`),
    physicalReceipt: {
      receiptId: `tool-call-${step.slug}`,
      handoffId: `handoff-${step.slug}`,
      toolCallId: `tool-call-${step.slug}`,
      toolName: "nexus_handoff_submit",
      source: "http-mcp",
      missionId: "mission-e2e",
      sessionId: `session-${step.slug}`,
      workerIncarnationId: `incarnation-${step.slug}`,
      authoritySha256: sha(`${step.slug}-authority`),
      worktreeHeadSha: headFor(step.member.kind),
      issuedAt: step.issuedAt,
      worktreeHeadIntegrated: true,
    },
    auditIntent: {
      invocationId: `tool-call-${step.slug}`,
      toolName: "nexus_handoff_submit",
      source: "http-mcp",
      sessionId: `session-${step.slug}`,
      missionId: "mission-e2e",
      scope: {
        projectId: "project-e2e",
        checkoutId: "checkout-e2e",
      },
      occurredAt: step.auditOccurredAt,
    },
    status: "success",
    deliveryState: "consumed",
    delivered: true,
    consumedAt: step.handoffConsumedAt,
    consumedBySessionId: "session-orch",
    consumedDeliveryAttemptId: `attempt-${step.slug}`,
    deliveryAttempts: [
      {
        id: `attempt-${step.slug}`,
        handoffId: `handoff-${step.slug}`,
        missionId: "mission-e2e",
        orchestratorSessionId: "session-orch",
        attemptNo: 1,
        state: "accepted",
        startedAt: step.attemptStartedAt,
        acceptDeadlineAt: step.acceptDeadlineAt,
        acceptedAt: step.acceptedAt,
        failedAt: null,
        failureCode: null,
      },
    ],
  }));
  const dependencyConsumptions = timeline.slice(1).map((step) => {
    const previous = timeline[step.index - 1]!;
    return {
      missionId: "mission-e2e",
      consumerTaskId: step.taskId,
      dependencyTaskId: previous.taskId,
      handoffId: `handoff-${previous.slug}`,
      consumerSessionId: `session-${step.slug}`,
      consumerWorkerIncarnationId: `incarnation-${step.slug}`,
      promptSha256: sha(`${step.slug}-accepted-prompt`),
      handoffSummarySha256: sha(`${previous.slug}-handoff-summary`),
      consumedAt: step.consumedDependencyAt,
    };
  });
  const participation = REAL_MISSION_E2E_ADVISORS.map((advisor) => {
    const step = timeline.find(
      (candidate) => candidate.member.agentRef === advisor.id,
    );
    if (!step) {
      return {
        cli: advisor.cli,
        tier: realMissionE2EAdvisorTier(advisor.cli),
        skipped:
          claudeReserved && advisor.cli === "claude"
            ? "orchestrator-reserved"
            : "no-credential",
        spawnedAt: null,
        firstNexusToolAt: null,
        handoffAt: null,
      };
    }
    return {
      cli: advisor.cli,
      tier: realMissionE2EAdvisorTier(advisor.cli),
      skipped: null,
      spawnedAt: step.spawnedAt,
      firstNexusToolAt: step.firstNexusToolAt,
      handoffAt: step.issuedAt,
    };
  });
  const codexWorkerPane = (agentRef: string) => {
    const step = timeline.find(
      (candidate) => candidate.member.agentRef === agentRef,
    )!;
    const readOnly = agentRef !== "e2e-executor";
    return {
      role: "worker",
      paneId: `pane-${step.slug}`,
      sessionId: `session-${step.slug}`,
      adapterId: "codex",
      agentRef,
      workerIncarnationId: `incarnation-${step.slug}`,
      readOnly,
      nativeReadOnly: readOnly,
      ptySpawnedAt: step.spawnedAt,
      ptyDataAt: step.ptyDataAt,
      ptyChunkSha256: sha(`${step.slug}-physical-pty`),
    };
  };
  const receiptTransitions = acceptanceCriteria.map(
    (_, index) =>
      [
        "validation-primary",
        index === acceptanceCriteria.length - 1
          ? "complete"
          : "validation-primary",
        3,
        index === acceptanceCriteria.length - 1 ? 4 : 3,
        completionCompletedAt,
      ] as const,
  );
  const milestones = acceptanceCriteria.map(
    (label, index) => ({
      stepId: `step-${index + 1}`,
      label,
      status: "done",
      evidenceIds: [`milestone:${sha(`step-${index + 1}`)}`],
    }),
  );
  const stepReceipts = receiptTransitions.map(
    ([fromStage, toStage, revisionBefore, revisionAfter, completedAt], index) => ({
      stepId: `step-${index + 1}`,
      fromStage,
      toStage,
      workflowRevisionBefore: revisionBefore,
      workflowRevisionAfter: revisionAfter,
      evidenceIds: [`milestone:${sha(`step-${index + 1}`)}`],
      evidenceBinding: {
        missionId: "mission-e2e",
        contextRevision: contextHash,
        contractHash,
        baseSha: INITIAL_HEAD_SHA,
        headSha: FINAL_HEAD_SHA,
        diffHash: finalDiffHash,
        workflowRevision: revisionBefore,
      },
      completedAt,
    }),
  );
  return {
    schemaVersion: REAL_MISSION_E2E_EVIDENCE_SCHEMA_VERSION,
    runId: "run-e2e",
    appVersion: "0.19.27",
    startedAt: 10,
    finishedAt,
    status: "pass",
    workspaceSha256: sha("workspace"),
    expectedContentSha256: sha("content"),
    coverageTier: "guided-delivery-core",
    planOrigin: "production-guided-planner",
    prevcOrigin: "e2e-fixture",
    reviewOrigin: "production-physical-worker",
    qaOrigin: "production-physical-worker",
    launchSurface,
    wizardCoverage:
      launchSurface === "product-wizard"
        ? "main-owned-product-sequence"
        : "not-covered",
    wizardReceipt:
      launchSurface === "product-wizard"
        ? {
            ...productWizardReceiptCore,
            chainSha256: productWizardReceiptChainSha256(
              productWizardReceiptCore,
            ),
          }
        : null,
    runtimeAttestation: {
      version: 1,
      algorithm: "hmac-sha256",
      challengeSha256: sha("synthetic-challenge"),
      bindingSha256: sha("synthetic-binding"),
      evidenceSha256: sha("synthetic-evidence"),
      macSha256: sha("synthetic-mac"),
    },
    interaction: {
      evidenceOrigin: "main-owned-instrumentation",
      nativeDialogCount: 1,
      missionApprovalDialogCount: 1,
      missionApprovalAcceptedCount: 1,
      codexMcpPromptCount: 0,
    },
    mission: {
      id: "mission-e2e",
      status: "done",
      intentState: "done",
      intentVersion: 1,
      squadId:
        launchSurface === "product-wizard"
          ? runtimeSquadId
          : REAL_MISSION_E2E_SQUAD_ID,
      squadSourceId: REAL_MISSION_E2E_SQUAD_ID,
      squadSourceRevisionHash: sourceSquadRevisionHash,
      squadRevisionHash:
        launchSurface === "product-wizard"
          ? runtimeSquadRevisionHash
          : sourceSquadRevisionHash,
      approvedAt: 10,
      dispatchedAt: 11,
    },
    missionInventory: {
      evidenceOrigin: "main-owned-mission-store-inventory",
      selectedMissionId: "mission-e2e",
      observedMissionCount: 1,
      observedMissionIds: ["mission-e2e"],
      finalMissionCount: 1,
      finalMissionIds: ["mission-e2e"],
      exactSingleProductMission: true,
    },
    kickoff: {
      sessionId: "session-orch",
      idleAt: 12,
      busyAt: 14,
      ptyDataAt: 15,
      ptyChunkSha256: sha("pty-chunk-without-storing-it"),
    },
    plan: {
      version: 1,
      squadId:
        launchSurface === "product-wizard"
          ? runtimeSquadId
          : REAL_MISSION_E2E_SQUAD_ID,
      planHash,
      rosterHash: sha("guided-roster"),
      tasks: planTasks,
    },
    panes: [
      {
        role: "orchestrator",
        paneId: "pane-orch",
        sessionId: "session-orch",
        adapterId: orchestratorCli,
        agentRef: REAL_MISSION_E2E_ORCHESTRATOR_ID,
        workerIncarnationId: null,
        readOnly: false,
        nativeReadOnly: true,
        ptySpawnedAt: 11,
        ptyDataAt: 13,
        ptyChunkSha256: sha("orchestrator-physical-pty"),
      },
      codexWorkerPane("e2e-executor"),
      codexWorkerPane("e2e-reviewer"),
      codexWorkerPane("e2e-qa"),
    ],
    physicalPty: {
      count: 4,
      ids: [
        "session-orch",
        "session-executor",
        "session-reviewer",
        "session-qa",
      ],
    },
    dispatches,
    handoffs,
    durableHandoffs: {
      count: handoffs.length,
      ids: handoffs.map((handoff) => handoff.id),
    },
    dependencyConsumptions,
    participation,
    completion: {
      origin: "mission-driver-prevc",
      missionId: "mission-e2e",
      intentVersion: 1,
      orchestratorSessionId: "session-orch",
      planHash,
      taskCount: chain.length,
      completedAt: completionCompletedAt,
      driver: {
        revision: 15,
        runStartedAt: 16,
        attemptCount: acceptanceCriteria.length + 1,
        lastAttemptAt: completionCompletedAt,
        lastSuccessAt: completionCompletedAt,
        lastActionKind: "complete",
        lastOutcome: "success",
        updatedAt: completionCompletedAt,
      },
      workflow: {
        stage: "complete",
        revision: 4,
        route: workflowRoute,
        binding: {
          missionId: "mission-e2e",
          contractHash,
          contextHash,
          baseSha: INITIAL_HEAD_SHA,
          headSha: FINAL_HEAD_SHA,
          diffHash: finalDiffHash,
        },
      },
      milestones,
      stepReceipts,
    },
    repository: {
      initialHeadSha: INITIAL_HEAD_SHA,
      finalHeadSha: FINAL_HEAD_SHA,
      resultSha256: sha("content"),
      commitCount: 2,
      clean: true,
      changedBeforeWorker: false,
      exactSingleCommit: true,
    },
    failure: null,
  };
}
