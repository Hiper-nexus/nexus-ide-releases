import { z } from "zod";

import { isMissionRuntimeSquadId } from "./orch-types";
import {
  REAL_MISSION_E2E_ADVISORS,
  REAL_MISSION_E2E_EVIDENCE_SCHEMA_VERSION,
  REAL_MISSION_E2E_EXECUTOR_ID,
  REAL_MISSION_E2E_ORCHESTRATOR_ID,
  REAL_MISSION_E2E_PRODUCT_WIZARD_ACCEPTANCE_CRITERIA,
  REAL_MISSION_E2E_QA_ID,
  REAL_MISSION_E2E_REVIEWER_ID,
  REAL_MISSION_E2E_SQUAD_ID,
  realMissionE2EAcceptanceCriteria,
  realMissionE2EAdvisorTier,
  realMissionE2EExpectedTaskChain,
} from "./real-mission-e2e-contract";
import {
  advisorParticipationProofSchema,
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
  productWizardReceiptSchema,
  qaOriginSchema,
  realMissionRuntimeAttestationSchema,
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
    wizardReceipt: productWizardReceiptSchema.nullable(),
    runtimeAttestation: realMissionRuntimeAttestationSchema.nullable(),
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
    participation: z
      .array(advisorParticipationProofSchema)
      .length(REAL_MISSION_E2E_ADVISORS.length),
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
    if (
      evidence.launchSurface === "private-runner" &&
      evidence.wizardReceipt !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["wizardReceipt"],
        message: "private runner cannot carry a product-wizard receipt",
      });
    }
    // O receipt causal é obrigatório apenas no PASS. Um FAIL de product-wizard
    // (wizard nunca executado, timeout, setup) fecha com wizardReceipt nulo —
    // exigir a cadeia causal aqui derrubava o processo com ZodError em vez de
    // persistir a evidência de falha.
    if (
      evidence.launchSurface === "product-wizard" &&
      evidence.status === "pass" &&
      (evidence.wizardCoverage !== "main-owned-product-sequence" ||
        evidence.wizardReceipt === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["wizardReceipt"],
        message: "product-wizard coverage requires a causal main-owned receipt",
      });
    }
    if (
      evidence.wizardReceipt !== null &&
      (evidence.wizardReceipt.workspaceSha256 !== evidence.workspaceSha256 ||
        evidence.wizardReceipt.approvalReturnedAt > evidence.finishedAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["wizardReceipt"],
        message: "product-wizard receipt is outside the evidence boundary",
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
    // O roster advisor é canônico: as seis CLIs na ordem do contrato, com o
    // tier de confinamento exato. Advisors skipped não podem carregar recibos.
    if (
      !evidence.participation.every(
        (row, index) =>
          row.cli === REAL_MISSION_E2E_ADVISORS[index]!.cli &&
          row.tier === realMissionE2EAdvisorTier(row.cli) &&
          (row.skipped === null ||
            (row.spawnedAt === null &&
              row.firstNexusToolAt === null &&
              row.handoffAt === null)),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["participation"],
        message: "advisor participation is not the canonical harness roster",
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
        (pane.adapterId === "codex" || pane.adapterId === "claude"),
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
    // O DAG selado é derivado do roster advisor presente: scouts e executor
    // são raízes do fan-out; a cadeia de reviewers parte do executor e termina
    // no QA. Advisors skipped por credencial/reserva ficam fora do grafo —
    // eles nunca ganharam task no plano. Um advisor `provider-rerouted` é o
    // OPOSTO: a task selada dele EXISTE e foi entregue pelo substituto (a
    // diretiva durável prova a origem), então o membro permanece na cadeia;
    // só a participação PESSOAL é dispensada.
    const presentAdvisorClis = evidence.participation
      .filter(
        (row) =>
          row.skipped === null || row.skipped === "provider-rerouted",
      )
      .map((row) => row.cli);
    const chain = realMissionE2EExpectedTaskChain(presentAdvisorClis);
    const chainPlans = chain.map((member) =>
      evidence.plan?.tasks.find(
        (task) =>
          task.plannerId === member.plannerId &&
          task.agentRef === member.agentRef,
      ),
    );
    // Substituição por reroute: o dispatch da task selada pode carregar o
    // agentRef do SUBSTITUTO; a diretiva durável prova a origem selada.
    const chainDispatches = chain.map((member) =>
      evidence.dispatches.find(
        (dispatch) =>
          dispatch.plannerId === member.plannerId &&
          (dispatch.agentRef === member.agentRef ||
            dispatch.providerReroute?.fromAgentRef === member.agentRef),
      ),
    );
    const chainHandoffs = chainDispatches.map((dispatch) =>
      evidence.handoffs.find((handoff) => handoff.id === dispatch?.handoffId),
    );
    const chainReceipts = chainDispatches.map(
      (dispatch) => dispatch?.integrationReceipt ?? null,
    );
    const chainIndexByPlannerId = new Map(
      chain.map((member, index) => [member.plannerId, index]),
    );
    const expectedDependencyTaskIds = (
      member: (typeof chain)[number],
    ): readonly string[] | null => {
      const ids = member.dependsOnPlannerIds.map((plannerId) => {
        const dependencyIndex = chainIndexByPlannerId.get(plannerId);
        return dependencyIndex === undefined
          ? undefined
          : chainPlans[dependencyIndex]?.taskId;
      });
      return ids.every((taskId): taskId is string => Boolean(taskId))
        ? ids
        : null;
    };
    const exactDependencies = (
      actual: readonly string[],
      member: (typeof chain)[number],
    ): boolean => {
      const expected = expectedDependencyTaskIds(member);
      return Boolean(
        expected &&
          actual.length === expected.length &&
          actual.every((taskId, index) => taskId === expected[index]),
      );
    };
    const chainNoChangeReferences = chainReceipts.map((receipt) =>
      receipt?.kind === "worktree_validated_no_change"
        ? /^no-change:([a-f0-9]{40,64}):([a-f0-9]{64})$/u.exec(
            receipt.reference,
          )
        : null,
    );
    const isNonExecutionValidationReceipt = (
      receipt: (typeof chainReceipts)[number],
    ): boolean =>
      (receipt?.kind === "worktree_validated_no_change" &&
        /^no-change:[a-f0-9]{40,64}:[a-f0-9]{64}$/u.test(receipt.reference)) ||
      (receipt?.kind === "read_only_validated" &&
        /^[a-f0-9]{64}$/u.test(receipt.reference) &&
        receipt.evidenceIds.length > 0);
    const executorIndex = chain.findIndex(
      (member) => member.kind === "execution",
    );
    const reviewerIndex = chain.findIndex(
      (member) => member.agentRef === REAL_MISSION_E2E_REVIEWER_ID,
    );
    const qaIndex = chain.length - 1;
    const executorPlan = chainPlans[executorIndex];
    const reviewerPlan = chainPlans[reviewerIndex];
    const qaPlan = chainPlans[qaIndex];
    const executorDispatch = chainDispatches[executorIndex];
    const reviewerDispatch = chainDispatches[reviewerIndex];
    const qaDispatch = chainDispatches[qaIndex];
    const executorReceipt =
      executorDispatch?.integrationReceipt?.kind === "worktree_integrated"
        ? executorDispatch.integrationReceipt
        : null;
    const reviewerReceipt = isNonExecutionValidationReceipt(
      reviewerDispatch?.integrationReceipt ?? null,
    )
      ? reviewerDispatch!.integrationReceipt
      : null;
    const qaReceipt = isNonExecutionValidationReceipt(
      qaDispatch?.integrationReceipt ?? null,
    )
      ? qaDispatch!.integrationReceipt
      : null;
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
    // A lista de critérios da variante deriva do orquestrador físico provado
    // nos panes: Claude carrega o critério extra de variante; codex, a base.
    const expectedAcceptanceCriteria =
      evidence.launchSurface === "product-wizard"
        ? REAL_MISSION_E2E_PRODUCT_WIZARD_ACCEPTANCE_CRITERIA
        : realMissionE2EAcceptanceCriteria(
            orchestrators[0]?.adapterId === "claude" ? "claude" : "codex",
            presentAdvisorClis,
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
        // Final validation has already advanced PREVC to confirmation before
        // the mission driver consumes its ordered milestone attestations.
        // Accepting an older validation-stage receipt would no longer prove
        // the current atomic completion path exercised by the product.
        receipt.fromStage === "confirmation" &&
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
      completionMilestones.length === expectedAcceptanceCriteria.length &&
      completionMilestones.every(
        (milestone, index) =>
          milestone.stepId === `step-${index + 1}` &&
          milestone.label === expectedAcceptanceCriteria[index] &&
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
    const deliveryAuthorityMatches = (
      handoff: (typeof evidence.handoffs)[number],
      accepted: (typeof evidence.handoffs)[number]["deliveryAttempts"][number],
    ): boolean => {
      const hasNoManualConsumption =
        handoff.consumedAt === null &&
        handoff.consumedBySessionId === null &&
        handoff.consumedDeliveryAttemptId === null;
      if (
        handoff.deliveryState === "submitted" ||
        handoff.deliveryState === "acknowledged"
      ) {
        return hasNoManualConsumption;
      }
      return (
        handoff.deliveryState === "consumed" &&
        handoff.consumedAt !== null &&
        accepted.acceptedAt !== null &&
        accepted.acceptedAt <= handoff.consumedAt &&
        handoff.consumedBySessionId === evidence.kickoff.sessionId &&
        handoff.consumedDeliveryAttemptId === accepted.id
      );
    };
    const handoffMatchesDispatch = (
      handoff: (typeof evidence.handoffs)[number] | undefined,
      dispatch: (typeof evidence.dispatches)[number] | undefined,
      member: (typeof chain)[number],
    ): boolean => {
      if (!handoff || !dispatch) return false;
      const physical = handoff.physicalReceipt;
      const audit = handoff.auditIntent;
      const accepted = exactAcceptedAttempt(handoff);
      // Substituição por reroute: a diretiva durável (validada em CAS no
      // claim) vincula este dispatch ao membro selado original — o handoff é
      // fisicamente do SUBSTITUTO, então nome e superfície esperados são os
      // dele, resolvidos pelo roster canônico do harness.
      const substitute =
        dispatch.providerReroute &&
        dispatch.providerReroute.fromAgentRef === member.agentRef
          ? (REAL_MISSION_E2E_ADVISORS.find(
              (advisor) =>
                advisor.id === dispatch.providerReroute?.toAgentRef,
            ) ?? null)
          : null;
      const expectedFromAgent = substitute?.name ?? member.agentName;
      const expectedCli = substitute?.cli ?? member.cli;
      const expectedSource =
        member.kind === "advisory" && expectedCli === "agy"
          ? "pty-stream"
          : "http-mcp";
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
          physical.source === expectedSource &&
          audit.source === physical.source &&
          audit.missionId === physical.missionId &&
          audit.sessionId === physical.sessionId &&
          audit.occurredAt <= physical.issuedAt &&
          physical.issuedAt <= (dispatch.handoffAcceptedAt ?? -1) &&
          physical.issuedAt <= (accepted.acceptedAt ?? -1) &&
          handoff.fromAgent === expectedFromAgent &&
          handoff.sessionId === dispatch.sessionId &&
          handoff.workerIncarnationId === dispatch.workerIncarnationId &&
          handoff.status === "success" &&
          handoff.delivered &&
          accepted.acceptedAt !== null &&
          accepted.failedAt === null &&
          accepted.failureCode === null &&
          accepted.acceptDeadlineAt !== null &&
          accepted.startedAt <= accepted.acceptedAt &&
          accepted.acceptedAt <= accepted.acceptDeadlineAt &&
          deliveryAuthorityMatches(handoff, accepted),
      );
    };
    const chainPlanIsExact =
      evidence.plan !== null &&
      evidence.plan.tasks.length === chain.length &&
      chain.every((member, index) => {
        const task = chainPlans[index];
        if (!task) return false;
        return (
          task.agentCategory === member.agentCategory &&
          task.executionMode === member.executionMode &&
          exactDependencies(task.dependsOn, member)
        );
      });
    const chainDispatchIsExact =
      evidence.dispatches.length === chain.length &&
      chain.every((member, index) => {
        const dispatch = chainDispatches[index];
        const receipt = chainReceipts[index];
        return Boolean(
          dispatch &&
            dispatch.taskId === chainPlans[index]?.taskId &&
            dispatch.agentCategory === member.agentCategory &&
            dispatch.executionMode === member.executionMode &&
            exactDependencies(dispatch.dependsOn, member) &&
            completedDispatchIsPhysical(dispatch) &&
            (member.kind === "execution"
              ? receipt?.kind === "worktree_integrated"
              : isNonExecutionValidationReceipt(receipt)),
        );
      });
    const chainHandoffIsExact =
      evidence.handoffs.length === chain.length &&
      exactDurableHandoffSet &&
      chain.every((member, index) =>
        handoffMatchesDispatch(
          chainHandoffs[index],
          chainDispatches[index],
          member,
        ),
      ) &&
      new Set(chainHandoffs.map((handoff) => handoff?.id)).size ===
        chain.length &&
      new Set(chainHandoffs.map((handoff) => handoff?.sessionId)).size ===
        chain.length &&
      new Set(chainHandoffs.map((handoff) => handoff?.workerIncarnationId))
        .size === chain.length &&
      new Set(
        chainHandoffs.map((handoff) => handoff?.physicalReceipt?.receiptId),
      ).size === chain.length &&
      new Set(
        chainHandoffs.map((handoff) => handoff?.physicalReceipt?.toolCallId),
      ).size === chain.length &&
      chainHandoffs.every(
        (handoff) =>
          handoff?.auditIntent?.scope.projectId ===
            chainHandoffs[0]?.auditIntent?.scope.projectId &&
          handoff?.auditIntent?.scope.checkoutId ===
            chainHandoffs[0]?.auditIntent?.scope.checkoutId,
      );
    // Advisors e executor são raízes independentes: com capacidade limitada,
    // um advisor pode observar o HEAD inicial até a integração ou o HEAD final
    // somente a partir do receipt de integração. O SHA e o issuedAt precisam
    // contar a mesma história causal; nenhum terceiro HEAD é aceito. O revisor
    // codex e o QA dependem da cadeia e validam sempre o HEAD final integrado.
    // Receipts worktree_validated_no_change ainda precisam selar exatamente o
    // mesmo HEAD observado fisicamente; read_only_validated exige só esse HEAD.
    const chainHeadIsExact = chain.every((member, index) => {
      const physicalReceipt = chainHandoffs[index]?.physicalReceipt;
      const head = physicalReceipt?.worktreeHeadSha;
      const receipt = chainReceipts[index];
      const noChangeHead = chainNoChangeReferences[index]?.[1];
      if (member.kind === "advisory") {
        const executorIntegratedAt = executorReceipt?.completedAt;
        const headMatchesIntegrationChronology =
          executorIntegratedAt !== undefined &&
          ((head === evidence.repository.initialHeadSha &&
            (physicalReceipt?.issuedAt ?? Number.MAX_SAFE_INTEGER) <=
              executorIntegratedAt) ||
            (head === evidence.repository.finalHeadSha &&
              (physicalReceipt?.issuedAt ?? -1) >= executorIntegratedAt));
        if (receipt?.kind === "read_only_validated") {
          return headMatchesIntegrationChronology;
        }
        return headMatchesIntegrationChronology && noChangeHead === head;
      }
      if (member.kind === "execution") {
        return (
          head !== null &&
          head !== undefined &&
          head !== evidence.repository.initialHeadSha
        );
      }
      if (receipt?.kind === "read_only_validated") {
        return head === evidence.repository.finalHeadSha;
      }
      return (
        head === evidence.repository.finalHeadSha &&
        noChangeHead === evidence.repository.finalHeadSha
      );
    });
    const dependencyEdges = chain.flatMap((member, consumerIndex) =>
      member.dependsOnPlannerIds.map((plannerId) => ({
        consumerIndex,
        dependencyIndex: chainIndexByPlannerId.get(plannerId) ?? -1,
      })),
    );
    const chainConsumptionIsExact =
      evidence.dependencyConsumptions.length === dependencyEdges.length &&
      dependencyEdges.every(({ consumerIndex, dependencyIndex }) => {
        if (dependencyIndex < 0) return false;
        const dispatch = chainDispatches[consumerIndex];
        const receipt = evidence.dependencyConsumptions.find(
          (candidate) =>
            candidate.consumerTaskId === dispatch?.taskId &&
            candidate.dependencyTaskId ===
              chainDispatches[dependencyIndex]?.taskId,
        );
        const dependencyDispatch = chainDispatches[dependencyIndex];
        const dependencyHandoff = chainHandoffs[dependencyIndex];
        return Boolean(
          receipt &&
            receipt.missionId === evidence.mission?.id &&
            receipt.dependencyTaskId === dependencyDispatch?.taskId &&
            receipt.handoffId === dependencyHandoff?.id &&
            receipt.consumerSessionId === dispatch?.sessionId &&
            receipt.consumerWorkerIncarnationId ===
              dispatch?.workerIncarnationId &&
            receipt.handoffSummarySha256 ===
              dependencyHandoff?.summarySha256 &&
            (dependencyDispatch?.completedAt ?? Number.MAX_SAFE_INTEGER) <=
              receipt.consumedAt &&
            receipt.consumedAt <= (dispatch?.handoffAcceptedAt ?? -1) &&
            receipt.consumedAt <=
              (chainHandoffs[consumerIndex]?.auditIntent?.occurredAt ?? -1),
        );
      });
    const chainTimingIsExact =
      chain.every((member, index) => {
        const receipt = chainReceipts[index];
        const dispatch = chainDispatches[index];
        const handoff = chainHandoffs[index];
        const dependencies = member.dependsOnPlannerIds.map((plannerId) => {
          const dependencyIndex = chainIndexByPlannerId.get(plannerId);
          return dependencyIndex === undefined
            ? null
            : chainReceipts[dependencyIndex];
        });
        return Boolean(
          receipt &&
            receipt.completedAt === dispatch?.completedAt &&
            (handoff?.physicalReceipt?.issuedAt ?? Number.MAX_SAFE_INTEGER) <=
              receipt.completedAt &&
            dependencies.every(
              (dependencyReceipt) =>
                dependencyReceipt !== null &&
                dependencyReceipt.completedAt <=
                  (dispatch?.routeConsumedAt ?? -1) &&
                dependencyReceipt.completedAt <=
                  (handoff?.physicalReceipt?.issuedAt ?? -1),
            ),
        );
      }) &&
      chainHandoffs.every((handoff) => {
        if (!handoff) return false;
        const accepted = exactAcceptedAttempt(handoff);
        const deliveredAt = handoff.consumedAt ?? accepted?.acceptedAt;
        return (
          deliveredAt !== null &&
          deliveredAt !== undefined &&
          deliveredAt <= (completion?.completedAt ?? -1)
        );
      });
    // Cada advisor credenciada prova PTY físico, primeira ação nexus_* e o
    // handoff físico; handoffAt casa exatamente com o receipt Main-owned.
    const participationIsExact = evidence.participation.every((row) => {
      if (row.skipped !== null) return true;
      const advisor = REAL_MISSION_E2E_ADVISORS.find(
        (candidate) => candidate.cli === row.cli,
      );
      const index = chain.findIndex(
        (member) => member.agentRef === advisor?.id,
      );
      const handoff = index >= 0 ? chainHandoffs[index] : undefined;
      return Boolean(
        advisor &&
          index >= 0 &&
          row.spawnedAt !== null &&
          row.firstNexusToolAt !== null &&
          row.handoffAt !== null &&
          row.spawnedAt <= row.firstNexusToolAt &&
          row.firstNexusToolAt <= row.handoffAt &&
          row.spawnedAt >= evidence.startedAt &&
          row.handoffAt <= evidence.finishedAt &&
          handoff?.physicalReceipt &&
          row.handoffAt === handoff.physicalReceipt.issuedAt,
      );
    });
    // Conjunção final NOMEADA: quando o PASS falha, a mensagem lista QUAIS
    // grupos falharam — uma noite de gates provou que "missing one or more"
    // sem nome custa um ciclo inteiro de build para descobrir o conjunto.
    const invariantGroups: ReadonlyArray<readonly [string, boolean]> = [
      [
        "provenance",
        evidence.failure === null &&
          evidence.coverageTier === "guided-delivery-core" &&
          evidence.planOrigin === "production-guided-planner" &&
          evidence.prevcOrigin === "e2e-fixture" &&
          evidence.reviewOrigin === "production-physical-worker" &&
          evidence.qaOrigin === "production-physical-worker",
      ],
      [
        "launchSurfaceReceipt",
        (evidence.launchSurface === "private-runner" &&
          evidence.wizardCoverage === "not-covered" &&
          evidence.wizardReceipt === null) ||
          (evidence.launchSurface === "product-wizard" &&
            evidence.wizardCoverage === "main-owned-product-sequence" &&
            evidence.wizardReceipt !== null &&
            evidence.wizardReceipt.missionId === evidence.mission?.id &&
            evidence.wizardReceipt.workspaceSha256 ===
              evidence.workspaceSha256 &&
            evidence.wizardReceipt.sourceSquadRevisionHash ===
              evidence.mission?.squadSourceRevisionHash &&
            evidence.wizardReceipt.squadRevisionHash ===
              evidence.mission?.squadRevisionHash &&
            evidence.wizardReceipt.nativeDialogAcceptedAt <=
              (evidence.mission?.approvedAt ?? -1) &&
            (evidence.mission?.approvedAt ?? -1) <=
              evidence.wizardReceipt.approvalReturnedAt &&
            (evidence.mission?.dispatchedAt ?? -1) <=
              evidence.wizardReceipt.approvalReturnedAt),
      ],
      [
        "interaction",
        evidence.interaction.evidenceOrigin ===
          "main-owned-instrumentation" &&
          evidence.interaction.nativeDialogCount === 1 &&
          evidence.interaction.missionApprovalDialogCount === 1 &&
          evidence.interaction.missionApprovalAcceptedCount === 1 &&
          evidence.interaction.codexMcpPromptCount === 0,
      ],
      [
        "missionState",
        evidence.mission !== null &&
          evidence.mission.status === "done" &&
          exactMissionInventory &&
          evidence.mission.intentState === "done" &&
          evidence.mission.intentVersion === 1,
      ],
      [
        "missionIdentity",
        evidence.mission !== null &&
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
          evidence.mission.dispatchedAt <= (evidence.kickoff.idleAt ?? -1),
      ],
      [
        "kickoff",
        evidence.kickoff.sessionId !== null &&
          evidence.kickoff.idleAt !== null &&
          evidence.kickoff.busyAt !== null &&
          evidence.kickoff.ptyDataAt !== null &&
          evidence.kickoff.ptyChunkSha256 !== null &&
          evidence.kickoff.idleAt <= evidence.kickoff.busyAt &&
          evidence.kickoff.idleAt <= evidence.kickoff.ptyDataAt,
      ],
      ["chainPlanIsExact", chainPlanIsExact],
      [
        "physicalPanes",
        evidence.panes.length === 4 &&
          orchestrators.length === 1 &&
          executors.length === 1 &&
          reviewers.length === 1 &&
          qualityAssurers.length === 1 &&
          evidence.panes.every(physicalPaneIsComplete) &&
          exactPhysicalPtySet &&
          new Set(evidence.panes.map((pane) => pane.sessionId)).size === 4,
      ],
      [
        "mutationAuthority",
        orchestrators[0]?.readOnly === false &&
          orchestrators[0]?.nativeReadOnly === false &&
          executors[0]?.readOnly === false &&
          executors[0]?.nativeReadOnly === false &&
          reviewers[0]?.readOnly === true &&
          reviewers[0]?.nativeReadOnly === false &&
          qualityAssurers[0]?.readOnly === true &&
          qualityAssurers[0]?.nativeReadOnly === false &&
          executors[0]?.workerIncarnationId !== null &&
          reviewers[0]?.workerIncarnationId !== null &&
          qualityAssurers[0]?.workerIncarnationId !== null,
      ],
      [
        // Variante coerente: orquestrador Claude exige a advisor claude marcada
        // orchestrator-reserved (reserveClaude); orquestrador codex proíbe essa
        // marca (lá a advisor claude participa, é no-credential ou foi
        // re-roteada).
        "orchestratorVariant",
        (orchestrators[0]?.adapterId === "claude" &&
          evidence.participation.find((row) => row.cli === "claude")
            ?.skipped === "orchestrator-reserved") ||
          (orchestrators[0]?.adapterId === "codex" &&
            evidence.participation.find((row) => row.cli === "claude")
              ?.skipped !== "orchestrator-reserved"),
      ],
      ["chainDispatchIsExact", chainDispatchIsExact],
      ["chainHandoffIsExact", chainHandoffIsExact],
      ["chainHeadIsExact", chainHeadIsExact],
      ["chainConsumptionIsExact", chainConsumptionIsExact],
      ["chainTimingIsExact", chainTimingIsExact],
      ["participationIsExact", participationIsExact],
      [
        "deliveryChainPresence",
        executorPlan !== undefined &&
          reviewerPlan !== undefined &&
          qaPlan !== undefined &&
          executorDispatch !== undefined &&
          reviewerDispatch !== undefined &&
          qaDispatch !== undefined &&
          executorReceipt !== null &&
          reviewerReceipt !== null &&
          qaReceipt !== null,
      ],
      [
        "missionDriverCompletion",
        exactMissionDriverCompletion &&
          (qaDispatch?.completedAt ?? Number.MAX_SAFE_INTEGER) <=
            completion.completedAt,
      ],
      [
        "repository",
        evidence.repository.finalHeadSha !== null &&
          evidence.repository.initialHeadSha !== null &&
          evidence.repository.resultSha256 ===
            evidence.expectedContentSha256 &&
          // Fast-forward (2) or real merge commit (3); exactSingleCommit
          // already proved HEAD descends from the initial commit with only
          // resultado.txt changed, so both integration shapes are the same
          // logical result.
          (evidence.repository.commitCount === 2 ||
            evidence.repository.commitCount === 3) &&
          evidence.repository.clean &&
          !evidence.repository.changedBeforeWorker &&
          evidence.repository.exactSingleCommit &&
          evidence.repository.initialHeadSha !==
            evidence.repository.finalHeadSha &&
          executorReceipt?.reference === evidence.repository.finalHeadSha,
      ],
      [
        "physicalSessionIdentity",
        executors[0]?.sessionId === executorDispatch?.sessionId &&
          executors[0]?.workerIncarnationId ===
            executorDispatch?.workerIncarnationId &&
          reviewers[0]?.sessionId === reviewerDispatch?.sessionId &&
          reviewers[0]?.workerIncarnationId ===
            reviewerDispatch?.workerIncarnationId &&
          qualityAssurers[0]?.sessionId === qaDispatch?.sessionId &&
          qualityAssurers[0]?.workerIncarnationId ===
            qaDispatch?.workerIncarnationId &&
          orchestrators[0]?.sessionId === evidence.kickoff.sessionId,
      ],
    ];
    const failedInvariants = invariantGroups
      .filter(([, holds]) => !holds)
      .map(([name]) => name);
    const pass = failedInvariants.length === 0;
    if (!pass) {
      context.addIssue({
        code: "custom",
        message:
          "PASS evidence is missing one or more real-mission invariants: " +
          failedInvariants.join(", "),
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
    evidence.wizardReceipt === null ||
    evidence.runtimeAttestation === null ||
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
