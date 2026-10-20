import { completionFactsFrom, missionGoalOf, scheduleCompletionCheck, scheduleReviewTriageAdvice } from "./jev-mission-advisor";
import { analysisClient, flushPtyAnalysis, isPtyAnalysisEnabled } from '../pty/pty-analysis-runtime';
import { checkVisualHandoff } from './visual-handoff-gate';
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  canSubmitMissionHandoff,
  hasCurrentApprovedDispatchContract,
  MAX_PROMOTED_PLAN_SUMMARY_BYTES,
  MAX_PROMOTED_PLAN_SUMMARY_CHARS,
  resolveEffectiveIntentState,
} from "../../shared/mission-intent";
import { handoffStatusSchema } from "../../shared/orch-types";
import {
  auditError,
  auditIntent,
  auditSuccess,
  type AuditContext,
} from "../jarvis/audit-log";
import { MECHANICAL_HANDOFF_MARK } from "./turn-end-handoff";
import {
  getContextBySession,
  markHandoffSubmitted,
  type AgentGateContext,
} from "./gate";
import {
  attestationGateErrorMessage,
  gateHandoffAttestation,
} from "./agent-attestation-gate";
import { lookupIssuedHandoffAttestation } from "./agent-attestation-lookup";
import { handoffRawPayloadSha256 } from "./handoff-payload-identity";
import {
  mintAgentTransportPhysicalReceipt,
  runInsidePtyStreamAgentTransport,
} from "./http-mcp-boundary";
import { onHandoffSubmitted } from "./idle-delivery";
import { scheduleAutoCloseAfterHandoff } from "./pane-close-scopes";
import { workerActivityProbes } from "./worker-idle-probe";
import { findPane, requestPaneClose } from "./pane-registry";
import { advanceFastLaneStoryTaskFromHandoff } from "./mission-story-plan";
import {
  committedPhysicalWorkerHead,
  assertReadOnlyLaneObservationCurrent,
  STALE_READ_ONLY_OBSERVATION_REASON,
  StaleReadOnlyObservationError,
} from "./physical-handoff-git";
import type { ToolDispatchResult } from "./mcp-dispatch-contract";
import { orchTerminateSession } from "../pty/pty-manager";
import {
  getProjectDomainStores,
  type ProjectDomainStoreSuite,
} from "./project-domain-store-registry";
import { compactText } from "./session-compaction";
import type { TaskDispatchRecord } from "./task-dispatch-codec";
import { getMissionEventRuntimeManager } from "./mission-event-emit";
import { isProvisionalWorkerHandoff } from "./provisional-worker-handoff";
import {
  extractLegacyHandoffsFromText,
  isPlaceholderSummary,
} from "./legacy-handoff";
import { evaluateWriterHandoffRegression } from "./handoff-regression-gate";
import { captureWriterHandoffCheckpoint } from "./handoff-checkpoint";
import { normalizeFilesModified } from "./worker-files-modified";
import { REGRESSION_UNVERIFIED_PREFIX } from "../regression-gate/regression-gate-handoff";
import {
  mechanicalHandoffReviewOutcome,
  reviewMissionHandoff,
} from "./jev-handoff-review";

const ptyStreamHandoffPayloadSchema = z
  .object({
    status: handoffStatusSchema,
    summary: z.string().min(1).max(65_536),
    artifacts: z.array(z.unknown()).max(4_096),
  })
  .strict();

export type PtyStreamHandoffPayload = z.infer<
  typeof ptyStreamHandoffPayloadSchema
>;

export interface PtyStreamHandoffResult {
  readonly handoffId: string;
  readonly taskDispatchState: string;
  readonly replayed: boolean;
}

export function isStaleReadOnlyObservationHandoffError(
  error: unknown,
): boolean {
  return (
    error instanceof StaleReadOnlyObservationError ||
    (error instanceof Error &&
      error.name === StaleReadOnlyObservationError.name)
  );
}

/**
 * HTTP/ACP dispatch catches handler exceptions so it can return a proper MCP
 * tool error. Preserve the stable stale-observation classification after that
 * boundary without treating arbitrary tool failures as a reason to kill a
 * physical worker.
 */
