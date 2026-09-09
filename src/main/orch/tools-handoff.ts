import path from "node:path";
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
import { markHandoffSubmitted, type GateRole } from "./gate";
import { onHandoffSubmitted } from "./idle-delivery";
import {
  armedAutoClosePaneId,
  disarmAutoCloseOnHandoff,
  shouldAutoCloseAfterHandoff,
} from "./pane-close-scopes";
import { listPaneSnapshots, requestPaneClose } from "./pane-registry";
import {
  assertMcpInvocationCurrent,
  type McpToolDef,
  type McpToolInvocation,
} from "./mcp-protocol";
import { getProjectDomainStores } from "./project-domain-store-registry";
import { normalizeHandoffStatusInput } from "./legacy-handoff";
import { requireStr, str } from "./tool-util";
import { compactText } from "./session-compaction";
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
    "and bound by Nexus can satisfy the worker stop receipt.",
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
    const summary = isPlanHandoff
      ? cleanSummary
      : compactText(cleanSummary, { maxChars: 4_000 }).text;
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
    const status = handoffStatusSchema.parse(
      normalizeHandoffStatusInput(args.status),
    );
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
    const artifacts = [
      ...(Array.isArray(args.artifacts) ? args.artifacts : []),
      ...overclockArtifacts,
      ...contextDagArtifacts,
      ...(telemetry ? [embedTelemetryArtifact(telemetry)] : []),
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
        const declaredFiles = normalizeFilesModified({
          filesModified: args.filesModified,
          "files-modified": args["files-modified"],
          artifacts: args.artifacts,
        });
        const diskFiles = collectFilesModified(ctx.scope.rootRealPath);
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
    if (ctx.sessionId) {
      const autoClosePaneId = armedAutoClosePaneId(ctx.sessionId);
      if (
        shouldAutoCloseAfterHandoff({
          armed: autoClosePaneId !== null,
          status,
        })
      ) {
        disarmAutoCloseOnHandoff(ctx.sessionId);
        setTimeout(() => {
          void Promise.resolve(requestPaneClose(autoClosePaneId!)).catch(
            (error) =>
              console.warn(
                `[handoff] auto-close do pane ${autoClosePaneId} falhou:`,
                error,
              ),
          );
        }, 0);
      }
    }
    return {
      ok: true,
      handoffId: handoff.id,
      evidenceTrust: handoff.evidenceTrust,
      stopGateSatisfied: handoff.evidenceTrust === "nexus-trusted",
      ...(replayed ? { replayed: true } : {}),
      ...(taskDispatchState ? { taskDispatchState } : {}),
      ...(petStudioCompletion ? { petStudioCompletion } : {}),
    };
  },
};

const handoffListTool: McpToolDef = {
  name: "nexus_handoff_list",
  description:
    "List handoffs for the current mission. The Maestro sees the full audit " +
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
    const requestedMission = str(args, "missionId");
    const missionId =
      ctx.role === "orchestrator"
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
    const rawIds = Array.isArray(args.ids)
      ? args.ids.filter((i) => typeof i === "string")
      : [];
    const rows = getProjectDomainStores(ctx.scope).handoffs.list({
      missionId,
      includeDelivered: resolveHandoffListIncludeDelivered(args, ctx.role),
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
      ctx.role === "orchestrator" &&
      ctx.missionId &&
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
