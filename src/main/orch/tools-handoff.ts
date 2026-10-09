import { createHash } from "node:crypto";
import path from "node:path";
import { checkVisualHandoff } from './visual-handoff-gate';
import { submitWorkspaceHandoff } from "./tools-handoff-workspace";
import {
  canSubmitMissionHandoff,
  hasCurrentApprovedDispatchContract,
  MAX_PROMOTED_PLAN_SUMMARY_BYTES,
  MAX_PROMOTED_PLAN_SUMMARY_CHARS,
  resolveEffectiveIntentState,
} from "../../shared/mission-intent";
import { handoffStatusSchema } from "../../shared/orch-types";
import {
  embedTelemetryArtifact,
  sanitizeHandoffTelemetry,
} from "../../shared/handoff-telemetry";
import {
  filterAntiSocialChatter,
  enforceScopeRules,
  writeSwarmMailboxMessage,
} from "./swarm-protocol";
import { markHandoffSubmitted, executionScopeFor, type GateRole } from "./gate";
import { requireMissionLeaderSession } from "./mission-leader-gate";
import { onHandoffSubmitted } from "./idle-delivery";
import {
  diagnoseHandoffStuck,
  HANDOFF_STUCK_PARK_ROUND,
} from "./handoff-stuck-diagnosis";
import { MAX_HANDOFF_DELIVERY_ATTEMPTS } from "./handoff-delivery-policy";
import { classifySessionLiveness } from "../pty/session-liveness";
import { getSessionState } from "../pty/pty-manager";
import type { ProjectExecutionScope } from "../../shared/project-identity-types";
import {
  clampPageSize,
  decodeCursor,
  encodeCursor,
  InvalidCursorError,
} from "../../shared/cursor-pagination";
import {
  scheduleAutoCloseAfterHandoff,
  assertAutoCloseReportPreserved,
} from "./pane-close-scopes";
import { findPane, listPaneSnapshots, readSessionOutput, requestPaneClose } from "./pane-registry";
import {
  assertMcpInvocationCurrent,
  type McpToolDef,
  type McpToolInvocation,
} from "./mcp-protocol";
import { getProjectDomainStores } from "./project-domain-store-registry";
import { normalizeHandoffStatusInput } from "./legacy-handoff";
import { requireStr, str } from "./tool-util";
import {
  deliveryContractExhaustedArtifact,
  deliveryContractRetryMessage,
  disarmDeliveryContract,
  evaluateDeliveryContract,
} from "./delivery-contract";
import {
  capHandoffFullText,
  condenseHandoffSummary,
} from "./handoff-summary-rule";
import type { HandoffDeliveryAttempt, ScopedHandoff } from "./handoff-store";

/** Lease de heartbeat herdado do dispatch cerimonial (linhas legadas). */
const TASK_DISPATCH_HEARTBEAT_LEASE_MS = 10 * 60_000;
import { handoffRawPayloadSha256 } from "./handoff-payload-identity";
import {
  committedPhysicalWorkerHead,
  assertReadOnlyLaneObservationCurrent,
} from "./physical-handoff-git";
import {
  attestationGateErrorMessage,
  gateHandoffAttestation,
} from "./agent-attestation-gate";
import { lookupIssuedHandoffAttestation } from "./agent-attestation-lookup";
import { getMissionEventRuntimeManager } from "./mission-event-emit";
import {
  advanceFastLaneStoryTaskFromHandoff,
  boardProgressFromSealedTasks,
} from "./mission-story-plan";
import {
  markMissionFilesCredited,
  markSessionSealedBoardCredited,
} from "./sealed-board-session-credit";
import { listDirtyPathsUnderCwd } from "./worker-delivery-evidence";
import { maybeApplyCivilianPronto } from "./civilian-pronto";
import {
  collectFilesModified,
  maybeCompleteFastLaneOnDelivery,
  normalizeFilesModified,
} from "./worker-files-modified";
import {
  reviewMissionHandoff,
  type HandoffAckVerdict,
  type JevReviewVerdict,
} from "./jev-handoff-review";
import {
  REGRESSION_UNVERIFIED_PREFIX,
  type RegressionHandoffVerdict,
} from "../regression-gate/regression-gate-handoff";
import { evaluateWriterHandoffRegression } from "./handoff-regression-gate";
import { withHandoffSubmitResilience } from "./handoff-submit-resilience";
import { captureWriterHandoffCheckpoint } from "./handoff-checkpoint";

function buildOverclockArtifacts(
  args: Record<string, unknown>,
): Array<{ readonly kind: string; readonly payload: unknown }> {
  const artifacts: Array<{ readonly kind: string; readonly payload: unknown }> = [];
  if (typeof args.briefId === "string" && args.briefId.length > 0) {
    artifacts.push({ kind: "overclock.briefId", payload: args.briefId });
  }
  if (typeof args.to === "string" && args.to.length > 0) {
    artifacts.push({ kind: "overclock.to", payload: args.to });
  }
  if (typeof args.fullText === "string" && args.fullText.length > 0) {
    const text = args.fullText.length > 60_000
      ? `${args.fullText.slice(0, 60_000)}\n[...]`
      : args.fullText;
    artifacts.push({ kind: "overclock.fullText", payload: text });
  }
  if (args.evidence !== undefined) {
    artifacts.push({ kind: "overclock.evidence", payload: args.evidence });
  }
  return artifacts;
}

function buildContextDagArtifacts(
  args: Record<string, unknown>,
): Array<{ readonly kind: string; readonly payload: unknown }> {
  const artifacts: Array<{ readonly kind: string; readonly payload: unknown }> = [];
  if (args.accomplished !== undefined) {
    artifacts.push({ kind: "context.accomplished", payload: args.accomplished });
  }
  if (args.blockers !== undefined) {
    artifacts.push({ kind: "context.blockers", payload: args.blockers });
  }
  if (args.nextSteps !== undefined) {
    artifacts.push({ kind: "context.nextSteps", payload: args.nextSteps });
  }
  if (args.contextDag !== undefined) {
    artifacts.push({ kind: "context.dag", payload: args.contextDag });
  }
  return artifacts;
}

function requireHandoffMcpEffectIntent(
  invocation: McpToolInvocation | undefined,
): NonNullable<McpToolInvocation["agentTransportPhysicalReceipt"]> {
  const intent = invocation?.effectIntent;
  if (
    !intent ||
    !["http-mcp", "acp-stdio", "pty-stream", "mission-shim"].includes(
      intent.source,
    ) ||
    intent.toolName !== "nexus_handoff_submit" ||
    !invocation?.agentTransportPhysicalReceipt
  ) {
    throw new Error(
      "handoff_provenance: exact physical agent tool-call receipt is required",
    );
  }
  assertMcpInvocationCurrent(invocation);
  return invocation.agentTransportPhysicalReceipt;
}

