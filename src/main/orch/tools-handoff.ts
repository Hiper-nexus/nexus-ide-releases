import {
  canSubmitMissionHandoff,
  hasCurrentApprovedDispatchContract,
  MAX_PROMOTED_PLAN_SUMMARY_BYTES,
  MAX_PROMOTED_PLAN_SUMMARY_CHARS,
  resolveEffectiveIntentState,
} from "../../shared/mission-intent";
import { handoffStatusSchema } from "../../shared/orch-types";
import { markHandoffSubmitted } from "./gate";
import { onHandoffSubmitted } from "./idle-delivery";
import {
  armedAutoClosePaneId,
  disarmAutoCloseOnHandoff,
  shouldAutoCloseAfterHandoff,
} from "./pane-close-scopes";
import { requestPaneClose } from "./pane-registry";
import {
  assertMcpInvocationCurrent,
  type McpToolDef,
  type McpToolInvocation,
} from "./mcp-protocol";
import { getProjectDomainStores } from "./project-domain-store-registry";
import { orchWriteSession, requireStr, str } from "./tool-util";
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

const handoffSubmitTool: McpToolDef = {
  name: "nexus_handoff_submit",
  description:
    "Submit your work handoff to the orchestrator: " +
    "{status: success|partial|blocked|failed, summary, artifacts?, " +
    "evidenceIds?}. Always allowed regardless of allowlists. Status and " +
    "artifacts are untrusted delivery metadata and never complete a mission. " +
    "Only evidenceIds already issued and bound by Nexus can satisfy the " +
    "worker stop receipt.",
  inputSchema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["success", "partial", "blocked", "failed"],
      },
      summary: { type: "string" },
      artifacts: { type: "array", items: {} },
      evidenceIds: { type: "array", items: { type: "string" } },
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
    // Other lanes retain compact operational summaries.
    const summary = isPlanHandoff
      ? rawSummary
      : compactText(rawSummary, { maxChars: 4_000 }).text;
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
    const status = handoffStatusSchema.parse(args.status);
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
    const handoffInput = {
      status,
      summary,
      artifacts: Array.isArray(args.artifacts) ? args.artifacts : [],
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
    // Acorda o orquestrador: entrega o handoff no PTY dele pra que ele saiba
    // que tem resultado novo. Sem isto, o orquestrador ficava em
    // chef_idle_awaiting_workers pra sempre — o handoff existia mas ninguém
    // avisava. Bug real 12/08: worker chamou nexus_handoff_submit, foi OK,
    // mas orquestrador nunca recebeu.
    if (mission.orchestratorSessionId) {
      try {
        const wakeMsg =
          `\n📬 ${fromAgent || 'worker'}: **${status}** — ${summary.slice(0, 280)}\n` +
          `   (use nexus_handoff_list para ver todos os handoffs)\n`;
        orchWriteSession(mission.orchestratorSessionId, wakeMsg, {
          markInputBusy: false,
        });
      } catch {
        // Best-effort: handoff já está armazenado, wake é bônus.
      }
    }
    // A queued replay may be recovering from a process/network loss after the
    // SQLite commit but before delivery/completion side effects. Once delivery
    // advanced, replaying Pet Studio would re-read mutable artifact paths and
    // repeat an already-finished installation.
    const petStudioCompletion =
      !replayed || handoff.deliveryState === "queued"
        ? onHandoffSubmitted(handoff, ctx.scope)
        : null;
    // autoCloseOnHandoff (paridade Overclock): declarado no spawn, dispara SÓ
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
    "List submitted handoffs (undelivered by default; includeDelivered: true " +
    "for the full audit trail). Optionally filter by missionId.",
  inputSchema: {
    type: "object",
    properties: {
      missionId: { type: "string" },
      includeDelivered: { type: "boolean" },
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
    return getProjectDomainStores(ctx.scope).handoffs.list({
      missionId,
      includeDelivered: args.includeDelivered === true,
    });
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