export function isStaleReadOnlyObservationHandoffResult(
  result: Readonly<ToolDispatchResult>,
): boolean {
  return (
    !result.ok &&
    result.tool === "nexus_handoff_submit" &&
    result.error?.startsWith(`${STALE_READ_ONLY_OBSERVATION_REASON}:`) === true
  );
}

/**
 * A legacy PTY marker has no channel for returning the handoff rejection to
 * the provider. Once the read-only tree is stale, keeping that process alive
 * only produces placeholder repaint loops and prevents scheduler recovery.
 * Terminate the exact main-owned session so the normal physical-exit path can
 * requeue and re-anchor the task on the integrated HEAD.
 */
export async function terminateStaleReadOnlyPtyStreamSession(
  sessionId: string,
  error: unknown,
  terminate: (sessionId: string) => Promise<boolean> = (id) =>
    orchTerminateSession(id, { origin: "pty-handoff:stale-read-only" }),
): Promise<boolean> {
  if (!isStaleReadOnlyObservationHandoffError(error)) return false;
  return terminate(sessionId);
}

/**
 * MCP transports can return the rejection before retiring the stale worker.
 * The caller invokes this only after writing the HTTP response, then the normal
 * physical-exit lifecycle requeues and re-anchors the read-only task.
 */
export async function terminateStaleReadOnlyMcpSession(
  sessionId: string,
  result: Readonly<ToolDispatchResult>,
  terminate: (sessionId: string) => Promise<boolean> = (id) =>
    orchTerminateSession(id, { origin: "pty-handoff:stale-read-only" }),
): Promise<boolean> {
  if (!isStaleReadOnlyObservationHandoffResult(result)) return false;
  return terminate(sessionId);
}

interface PreparedPtyHandoff {
  readonly visualPending?: boolean;
  readonly sessionId: string;
  readonly ctx: AgentGateContext;
  readonly suite: ProjectDomainStoreSuite;
  readonly missionId: string;
  readonly dispatch: TaskDispatchRecord | undefined;
  readonly payload: PtyStreamHandoffPayload;
  /** O que é persistido: `payload` depois do portão de regressão. */
  readonly status: PtyStreamHandoffPayload["status"];
  readonly artifacts: readonly unknown[];
  readonly rawArgs: PtyStreamHandoffPayload;
  readonly rawPayloadSha256: string;
  readonly summary: string;
  readonly worktreeHeadSha: string | undefined;
  readonly invocationId: string;
  readonly startedAt: number;
  readonly auditContext: AuditContext;
}

function requireCurrentPtyWorkerContext(sessionId: string): AgentGateContext {
  const ctx = getContextBySession(sessionId);
  if (
    !ctx ||
    ctx.role !== "worker" ||
    ctx.sessionId !== sessionId ||
    !ctx.missionId ||
    !ctx.workerIncarnationId
  ) {
    throw new Error(
      "handoff_provenance: PTY stream is not bound to a current mission worker",
    );
  }
  return ctx;
}

function summarizeForPersistence(
  rawSummary: string,
  isPlanHandoff: boolean,
): string {
  const summary = rawSummary.trim();
  if (summary.length < 20 || /^<.*>$/u.test(summary)) {
    throw new Error(
      "summary inválido: descreva de verdade o que foi feito (mínimo 20 caracteres, sem placeholder)",
    );
  }
  if (
    isPlanHandoff &&
    (summary.length > MAX_PROMOTED_PLAN_SUMMARY_CHARS ||
      Buffer.byteLength(summary, "utf8") > MAX_PROMOTED_PLAN_SUMMARY_BYTES)
  ) {
    throw new Error(
      "summary inválido: PRD/plano excede o limite físico de 32 KiB",
    );
  }
  return isPlanHandoff
    ? summary
    : compactText(summary, { maxChars: 4_000 }).text;
}

/**
 * Terminal UIs may repaint the same JSON marker with different indentation.
 * Horizontal spacing is presentation noise on this legacy PTY transport; the
 * words, line boundaries, status and artifacts remain part of the physical
 * replay identity and therefore stay fail-closed.
 */