function requireHandoffAckPhysicalReceipt(
  invocation: McpToolInvocation | undefined,
): NonNullable<McpToolInvocation["agentTransportPhysicalReceipt"]> {
  const intent = invocation?.effectIntent;
  if (
    !intent ||
    !["http-mcp", "acp-stdio", "pty-stream"].includes(intent.source) ||
    intent.toolName !== "nexus_handoff_ack" ||
    !invocation?.agentTransportPhysicalReceipt
  ) {
    throw new Error(
      "handoff_ack_provenance: exact physical Maestro tool-call receipt is required",
    );
  }
  assertMcpInvocationCurrent(invocation);
  return invocation.agentTransportPhysicalReceipt;
}

/**
 * Maestro inbox vs audit trail.
 *
 * The store defaults to undelivered-only. After idle-delivery marks a row
 * submitted/consumed, that filter returns []. The Maestro prompt tells it to
 * call `nexus_handoff_list({full:true})` "to see every handoff"; `full` was
 * not in the schema, so the call silently listed an empty pending inbox.
 */
export function resolveHandoffListIncludeDelivered(
  args: Record<string, unknown>,
  role: GateRole,
): boolean {
  if (args.includeDelivered === false) return false;
  if (args.includeDelivered === true || args.full === true) return true;
  return role === "orchestrator";
}

/**
 * Digest do recorte de `nexus_handoff_list`. Entra no cursor para que um
 * cursor de outra missão, outro filtro ou outra lista seja recusado.
 */
export function handoffListCursorSlice(input: {
  readonly missionId: string | null;
  readonly includeDelivered: boolean;
  readonly ids: readonly string[];
  readonly panes: readonly string[];
}): string {
  const canonical = JSON.stringify({
    list: "handoff",
    missionId: input.missionId,
    includeDelivered: input.includeDelivered,
    ids: [...input.ids].sort(),
    panes: [...input.panes].sort(),
  });
  return createHash("sha256").update(canonical).digest("base64url").slice(0, 22);
}

