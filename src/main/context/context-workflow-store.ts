import { z } from 'zod';
import type { ProjectExecutionScope } from '../../shared/types';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { ScopedStoreBinding, ScopedStoreCorruptionError } from '../orch/scoped-store';
import {
  parseMissionContract,
  type MissionContract,
} from './contract-compiler';
import {
  advanceWorkflow,
  parseWorkflowState,
  type WorkflowEvidence,
  type WorkflowState,
} from './prevc-engine';
import {
  parseTrustedEvidence,
  type TrustedEvidence,
} from './sensor-broker';
import { canonicalJson } from './canonical-json';
import {
  parseReviewReport,
  type ReviewReport,
} from './review-council';

const identitySchema = z
  .object({
    id: z.string().trim().min(1).max(256),
    sessionId: z.string().trim().min(1).max(256),
    provider: z.string().trim().min(1).max(256),
  })
  .strict();
const missionIdSchema = z.string().trim().min(1).max(256);

interface ContractRow {
  contract_json: string;
  author_id: string;
  author_session_id: string;
  author_provider: string;
  frozen_at: number;
}

interface WorkflowRow {
  workflow_json: string;
  revision: number;
}

export interface WorkflowActorIdentity {
  readonly id: string;
  readonly sessionId: string;
  readonly provider: string;
}

export interface StoredMissionContract {
  readonly contract: MissionContract;
  readonly author: WorkflowActorIdentity;
  readonly frozenAt: number;
}

export interface ContextWorkflowStoreOptions {
  readonly now?: () => number;
}

function parseJson(raw: string, label: string): unknown {
  try {
    if (Buffer.byteLength(raw, 'utf8') > 4 * 1024 * 1024) {
      throw new Error('record exceeds 4 MiB');
    }
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new ScopedStoreCorruptionError(label, { cause: error });
  }
}

function asCorruption<T>(label: string, parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof ScopedStoreCorruptionError) throw error;
    throw new ScopedStoreCorruptionError(label, { cause: error });
  }
}

export class ContextWorkflowStore {
  readonly #binding: ScopedStoreBinding;