function normalizePtySummary(rawSummary: string): string {
  return rawSummary.replace(/[\t\f\v ]+/gu, " ").trim();
}

function findBoundDispatch(
  suite: ProjectDomainStoreSuite,
  missionId: string,
  sessionId: string,
  workerIncarnationId: string | undefined,
): TaskDispatchRecord | undefined {
  const missionDispatches = suite.taskDispatches.list(missionId);
  const sessionDispatches = missionDispatches.filter(
    (dispatch) => dispatch.sessionId === sessionId,
  );
  const boundDispatch = workerIncarnationId
    ? sessionDispatches.find(
        (dispatch) => dispatch.workerIncarnationId === workerIncarnationId,
      )
    : sessionDispatches[0];
  if (
    sessionDispatches.length > 0 &&
    (!boundDispatch ||
      !workerIncarnationId ||
      boundDispatch.workerIncarnationId !== workerIncarnationId)
  ) {
    throw new Error(
      "worker incarnation obsoleta: PTY stream não pertence ao dispatch físico atual",
    );
  }
  if (!boundDispatch) {
    assertUnboundLateWorkerCurrent(
      suite,
      missionId,
      sessionId,
      workerIncarnationId,
      missionDispatches,
    );
  }
  return boundDispatch;
}

function assertUnboundLateWorkerCurrent(
  suite: ProjectDomainStoreSuite,
  missionId: string,
  sessionId: string,
  workerIncarnationId: string | undefined,
  dispatches: readonly TaskDispatchRecord[],
): void {
  if (!workerIncarnationId || dispatches.length === 0) return;
  if (
    dispatches.some(
      (dispatch) => dispatch.workerIncarnationId === workerIncarnationId,
    )
  ) {
    throw new Error(
      "worker incarnation obsoleta: dispatch pertence a outra sessão física",
    );
  }
  const hasDiagnostic = suite.handoffs
    .list({ missionId, includeDelivered: true })
    .some(
      (handoff) =>
        handoff.sessionId === sessionId &&
        isProvisionalWorkerHandoff(handoff),
    );
  if (!hasDiagnostic) return;
  // Replacing a dispatch can erase its old session, nonce and pane binding.
  // Neither a display name nor an unmatched persisted pane proves this was
  // an independent ad-hoc worker. Preserve the diagnostic when ambiguous.
  throw new Error(
    "handoff_provenance: late worker has no current dispatch binding",
  );
}

function assertCurrentHandoffOrigin(
  ctx: AgentGateContext,
  suite: ProjectDomainStoreSuite,
  mission: NonNullable<ReturnType<ProjectDomainStoreSuite["missions"]["get"]>>,
  dispatch: TaskDispatchRecord | undefined,
  sessionId: string,
): void {
  const intentState = resolveEffectiveIntentState({
    mission,
    taskCount: suite.tasks.list(mission.id).length,
    workerPaneCount: suite.missionPanes
      .list(mission.id)
      .filter((pane) => pane.role === "worker").length,
  });
  const origin = canSubmitMissionHandoff({
    role: ctx.role,
    missionId: ctx.missionId,
    sessionId,
    intentState,
  });
  const terminalReplay =
    (mission.status === "blocked" || mission.status === "done") &&
    dispatch?.handoffId !== undefined;
  if (!origin.ok && !terminalReplay) throw new Error(origin.error);
}