const handoffSubmitTool: McpToolDef = {
  name: "nexus_handoff_submit",
  description:
    "Submit your work handoff to the orchestrator: " +
    "{status: success|partial|blocked|failed, summary, artifacts?, " +
    "filesModified?, evidenceIds?}. The Overclock aliases done/error are accepted at the " +
    "boundary and mapped (done→success, error→failed). Always allowed " +
    "regardless of allowlists. Status and artifacts are untrusted delivery " +
    "metadata and never complete a mission. Only evidenceIds already issued " +
    "and bound by Nexus can satisfy the worker stop receipt. summary: 1-2 " +
    "sentences (<=280 chars ideal); above 400 chars it is auto-condensed at a " +
    "sentence boundary and the full text is kept as an overclock.fullText " +
    "artifact. If the pane was spawned with expect.schema, a success handoff " +
    "has its artifacts validated against it: mismatches come back to you " +
    "naming what is missing (up to `retries` times); after that the handoff " +
    "is recorded as blocked.",
  inputSchema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["success", "partial", "blocked", "failed", "done", "error"],
      },
      summary: { type: "string" },
      accomplished: {
        description: "Itens concluídos com sucesso neste turno/tarefa.",
        oneOf: [
          { type: "string" },
          { type: "array", items: { type: "string" } },
        ],
      },
      blockers: {
        description: "Bloqueios, pendências ou impedimentos encontrados.",
        oneOf: [
          { type: "string" },
          { type: "array", items: { type: "string" } },
        ],
      },
      nextSteps: {
        description: "Próximos passos acionáveis sugeridos para a continuidade do trabalho.",
        oneOf: [
          { type: "string" },
          { type: "array", items: { type: "string" } },
        ],
      },
      contextDag: {
        type: "object",
        description: "Grafo de contexto / fio da meada estruturado.",
        properties: {
          nodeId: { type: "string" },
          parentHandoffId: { type: "string" },
          prerequisites: { type: "array", items: { type: "string" } },
          outputs: { type: "array", items: { type: "string" } },
        },
      },
      artifacts: { type: "array", items: {} },
      filesModified: { type: "array", items: { type: "string" } },
      "files-modified": { type: "array", items: { type: "string" } },
      evidenceIds: { type: "array", items: { type: "string" } },
      briefId: { type: "string", description: "Optional task/brief id (Overclock parity)." },
      to: { type: "string", description: "Optional target pane id (Overclock parity)." },
      fullText: { type: "string", description: "Complete worker report, up to 60000 characters. Required for a success that automatically closes the pane; summary alone only notifies the parent." },
      evidence: { type: "object", description: "Optional untrusted evidence blob (Overclock parity)." },
      telemetry: {
        type: "object",
        description:
          "Autorrelato do SEU transcript: {durationMs, tokensTotal, " +
          "tokensByModel?, estimated?}. Números reais do turno; estimativa " +
          "marca estimated:true; sem dados, OMITA (nunca invente zero).",
        properties: {
          durationMs: { type: "number" },
          tokensTotal: { type: "number" },
          tokensByModel: { type: "object" },
          estimated: { type: "boolean" },
        },
      },
    },
    required: ["status", "summary"],
  },
  handler: async (args, ctx, invocation) => {
    const captureTerminalTail = () => assertAutoCloseReportPreserved(ctx.sessionId,
      ctx.sessionId ? findPane(ctx.sessionId)?.paneId ?? null : null,
      normalizeHandoffStatusInput(args.status), args,
      () => readSessionOutput(ctx.sessionId!, 40));
    const tailWarning = {
      warning: 'O relatório completo não foi enviado. A cauda sanitizada do terminal foi preservada no handoff; ela pode estar incompleta. Envie os detalhes em fullText nas próximas entregas.',
    };
    if (!ctx.missionId) {
      const terminalTail = captureTerminalTail();
      const result = await submitWorkspaceHandoff(args, ctx, invocation, [
        ...buildOverclockArtifacts(args),
        ...buildContextDagArtifacts(args),
        ...(terminalTail ? [{ kind: 'nexus.terminal-tail', payload: terminalTail }] : []),
      ]);
      return { ...result, ...(terminalTail ? tailWarning : {}) };
    }
    const physicalReceipt = requireHandoffMcpEffectIntent(invocation);
    let suite: ReturnType<typeof getProjectDomainStores>;
    let mission: ReturnType<
      ReturnType<typeof getProjectDomainStores>["missions"]["get"]
    >;
    try {
      suite = getProjectDomainStores(ctx.scope);
      mission = ctx.missionId ? suite.missions.get(ctx.missionId) : null;
    } catch (error) {
      console.warn("[handoff] mission authority lookup failed (deny):", error);
      throw new Error("handoff_origin: mission authority unavailable");
    }
    if (!mission || !hasCurrentApprovedDispatchContract(mission)) {
      throw new Error("handoff_origin: current approved mission unavailable");
    }
    const rawPayloadSha256 = handoffRawPayloadSha256(args);
    const intentState = resolveEffectiveIntentState({
      mission,
      taskCount: suite.tasks?.list(mission.id).length ?? 0,
      workerPaneCount:
        suite.missionPanes?.list(mission.id).filter((p) => p.role === "worker")
          .length ?? 0,
    });
    const origin = canSubmitMissionHandoff({
      role: ctx.role,
      missionId: ctx.missionId,
      sessionId: ctx.sessionId,
      intentState,
    });
    const rawSummary = requireStr(args, "summary").trim();
    if (rawSummary.length < 20 || /^<.*>$/.test(rawSummary)) {
      throw new Error(
        "summary inválido: descreva de verdade o que foi feito (mínimo 20 " +
          'caracteres, sem placeholders como "<resumo...>").',
      );
    }
    const isPlanHandoff = mission.intentContract?.lane === "plan";
    if (
      isPlanHandoff &&
      (rawSummary.length > MAX_PROMOTED_PLAN_SUMMARY_CHARS ||
        Buffer.byteLength(rawSummary, "utf8") > MAX_PROMOTED_PLAN_SUMMARY_BYTES)
    ) {
      throw new Error(
        "summary inválido: PRD/plano excede o limite físico de 32 KiB",
      );
    }
    // A plan handoff is the exact physical PRD/architecture/story payload.
    // Other lanes retain compact operational summaries without anti-social noise.
    const cleanSummary = filterAntiSocialChatter(rawSummary).clean;
    // Régua 280/400 (Overclock 1.3.23): o summary é o que o Maestro lê
    // colado no PTY; acima de 400 chars condensa na fronteira de frase e a
    // íntegra vai para o registro como artifact overclock.fullText.
    const condensed = isPlanHandoff
      ? null
      : condenseHandoffSummary(cleanSummary);
    let summary = condensed ? condensed.summary : cleanSummary;
    const rawEvidenceIds = args.evidenceIds;
    if (
      rawEvidenceIds !== undefined &&
      (!Array.isArray(rawEvidenceIds) ||
        rawEvidenceIds.some((id) => typeof id !== "string"))
    ) {
      throw new Error("evidenceIds must be an array of Nexus evidence IDs");
    }
    const missionDispatches = suite.taskDispatches?.list(mission.id) ?? [];
    const sessionDispatches = ctx.sessionId
      ? missionDispatches.filter(
          (dispatch) => dispatch.sessionId === ctx.sessionId,
        )
      : [];
    const boundDispatch = ctx.workerIncarnationId
      ? sessionDispatches.find(
          (dispatch) =>
            dispatch.workerIncarnationId === ctx.workerIncarnationId,
        )
      : sessionDispatches[0];
    if (
      sessionDispatches.length > 0 &&
      (!boundDispatch ||
        !ctx.workerIncarnationId ||
        boundDispatch.workerIncarnationId !== ctx.workerIncarnationId)
    ) {
      throw new Error(
        "worker incarnation obsoleta: este handoff pertence a outra geração física",
      );
    }
    const terminalReplayCandidate =
      ctx.role === "worker" &&
      (mission.status === "blocked" || mission.status === "done") &&
      boundDispatch !== undefined &&
      boundDispatch.workerIncarnationId === ctx.workerIncarnationId &&
      boundDispatch.handoffId !== undefined;
    if (!origin.ok && !terminalReplayCandidate) {
      throw new Error(origin.error);
    }
    const worktreeHeadSha = await committedPhysicalWorkerHead(
      ctx,
      ctx.role === "worker" && boundDispatch !== undefined,
    );
    const terminalTail = (ctx.sessionId ? suite.handoffs.recoverPhysicalReplayTerminalTail(
      { missionId: ctx.missionId, sessionId: ctx.sessionId, workerIncarnationId: ctx.workerIncarnationId,
        agentArtifacts: Array.isArray(args.artifacts) ? args.artifacts : [] },
      physicalReceipt, { worktreeHeadSha, rawPayloadSha256 },
    ) : null) ?? captureTerminalTail();
    // Stale-observation fence: a Guided read_only lane whose tree went stale
    // between bind and handoff (executor integrated meanwhile) is refused
    // here — before any receipt state exists — so the task is retried
    // honestly against the integrated tree.
    if (boundDispatch && worktreeHeadSha) {
      assertReadOnlyLaneObservationCurrent({
        lane: boundDispatch,
        missionDispatches,
        worktreeHeadSha,
      });
    }
    const declaredStatus = handoffStatusSchema.parse(
      normalizeHandoffStatusInput(args.status),
    );
    // Contrato de entrega declarado no spawn (expect.schema): só um
    // success é cobrado — blocked/failed/partial já confessam que não há
    // entrega completa. Divergência devolve ao worker o que falta; com as
    // devoluções esgotadas o handoff entra como blocked, com as violações
    // registradas em artifacts para o Maestro decidir com evidência.
    const contractVerdict =
      declaredStatus === "success"
        ? evaluateDeliveryContract(ctx.sessionId, args.artifacts)
        : ({ kind: "none" } as const);
    if (contractVerdict.kind === "retry") {
      throw new Error(deliveryContractRetryMessage(contractVerdict));
    }
    // Revisão de evidência (piloto automático Jev): relatório fraco devolve ao
    // worker uma vez com o que falta — antes de qualquer escrita durável, como
    // o contrato determinístico. Fail-open: exceção vira `skipped` e nada muda.
    const declaredFiles = normalizeFilesModified({
      filesModified: args.filesModified,
      "files-modified": args["files-modified"],
      artifacts: args.artifacts,
    });
    // Portão de regressão: roda só os testes impactados pelo diff do
    // worktree. Falha devolve ao worker (mesmo caminho do contrato); com as
    // devoluções esgotadas o handoff entra como blocked com as falhas.
    let regressionVerdict: RegressionHandoffVerdict = {
      kind: "skipped",
      reason: "not-run",
    };
    if (
      declaredStatus === "success" &&
      !isPlanHandoff &&
      ctx.readOnly !== true &&
      contractVerdict.kind !== "exhausted"
    ) {
      assertMcpInvocationCurrent(invocation);
      regressionVerdict = await evaluateWriterHandoffRegression(ctx, {
        declaredFiles,
        mission,
        invocation,
      });
      if (regressionVerdict.kind === "retry") {
        throw new Error(regressionVerdict.message);
      }
    }
    let jevVerdict: JevReviewVerdict = { kind: "skipped", reason: "not-run" };
    // Não julga entregas que não são trabalho de implementação: PRD/plano
    // (documento não tem testes), sessões read-only (revisores entregam
    // achados, não código) e contrato determinístico esgotado (o handoff já
    // entra como blocked — um bounce do Jev contradiz o resultado registrado).
    const jevSkipReason =
      declaredStatus !== "success"
        ? undefined
        : isPlanHandoff
          ? "plan-lane"
          : ctx.readOnly === true
            ? "read-only-session"
            : contractVerdict.kind === "exhausted"
              ? "contract-exhausted"
              : regressionVerdict.kind === "exhausted"
                ? "regression-exhausted"
                : undefined;
    if (declaredStatus === "success" && jevSkipReason === undefined) {
      // A revisão Jev é egresso externo: revalida a autoridade ANTES do await
      // (o checkpoint pós-await permanece logo abaixo, antes da escrita).
      assertMcpInvocationCurrent(invocation);
      try {
        jevVerdict = await reviewMissionHandoff({
          sessionId: ctx.sessionId,
          missionId: ctx.missionId,
          signal: invocation?.signal,
          declaredStatus,
          summary,
          fullText:
            typeof args.fullText === "string" ? args.fullText : undefined,
          accomplished: args.accomplished,
          blockers: args.blockers,
          nextSteps: args.nextSteps,
          declaredFiles,
          artifactKinds: (Array.isArray(args.artifacts) ? args.artifacts : [])
            .filter(
              (a): a is { kind: string } =>
                !!a &&
                typeof a === "object" &&
                typeof (a as Record<string, unknown>).kind === "string",
            )
            .map((a) => a.kind),
          evidenceIdsCount: Array.isArray(rawEvidenceIds)
            ? rawEvidenceIds.length
            : 0,
          hasObservedCommit: Boolean(worktreeHeadSha),
        });
      } catch (error) {
        console.warn("[handoff] revisão Jev falhou (ignorada):", error);
        jevVerdict = { kind: "skipped", reason: "review-error" };
      }
      if (jevVerdict.kind === "retry") {
        throw new Error(jevVerdict.message);
      }
      if (jevVerdict.kind === "weak") {
        summary = `[evidência fraca] ${summary}`;
      }
    } else if (jevSkipReason) {
      jevVerdict = { kind: "skipped", reason: jevSkipReason };
    }
    const visual = declaredStatus === 'success' && !isPlanHandoff ? await checkVisualHandoff(ctx, {
      task: boundDispatch?.taskId ? suite.tasks.getPlannedTask(boundDispatch.taskId) : undefined,
      assertCurrent: () => assertMcpInvocationCurrent(invocation),
    }) : undefined;
    const visualPending = visual?.required === true && !visual.verified;
    if (visualPending) summary = `[verificação visual pendente] ${summary}`;
    const status: typeof declaredStatus =
      contractVerdict.kind === "exhausted" ||
      regressionVerdict.kind === "exhausted"
        ? "blocked"
        : visualPending ? 'partial' : declaredStatus;
    if (regressionVerdict.kind === "exhausted") {
      summary = `[testes impactados falhando] ${summary}`;
    } else if (
      regressionVerdict.kind === "accepted" &&
      regressionVerdict.unverified
    ) {
      summary = `${REGRESSION_UNVERIFIED_PREFIX} ${summary}`;
    }
    // ORC-03: a árvore do writer no fim do turno vira ref oculta, registrada
    // no próprio handoff; o checkpoint abaixo revalida a autoridade.
    const checkpointArtifact = await captureWriterHandoffCheckpoint(ctx);
    assertMcpInvocationCurrent(invocation);
    const fromAgent = ctx.agentName ?? ctx.label;
    const atSeconds = Math.floor(Date.now() / 1000);
    let attestationBind:
      | {
          readonly agentPubkey: string;
          readonly ownerPubkey: string;
          readonly credential: import("../../shared/agent-attestation").AgentAttestation;
        }
      | null = null;
    if (ctx.missionId) {
      const manager = getMissionEventRuntimeManager();
      if (manager) {
        const runtime = manager.open(ctx.scope);
        const proof = lookupIssuedHandoffAttestation(
          runtime.db,
          ctx.missionId,
          fromAgent,
          atSeconds,
        );
        const gate = gateHandoffAttestation(runtime.db, ctx.missionId, proof);
        if (gate.required && !gate.accepted) {
          throw new Error(attestationGateErrorMessage(gate));
        }
        if (gate.required && gate.accepted) {
          attestationBind = {
            agentPubkey: gate.agentPubkey,
            ownerPubkey: gate.ownerPubkey,
            credential: gate.credential,
          };
        }
      }
    }
    // Telemetria autorrelatada (overclick, 19/08): viaja DENTRO de artifacts
    // (metadado untrusted já persistido) — nada disso é evidência de
    // conclusão, e payload inválido é simplesmente ignorado.
    const telemetry = sanitizeHandoffTelemetry(args.telemetry);
    const overclockArtifacts = buildOverclockArtifacts(args);
    const contextDagArtifacts = buildContextDagArtifacts(args);
    // Íntegra do summary condensado, salvo quando o worker já mandou o
    // próprio fullText (o dele vence: é o texto que ele escolheu registrar).
    const condensedFullText =
      condensed?.condensed &&
      condensed.original !== undefined &&
      !(typeof args.fullText === "string" && args.fullText.length > 0)
        ? [
            {
              kind: "overclock.fullText",
              payload: capHandoffFullText(condensed.original),
            },
          ]
        : [];
    const artifacts = [
      ...(visual?.required ? [{ kind: 'nexus.visualVerification', payload: visual }] : []),
      ...(Array.isArray(args.artifacts) ? args.artifacts : []),
      ...overclockArtifacts,
      ...condensedFullText,
      ...contextDagArtifacts,
      ...(terminalTail ? [{ kind: 'nexus.terminal-tail', payload: terminalTail }] : []),
      ...(checkpointArtifact ? [checkpointArtifact] : []),
      ...(contractVerdict.kind === "exhausted"
        ? [deliveryContractExhaustedArtifact(contractVerdict, declaredStatus)]
        : []),
      ...((regressionVerdict.kind === "accepted" ||
        regressionVerdict.kind === "exhausted") &&
      regressionVerdict.artifact
        ? [regressionVerdict.artifact]
        : []),
      ...(telemetry ? [embedTelemetryArtifact(telemetry)] : []),
      ...(jevVerdict.kind === "ok" || jevVerdict.kind === "weak"
        ? [jevVerdict.artifact]
        : []),
    ];
    const handoffInput = {
      status,
      summary,
      artifacts,
      evidenceIds: rawEvidenceIds as string[] | undefined,
      missionId: ctx.missionId,
      sessionId: ctx.sessionId,
      workerIncarnationId: ctx.workerIncarnationId,
      fromAgent,
    };
    let handoff: ScopedHandoff;
    let taskDispatchState: string | undefined;
    let replayed = false;
    // F-239: a transição de dispatch vale quando o dispatch ainda espera o
    // SEU handoff (running). Dispatch que JÁ entregou (handoffId gravado:
    // handoff_ready e além) significa rodada nova — caminho de replay puro.
    // Dispatch parado SEM handoff (superseded/cancelado antes de entregar)
    // continua na transição, que recusa a resposta tardia como sempre.
    const dispatchAwaitingHandoff = boundDispatch?.state === "running";
    const dispatchDeliveredBefore = boundDispatch?.handoffId !== undefined;
    if (
      ctx.sessionId &&
      ctx.workerIncarnationId &&
      boundDispatch &&
      (dispatchAwaitingHandoff || !dispatchDeliveredBefore)
    ) {
      const committed =
        suite.handoffs.submitFromPhysicalAgentBoundaryAndTransitionDispatch(
          handoffInput,
          physicalReceipt,
          {
            worktreeHeadSha,
            rawPayloadSha256,
          },
          {
            sessionId: ctx.sessionId,
            workerIncarnationId: ctx.workerIncarnationId,
            detail: `${status}: ${summary}`,
          },
          attestationBind ?? undefined,
        );
      handoff = committed.handoff;
      taskDispatchState = committed.taskDispatch.state;
      replayed = committed.replayed;
    } else {
      const committed =
        suite.handoffs.submitFromPhysicalAgentBoundaryWithReplay(
          handoffInput,
          physicalReceipt,
          {
            worktreeHeadSha,
            rawPayloadSha256,
          },
          attestationBind ?? undefined,
        );
      handoff = committed.handoff;
      replayed = committed.replayed;
    }
    if (handoff.evidenceTrust === "nexus-trusted") {
      markHandoffSubmitted(ctx);
    }
    if (ctx.sessionId && contractVerdict.kind !== "none") {
      // Contrato cumprido (ok) ou esgotado (blocked): a cobrança acabou.
      disarmDeliveryContract(ctx.sessionId);
    }
    // Wake is exclusively `onHandoffSubmitted` → idle-delivery (bracketed
    // paste + 500 ms settle + Enter). A raw PTY dump here (commit 2b8b4e1d)
    // left `📬 … (use nexus_handoff_list)` sitting in the Maestro composer
    // without submit, and the TUI repaint made idle-delivery queue for minutes.
    //
    // A queued replay may be recovering from a process/network loss after the
    // SQLite commit but before delivery/completion side effects. Once delivery
    // advanced, replaying Pet Studio would re-read mutable artifact paths and
    // repeat an already-finished installation.
    const petStudioCompletion =
      !replayed || handoff.deliveryState === "queued"
        ? onHandoffSubmitted(handoff, ctx.scope)
        : null;
    if (ctx.missionId && !replayed && !visualPending) {
      try {
        const diskFiles = await collectFilesModified(executionScopeFor(ctx).rootRealPath);
        assertMcpInvocationCurrent(invocation);
        const filesModified =
          declaredFiles.length > 0 ? declaredFiles : diskFiles;
        if (filesModified.length > 0) {
          const scopeCheck = enforceScopeRules({
            ownedFiles: ((boundDispatch as unknown as Record<string, unknown>)?.ownedFiles as string[]) ?? [],
            modifiedFiles: filesModified,
          });
          if (!scopeCheck.allowed) {
            console.warn(
              `[swarm-protocol] scope-freeze boundary notice: ${scopeCheck.violations.join(", ")}`,
            );
          }
        }
        try {
          const swarmsDir = path.join(
            ctx.scope.rootRealPath,
            ".nexus",
            "swarms",
            ctx.missionId,
          );
          writeSwarmMailboxMessage({
            baseDir: swarmsDir,
            message: {
              sender: fromAgent,
              recipient: mission.orchestratorSessionId ?? "orchestrator",
              content: summary,
              payload: {
                handoffStatus: status,
                workerIncarnationId: ctx.workerIncarnationId,
                handoffId: handoff.id,
              },
            },
            nudgeRecipient: true,
          });
        } catch {
          // Swarm mailbox logging is best-effort alongside durable SQLite handoff
        }
        const advanced = advanceFastLaneStoryTaskFromHandoff(suite, {
          missionId: ctx.missionId,
          fromAgent,
          adapterId: ctx.providerId,
          summary,
          preferredTaskId: dispatchAwaitingHandoff
            ? boundDispatch?.taskId
            : undefined,
          handoffStatus: status,
          filesModified,
        });
        if (advanced && ctx.sessionId) {
          markSessionSealedBoardCredited(ctx.sessionId);
          const cwd =
            ctx.executionScope?.rootRealPath ?? ctx.scope.rootRealPath;
          try {
            const dirtyFiles = await listDirtyPathsUnderCwd(cwd);
            assertMcpInvocationCurrent(invocation);
            markMissionFilesCredited(ctx.missionId, dirtyFiles);
          } catch {
            // Credit de arquivos é best-effort; a task já avançou.
          }
        }
        try {
          const sealed = suite.tasks.list(ctx.missionId);
          const progress = boardProgressFromSealedTasks(sealed);
          const delivery = maybeCompleteFastLaneOnDelivery({
            filesModified,
            mcpHandoffClosedTask: Boolean(advanced),
            sealedCompleted: progress.completed,
            sealedTotal: progress.total,
          });
          console.info(
            `[handoff] worker_done files-modified=${filesModified.length} sealed=${progress.completed}/${progress.total} pronto=${delivery.pronto}`,
          );
        } catch (creditErr) {
          console.warn(
            "[handoff] files-modified credit falhou:",
            creditErr instanceof Error ? creditErr.message : creditErr,
          );
        }
      } catch (error) {
        console.warn(
          "[handoff] avanço da task selada falhou:",
          error instanceof Error ? error.message : error,
        );
      }
      void maybeApplyCivilianPronto(ctx.scope, ctx.missionId).catch((error) => {
        console.warn(
          "[handoff] Pronto civil após handoff falhou:",
          error instanceof Error ? error.message : error,
        );
      });    }
    // autoCloseOnHandoff (paridade Bridge): declarado no spawn, dispara SÓ
    // no success — falha preserva pane e scrollback. Fora do caminho da
    // resposta: o fechamento nunca atrasa nem derruba o handoff.
    scheduleAutoCloseAfterHandoff(
      ctx.sessionId,
      status,
      (sessionId) => findPane(sessionId)?.paneId ?? null,
      requestPaneClose,
    );
    return {
      ok: true,
      handoffId: handoff.id,
      ...(terminalTail ? tailWarning : {}),
      ...(visual?.required ? { visualVerification: visual, status } : {}),
      evidenceTrust: handoff.evidenceTrust,
      stopGateSatisfied: handoff.evidenceTrust === "nexus-trusted",
      ...(replayed ? { replayed: true } : {}),
      ...(taskDispatchState ? { taskDispatchState } : {}),
      ...(petStudioCompletion ? { petStudioCompletion } : {}),
      ...(jevVerdict.kind === "ok" || jevVerdict.kind === "weak"
        ? { jevReview: jevVerdict.kind }
        : {}),
    };
  },
};