  constructor(
    runtimeManager: ProjectRuntimeManager,
    scope: ProjectExecutionScope,
    options: ContextWorkflowStoreOptions = {},
  ) {
    this.#binding = new ScopedStoreBinding(runtimeManager, scope, {
      now: options.now,
    });
  }

  get scope(): ProjectExecutionScope {
    return this.#binding.scope;
  }

  freeze(
    contract: MissionContract,
    workflow: WorkflowState,
    rawAuthor: WorkflowActorIdentity,
  ): StoredMissionContract {
    const parsedContract = parseMissionContract(contract);
    const parsedWorkflow = parseWorkflowState(workflow);
    const author = identitySchema.parse(rawAuthor);
    if (
      parsedContract.projectId !== this.scope.projectId ||
      parsedContract.checkoutId !== this.scope.checkoutId ||
      parsedWorkflow.binding.projectId !== this.scope.projectId ||
      parsedWorkflow.binding.checkoutId !== this.scope.checkoutId ||
      parsedWorkflow.binding.missionId !== parsedContract.missionId ||
      parsedWorkflow.binding.contractHash !== parsedContract.contractHash ||
      parsedWorkflow.binding.contextHash !== parsedContract.contextRevision ||
      parsedWorkflow.binding.baseSha !== parsedContract.baseCommit
    ) {
      throw new Error('contract/workflow binding does not match project scope');
    }
    const now = this.#binding.now();
    const db = this.#binding.writeDatabase();
    db.transaction(() => {
      const mission = db.prepare('SELECT id FROM missions WHERE id = ?').get(parsedContract.missionId);
      if (!mission) throw new Error('mission not found in project scope');
      db.prepare(
        `INSERT INTO mission_contracts
           (mission_id, revision, contract_hash, context_revision,
            contract_json, author_id, author_session_id, author_provider, frozen_at)
         VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        parsedContract.missionId,
        parsedContract.contractHash,
        parsedContract.contextRevision,
        canonicalJson(parsedContract),
        author.id,
        author.sessionId,
        author.provider,
        now,
      );
      db.prepare(
        `INSERT INTO workflow_states
           (mission_id, revision, stage, workflow_json, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        parsedContract.missionId,
        parsedWorkflow.revision,
        parsedWorkflow.stage,
        canonicalJson(parsedWorkflow),
        now,
      );
    })();
    return Object.freeze({
      contract: parsedContract,
      author: Object.freeze({ ...author }),
      frozenAt: now,
    });
  }

  getContract(rawMissionId: string): StoredMissionContract | null {
    const missionId = missionIdSchema.parse(rawMissionId);
    const row = this.#binding
      .readDatabase()
      .prepare(
        `SELECT contract_json, author_id, author_session_id, author_provider, frozen_at
         FROM mission_contracts WHERE mission_id = ?`,
      )
      .get(missionId) as ContractRow | undefined;
    if (!row) return null;
    return asCorruption('mission contract', () => Object.freeze({
      contract: parseMissionContract(parseJson(row.contract_json, 'mission contract')),
      author: Object.freeze(identitySchema.parse({
        id: row.author_id,
        sessionId: row.author_session_id,
        provider: row.author_provider,
      })),
      frozenAt: z.number().int().nonnegative().parse(row.frozen_at),
    }));
  }

  getWorkflow(rawMissionId: string): WorkflowState | null {
    const missionId = missionIdSchema.parse(rawMissionId);
    const row = this.#binding
      .readDatabase()
      .prepare('SELECT workflow_json, revision FROM workflow_states WHERE mission_id = ?')
      .get(missionId) as WorkflowRow | undefined;
    if (!row) return null;
    return asCorruption('workflow state', () => {
      const state = parseWorkflowState(parseJson(row.workflow_json, 'workflow state'));
      if (state.revision !== row.revision) {
        throw new Error('workflow revision columns diverged');
      }
      return state;
    });
  }

  advance(
    rawMissionId: string,
    expectedRevision: number,
    evidence: WorkflowEvidence,
    requestedNext: WorkflowState['stage'],
  ): WorkflowState {
    const missionId = missionIdSchema.parse(rawMissionId);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new Error('valid expected workflow revision is required');
    }
    const db = this.#binding.writeDatabase();
    const next = db.transaction(() => {
      const row = db
        .prepare('SELECT workflow_json, revision FROM workflow_states WHERE mission_id = ?')
        .get(missionId) as WorkflowRow | undefined;
      if (!row) throw new Error('workflow not found');
      if (row.revision !== expectedRevision) {
        throw new Error('workflow optimistic concurrency conflict');
      }
      const current = parseWorkflowState(parseJson(row.workflow_json, 'workflow state'));
      const advanced = advanceWorkflow(current, evidence, requestedNext);
      const result = db
        .prepare(
          `UPDATE workflow_states
           SET revision = ?, stage = ?, workflow_json = ?, updated_at = ?
           WHERE mission_id = ? AND revision = ?`,
        )
        .run(
          advanced.revision,
          advanced.stage,
          canonicalJson(advanced),
          this.#binding.now(),
          missionId,
          expectedRevision,
        );
      if (result.changes !== 1) throw new Error('workflow optimistic concurrency conflict');
      return advanced;
    })();
    return next;
  }

  recordSensorEvidence(rawEvidence: TrustedEvidence): TrustedEvidence {
    return this.#recordSensorEvidence(rawEvidence, true);
  }

  recordMergeSensorEvidence(rawEvidence: TrustedEvidence): TrustedEvidence {
    return this.#recordSensorEvidence(rawEvidence, false);
  }

  #recordSensorEvidence(
    rawEvidence: TrustedEvidence,
    requireContractBase: boolean,
  ): TrustedEvidence {
    const evidence = parseTrustedEvidence(rawEvidence);
    if (
      evidence.projectId !== this.scope.projectId ||
      evidence.checkoutId !== this.scope.checkoutId
    ) {
      throw new Error('sensor evidence belongs to another project scope');
    }
    const contract = this.getContract(evidence.missionId);
    if (!contract) throw new Error('sensor evidence mission has no frozen contract');
    if (
      contract.contract.contractHash !== evidence.contractHash ||
      contract.contract.contextRevision !== evidence.contextHash ||
      (requireContractBase && contract.contract.baseCommit !== evidence.baseSha)
    ) {
      throw new Error('sensor evidence does not match the frozen contract');
    }
    this.#binding
      .writeDatabase()
      .prepare(
        `INSERT INTO sensor_evidence
           (id, mission_id, sensor_id, head_sha, diff_hash, passed,
            evidence_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        evidence.id,
        evidence.missionId,
        evidence.sensorId,
        evidence.headSha,
        evidence.diffHash,
        evidence.exitCode === 0 && !evidence.timedOut ? 1 : 0,
        canonicalJson(evidence),
        Date.parse(evidence.finishedAt),
      );
    return evidence;
  }

  listSensorEvidence(rawMissionId: string): readonly TrustedEvidence[] {
    const missionId = missionIdSchema.parse(rawMissionId);
    const rows = this.#binding
      .readDatabase()
      .prepare(
        `SELECT evidence_json FROM sensor_evidence
         WHERE mission_id = ? ORDER BY created_at, id`,
      )
      .all(missionId) as Array<{ evidence_json: string }>;
    return Object.freeze(rows.map((row) => asCorruption('sensor evidence', () =>
      parseTrustedEvidence(parseJson(row.evidence_json, 'sensor evidence')),
    )));
  }

  recordReviewReport(rawReport: ReviewReport): ReviewReport {
    return this.#recordReviewReport(rawReport, true);
  }

  recordMergeReviewReport(rawReport: ReviewReport): ReviewReport {
    return this.#recordReviewReport(rawReport, false);
  }

  #recordReviewReport(
    rawReport: ReviewReport,
    requireCurrentWorkflow: boolean,
  ): ReviewReport {
    const report = parseReviewReport(rawReport);
    if (
      report.binding.projectId !== this.scope.projectId ||
      report.binding.checkoutId !== this.scope.checkoutId
    ) {
      throw new Error('review report belongs to another project scope');
    }
    const contract = this.getContract(report.binding.missionId);
    const workflow = this.getWorkflow(report.binding.missionId);
    if (!contract || !workflow) throw new Error('review mission has no frozen workflow');
    if (
      report.binding.contractHash !== contract.contract.contractHash ||
      report.binding.contextHash !== contract.contract.contextRevision ||
      (requireCurrentWorkflow &&
        (report.binding.diffHash !== workflow.binding.diffHash ||
          report.binding.headSha !== workflow.binding.headSha ||
          report.binding.baseSha !== workflow.binding.baseSha))
    ) {
      throw new Error('review report does not match the current workflow binding');
    }
    this.#binding
      .writeDatabase()
      .prepare(
        `INSERT INTO review_reports
           (review_id, mission_id, diff_hash, report_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        report.reviewId,
        report.binding.missionId,
        report.binding.diffHash,
        canonicalJson(report),
        this.#binding.now(),
      );
    return report;
  }

  listReviewReports(
    rawMissionId: string,
    rawDiffHash?: string,
  ): readonly ReviewReport[] {
    const missionId = missionIdSchema.parse(rawMissionId);
    const diffHash = rawDiffHash === undefined
      ? undefined
      : z.string().regex(/^[a-f0-9]{64}$/).parse(rawDiffHash);
    const rows = diffHash
      ? this.#binding
          .readDatabase()
          .prepare(
            `SELECT report_json FROM review_reports
             WHERE mission_id = ? AND diff_hash = ?
             ORDER BY created_at, review_id`,
          )
          .all(missionId, diffHash)
      : this.#binding
          .readDatabase()
          .prepare(
            `SELECT report_json FROM review_reports
             WHERE mission_id = ? ORDER BY created_at, review_id`,
          )
          .all(missionId);
    return Object.freeze(
      (rows as Array<{ report_json: string }>).map((row) =>
        asCorruption('review report', () =>
          parseReviewReport(parseJson(row.report_json, 'review report')),
        ),
      ),
    );
  }
}

export function createContextWorkflowStore(
  runtimeManager: ProjectRuntimeManager,
  scope: ProjectExecutionScope,
  options: ContextWorkflowStoreOptions = {},
): ContextWorkflowStore {
  return new ContextWorkflowStore(runtimeManager, scope, options);
}