async function preparePtyHandoff(
  rawSessionId: string,
  rawPayload: PtyStreamHandoffPayload,
): Promise<PreparedPtyHandoff> {
  const sessionId = z.string().min(1).max(256).parse(rawSessionId);
  const parsedPayload = ptyStreamHandoffPayloadSchema.parse(rawPayload);
  const payload = Object.freeze({
    ...parsedPayload,
    summary: normalizePtySummary(parsedPayload.summary),
  });
  const ctx = requireCurrentPtyWorkerContext(sessionId);
  const suite = getProjectDomainStores(ctx.scope);
  const mission = suite.missions.get(ctx.missionId!);
  if (!mission) {
    throw new Error("handoff_origin: current approved mission unavailable");
  }
  // Via Rápida (C-194.1): o fechamento mecânico é a RESOLUÇÃO da espera do
  // Maestro. Para worker sem dispatch da era cerimonial (pane ad-hoc do
  // nexus_pane_spawn — revisores, segunda onda, meta-de-pane), a autoridade
  // já foi provada a montante: gate ctx com role+missionId+encarnação,
  // turno não-humano e dedup limpo. Exigir aqui contrato selado aprovado
  // matava TODA resposta curta ("nenhum pane entrega handoffs", campo
  // 22/08) porque o env varreu esse módulo como legado INERTE — mas o
  // /hook/status o mantém VIVO no caminho do fechamento mecânico.
  // Missão que já encerrou segue recusada (nada entra depois do fim).
  const ceremonialAuthority = hasCurrentApprovedDispatchContract(mission);
  if (!ceremonialAuthority && mission.status !== "running") {
    throw new Error("handoff_origin: mission is not live");
  }
  const dispatch = findBoundDispatch(
    suite,
    mission.id,
    sessionId,
    ctx.workerIncarnationId,
  );
  assertCurrentHandoffOrigin(ctx, suite, mission, dispatch, sessionId);
  const rawArgs = Object.freeze({ ...payload });
  const worktreeHeadSha = await committedPhysicalWorkerHead(
    ctx,
    dispatch !== undefined,
  );
  if (dispatch && !worktreeHeadSha) {
    throw new Error("handoff_provenance: physical worker HEAD is required");
  }
  // Stale-observation fence (shared with the HTTP MCP transport): a Guided
  // read_only lane whose tree went stale between bind and handoff is
  // refused before any receipt/audit state exists, so the scheduler retry
  // re-reviews the integrated tree and seals it honestly.
  if (dispatch && worktreeHeadSha) {
    assertReadOnlyLaneObservationCurrent({
      lane: dispatch,
      missionDispatches: suite.taskDispatches.list(mission.id),
      worktreeHeadSha,
    });
  }
  const isPlanHandoff = mission.intentContract?.lane === "plan";
  let summary = summarizeForPersistence(payload.summary, isPlanHandoff);
  // Portão de regressão: a MESMA etapa do handoff MCP. Bloco no PTY e
  // fechamento mecânico (que nasce `success`) não têm canal de devolução:
  // teste impactado falhando entra como blocked, nunca como success — nem
  // depois de o MCP ter recusado a mesma entrega.
  const declaredFiles = normalizeFilesModified({ artifacts: payload.artifacts });
  const regression =
    // F-1157: só a lane que o Hardened confina à leitura não escreve.
    payload.status === "success" && !isPlanHandoff && ctx.readOnlyEnforced !== true
      ? await evaluateWriterHandoffRegression(ctx, {
          declaredFiles,
          mission,
          returnable: false,
        })
      : null;
  if (regression?.kind === "exhausted") {
    summary = `[testes impactados falhando] ${summary}`;
  } else if (regression?.kind === "accepted" && regression.unverified) {
    summary = `${REGRESSION_UNVERIFIED_PREFIX} ${summary}`;
  }
  const regressionArtifact =
    (regression?.kind === "accepted" || regression?.kind === "exhausted") &&
    regression.artifact
      ? [regression.artifact]
      : [];
  // F-786: a MESMA revisão de evidência do handoff MCP (tools-handoff), sem
  // canal de devolução — o worker já encerrou, então a revisão roda com
  // orçamento zero de devoluções. Fraca por sinal que o MCP devolveria vira
  // partial (texto integral preservado nos artifacts); fraca só por sinal que
  // nem o MCP devolve fica success marcado, como no MCP (F-823).
  // Fail-open como no MCP: exceção vira skipped e nada muda.
  let jevOutcome = mechanicalHandoffReviewOutcome({
    kind: "skipped",
    reason: "not-run",
  });
  if (
    payload.status === "success" &&
    !isPlanHandoff &&
    ctx.readOnlyEnforced !== true &&
    regression?.kind !== "exhausted"
  ) {
    try {
      const jevVerdict = await reviewMissionHandoff({
        sessionId,
        missionId: mission.id,
        declaredStatus: payload.status,
        summary,
        artifacts: payload.artifacts,
        declaredFiles,
        artifactKinds: payload.artifacts
          .filter(
            (a): a is { kind: string } =>
              !!a &&
              typeof a === "object" &&
              typeof (a as Record<string, unknown>).kind === "string",
          )
          .map((a) => a.kind),
        evidenceIdsCount: 0,
        hasObservedCommit: Boolean(worktreeHeadSha),
        maxBounces: 0,
      });
      jevOutcome = mechanicalHandoffReviewOutcome(jevVerdict);
    } catch (error) {
      console.warn("[pty-handoff] revisão Jev falhou (ignorada):", error);
    }
  }
  if (jevOutcome.mark) {
    summary = `[evidência fraca] ${summary}`;
  }
  const visual = payload.status === 'success' && !isPlanHandoff ? await checkVisualHandoff(ctx, {
    task: dispatch?.taskId ? suite.tasks.getPlannedTask(dispatch.taskId) : undefined,
    assertCurrent: () => {
      if (requireCurrentPtyWorkerContext(sessionId) !== ctx) throw new Error('handoff_provenance: visual proof context changed');
    },
  }) : undefined;
  const visualPending = visual?.required === true && !visual.verified;
  if (visualPending) summary = `[verificação visual pendente] ${summary}`;
  // ORC-03: mesmo checkpoint oculto do handoff MCP (fim do turno do writer).
  const checkpointArtifact = await captureWriterHandoffCheckpoint(ctx);
  return Object.freeze({
    visualPending,
    sessionId,
    ctx,
    suite,
    missionId: mission.id,
    dispatch,
    payload,
    status:
      regression?.kind === "exhausted"
        ? "blocked"
        : jevOutcome.status === "partial" || visualPending
          ? "partial"
          : payload.status,
    artifacts: [...payload.artifacts, ...regressionArtifact, ...jevOutcome.artifacts,
      ...(visual?.required ? [{ kind: 'nexus.visualVerification', payload: visual }] : []),
      ...(checkpointArtifact ? [checkpointArtifact] : [])],
    rawArgs,
    rawPayloadSha256: handoffRawPayloadSha256(rawArgs),
    summary,
    worktreeHeadSha,
    invocationId: `pty-handoff-${randomUUID()}`,
    startedAt: Date.now(),
    auditContext: {
      scope: ctx.scope,
      missionId: mission.id,
      contextRevision: ctx.contextRevision,
    },
  });
}