const handoffListTool: McpToolDef = {
  name: "nexus_handoff_list",
  description:
    "List handoffs for the current mission, or workspace handoffs for an operator without a mission. The Maestro sees the full audit " +
    "trail by default (including delivered/consumed). Pass includeDelivered: " +
    "false for only undelivered rows. full:true is the documented alias for " +
    "the complete trail (same as includeDelivered:true). Older delivered " +
    "rows are compacted (artifacts replaced by artifactsOmitted + " +
    "detailHint); the 5 most recent, undelivered rows and rows fetched by " +
    "ids stay complete. detail:'full' disables compaction.",
  inputSchema: {
    type: "object",
    properties: {
      missionId: { type: "string" },
      includeDelivered: { type: "boolean" },
      full: { type: "boolean" },
      detail: { type: "string", enum: ["full"], description: "'full' returns every artifact instead of compacting older delivered rows." },
      panes: { type: "array", items: { type: "string" }, description: "Optional pane ids/sessions to limit results (Overclock parity)." },
      ids: { type: "array", items: { type: "string" }, description: "Optional exact handoff ids to fetch (Overclock parity); rows fetched this way are never compacted." },
      limit: { type: "number", description: "Page size for cursor mode (default 50, max 200)." },
      cursor: { type: "string", description: "Opaque cursor from a previous page (cursor mode). Omit for the first page." },
    },
  },
  handler: async (args, ctx) => {
    // L10: only an orchestrator may enumerate other missions' handoffs. A worker
    // is confined to its own mission, so a prompt-injected worker cannot read
    // another mission's handoff summaries/artifacts by passing a guessed id.
    if (
      !ctx.missionId &&
      (ctx.role === "worker" || ctx.contextRevision || ctx.workerIncarnationId)
    ) return [];
    const requestedMission = str(args, "missionId");
    // A role bit alone can be stale (superseded orchestrator token): the
    // cross-mission read escalation requires the resolver to still prove
    // this exact session leads its own mission right now.
    const isProvenCurrentOrchestrator =
      ctx.role === "orchestrator" &&
      ctx.missionId !== undefined &&
      requireMissionLeaderSession(ctx.scope, ctx.missionId, {
        sessionId: ctx.sessionId,
      }).ok;
    const missionId =
      !ctx.missionId
        ? null
        : isProvenCurrentOrchestrator
          ? (requestedMission ?? ctx.missionId)
          : ctx.missionId;
    const rawPanes = Array.isArray(args.panes)
      ? args.panes.filter((p) => typeof p === "string")
      : [];
    const paneSessionIds = rawPanes.length > 0
      ? listPaneSnapshots()
          .filter(
            (s) =>
              rawPanes.includes(s.paneId) ||
              (s.sessionId !== null && rawPanes.includes(s.sessionId)) ||
              (s.paneNumber !== undefined &&
                rawPanes.includes(String(s.paneNumber))),
          )
          .map((s) => s.sessionId)
          .filter((s): s is string => s !== null)
      : undefined;
    if (paneSessionIds?.length === 0) return [];
    const rawIds = Array.isArray(args.ids)
      ? args.ids.filter((i) => typeof i === "string")
      : [];
    const includeDelivered = resolveHandoffListIncludeDelivered(
      args, !ctx.missionId ? "orchestrator" : ctx.role,
    );
    const cursorSlice = handoffListCursorSlice({
      missionId,
      includeDelivered,
      ids: rawIds,
      panes: rawPanes,
    });
    const listFilter = {
      missionId,
      includeDelivered,
      ...(paneSessionIds !== undefined && paneSessionIds.length > 0
        ? { sessionIds: paneSessionIds }
        : {}),
      ...(rawIds.length > 0 ? { ids: rawIds } : {}),
    };
    const handoffStore = getProjectDomainStores(ctx.scope).handoffs;
    // A página é escolhida ANTES do recibo. Cursor inválido não reconhece
    // nada; um limit menor que a trilha só reconhece as linhas devolvidas.
    // Com limit/cursor o predicado e o LIMIT ficam no SQL: a trilha inteira,
    // artifacts inclusos, não é materializada.
    let returned: ScopedHandoff[];
    let nextCursor: string | null = null;
    let hasMoreHistory = false;
    const wantCursorMode =
      args.cursor !== undefined || args.limit !== undefined;
    if (wantCursorMode) {
      try {
        let after: { createdAt: number; id: string } | undefined;
        if (typeof args.cursor === "string") {
          const decoded = decodeCursor(args.cursor);
          if (decoded.s !== cursorSlice) {
            throw new InvalidCursorError("cursor does not match this slice");
          }
          if (
            typeof decoded.k !== "number" ||
            !Number.isInteger(decoded.k) ||
            decoded.k < 0
          ) {
            throw new InvalidCursorError("cursor key is not a handoff timestamp");
          }
          after = { createdAt: decoded.k, id: decoded.i };
        }
        const pageLimit = clampPageSize(args.limit);
        const window = handoffStore.listCursorPage({
          ...listFilter,
          ...(after ? { after } : {}),
          limit: pageLimit + 1,
        });
        hasMoreHistory = window.length > pageLimit;
        returned = hasMoreHistory ? window.slice(0, pageLimit) : [...window];
        const last = returned[returned.length - 1];
        nextCursor =
          hasMoreHistory && last
            ? encodeCursor({
                key: last.createdAt ?? 0,
                id: last.id,
                slice: cursorSlice,
              })
            : null;
      } catch (error) {
        if (error instanceof InvalidCursorError) {
          throw new Error(
            `nexus_handoff_list: cursor inválido (${error.message}). ` +
              'Comece a primeira página sem cursor.',
          );
        }
        throw error;
      }
    } else {
      returned = handoffStore.list(listFilter);
    }
    // Recência é da trilha inteira, não da página. Com limit <= 5, tratar
    // as últimas linhas da página como "as 5 mais novas" devolveria artifact
    // completo de histórico. No modo cursor isso é um SELECT de ids, sem artifacts.
    const recentIds = new Set(
      wantCursorMode
        ? handoffStore.listRecentIds(listFilter, 5)
        : returned.slice(Math.max(0, returned.length - 5)).map((row) => row.id),
    );
    // List = recibo só de `submitted` (já colado no PTY) que esta resposta
    // devolve. O diagnóstico sai DEPOIS: uma linha reconhecida nesta chamada
    // não pode voltar como accepted-not-consumed. `queued` segue para o
    // idle-delivery. Leitura cross-mission é auditoria: nunca reconhece nada.
    const acknowledgedIds = new Set<string>();
    if (isProvenCurrentOrchestrator && missionId === ctx.missionId) {
      const seenIds = returned
        .filter((row) => row.deliveryState === "submitted")
        .map((row) => row.id);
      if (seenIds.length > 0) {
        try {
          const acked = getProjectDomainStores(
            ctx.scope,
          ).handoffs.acknowledgeSeenByOrchestratorList(ctx.missionId, seenIds);
          if (acked === seenIds.length) {
            for (const id of seenIds) acknowledgedIds.add(id);
          }
          if (acked > 0) {
            console.info(
              `[handoff] list-ack: ${acked} handoff(s) reconhecido(s) pela ` +
                `leitura do Maestro (mission=${ctx.missionId})`,
            );
          }
        } catch (error) {
          console.warn(
            "[handoff] list-ack falhou (segue sem recibo):",
            error instanceof Error ? error.message : error,
          );
        }
      }
    }
    const visible = compactHandoffListRows(
      returned,
      rawIds,
      str(args, "detail") === "full",
      ctx.scope,
      recentIds,
      acknowledgedIds,
    );
    if (wantCursorMode) {
      return {
        items: visible,
        nextCursor,
        hasMoreHistory,
      };
    }
    return visible;
  },
};

