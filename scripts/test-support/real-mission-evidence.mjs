import { createHash } from "node:crypto";

import { productWizardReceiptChainSha256 } from "../e2e-real-mission-contract.mjs";

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
const ACCEPTANCE_CRITERIA = Object.freeze([
  "O executor Codex do roster cria resultado.txt no próprio worktree — nunca o orquestrador nem o processo main.",
  "resultado.txt contém exatamente nexus-real-mission-e2e-ok seguido de newline.",
  "O próprio executor faz o commit local e chama nexus_handoff_submit; sessão e encarnação conferem com o primeiro dispatch.",
  "O motor Nexus integra o commit antes de liberar a tarefa dependente do revisor.",
  "O revisor Codex abre um segundo PTY físico, valida o HEAD integrado e chama nexus_handoff_submit sem commit vazio nem alteração cosmética.",
  "O motor Nexus emite worktree_validated_no_change para o revisor antes de liberar a tarefa dependente de QA.",
  "O QA Codex abre um terceiro PTY físico, consome o handoff do revisor e valida o HEAD integrado; o QA não deve editar, alterar ou escrever arquivos e chama nexus_handoff_submit sem mudança artificial.",
  "O motor Nexus emite o receipt final worktree_validated_no_change e marca a missão done sem atalho manual.",
]);
const PRODUCT_WIZARD_GOAL =
  'Entregue resultado.txt com o conteúdo exato "nexus-real-mission-e2e-ok\\n". ' +
  "O executor deve implementar e enviar seu handoff; depois um revisor independente " +
  "deve validar o HEAD integrado e enviar seu handoff; por fim o QA deve validar a " +
  "revisão integrada e enviar o terceiro handoff. O QA não deve editar, alterar ou " +
  "escrever arquivos nem criar mudança artificial. " +
  "O orquestrador não pode editar nem commitar o arquivo.";
const PRODUCT_WIZARD_ACCEPTANCE_CRITERIA = Object.freeze([
  `Objetivo concluído conforme: ${PRODUCT_WIZARD_GOAL}`,
]);

