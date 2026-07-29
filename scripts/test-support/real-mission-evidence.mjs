import { createHash } from "node:crypto";

import {
  REAL_MISSION_ADVISORS,
  REAL_MISSION_EVIDENCE_SCHEMA_VERSION,
  REAL_MISSION_PRODUCT_WIZARD_ACCEPTANCE_CRITERIA,
  productWizardReceiptChainSha256,
  realMissionAcceptanceCriteria,
  realMissionExpectedTaskChain,
} from "../e2e-real-mission-contract.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonicalJson = (value) => {
  const seen = new Set();
  const visit = (input, inArray) => {
    if (input === null) return "null";
    if (typeof input === "string" || typeof input === "boolean") {
      return JSON.stringify(input);
    }
    if (typeof input === "number") {
      if (!Number.isFinite(input)) throw new Error("non-finite canonical JSON");
      return JSON.stringify(Object.is(input, -0) ? 0 : input);
    }
    if (typeof input === "undefined") return inArray ? "null" : undefined;
    if (typeof input !== "object" || seen.has(input)) {
      throw new Error("unsupported canonical JSON");
    }
    seen.add(input);
    try {
      if (Array.isArray(input)) {
        return `[${input.map((item) => visit(item, true) ?? "null").join(",")}]`;
      }
      return `{${Object.keys(input)
        .sort()
        .flatMap((key) => {
          const encoded = visit(input[key], false);
          return encoded === undefined
            ? []
            : [`${JSON.stringify(key)}:${encoded}`];
        })
        .join(",")}}`;
    } finally {
      seen.delete(input);
    }
  };
  return visit(value, false);
};
const milestoneAttestationId = (missionId, stepId, binding) =>
  `milestone:${sha256(canonicalJson({
    version: "nexus-milestone-validation-v1",
    missionId,
    milestoneId: stepId,
    binding,
  }))}`;

const memberSlug = (agentRef) => agentRef.replace(/^e2e-/u, "");
const handoffSource = (member) =>
  member.kind === "advisory" && member.cli === "agy"
    ? "pty-stream"
    : "http-mcp";

