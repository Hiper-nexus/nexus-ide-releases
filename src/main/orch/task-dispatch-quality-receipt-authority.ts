import { canonicalJson } from "../context/canonical-json";
import {
  parseMissionContract,
  type MissionContract,
} from "../context/contract-compiler";
import { parseWorkflowState } from "../context/prevc-engine";
import {
  parseReviewReport,
  type ReviewReport,
} from "../context/review-council";
import {
  parseTrustedEvidence,
  type TrustedEvidence,
} from "../context/sensor-broker";
import type { ScopeCoordinates } from "./scoped-store";
import { ScopedStoreCorruptionError } from "./scoped-store";
import { assertQualityCandidatePhysicalGitAuthority } from "./task-dispatch-physical-git-authority";
import {
  taskQualityReceiptProofSchema,
  type TaskIntegrationReceipt,
  type TaskQualityReceiptProof,
} from "./task-dispatch-codec";
import type { TaskDispatchDatabase } from "./task-dispatch-persistence";

const NO_CHANGE_QUALITY_REFERENCE =
  /^no-change:([a-f0-9]{40,64}):([a-f0-9]{64})$/u;
const GIT_REFERENCE = /^[a-f0-9]{40,64}$/u;
const MAX_EVIDENCE_JSON_BYTES = 4 * 1024 * 1024;

interface QualityContractRow {
  readonly contract_hash: string;
  readonly context_revision: string;
  readonly contract_json: string;
}

interface QualityWorkflowRow {
  readonly revision: number;
  readonly workflow_json: string;
}

function parseJson(raw: string, label: string): unknown {
  try {
    if (Buffer.byteLength(raw, "utf8") > MAX_EVIDENCE_JSON_BYTES) {
      throw new Error(`${label} exceeds 4 MiB`);
    }
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new ScopedStoreCorruptionError(label, { cause: error });
  }
}

function parsePersisted<T>(label: string, parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof ScopedStoreCorruptionError) throw error;
    throw new ScopedStoreCorruptionError(label, { cause: error });
  }
}

function assertContractAuthority(
  contract: MissionContract,
  row: QualityContractRow,
  coordinates: ScopeCoordinates,
  missionId: string,
): void {
  if (
    contract.projectId !== coordinates.projectId ||
    contract.checkoutId !== coordinates.checkoutId ||
    contract.missionId !== missionId ||
    contract.contractHash !== row.contract_hash ||
    contract.contextRevision !== row.context_revision
  ) {
    throw new ScopedStoreCorruptionError("quality receipt contract binding");
  }
}

function sameCandidateBinding(
  left: Pick<
    TrustedEvidence,
    | "projectId"
    | "checkoutId"
    | "missionId"
    | "contractHash"
    | "contextHash"
    | "baseSha"
    | "headSha"
    | "diffHash"
  >,
  right: ReviewReport["binding"],
): boolean {
  return (
    left.projectId === right.projectId &&
    left.checkoutId === right.checkoutId &&
    left.missionId === right.missionId &&
    left.contractHash === right.contractHash &&
    left.contextHash === right.contextHash &&
    left.baseSha === right.baseSha &&
    left.headSha === right.headSha &&
    left.diffHash === right.diffHash
  );
}

function assertReviewQuorum(
  contract: MissionContract,
  reports: readonly ReviewReport[],
): void {
  const reviewerSessionsById = new Map<string, string>();
  const reviewerIdsBySession = new Map<string, string>();
  for (const report of reports) {
    if (
      report.reviewerId === report.authorId ||
      report.reviewerSessionId === report.authorSessionId
    ) {
      throw new Error(
        "task quality receipt contains a self-review identity",
      );
    }
    const knownSession = reviewerSessionsById.get(report.reviewerId);
    const knownReviewer = reviewerIdsBySession.get(report.reviewerSessionId);
    if (
      (knownSession !== undefined &&
        knownSession !== report.reviewerSessionId) ||
      (knownReviewer !== undefined && knownReviewer !== report.reviewerId)
    ) {
      throw new Error(
        "task quality receipt contains an inconsistent reviewer identity",
      );
    }
    reviewerSessionsById.set(report.reviewerId, report.reviewerSessionId);
    reviewerIdsBySession.set(report.reviewerSessionId, report.reviewerId);
    const blockingFinding = report.findings.find(
      (finding) =>
        finding.status === "open" &&
        (finding.severity === "critical" || finding.severity === "high"),
    );
    if (blockingFinding) {
      throw new Error(
        "task quality receipt contains an open blocking review finding",
      );
    }
  }
  if (reviewerSessionsById.size < contract.reviewerPolicy.minimumReviewers) {
    throw new Error(
      "task quality receipt is missing the independent review quorum",
    );
  }
}