export function makeValidRealMissionEvidence({
  appVersion = "1.2.3",
  commitSha = "a".repeat(40),
  artifactSha256 = sha256("zip"),
  identity = "Developer ID Application: Cleofas Pereira rocha (35P5XL3JN6)",
  launchSurface = "product-wizard",
} = {}) {
  const finalHeadSha = "b".repeat(40);
  const expectedContentSha256 = sha256("nexus-real-mission-e2e-ok\n");
  const reviewerNoChangeDiffHash = sha256("reviewer-clean-diff");
  const qaNoChangeDiffHash = sha256("qa-clean-diff");
  const planHash = sha256("guided-plan");
  const sourceSquadRevisionHash = sha256("source-squad-revision");
  const runtimeSquadRevisionHash = sha256("runtime-squad-revision");
  const workspaceSha256 = sha256("workspace");
  const runtimeSquadId =
    "agentic-runtime-11111111-1111-4111-8111-111111111111";
  const contextHash = sha256("frozen-context");
  const contractHash = sha256("frozen-contract");
  const finalDiffHash = sha256("integrated-diff");
  const workflowBinding = {
    projectId: "project-real",
    checkoutId: "checkout-real",
    missionId: "mission-real",
    contextHash,
    contractHash,
    baseSha: "c".repeat(40),
    headSha: finalHeadSha,
    diffHash: finalDiffHash,
  };
  const acceptanceCriteria =
    launchSurface === "private-runner"
      ? ACCEPTANCE_CRITERIA
      : PRODUCT_WIZARD_ACCEPTANCE_CRITERIA;
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
      baseSha: "c".repeat(40),
      headSha: finalHeadSha,
      diffHash: finalDiffHash,
      workflowRevision: 3,
    },
    completedAt: 20,
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
  return {
    schemaVersion: 8,
    runId: "run-synthetic-fixture",
    appVersion,
    startedAt: 0,
    finishedAt: 20,
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
      tasks: [
        {
          plannerId: "guided-execution",
          taskId: "task-executor",
          agentRef: "e2e-executor",
          agentCategory: "executor",
          executionMode: "isolated_worktree",
          dependsOn: [],
        },
        {
          plannerId: "guided-review-e2e-reviewer-0",
          taskId: "task-reviewer",
          agentRef: "e2e-reviewer",
          agentCategory: "reviewer",
          executionMode: "read_only",
          dependsOn: ["task-executor"],
        },
        {
          plannerId: "guided-quality-gate",
          taskId: "task-qa",
          agentRef: "e2e-qa",
          agentCategory: "reviewer",
          executionMode: "read_only",
          dependsOn: ["task-reviewer"],
        },
      ],
    },
    panes: [
      {
        role: "orchestrator",
        paneId: "pane-orchestrator",
        adapterId: "codex",
        agentRef: "e2e-orchestrator",
        workerIncarnationId: null,
        sessionId: "session-orch",
        readOnly: false,
        nativeReadOnly: true,
        ptySpawnedAt: 1,
        ptyDataAt: 3,
        ptyChunkSha256: sha256("orchestrator-pty"),
      },
      {
        role: "worker",
        paneId: "pane-executor",
        adapterId: "codex",
        agentRef: "e2e-executor",
        workerIncarnationId: "incarnation-executor",
        sessionId: "session-executor",
        readOnly: false,
        nativeReadOnly: false,
        ptySpawnedAt: 4,
        ptyDataAt: 5,
        ptyChunkSha256: sha256("executor-pty"),
      },
      {
        role: "worker",
        paneId: "pane-reviewer",
        adapterId: "codex",
        agentRef: "e2e-reviewer",
        workerIncarnationId: "incarnation-reviewer",
        sessionId: "session-reviewer",
        readOnly: true,
        nativeReadOnly: true,
        ptySpawnedAt: 9,
        ptyDataAt: 10,
        ptyChunkSha256: sha256("reviewer-pty"),
      },
      {
        role: "worker",
        paneId: "pane-qa",
        adapterId: "codex",
        agentRef: "e2e-qa",
        workerIncarnationId: "incarnation-qa",
        sessionId: "session-qa",
        readOnly: true,
        nativeReadOnly: true,
        ptySpawnedAt: 14,
        ptyDataAt: 15,
        ptyChunkSha256: sha256("qa-pty"),
      },
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
    dispatches: [
      {
        taskId: "task-executor",
        plannerId: "guided-execution",
        agentRef: "e2e-executor",
        agentCategory: "executor",
        executionMode: "isolated_worktree",
        dependsOn: [],
        state: "completed",
        routeReservationId: "reservation-executor",
        routeConsumedAt: 4,
        routeConsumerMatches: true,
        workerIncarnationId: "incarnation-executor",
        sessionId: "session-executor",
        handoffId: "handoff-executor",
        handoffAcceptedAt: 7,
        completedAt: 8,
        integrationReceipt: {
          kind: "worktree_integrated",
          reference: finalHeadSha,
          completedAt: 8,
        },
      },
      {
        taskId: "task-reviewer",
        plannerId: "guided-review-e2e-reviewer-0",
        agentRef: "e2e-reviewer",
        agentCategory: "reviewer",
        executionMode: "read_only",
        dependsOn: ["task-executor"],
        state: "completed",
        routeReservationId: "reservation-reviewer",
        routeConsumedAt: 9,
        routeConsumerMatches: true,
        workerIncarnationId: "incarnation-reviewer",
        sessionId: "session-reviewer",
        handoffId: "handoff-reviewer",
        handoffAcceptedAt: 12,
        completedAt: 13,
        integrationReceipt: {
          kind: "worktree_validated_no_change",
          reference: `no-change:${finalHeadSha}:${reviewerNoChangeDiffHash}`,
          completedAt: 13,
          evidenceIds: ["sensor-typecheck", "review-independent"],
        },
      },
      {
        taskId: "task-qa",
        plannerId: "guided-quality-gate",
        agentRef: "e2e-qa",
        agentCategory: "reviewer",
        executionMode: "read_only",
        dependsOn: ["task-reviewer"],
        state: "completed",
        routeReservationId: "reservation-qa",
        routeConsumedAt: 14,
        routeConsumerMatches: true,
        workerIncarnationId: "incarnation-qa",
        sessionId: "session-qa",
        handoffId: "handoff-qa",
        handoffAcceptedAt: 17,
        completedAt: 18,
        integrationReceipt: {
          kind: "worktree_validated_no_change",
          reference: `no-change:${finalHeadSha}:${qaNoChangeDiffHash}`,
          completedAt: 18,
          evidenceIds: ["sensor-typecheck-qa", "qa-independent"],
        },
      },
    ],
    handoffs: [
      {
        id: "handoff-executor",
        sessionId: "session-executor",
        workerIncarnationId: "incarnation-executor",
        fromAgent: "E2E Executor",
        authorityOrigin: "agent",
        summarySha256: sha256("executor-handoff-summary"),
        physicalReceipt: {
          receiptId: "tool-call-executor",
          handoffId: "handoff-executor",
          toolCallId: "tool-call-executor",
          toolName: "nexus_handoff_submit",
          source: "http-mcp",
          missionId: "mission-real",
          sessionId: "session-executor",
          workerIncarnationId: "incarnation-executor",
          authoritySha256: sha256("executor-authority"),
          worktreeHeadSha: finalHeadSha,
          issuedAt: 6,
          worktreeHeadIntegrated: true,
        },
        auditIntent: {
          invocationId: "tool-call-executor",
          toolName: "nexus_handoff_submit",
          source: "http-mcp",
          sessionId: "session-executor",
          missionId: "mission-real",
          scope: {
            projectId: "project-real",
            checkoutId: "checkout-real",
          },
          occurredAt: 5,
        },
        status: "success",
        delivered: true,
        deliveryState: "consumed",
        consumedAt: 7,
        consumedBySessionId: "session-orch",
        consumedDeliveryAttemptId: "attempt-executor",
        deliveryAttempts: [
          {
            id: "attempt-executor",
            handoffId: "handoff-executor",
            missionId: "mission-real",
            orchestratorSessionId: "session-orch",
            attemptNo: 1,
            state: "accepted",
            startedAt: 6,
            acceptDeadlineAt: 8,
            acceptedAt: 7,
            failedAt: null,
            failureCode: null,
          },
        ],
      },
      {
        id: "handoff-reviewer",
        sessionId: "session-reviewer",
        workerIncarnationId: "incarnation-reviewer",
        fromAgent: "E2E Revisor",
        authorityOrigin: "agent",
        summarySha256: sha256("reviewer-handoff-summary"),
        physicalReceipt: {
          receiptId: "tool-call-reviewer",
          handoffId: "handoff-reviewer",
          toolCallId: "tool-call-reviewer",
          toolName: "nexus_handoff_submit",
          source: "http-mcp",
          missionId: "mission-real",
          sessionId: "session-reviewer",
          workerIncarnationId: "incarnation-reviewer",
          authoritySha256: sha256("reviewer-authority"),
          worktreeHeadSha: finalHeadSha,
          issuedAt: 11,
          worktreeHeadIntegrated: true,
        },
        auditIntent: {
          invocationId: "tool-call-reviewer",
          toolName: "nexus_handoff_submit",
          source: "http-mcp",
          sessionId: "session-reviewer",
          missionId: "mission-real",
          scope: {
            projectId: "project-real",
            checkoutId: "checkout-real",
          },
          occurredAt: 10,
        },
        status: "success",
        delivered: true,
        deliveryState: "consumed",
        consumedAt: 12,
        consumedBySessionId: "session-orch",
        consumedDeliveryAttemptId: "attempt-reviewer",
        deliveryAttempts: [
          {
            id: "attempt-reviewer",
            handoffId: "handoff-reviewer",
            missionId: "mission-real",
            orchestratorSessionId: "session-orch",
            attemptNo: 1,
            state: "accepted",
            startedAt: 11,
            acceptDeadlineAt: 13,
            acceptedAt: 12,
            failedAt: null,
            failureCode: null,
          },
        ],
      },
      {
        id: "handoff-qa",
        sessionId: "session-qa",
        workerIncarnationId: "incarnation-qa",
        fromAgent: "E2E QA",
        authorityOrigin: "agent",
        summarySha256: sha256("qa-handoff-summary"),
        physicalReceipt: {
          receiptId: "tool-call-qa",
          handoffId: "handoff-qa",
          toolCallId: "tool-call-qa",
          toolName: "nexus_handoff_submit",
          source: "http-mcp",
          missionId: "mission-real",
          sessionId: "session-qa",
          workerIncarnationId: "incarnation-qa",
          authoritySha256: sha256("qa-authority"),
          worktreeHeadSha: finalHeadSha,
          issuedAt: 16,
          worktreeHeadIntegrated: true,
        },
        auditIntent: {
          invocationId: "tool-call-qa",
          toolName: "nexus_handoff_submit",
          source: "http-mcp",
          sessionId: "session-qa",
          missionId: "mission-real",
          scope: {
            projectId: "project-real",
            checkoutId: "checkout-real",
          },
          occurredAt: 15,
        },
        status: "success",
        delivered: true,
        deliveryState: "consumed",
        consumedAt: 17,
        consumedBySessionId: "session-orch",
        consumedDeliveryAttemptId: "attempt-qa",
        deliveryAttempts: [
          {
            id: "attempt-qa",
            handoffId: "handoff-qa",
            missionId: "mission-real",
            orchestratorSessionId: "session-orch",
            attemptNo: 1,
            state: "accepted",
            startedAt: 16,
            acceptDeadlineAt: 18,
            acceptedAt: 17,
            failedAt: null,
            failureCode: null,
          },
        ],
      },
    ],
    durableHandoffs: {
      count: 3,
      ids: ["handoff-executor", "handoff-reviewer", "handoff-qa"],
    },
    dependencyConsumptions: [
      {
        missionId: "mission-real",
        consumerTaskId: "task-reviewer",
        dependencyTaskId: "task-executor",
        handoffId: "handoff-executor",
        consumerSessionId: "session-reviewer",
        consumerWorkerIncarnationId: "incarnation-reviewer",
        promptSha256: sha256("reviewer-accepted-prompt"),
        handoffSummarySha256: sha256("executor-handoff-summary"),
        consumedAt: 9,
      },
      {
        missionId: "mission-real",
        consumerTaskId: "task-qa",
        dependencyTaskId: "task-reviewer",
        handoffId: "handoff-reviewer",
        consumerSessionId: "session-qa",
        consumerWorkerIncarnationId: "incarnation-qa",
        promptSha256: sha256("qa-accepted-prompt"),
        handoffSummarySha256: sha256("reviewer-handoff-summary"),
        consumedAt: 14,
      },
    ],
    completion: {
      origin: "mission-driver-prevc",
      missionId: "mission-real",
      intentVersion: 1,
      orchestratorSessionId: "session-orch",
      planHash,
      taskCount: 3,
      completedAt: 20,
      driver: {
        revision: 15,
        runStartedAt: 1,
        attemptCount: 9,
        lastAttemptAt: 20,
        lastSuccessAt: 20,
        lastActionKind: "complete",
        lastOutcome: "success",
        updatedAt: 20,
      },
      workflow: {
        stage: "complete",
        revision: 4,
        route: ["planning", "execution", "validation-primary"],
        binding: {
          missionId: "mission-real",
          contractHash,
          contextHash,
          baseSha: "c".repeat(40),
          headSha: finalHeadSha,
          diffHash: finalDiffHash,
        },
      },
      milestones,
      stepReceipts,
    },
    repository: {
      initialHeadSha: "c".repeat(40),
      finalHeadSha,
      resultSha256: expectedContentSha256,
      commitCount: 2,
      clean: true,
      changedBeforeWorker: false,
      exactSingleCommit: true,
    },
  };
}
