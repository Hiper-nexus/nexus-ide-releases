import { createHash } from "node:crypto";
import type { Handoff } from "../../shared/orch-types";
import type { TaskDispatchRecord } from "./task-dispatch-codec";

const MAX_DEPENDENCY_HANDOFF_SUMMARY_CHARS = 8_000;
const MAX_DEPENDENCY_HANDOFF_CONTEXT_CHARS = 12_000;
const MAX_DEPENDENCY_HANDOFFS = 32;
const MAX_DEPENDENCY_EVIDENCE_IDS = 16;

export interface MissionSchedulerDependencyHandoff {
  readonly taskId: string;
  readonly handoffId: string;
  readonly fromAgent: string;
  readonly summary: string;
  readonly summarySha256: string;
  readonly summaryTruncated: boolean;
  readonly evidenceIds: readonly string[];
  readonly evidenceIdsTruncated: boolean;
}

interface MissionSchedulerDependencyStores {
  readonly taskDispatches: {
    get(taskId: string):
      | Pick<
          TaskDispatchRecord,
          | "taskId"
          | "missionId"
          | "state"
          | "sessionId"
          | "workerIncarnationId"
          | "handoffId"
          | "handoffAcceptedAt"
          | "integrationReceipt"
          | "completedAt"
        >
      | null;
  };
  readonly handoffs: {
    get(handoffId: string):
      | Pick<
          Handoff,
          | "id"
          | "missionId"
          | "sessionId"
          | "workerIncarnationId"
          | "fromAgent"
          | "authorityOrigin"
          | "mcpProvenance"
          | "status"
          | "summary"
          | "evidenceIds"
        >
      | null;
  };
}

/**
 * Materialize the exact accepted handoffs behind a task's sealed dependencies.
 *
 * `dependsOn` alone orders work but carries no useful knowledge. This loader
 * binds each summary back to the completed dispatch and its physical MCP
 * provenance before exposing a bounded, explicitly untrusted context block to
 * the next worker. A handoff can inform the next task; it can never expand its
 * ownership, tools or execution authority.
 */
export function loadMissionSchedulerDependencyHandoffs(input: {
  readonly missionId: string;
  readonly dependsOn: readonly string[];
  readonly stores: MissionSchedulerDependencyStores;
}): readonly MissionSchedulerDependencyHandoff[] {
  if (input.dependsOn.length > MAX_DEPENDENCY_HANDOFFS) {
    throw new Error(
      "dependency_context_too_large: a tarefa excede 32 predecessores",
    );
  }
  let remainingChars = MAX_DEPENDENCY_HANDOFF_CONTEXT_CHARS;
  return Object.freeze(
    input.dependsOn.map((taskId, index) => {
      const dispatch = input.stores.taskDispatches.get(taskId);
      if (
        !dispatch ||
        dispatch.taskId !== taskId ||
        dispatch.missionId !== input.missionId ||
        dispatch.state !== "completed" ||
        !dispatch.sessionId ||
        !dispatch.workerIncarnationId ||
        !dispatch.handoffId ||
        dispatch.handoffAcceptedAt === undefined ||
        dispatch.completedAt === undefined ||
        !dispatch.integrationReceipt
      ) {
        throw new Error(
          `dependency_context_unavailable: ${taskId} não possui receipt de conclusão`,
        );
      }
      const handoff = input.stores.handoffs.get(dispatch.handoffId);
      const provenance = handoff?.mcpProvenance;
      if (
        !handoff ||
        handoff.id !== dispatch.handoffId ||
        handoff.missionId !== input.missionId ||
        handoff.sessionId !== dispatch.sessionId ||
        handoff.workerIncarnationId !== dispatch.workerIncarnationId ||
        handoff.authorityOrigin !== "agent" ||
        handoff.status !== "success" ||
        !provenance ||
        provenance.toolName !== "nexus_handoff_submit" ||
        provenance.missionId !== input.missionId ||
        provenance.sessionId !== dispatch.sessionId ||
        provenance.workerIncarnationId !== dispatch.workerIncarnationId
      ) {
        throw new Error(
          `dependency_context_unavailable: ${taskId} não possui handoff físico compatível`,
        );
      }
      const fullSummary = handoff.summary.trim();
      if (!fullSummary) {
        throw new Error(
          `dependency_context_unavailable: ${taskId} possui resumo vazio`,
        );
      }
      const safeSummary = fullSummary.replace(
        /[\0-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/gu,
        " ",
      );
      const remainingDependencies = input.dependsOn.length - index;
      const summaryLimit = Math.max(
        0,
        Math.min(
          MAX_DEPENDENCY_HANDOFF_SUMMARY_CHARS,
          Math.floor(remainingChars / remainingDependencies),
        ),
      );
      const summary = safeSummary.slice(0, summaryLimit);
      remainingChars -= summary.length;
      const evidenceIds = handoff.evidenceIds.slice(
        0,
        MAX_DEPENDENCY_EVIDENCE_IDS,
      );
      return Object.freeze({
        taskId,
        handoffId: handoff.id,
        fromAgent: handoff.fromAgent ?? taskId,
        summary,
        summarySha256: createHash("sha256")
          .update(fullSummary)
          .digest("hex"),
        summaryTruncated: summary.length !== safeSummary.length,
        evidenceIds: Object.freeze([...evidenceIds]),
        evidenceIdsTruncated: evidenceIds.length !== handoff.evidenceIds.length,
      });
    }),
  );
}
