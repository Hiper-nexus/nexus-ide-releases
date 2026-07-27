import type { RealMissionE2EEvidence } from "../shared/real-mission-e2e";
import { getAuditStoragePath } from "./jarvis/audit-log";
import type { ProjectDomainStoreSuite } from "./orch/project-domain-store-registry";
import { createLazyProjectDatabaseFactory } from "./runtime/project-runtime-manager";

type MissionDriverCompletion = NonNullable<
  RealMissionE2EEvidence["completion"]
>;
export type MissionDriverStepReceipt =
  MissionDriverCompletion["stepReceipts"][number];
export type MissionDriverEvidenceBinding =
  MissionDriverStepReceipt["evidenceBinding"];
export type MissionDriverWorkflowStage = MissionDriverStepReceipt["fromStage"];

export const MISSION_DRIVER_WORKFLOW_STAGES =
  new Set<MissionDriverWorkflowStage>([
    "planning",
    "review-primary",
    "review-secondary",
    "execution",
    "validation-primary",
    "validation-secondary",
    "confirmation",
    "complete",
  ]);
const EVIDENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_SHA = /^[a-f0-9]{40,64}$/u;

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseMissionDriverEvidenceIds(raw: string): string[] | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      value.length > 256 ||
      value.some((id) => typeof id !== "string" || !EVIDENCE_ID.test(id)) ||
      new Set(value).size !== value.length
    ) {
      return null;
    }
    return [...value] as string[];
  } catch {
    return null;
  }
}

export function parseMissionDriverEvidenceBinding(
  raw: string,
): MissionDriverEvidenceBinding | null {
  try {
    const value = objectRecord(JSON.parse(raw) as unknown);
    if (
      !value ||
      typeof value.missionId !== "string" ||
      !EVIDENCE_ID.test(value.missionId) ||
      typeof value.contextRevision !== "string" ||
      !SHA256.test(value.contextRevision) ||
      typeof value.contractHash !== "string" ||
      !SHA256.test(value.contractHash) ||
      typeof value.baseSha !== "string" ||
      !GIT_SHA.test(value.baseSha) ||
      typeof value.headSha !== "string" ||
      !GIT_SHA.test(value.headSha) ||
      typeof value.diffHash !== "string" ||
      !SHA256.test(value.diffHash) ||
      !Number.isInteger(value.workflowRevision) ||
      (value.workflowRevision as number) <= 0
    ) {
      return null;
    }
    return {
      missionId: value.missionId,
      contextRevision: value.contextRevision,
      contractHash: value.contractHash,
      baseSha: value.baseSha,
      headSha: value.headSha,
      diffHash: value.diffHash,
      workflowRevision: value.workflowRevision as number,
    };
  } catch {
    return null;
  }
}

interface DurableHandoffConsumptionRow {
  readonly id: string;
  readonly consumed_at: number | null;
  readonly consumed_by_session: string | null;
  readonly consumed_delivery_attempt_id: string | null;
}

interface DurableDependencyConsumptionRow {
  readonly mission_id: string;
  readonly consumer_task_id: string;
  readonly dependency_task_id: string;
  readonly handoff_id: string;
  readonly consumer_session_id: string;
  readonly consumer_worker_incarnation_id: string;
  readonly prompt_sha256: string;
  readonly handoff_summary_sha256: string;
  readonly consumed_at: number;
}

interface DurableMissionStepReceiptRow {
  readonly step_id: string;
  readonly from_stage: string;
  readonly to_stage: string;
  readonly workflow_revision_before: number;
  readonly workflow_revision_after: number;
  readonly evidence_ids_json: string;
  readonly evidence_binding_json: string;
  readonly completed_at: number;
}

interface DurableAuthoritySnapshot {
  readonly handoffConsumptions: ReadonlyMap<
    string,
    DurableHandoffConsumptionRow
  >;
  readonly dependencyConsumptions: readonly DurableDependencyConsumptionRow[];
  readonly missionStepReceipts: readonly DurableMissionStepReceiptRow[];
}

const openProjectEvidenceDatabase = createLazyProjectDatabaseFactory();

export function readDurableAuthoritySnapshot(
  scope: ProjectDomainStoreSuite["scope"],
  missionId: string,
): DurableAuthoritySnapshot {
  const database = openProjectEvidenceDatabase(
    getAuditStoragePath({ scope, missionId }),
    {
      readonly: true,
      fileMustExist: true,
    },
  );
  try {
    database.pragma("query_only = ON");
    return database
      .transaction(() => {
        const handoffRows = database
          .prepare(
            `SELECT id, consumed_at, consumed_by_session,
                    consumed_delivery_attempt_id
             FROM handoffs
             WHERE mission_id = ?
             ORDER BY created_at, id`,
          )
          .all(missionId) as DurableHandoffConsumptionRow[];
        const dependencyConsumptions = database
          .prepare(
            `SELECT mission_id, consumer_task_id, dependency_task_id,
                    handoff_id, consumer_session_id,
                    consumer_worker_incarnation_id, prompt_sha256,
                    handoff_summary_sha256, consumed_at
             FROM task_dependency_consumption_receipts
             WHERE mission_id = ?
             ORDER BY consumed_at, consumer_task_id, dependency_task_id`,
          )
          .all(missionId) as DurableDependencyConsumptionRow[];
        const missionStepReceipts = database
          .prepare(
            `SELECT step_id, from_stage, to_stage,
                    workflow_revision_before, workflow_revision_after,
                    evidence_ids_json, evidence_binding_json, completed_at
             FROM mission_step_receipts
             WHERE mission_id = ?
             ORDER BY completed_at, step_id`,
          )
          .all(missionId) as DurableMissionStepReceiptRow[];
        return Object.freeze({
          handoffConsumptions: new Map(
            handoffRows.map((row) => [row.id, Object.freeze({ ...row })]),
          ),
          dependencyConsumptions: Object.freeze(
            dependencyConsumptions.map((row) => Object.freeze({ ...row })),
          ),
          missionStepReceipts: Object.freeze(
            missionStepReceipts.map((row) => Object.freeze({ ...row })),
          ),
        });
      })
      .deferred();
  } finally {
    database.close();
  }
}