function commitPhysicalPtyHandoff(
  prepared: PreparedPtyHandoff,
  physicalReceipt: ReturnType<typeof mintAgentTransportPhysicalReceipt>,
) {
  const { ctx, dispatch, missionId, sessionId, suite } = prepared;
  const fromAgent = dispatch?.workerId ?? ctx.agentName ?? ctx.label;
  const manager = getMissionEventRuntimeManager();
  let attestation:
    | {
        readonly agentPubkey: string;
        readonly ownerPubkey: string;
        readonly credential: import("../../shared/agent-attestation").AgentAttestation;
      }
    | undefined;
  if (manager) {
    const runtime = manager.open(ctx.scope);
    const proof = lookupIssuedHandoffAttestation(
      runtime.db,
      missionId,
      fromAgent,
      Math.floor(Date.now() / 1000),
    );
    const gate = gateHandoffAttestation(runtime.db, missionId, proof);
    if (gate.required && !gate.accepted) {
      throw new Error(attestationGateErrorMessage(gate));
    }
    if (gate.required && gate.accepted) {
      attestation = {
        agentPubkey: gate.agentPubkey,
        ownerPubkey: gate.ownerPubkey,
        credential: gate.credential,
      };
    }
  }
  const handoffInput = {
    status: prepared.status,
    summary: prepared.summary,
    artifacts: [...prepared.artifacts],
    missionId,
    sessionId,
    workerIncarnationId: ctx.workerIncarnationId,
    fromAgent,
  };
  const provenance = {
    worktreeHeadSha: prepared.worktreeHeadSha,
    rawPayloadSha256: prepared.rawPayloadSha256,
  };
  // F-239: transição de dispatch vale quando o dispatch ainda espera o SEU
  // handoff (running). Dispatch que JÁ entregou (handoffId gravado) é rodada
  // nova — caminho de replay. Dispatch parado SEM handoff (superseded e
  // afins) continua na transição, que recusa a resposta tardia como sempre.
  const dispatchDeliveredBefore = dispatch?.handoffId !== undefined;
  if (
    dispatch &&
    ctx.workerIncarnationId &&
    (dispatch.state === "running" || !dispatchDeliveredBefore)
  ) {
    return suite.handoffs.submitFromPhysicalAgentBoundaryAndTransitionDispatch(
      handoffInput,
      physicalReceipt,
      provenance,
      {
        sessionId,
        workerIncarnationId: ctx.workerIncarnationId,
        detail: `${prepared.status}: ${prepared.summary}`,
      },
      attestation,
    );
  }
  const committed = suite.handoffs.submitFromPhysicalAgentBoundaryWithReplay(
    handoffInput,
    physicalReceipt,
    provenance,
    attestation,
  );
  return {
    handoff: committed.handoff,
    replayed: committed.replayed,
    taskDispatch: undefined,
  };
}