/**
 * As 5 linhas mais recentes da trilha inteira, qualquer linha não entregue
 * e as pedidas por `ids` saem inteiras. O resto perde `artifacts` (a parte
 * pesada) mas NÃO perde o diagnóstico: um `submitted` antigo ainda precisa
 * dizer accepted-not-consumed. `acknowledgedIds` são as linhas que esta
 * resposta acabou de reconhecer — o veredito tem de concordar com o recibo.
 */
function deliveryAttemptsFor(
  scope: ProjectExecutionScope,
  handoffId: string,
): HandoffDeliveryAttempt[] {
  try {
    const list = getProjectDomainStores(scope).handoffs.listDeliveryAttempts;
    if (typeof list !== "function") return [];
    return list.call(getProjectDomainStores(scope).handoffs, handoffId);
  } catch {
    return [];
  }
}

/** Falha encerrada ou rodada `released:`. Reserva, colagem e aceite não gastam rodada. */
function deliveryAttemptIsSpent(attempt: HandoffDeliveryAttempt): boolean {
  if (
    attempt.state === "reserved" ||
    attempt.state === "pasted" ||
    attempt.state === "accepted"
  ) {
    return false;
  }
  if (attempt.state === "failed") return true;
  return (
    typeof attempt.failureCode === "string" && attempt.failureCode.length > 0
  );
}