function loadSensorEvidence(
  db: TaskDispatchDatabase,
  evidenceId: string,
): TrustedEvidence | null {
  const row = db
    .prepare(
      `SELECT evidence_json, passed
         FROM sensor_evidence
        WHERE id = ?`,
    )
    .get(evidenceId) as
    | { readonly evidence_json: string; readonly passed: number }
    | undefined;
  if (!row) return null;
  const evidence = parsePersisted("quality sensor evidence", () =>
    parseTrustedEvidence(
      parseJson(row.evidence_json, "quality sensor evidence"),
    ),
  );
  if (
    evidence.id !== evidenceId ||
    row.passed !== 1 ||
    evidence.exitCode !== 0 ||
    evidence.timedOut
  ) {
    throw new Error("task quality receipt requires passing sensor evidence");
  }
  return evidence;
}

function loadReviewEvidence(
  db: TaskDispatchDatabase,
  evidenceId: string,
): ReviewReport | null {
  if (!evidenceId.startsWith("review:")) return null;
  const reviewId = evidenceId.slice("review:".length);
  const row = db
    .prepare(
      `SELECT report_json
         FROM review_reports
        WHERE review_id = ?`,
    )
    .get(reviewId) as { readonly report_json: string } | undefined;
  if (!row) return null;
  const report = parsePersisted("quality review evidence", () =>
    parseReviewReport(
      parseJson(row.report_json, "quality review evidence"),
    ),
  );
  if (`review:${report.reviewId}` !== evidenceId) {
    throw new ScopedStoreCorruptionError("quality review evidence identity");
  }
  return report;
}

/**
 * Re-proves an integrated/final-QA receipt from durable PREVC rows and
 * physical Git. Labels supplied by a scheduler are never authority: every
 * sensor/review ID must resolve to the exact contract, context and candidate,
 * and the candidate must be the commit published by the integration receipt.
 */
