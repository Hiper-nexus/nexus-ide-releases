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
import {
  extractLegacyHandoffsFromText,
  isPlaceholderSummary,
} from "./legacy-handoff";

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
  terminate: (sessionId: string) => Promise<boolean> = orchTerminateSession,
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
  terminate: (sessionId: string) => Promise<boolean> = orchTerminateSession,
): Promise<boolean> {
  if (!isStaleReadOnlyObservationHandoffResult(result)) return false;
  return terminate(sessionId);
}

interface PreparedPtyHandoff {
  readonly sessionId: string;
  readonly ctx: AgentGateContext;
  readonly suite: ProjectDomainStoreSuite;
  readonly missionId: string;
  readonly dispatch: TaskDispatchRecord | undefined;
  readonly payload: PtyStreamHandoffPayload;
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
  const sessionDispatches = suite.taskDispatches
    .list(missionId)
    .filter((dispatch) => dispatch.sessionId === sessionId);
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
  return boundDispatch;
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
  if (!mission || !hasCurrentApprovedDispatchContract(mission)) {
    throw new Error("handoff_origin: current approved mission unavailable");
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
  return Object.freeze({
    sessionId,
    ctx,
    suite,
    missionId: mission.id,
    dispatch,
    payload,
    rawArgs,
    rawPayloadSha256: handoffRawPayloadSha256(rawArgs),
    summary: summarizeForPersistence(
      payload.summary,
      mission.intentContract?.lane === "plan",
    ),
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
  const { ctx, dispatch, missionId, payload, sessionId, suite } = prepared;
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
    status: payload.status,
    summary: prepared.summary,
    artifacts: payload.artifacts,
    missionId,
    sessionId,
    workerIncarnationId: ctx.workerIncarnationId,
    fromAgent,
  };
  const provenance = {
    worktreeHeadSha: prepared.worktreeHeadSha,
    rawPayloadSha256: prepared.rawPayloadSha256,
  };
  if (dispatch && ctx.workerIncarnationId) {
    return suite.handoffs.submitFromPhysicalAgentBoundaryAndTransitionDispatch(
      handoffInput,
      physicalReceipt,
      provenance,
      {
        sessionId,
        workerIncarnationId: ctx.workerIncarnationId,
        detail: `${payload.status}: ${prepared.summary}`,
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
    if (!committed.replayed || committed.handoff.deliveryState === "queued") {
      onHandoffSubmitted(committed.handoff, ctx.scope);
      try {
        advanceFastLaneStoryTaskFromHandoff(prepared.suite, {
          missionId: prepared.missionId,
          fromAgent: committed.handoff.fromAgent,
          summary: prepared.summary,
          preferredTaskId: prepared.dispatch?.taskId,
          handoffStatus: prepared.payload.status,
          sessionId,
        });
      } catch (error) {
        console.warn(
          "[handoff] PTY SUCCESS não avançou o board selado:",
          error instanceof Error ? error.message : error,
        );
      }
    }
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
  const payloads = extractPromotablePtyHandoffs(text);
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