async function persistPtyHandoff(
  prepared: PreparedPtyHandoff,
): Promise<PtyStreamHandoffResult> {
  const { auditContext, ctx, invocationId, rawArgs, sessionId } = prepared;
  return runInsidePtyStreamAgentTransport(sessionId, ctx, async () => {
    // Recheck after the asynchronous HEAD read: an unbound worker must not
    // cross into the generic path if its dispatch was replaced meanwhile.
    if (
      !prepared.dispatch &&
      findBoundDispatch(
        prepared.suite,
        prepared.missionId,
        sessionId,
        ctx.workerIncarnationId,
      )
    ) {
      throw new Error(
        "handoff_provenance: dispatch binding changed during handoff preparation",
      );
    }
    auditIntent(
      auditContext,
      sessionId,
      "nexus_handoff_submit",
      rawArgs,
      0,
      false,
      "pty-stream",
      invocationId,
    );
    const receipt = mintAgentTransportPhysicalReceipt({
      ctx,
      toolCallId: invocationId,
      toolName: "nexus_handoff_submit",
    });
    const committed = commitPhysicalPtyHandoff(prepared, receipt);
    auditSuccess(
      auditContext,
      sessionId,
      "nexus_handoff_submit",
      rawArgs,
      Date.now() - prepared.startedAt,
      false,
      "pty-stream",
      invocationId,
    );
    if (committed.handoff.evidenceTrust === "nexus-trusted") {
      markHandoffSubmitted(ctx);
    }
    // F-1166: triagem consultiva do handoff de código, fora do caminho crítico.
    const ptyFiles = normalizeFilesModified({ artifacts: prepared.payload.artifacts });
    if (!committed.replayed && prepared.status === "success" && ptyFiles.length > 0) {
      const ptyMission = prepared.suite.missions.get(prepared.missionId);
      if (ptyMission?.intentContract?.lane !== "plan") {
        scheduleReviewTriageAdvice({
          missionId: prepared.missionId, handoffId: committed.handoff.id, summary: prepared.summary,
          declaredFiles: ptyFiles, goal: ptyMission ? missionGoalOf(ptyMission) : undefined,
          lane: ptyMission?.intentContract?.lane,
        });
      }
    }
    if (!committed.replayed && prepared.status === "success") {
      const coverageMissionId = prepared.missionId;
      scheduleCompletionCheck(coverageMissionId, () => {
        const live = prepared.suite.missions.get(coverageMissionId);
        // Worker atrasado não consulta missão já encerrada (a auditoria final cuida dela).
        return live && live.status !== "done" ? completionFactsFrom(live,
          prepared.suite.handoffs.list?.({ missionId: coverageMissionId, includeDelivered: true }) ?? []) : null;
      });
    }
    if (!committed.replayed || committed.handoff.deliveryState === "queued") {
      onHandoffSubmitted(committed.handoff, ctx.scope);
      try {
        if (!prepared.visualPending) advanceFastLaneStoryTaskFromHandoff(prepared.suite, {
          missionId: prepared.missionId,
          fromAgent: committed.handoff.fromAgent,
          summary: prepared.summary,
          preferredTaskId: prepared.dispatch?.taskId,
          handoffStatus: prepared.status,
          requireMatch: prepared.payload.summary.startsWith(MECHANICAL_HANDOFF_MARK),
        });
      } catch (error) {
        console.warn(
          "[handoff] PTY SUCCESS não avançou o board selado:",
          error instanceof Error ? error.message : error,
        );
      }
    }
    // F-1409: paridade com o MCP — success no ledger consome o braço de
    // auto-close; a entrega vive no ledger, não no PTY do worker, então a
    // fila do Maestro (deliveryState queued) não segura o pane.
    scheduleAutoCloseAfterHandoff(
      sessionId,
      committed.handoff.status,
      (id) => findPane(id)?.paneId ?? null,
      requestPaneClose,
      {
        handoffId: committed.handoff.id,
        ...workerActivityProbes,
        isDelivered: (id) => prepared.suite.handoffs.get(id)?.deliveryState !== "queued",
      },
    );
    return Object.freeze({
      handoffId: committed.handoff.id,
      taskDispatchState: committed.taskDispatch?.state ?? "",
      replayed: committed.replayed,
    });
  });
}