function maestroSessionAlive(
  sessionId: string | undefined,
): boolean | undefined {
  if (!sessionId) return undefined;
  try {
    const liveness = classifySessionLiveness(getSessionState(sessionId));
    if (liveness === "live") return true;
    if (liveness === "exited") return false;
    return undefined;
  } catch {
    return undefined;
  }
}

function compactHandoffListRows(
  rows: ScopedHandoff[],
  rawIds: readonly string[],
  detailFull: boolean,
  scope: ProjectExecutionScope,
  recentIds: ReadonlySet<string>,
  acknowledgedIds: ReadonlySet<string>,
): Array<ScopedHandoff | Record<string, unknown>> {
  const attachStuck = (row: ScopedHandoff): ScopedHandoff | Record<string, unknown> => {
    // F-1040: diagnóstico de entrega presa — não força nada, nomeia o escape.
    if (row.delivered && (row.deliveryState === 'consumed' || row.deliveryState === 'acknowledged')) {
      return row;
    }
    try {
      const attempts = deliveryAttemptsFor(scope, row.id);
      // A sessão vigente da missão ganha de uma tentativa antiga. Depois
      // de um rebind, o Maestro novo está vivo e elegível; contar a sessão
      // morta estaciona ou marca session-dead à toa.
      const missionSessionId = row.missionId
        ? getProjectDomainStores(scope).missions.get(row.missionId)
            ?.orchestratorSessionId
        : undefined;
      const fallbackSessionId =
        attempts.length > 0
          ? attempts[attempts.length - 1]?.orchestratorSessionId
          : undefined;
      const maestroSessionId =
        (typeof missionSessionId === "string" && missionSessionId.length > 0
          ? missionSessionId
          : undefined) ??
        (typeof fallbackSessionId === "string" && fallbackSessionId.length > 0
          ? fallbackSessionId
          : undefined);
      const sessionAttempts = maestroSessionId
        ? attempts.filter(
            (attempt) => attempt.orchestratorSessionId === maestroSessionId,
          )
        : attempts;
      const latest =
        sessionAttempts.length > 0
          ? sessionAttempts[sessionAttempts.length - 1]
          : undefined;
      // Reserva ou colagem ainda dentro da janela não é rodada gasta.
      // Contá-la faz retryRound 1 e o diagnóstico diz retry-backoff antes
      // do aceite normal. Só falha e `released:` entram na conta; uma
      // tentativa ativa permanece na janela de aceite.
      const attemptInFlight =
        latest?.state === "reserved" || latest?.state === "pasted";
      const spentAttempts = attemptInFlight
        ? []
        : sessionAttempts.filter(deliveryAttemptIsSpent);
      // F-925 conta rodadas, não tentativas cruas. Cada rodada gasta
      // MAX_HANDOFF_DELIVERY_ATTEMPTS colagens; linhas `released:` entram
      // na conta, como no idle-delivery — elas provam que a rodada
      // aconteceu. Estacionar continua no sinal `parked` (tentativas >=
      // orçamento + HANDOFF_STUCK_PARK_ROUND). Passar o total cru faria
      // `retryRound >= 6` estacionar na 6ª tentativa, antes da 9ª.
      const retryRound =
        spentAttempts.length > 0
          ? Math.ceil(spentAttempts.length / MAX_HANDOFF_DELIVERY_ATTEMPTS)
          : null;
      const diagnosis = diagnoseHandoffStuck({
        id: row.id,
        deliveryState: row.deliveryState,
        delivered: row.delivered,
        consumedAt: row.consumedAt ?? null,
        submittedAt: row.submittedAt ?? null,
        createdAt: row.createdAt,
        attemptedAt: latest?.startedAt ?? null,
        sessionId: maestroSessionId ?? null,
        sessionAlive: maestroSessionAlive(maestroSessionId),
        parked:
          spentAttempts.length >=
          MAX_HANDOFF_DELIVERY_ATTEMPTS + HANDOFF_STUCK_PARK_ROUND,
        retryRound,
      });
      if (!diagnosis.stuck) return row;
      return { ...row, stuckDiagnosis: diagnosis };
    } catch {
      return row;
    }
  };
  return rows.map((row) => {
    const view = acknowledgedIds.has(row.id)
      ? { ...row, delivered: true, deliveryState: "acknowledged" as const }
      : row;
    const diagnosed = attachStuck(view);
    const keepFull =
      detailFull ||
      !row.delivered ||
      recentIds.has(row.id) ||
      rawIds.includes(row.id);
    if (keepFull) return diagnosed;
    return {
      ...diagnosed,
      artifacts: [],
      artifactsOmitted: Array.isArray(row.artifacts) ? row.artifacts.length : 0,
      detailHint: `passe ids:["${row.id}"] para o conteúdo completo`,
    };
  });
}

