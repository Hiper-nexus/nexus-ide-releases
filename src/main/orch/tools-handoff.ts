import path from "node:path";
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
  scheduleAutoCloseAfterHandoff,
} from "./pane-close-scopes";
import { findPane, listPaneSnapshots, requestPaneClose } from "./pane-registry";
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
import type { ScopedHandoff } from "./handoff-store";

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
  type JevReviewVerdict,
} from "./jev-handoff-review";

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
      fullText: { type: "string", description: "Optional full worker response (Overclock parity)." },
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
    if (!ctx.missionId) {
      return submitWorkspaceHandoff(args, ctx, invocation, [
        ...buildOverclockArtifacts(args),
        ...buildContextDagArtifacts(args),
      ]);
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
              : undefined;
    if (declaredStatus === "success" && jevSkipReason === undefined) {
      // A revisão Jev é egresso externo: revalida a autoridade ANTES do await
      // (o checkpoint pós-await permanece logo abaixo, antes da escrita).
      assertMcpInvocationCurrent(invocation);
      try {
        jevVerdict = await reviewMissionHandoff({
          sessionId: ctx.sessionId,
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
    const status: typeof declaredStatus =
      contractVerdict.kind === "exhausted" ? "blocked" : declaredStatus;
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
      ...(Array.isArray(args.artifacts) ? args.artifacts : []),
      ...overclockArtifacts,
      ...condensedFullText,
      ...contextDagArtifacts,
      ...(contractVerdict.kind === "exhausted"
        ? [deliveryContractExhaustedArtifact(contractVerdict, declaredStatus)]
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
    if (ctx.sessionId && ctx.workerIncarnationId && boundDispatch) {
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
    if (ctx.missionId && !replayed) {
      try {
        const diskFiles = collectFilesModified(executionScopeFor(ctx).rootRealPath);
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
          preferredTaskId: boundDispatch?.taskId,
          handoffStatus: status,
          filesModified,
        });
        if (advanced && ctx.sessionId) {
          markSessionSealedBoardCredited(ctx.sessionId);
          const cwd =
            ctx.executionScope?.rootRealPath ?? ctx.scope.rootRealPath;
          try {
            markMissionFilesCredited(
              ctx.missionId,
              listDirtyPathsUnderCwd(cwd),
            );
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
    "the complete trail (same as includeDelivered:true).",
  inputSchema: {
    type: "object",
    properties: {
      missionId: { type: "string" },
      includeDelivered: { type: "boolean" },
      full: { type: "boolean" },
      panes: { type: "array", items: { type: "string" }, description: "Optional pane ids/sessions to limit results (Overclock parity)." },
      ids: { type: "array", items: { type: "string" }, description: "Optional exact handoff ids to fetch (Overclock parity)." },
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
    const rows = getProjectDomainStores(ctx.scope).handoffs.list({
      missionId,
      includeDelivered: resolveHandoffListIncludeDelivered(
        args, !ctx.missionId ? "orchestrator" : ctx.role,
      ),
      ...(paneSessionIds !== undefined && paneSessionIds.length > 0
        ? { sessionIds: paneSessionIds }
        : {}),
      ...(rawIds.length > 0 ? { ids: rawIds } : {}),
    });
    // List = recibo só de `submitted` (já colado no PTY). `queued` segue
    // para o idle-delivery: o Maestro que lista um queued ainda não recebeu
    // o paste — ack prematuro comia a fila (campo 24/08, 2x2).
    // Leitura cross-mission é auditoria: nunca reconhece nada.
    if (
      isProvenCurrentOrchestrator &&
      missionId === ctx.missionId &&
      rows.length > 0
    ) {
      try {
        const acked = getProjectDomainStores(
          ctx.scope,
        ).handoffs.acknowledgeSeenByOrchestratorList(ctx.missionId);
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
    return rows;
  },
};

const handoffAcknowledgeTool: McpToolDef = {
  name: "nexus_handoff_ack",
  description:
    "Mark one delivered handoff as consumed after you actually processed its result. " +
    "Orchestrator-only; the ACK is bound to the exact accepted delivery. It never " +
    "completes a mission by itself, but verified completion requires this receipt.",
  inputSchema: {
    type: "object",
    properties: { handoffId: { type: "string" } },
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
    const physicalReceipt = requireHandoffAckPhysicalReceipt(invocation);
    const consumed = getProjectDomainStores(
      ctx.scope,
    ).handoffs.markConsumedFromPhysicalAck(
      {
        handoffId,
        missionId: ctx.missionId,
        orchestratorSessionId: ctx.sessionId,
      },
      physicalReceipt,
    );
    if (!consumed)
      throw new Error("handoff is not awaiting consumption in this mission");
    return { ok: true, handoffId, deliveryState: "consumed" };
  },
};

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
    handoffSubmitTool,
    handoffListTool,
    handoffAcknowledgeTool,
    workerHeartbeatTool,
  ];
}