function auditPtyHandoffFailure(
  prepared: PreparedPtyHandoff,
  error: unknown,
): void {
  try {
    auditError(
      prepared.auditContext,
      prepared.sessionId,
      "nexus_handoff_submit",
      prepared.rawArgs,
      Date.now() - prepared.startedAt,
      error instanceof Error ? error.message : String(error),
      false,
      "pty-stream",
      prepared.invocationId,
    );
  } catch (auditFailure) {
    console.warn("[handoff] PTY stream audit failure:", auditFailure);
  }
}

/**
 * Promote one Main-observed terminal block into the same durable handoff +
 * receipt + task-dispatch transaction used by HTTP MCP.
 *
 * No mission/session/incarnation identifier is accepted from terminal text:
 * every identity comes from the PTY data tap and its current gate context.
 */
export async function submitPtyStreamHandoff(
  rawSessionId: string,
  rawPayload: PtyStreamHandoffPayload,
): Promise<PtyStreamHandoffResult> {
  const prepared = await preparePtyHandoff(rawSessionId, rawPayload);
  try {
    return await persistPtyHandoff(prepared);
  } catch (error) {
    auditPtyHandoffFailure(prepared, error);
    throw error;
  }
}

export function extractPromotablePtyHandoffs(
  text: string,
): PtyStreamHandoffPayload[] {
  return extractLegacyHandoffsFromText(text).filter(
    (payload) => !isPlaceholderSummary(payload.summary),
  );
}

/**
 * Overclock Stop-hook parity: when the worker already printed a completion
 * block, Main promotes it from the observed PTY snapshot. Does not wait for
 * the model to call MCP or nx-mail.
 */
export async function promoteObservedPtyHandoffs(
  sessionId: string,
  text: string,
): Promise<number> {
  if (isPtyAnalysisEnabled()) await flushPtyAnalysis(sessionId);
  const payloads = isPtyAnalysisEnabled()
    ? analysisClient.evidence(sessionId, 'handoff') as readonly PtyStreamHandoffPayload[]
    : extractPromotablePtyHandoffs(text);
  let promoted = 0;
  for (const payload of payloads) {
    try {
      await submitPtyStreamHandoff(sessionId, payload);
      promoted += 1;
    } catch (error) {
      console.warn(
        `[handoff] observed PTY block rejected (${sessionId}):`,
        error,
      );
    }
  }
  return promoted;
}