const handoffAcknowledgeTool: McpToolDef = {
  name: "nexus_handoff_ack",
  description:
    "Mark one delivered handoff as consumed after you actually processed its result. " +
    "Orchestrator-only; the ACK is bound to the exact accepted delivery. It never " +
    "completes a mission by itself, but verified completion requires this receipt. " +
    'verdict (default "accepted"): pass "rework" when you do NOT accept the delivery ' +
    "as-is (you send it back, or redo it elsewhere). It only records the verdict — " +
    "you still send the correction yourself — and Nexus learns from it: the " +
    "evidence review is labeled right/wrong against your decision, and a rework " +
    "counts as a failure in the CLI/model success rate that routing uses.",
  inputSchema: {
    type: "object",
    properties: {
      handoffId: { type: "string" },
      verdict: {
        type: "string",
        enum: ["accepted", "rework"],
        description:
          'accepted (default) = delivery accepted as-is; rework = sent back or redone',
      },
    },
    required: ["handoffId"],
  },
  handler: async (args, ctx, invocation) => {
    if (ctx.role !== "orchestrator" || !ctx.missionId || !ctx.sessionId) {
      throw new Error(
        "handoff acknowledgement requires the current physical mission orchestrator",
      );
    }
    const leader = requireMissionLeaderSession(ctx.scope, ctx.missionId, {
      sessionId: ctx.sessionId,
    });
    if (!leader.ok) {
      throw new Error(
        `handoff acknowledgement requires the current physical mission orchestrator (${leader.code}): ${leader.hint}`,
      );
    }
    const handoffId = requireStr(args, "handoffId");
    // F-782: o veredito é validado ANTES do consumo — valor inválido não
    // pode consumir o handoff e perder o rótulo.
    const verdict = handoffAckVerdictArg(args.verdict);
    const physicalReceipt = requireHandoffAckPhysicalReceipt(invocation);
    const consumed = getProjectDomainStores(
      ctx.scope,
    ).handoffs.markConsumedFromPhysicalAck(
      {
        handoffId,
        missionId: ctx.missionId,
        orchestratorSessionId: ctx.sessionId,
        verdict,
      },
      physicalReceipt,
    );
    if (!consumed)
      throw new Error("handoff is not awaiting consumption in this mission");
    return { ok: true, handoffId, deliveryState: "consumed", verdict };
  },
};