export function assertTaskQualityReceiptAuthority(input: {
  readonly db: TaskDispatchDatabase;
  readonly coordinates: ScopeCoordinates;
  readonly rootRealPath: string;
  readonly missionId: string;
  readonly physicalHeadSha: string;
  readonly receipt: TaskIntegrationReceipt;
  readonly requireEmbeddedProof?: boolean;
}): TaskQualityReceiptProof {
  const noChangeMatch = NO_CHANGE_QUALITY_REFERENCE.exec(
    input.receipt.reference,
  );
  const isIntegrated =
    input.receipt.kind === "worktree_integrated" &&
    GIT_REFERENCE.test(input.receipt.reference);
  const isNoChange =
    input.receipt.kind === "worktree_validated_no_change" &&
    noChangeMatch !== null &&
    noChangeMatch[1] === input.physicalHeadSha;
  if (!isIntegrated && !isNoChange) {
    throw new Error(
      "task quality receipt does not match an integrated/no-change Git reference",
    );
  }
  const evidenceIds = input.receipt.evidenceIds ?? [];
  if (
    evidenceIds.length === 0 ||
    new Set(evidenceIds).size !== evidenceIds.length
  ) {
    throw new Error(
      "task quality receipt requires unique durable evidence IDs",
    );
  }

  const contractRow = input.db
    .prepare(
      `SELECT contract_hash, context_revision, contract_json
         FROM mission_contracts
        WHERE mission_id = ?`,
    )
    .get(input.missionId) as QualityContractRow | undefined;
  const workflowRow = input.db
    .prepare(
      `SELECT revision, workflow_json
         FROM workflow_states
        WHERE mission_id = ?`,
    )
    .get(input.missionId) as QualityWorkflowRow | undefined;
  if (!contractRow || !workflowRow) {
    throw new Error(
      "task quality receipt requires a frozen contract and workflow",
    );
  }
  const contract = parsePersisted("quality receipt contract", () =>
    parseMissionContract(
      parseJson(contractRow.contract_json, "quality receipt contract"),
    ),
  );
  const workflow = parsePersisted("quality receipt workflow", () =>
    parseWorkflowState(
      parseJson(workflowRow.workflow_json, "quality receipt workflow"),
    ),
  );
  assertContractAuthority(
    contract,
    contractRow,
    input.coordinates,
    input.missionId,
  );
  if (
    workflow.revision !== workflowRow.revision ||
    workflow.binding.projectId !== input.coordinates.projectId ||
    workflow.binding.checkoutId !== input.coordinates.checkoutId ||
    workflow.binding.missionId !== input.missionId ||
    workflow.binding.contractHash !== contract.contractHash ||
    workflow.binding.contextHash !== contract.contextRevision
  ) {
    throw new ScopedStoreCorruptionError("quality receipt workflow binding");
  }
  const executionWorkflowRevision = workflow.route.indexOf("execution") + 1;
  if (
    executionWorkflowRevision < 1 ||
    workflow.revision < executionWorkflowRevision
  ) {
    throw new Error(
      "task quality receipt requires PREVC execution authority",
    );
  }
  if (
    !input.requireEmbeddedProof &&
    (workflow.stage !== "execution" ||
      workflow.revision !== executionWorkflowRevision)
  ) {
    throw new Error(
      "task quality receipt requires current PREVC execution authority",
    );
  }

  const sensors: TrustedEvidence[] = [];
  const reports: ReviewReport[] = [];
  for (const evidenceId of evidenceIds) {
    const sensor = loadSensorEvidence(input.db, evidenceId);
    if (sensor) {
      sensors.push(sensor);
      continue;
    }
    const report = loadReviewEvidence(input.db, evidenceId);
    if (report) {
      reports.push(report);
      continue;
    }
    throw new Error(
      `task quality evidence "${evidenceId}" is not durable`,
    );
  }
  if (reports.length === 0) {
    throw new Error(
      "task quality receipt requires independent review evidence",
    );
  }
  const candidate = reports[0]!.binding;
  const integratedHeadSha = isIntegrated
    ? input.receipt.reference
    : noChangeMatch![1]!;
  const expectedCandidateHeadSha = integratedHeadSha;
  const expectedDiffHash = isIntegrated
    ? candidate.diffHash
    : noChangeMatch![2]!;
  if (
    candidate.projectId !== input.coordinates.projectId ||
    candidate.checkoutId !== input.coordinates.checkoutId ||
    candidate.missionId !== input.missionId ||
    candidate.contractHash !== contract.contractHash ||
    candidate.contextHash !== contract.contextRevision ||
    candidate.headSha !== expectedCandidateHeadSha ||
    candidate.diffHash !== expectedDiffHash ||
    (isNoChange && candidate.headSha !== input.physicalHeadSha) ||
    reports.some(
      (report) => canonicalJson(report.binding) !== canonicalJson(candidate),
    ) ||
    sensors.some((sensor) => !sameCandidateBinding(sensor, candidate))
  ) {
    throw new Error(
      "task quality evidence belongs to another contract, context or diff",
    );
  }
  assertQualityCandidatePhysicalGitAuthority({
    rootRealPath: input.rootRealPath,
    baseSha: candidate.baseSha,
    candidateHeadSha: candidate.headSha,
    diffHash: candidate.diffHash,
    integratedHeadSha,
  });
  const trustedSensorIds = new Set(sensors.map((sensor) => sensor.sensorId));
  const missingSensor = contract.requiredSensors.find(
    (sensorId) => !trustedSensorIds.has(sensorId),
  );
  if (missingSensor) {
    throw new Error(
      `task quality receipt is missing required sensor "${missingSensor}"`,
    );
  }
  assertReviewQuorum(contract, reports);

  const proof = taskQualityReceiptProofSchema.parse({
    projectId: input.coordinates.projectId,
    checkoutId: input.coordinates.checkoutId,
    missionId: input.missionId,
    contractHash: contract.contractHash,
    contextHash: contract.contextRevision,
    baseSha: candidate.baseSha,
    workerHeadSha: input.physicalHeadSha,
    headSha: candidate.headSha,
    integrationHeadSha: integratedHeadSha,
    diffHash: candidate.diffHash,
    // The proof is issued for the deterministic execution revision. PREVC may
    // legitimately advance to validation before this immutable receipt is
    // replayed; deriving the revision from the verified route accepts that
    // transition without trusting a historical value supplied by the receipt.
    workflowRevision: executionWorkflowRevision,
    sensorEvidenceIds: sensors.map((sensor) => sensor.id).sort(),
    reviewEvidenceIds: reports
      .map((report) => `review:${report.reviewId}`)
      .sort(),
    reviewerIds: [...new Set(reports.map((report) => report.reviewerId))].sort(),
    advisories:
      contract.requiredSensors.length === 0
        ? ["no-required-project-sensors"]
        : [],
  });
  if (
    input.requireEmbeddedProof &&
    (!input.receipt.qualityProof ||
      canonicalJson(input.receipt.qualityProof) !== canonicalJson(proof))
  ) {
    throw new Error(
      "persisted task receipt lost its canonical quality proof",
    );
  }
  return Object.freeze(proof);
}