export function makeValidRealMissionEvidence({
  appVersion = "1.2.3",
  commitSha = "a".repeat(40),
  artifactSha256 = sha256("zip"),
  identity = "Developer ID Application: Cleofas Pereira rocha (35P5XL3JN6)",
  launchSurface = "product-wizard",
  skipAdvisorClis = [],
  orchestratorCli = "codex",
} = {}) {
  const initialHeadSha = "c".repeat(40);
  const finalHeadSha = "b".repeat(40);
  const expectedContentSha256 = sha256("nexus-real-mission-e2e-ok\n");
  const planHash = sha256("guided-plan");
  const sourceSquadRevisionHash = sha256("source-squad-revision");
  const runtimeSquadRevisionHash = sha256("runtime-squad-revision");
  const workspaceSha256 = sha256("workspace");
  const runtimeSquadId =
    "agentic-runtime-11111111-1111-4111-8111-111111111111";
  const contextHash = sha256("frozen-context");
  const contractHash = sha256("frozen-contract");
  const finalDiffHash = sha256("integrated-diff");
  const skipped = new Set(skipAdvisorClis);
  // reserveClaude: na variante orquestrador Claude a advisor claude é
  // reservada — nunca vira worker.
  const claudeReserved = orchestratorCli === "claude";
  const presentAdvisorClis = REAL_MISSION_ADVISORS.filter(
    (advisor) =>
      !skipped.has(advisor.cli) &&
      !(claudeReserved && advisor.cli === "claude"),
  ).map((advisor) => advisor.cli);
  const chain = realMissionExpectedTaskChain(presentAdvisorClis);
  const workflowBinding = {
    projectId: "project-real",
    checkoutId: "checkout-real",
    missionId: "mission-real",
    contextHash,
    contractHash,
    baseSha: initialHeadSha,
    headSha: finalHeadSha,
    diffHash: finalDiffHash,
  };
  const acceptanceCriteria =
    launchSurface === "private-runner"
      ? realMissionAcceptanceCriteria(orchestratorCli, presentAdvisorClis)
      : REAL_MISSION_PRODUCT_WIZARD_ACCEPTANCE_CRITERIA;

  // Linha do tempo física do DAG: roots de advisory + executor se sobrepõem;
  // cada reviewer/QA começa somente depois do dependency receipt exato.
  const taskIdByPlannerId = new Map(
    chain.map((member) => [
      member.plannerId,
      `task-${memberSlug(member.agentRef)}`,
    ]),
  );
  const completedAtByPlannerId = new Map();
  let nextRootStart = 4;
  const timeline = chain.map((member) => {
    const dependencyTaskIds = member.dependsOnPlannerIds.map((plannerId) => {
      const taskId = taskIdByPlannerId.get(plannerId);
      if (!taskId) throw new Error(`unknown fixture dependency ${plannerId}`);
      return taskId;
    });
    const dependencyCompletedAt = member.dependsOnPlannerIds.map(
      (plannerId) => {
        const completedAt = completedAtByPlannerId.get(plannerId);
        if (completedAt === undefined) {
          throw new Error(`fixture dependency is not topological: ${plannerId}`);
        }
        return completedAt;
      },
    );
    const base =
      dependencyCompletedAt.length === 0
        ? nextRootStart++
        : Math.max(...dependencyCompletedAt) + 1;
    const completedAt = base + 5;
    completedAtByPlannerId.set(member.plannerId, completedAt);
    return {
      member,
      slug: memberSlug(member.agentRef),
      taskId: `task-${memberSlug(member.agentRef)}`,
      dependencyTaskIds,
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
      completedAt,
    };
  });
  const lastCompletedAt = Math.max(
    ...timeline.map((step) => step.completedAt),
  );
  const completionCompletedAt = lastCompletedAt + 1;
  const finishedAt = lastCompletedAt + 2;
  const headFor = (kind) =>
    kind === "advisory" ? initialHeadSha : finalHeadSha;

  const milestones = acceptanceCriteria.map((label, index) => ({
    stepId: `step-${index + 1}`,
    label,
    status: "done",
    evidenceIds: [
      milestoneAttestationId(
        "mission-real",
        `step-${index + 1}`,
        workflowBinding,
      ),
    ],
  }));
  const stepReceipts = milestones.map((milestone, index) => ({
    stepId: milestone.stepId,
    fromStage: "validation-primary",
    toStage:
      index === milestones.length - 1 ? "complete" : "validation-primary",
    workflowRevisionBefore: 3,
    workflowRevisionAfter: index === milestones.length - 1 ? 4 : 3,
    evidenceIds: [...milestone.evidenceIds],
    evidenceBinding: {
      missionId: "mission-real",
      contextRevision: contextHash,
      contractHash,
      baseSha: initialHeadSha,
      headSha: finalHeadSha,
      diffHash: finalDiffHash,
      workflowRevision: 3,
    },
    completedAt: completionCompletedAt,
  }));
  const productWizardReceiptCore = {
    origin: "main-owned-product-wizard-causal-chain",
    missionId: "mission-real",
    workspaceSha256,
    sourceSquadRevisionHash,
    squadRevisionHash: runtimeSquadRevisionHash,
    submittedContractSha256: sha256("submitted-contract"),
    approvedContractSha256: sha256("approved-contract"),
    armedAt: 0,
    intentSubmittedAt: 0,
    nativeDialogOpenedAt: 0,
    nativeDialogAcceptedAt: 0,
    approvalReturnedAt: 1,
  };
  const codexWorkerPane = (agentRef) => {
    const step = timeline.find(
      (candidate) => candidate.member.agentRef === agentRef,
    );
    const readOnly = agentRef !== "e2e-executor";
    return {
      role: "worker",
      paneId: `pane-${step.slug}`,
      adapterId: "codex",
      agentRef,
      workerIncarnationId: `incarnation-${step.slug}`,
      sessionId: `session-${step.slug}`,
      readOnly,
      nativeReadOnly: false,
      ptySpawnedAt: step.spawnedAt,
      ptyDataAt: step.ptyDataAt,
      ptyChunkSha256: sha256(`${step.slug}-pty`),
    };
  };
  return {
    schemaVersion: REAL_MISSION_EVIDENCE_SCHEMA_VERSION,
    runId: "run-synthetic-fixture",
    appVersion,
    startedAt: 0,
    finishedAt,
    status: "pass",
    failure: null,
    workspaceSha256,
    expectedContentSha256,
    coverageTier: "guided-delivery-core",
    planOrigin: "production-guided-planner",
    prevcOrigin: "e2e-fixture",
    reviewOrigin: "production-physical-worker",
    qaOrigin: "production-physical-worker",
    launchSurface,
    wizardCoverage:
      launchSurface === "private-runner"
        ? "not-covered"
        : "main-owned-product-sequence",
    wizardReceipt:
      launchSurface === "private-runner"
        ? null
        : {
            ...productWizardReceiptCore,
            chainSha256: productWizardReceiptChainSha256(
              productWizardReceiptCore,
            ),
          },
    runtimeAttestation: {
      version: 1,
      algorithm: "hmac-sha256",
      challengeSha256: sha256("synthetic-challenge"),
      bindingSha256: sha256("synthetic-binding"),
      evidenceSha256: sha256("synthetic-evidence"),
      macSha256: sha256("synthetic-mac"),
    },
    interaction: {
      evidenceOrigin: "main-owned-instrumentation",
      nativeDialogCount: 1,
      missionApprovalDialogCount: 1,
      missionApprovalAcceptedCount: 1,
      codexMcpPromptCount: 0,
    },
    release: {
      appVersion,
      runId: "3e112472-c72f-4f5e-b6bd-e9cae5c9c413",
      startedAt: "2026-07-23T10:00:00.000Z",
      finishedAt: "2026-07-23T10:01:00.000Z",
      commitSha,
      artifact: {
        sha256: artifactSha256,
        identity,
      },
    },
    mission: {
      id: "mission-real",
      status: "done",
      intentState: "done",
      intentVersion: 1,
      squadId:
        launchSurface === "private-runner"
          ? "agentic-nexus-real-mission-e2e"
          : runtimeSquadId,
      squadSourceId: "agentic-nexus-real-mission-e2e",
      squadSourceRevisionHash: sourceSquadRevisionHash,
      squadRevisionHash:
        launchSurface === "private-runner"
          ? sourceSquadRevisionHash
          : runtimeSquadRevisionHash,
      approvedAt: 0,
      dispatchedAt: 1,
    },
    missionInventory: {
      evidenceOrigin: "main-owned-mission-store-inventory",
      selectedMissionId: "mission-real",
      observedMissionCount: 1,
      observedMissionIds: ["mission-real"],
      finalMissionCount: 1,
      finalMissionIds: ["mission-real"],
      exactSingleProductMission: true,
    },
    kickoff: {
      sessionId: "session-orch",
      idleAt: 1,
      busyAt: 2,
      ptyDataAt: 3,
      ptyChunkSha256: sha256("kickoff-pty"),
    },
    plan: {
      version: 1,
      squadId:
        launchSurface === "private-runner"
          ? "agentic-nexus-real-mission-e2e"
          : runtimeSquadId,
      planHash,
      rosterHash: sha256("guided-roster"),
      tasks: timeline.map((step) => ({
        plannerId: step.member.plannerId,
        taskId: step.taskId,
        agentRef: step.member.agentRef,
        agentCategory: step.member.agentCategory,
        executionMode: step.member.executionMode,
        dependsOn: [...step.dependencyTaskIds],
      })),
    },
    panes: [
      {
        role: "orchestrator",
        paneId: "pane-orchestrator",
        adapterId: orchestratorCli,
        agentRef: "e2e-orchestrator",
        workerIncarnationId: null,
        sessionId: "session-orch",
        readOnly: false,
        nativeReadOnly: false,
        ptySpawnedAt: 1,
        ptyDataAt: 3,
        ptyChunkSha256: sha256("orchestrator-pty"),
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
    dispatches: timeline.map((step) => ({
      taskId: step.taskId,
      plannerId: step.member.plannerId,
      agentRef: step.member.agentRef,
      agentCategory: step.member.agentCategory,
      executionMode: step.member.executionMode,
      dependsOn: [...step.dependencyTaskIds],
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
              reference: finalHeadSha,
              completedAt: step.completedAt,
            }
          : {
              kind: "worktree_validated_no_change",
              reference: `no-change:${headFor(step.member.kind)}:${sha256(`${step.slug}-clean-diff`)}`,
              completedAt: step.completedAt,
              evidenceIds: [`sensor-${step.slug}`],
            },
    })),
    handoffs: timeline.map((step) => ({
      id: `handoff-${step.slug}`,
      sessionId: `session-${step.slug}`,
      workerIncarnationId: `incarnation-${step.slug}`,
      fromAgent: step.member.agentName,
      authorityOrigin: "agent",
      summarySha256: sha256(`${step.slug}-handoff-summary`),
      physicalReceipt: {
        receiptId: `tool-call-${step.slug}`,
        handoffId: `handoff-${step.slug}`,
        toolCallId: `tool-call-${step.slug}`,
        toolName: "nexus_handoff_submit",
        source: handoffSource(step.member),
        missionId: "mission-real",
        sessionId: `session-${step.slug}`,
        workerIncarnationId: `incarnation-${step.slug}`,
        authoritySha256: sha256(`${step.slug}-authority`),
        worktreeHeadSha: headFor(step.member.kind),
        issuedAt: step.issuedAt,
        worktreeHeadIntegrated: true,
      },
      auditIntent: {
        invocationId: `tool-call-${step.slug}`,
        toolName: "nexus_handoff_submit",
        source: handoffSource(step.member),
        sessionId: `session-${step.slug}`,
        missionId: "mission-real",
        scope: {
          projectId: "project-real",
          checkoutId: "checkout-real",
        },
        occurredAt: step.auditOccurredAt,
      },
      status: "success",
      delivered: true,
      deliveryState: "consumed",
      consumedAt: step.handoffConsumedAt,
      consumedBySessionId: "session-orch",
      consumedDeliveryAttemptId: `attempt-${step.slug}`,
      deliveryAttempts: [
        {
          id: `attempt-${step.slug}`,
          handoffId: `handoff-${step.slug}`,
          missionId: "mission-real",
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
    })),
    durableHandoffs: {
      count: timeline.length,
      ids: timeline.map((step) => `handoff-${step.slug}`),
    },
    dependencyConsumptions: timeline.flatMap((step) =>
      step.dependencyTaskIds.map((dependencyTaskId) => {
        const dependency = timeline.find(
          (candidate) => candidate.taskId === dependencyTaskId,
        );
        if (!dependency) {
          throw new Error(`unknown fixture dependency task ${dependencyTaskId}`);
        }
        return {
          missionId: "mission-real",
          consumerTaskId: step.taskId,
          dependencyTaskId: dependency.taskId,
          handoffId: `handoff-${dependency.slug}`,
          consumerSessionId: `session-${step.slug}`,
          consumerWorkerIncarnationId: `incarnation-${step.slug}`,
          promptSha256: sha256(`${step.slug}-accepted-prompt`),
          handoffSummarySha256: sha256(
            `${dependency.slug}-handoff-summary`,
          ),
          consumedAt: step.consumedDependencyAt,
        };
      }),
    ),
    participation: REAL_MISSION_ADVISORS.map((advisor) => {
      const step = timeline.find(
        (candidate) => candidate.member.agentRef === advisor.id,
      );
      if (!step) {
        return {
          cli: advisor.cli,
          tier: advisor.tier,
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
        tier: advisor.tier,
        skipped: null,
        spawnedAt: step.spawnedAt,
        firstNexusToolAt: step.firstNexusToolAt,
        handoffAt: step.issuedAt,
      };
    }),
    completion: {
      origin: "mission-driver-prevc",
      missionId: "mission-real",
      intentVersion: 1,
      orchestratorSessionId: "session-orch",
      planHash,
      taskCount: chain.length,
      completedAt: completionCompletedAt,
      driver: {
        revision: 15,
        runStartedAt: 1,
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
        route: ["planning", "execution", "validation-primary"],
        binding: {
          missionId: "mission-real",
          contractHash,
          contextHash,
          baseSha: initialHeadSha,
          headSha: finalHeadSha,
          diffHash: finalDiffHash,
        },
      },
      milestones,
      stepReceipts,
    },
    repository: {
      initialHeadSha,
      finalHeadSha,
      resultSha256: expectedContentSha256,
      commitCount: 2,
      clean: true,
      changedBeforeWorker: false,
      exactSingleCommit: true,
    },
  };
}