/** F-782: ausente = aceito como veio (o ACK de sempre). */
function handoffAckVerdictArg(raw: unknown): HandoffAckVerdict {
  if (raw === undefined || raw === null || raw === "accepted") return "accepted";
  if (raw === "rework") return "rework";
  throw new Error('nexus_handoff_ack verdict must be "accepted" or "rework"');
}

const workerHeartbeatTool: McpToolDef = {
  name: "nexus_worker_heartbeat",
  description:
    "Renew the durable lifecycle lease for this exact worker PTY. Workers on " +
    "long tasks should call it no later than every four minutes. It never changes " +
    "task/mission status and is always allowed by the skill gate.",
  inputSchema: { type: "object", properties: {} },
  handler: async (_args, ctx) => {
    if (
      ctx.role !== "worker" ||
      !ctx.missionId ||
      !ctx.sessionId ||
      !ctx.workerIncarnationId
    ) {
      throw new Error(
        "worker heartbeat exige worker com missão, sessão e encarnação vinculadas",
      );
    }
    const dispatch = getProjectDomainStores(ctx.scope).taskDispatches.heartbeat(
      {
        sessionId: ctx.sessionId,
        missionId: ctx.missionId,
        workerIncarnationId: ctx.workerIncarnationId,
        leaseMs: TASK_DISPATCH_HEARTBEAT_LEASE_MS,
      },
    );
    if (dispatch.missionId !== ctx.missionId) {
      throw new Error("worker heartbeat não pertence à missão do token");
    }
    return {
      ok: true,
      dispatchId: dispatch.id,
      taskId: dispatch.taskId,
      leaseExpiresAt: dispatch.leaseExpiresAt,
    };
  },
};

export function buildHandoffTools(): McpToolDef[] {
  return [
    // F-794/F-795: submit em voo (spool) + salvaguarda da worktree do writer.
    withHandoffSubmitResilience(handoffSubmitTool),
    handoffListTool,
    handoffAcknowledgeTool,
    workerHeartbeatTool,
  ];
}
