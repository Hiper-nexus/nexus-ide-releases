import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  handoffStatusSchema,
  handoffDeliveryStateSchema,
  type Handoff,
  type HandoffEvidenceBinding,
} from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  parseWorkflowState,
  type EvidenceBinding,
} from '../context/prevc-engine';
import { parseReviewReport } from '../context/review-council';
import { parseTrustedEvidence } from '../context/sensor-broker';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import {
  encodeJsonArray,
  parseJsonArray,
  ScopedStoreBinding,
  ScopedStoreCorruptionError,
  type ScopedEntity,
  type ScopedStoreChangeListener,
  type ScopedStoreOptions,
} from './scoped-store';

const identifierSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);
// Squad agentName is a human-facing identity and legitimately contains spaces
// (for example "UX Designer"). Keep opaque ids strict, but do not make those
// valid roster workers unable to submit a handoff.
const agentLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[^\u0000-\u001F\u007F]+$/u);

const evidenceIdsSchema = z
  .array(identifierSchema)
  .max(256)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: 'evidenceIds must be unique',
  });

const submitHandoffInputSchema = z
  .object({
    status: handoffStatusSchema,
    summary: z.string().min(1).max(65_536),
    artifacts: z.array(z.unknown()).max(4_096).optional(),
    evidenceIds: evidenceIdsSchema.optional(),
    missionId: identifierSchema.optional(),
    sessionId: identifierSchema.optional(),
    workerIncarnationId: identifierSchema.optional(),
    fromAgent: agentLabelSchema.optional(),
  })
  .strict();

const nullableHashSchema = z.string().regex(/^[a-f0-9]{64}$/).nullable();
const nullableCommitSchema = z
  .string()
  .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
  .nullable();

const handoffRowSchema = z
  .object({
    id: identifierSchema,
    mission_id: identifierSchema.nullable(),
    session_id: identifierSchema.nullable(),
    worker_incarnation_id: identifierSchema.nullable(),
    from_agent: agentLabelSchema.nullable(),
    authority_origin: z.enum(['agent', 'operator-confirmed']),
    status: handoffStatusSchema,
    summary: z.string().min(1).max(65_536),
    artifacts_json: z.string(),
    evidence_ids_json: z.string(),
    evidence_trusted: z.union([z.literal(0), z.literal(1)]),
    context_revision: nullableHashSchema,
    contract_hash: nullableHashSchema,
    base_sha: nullableCommitSchema,
    head_sha: nullableCommitSchema,
    diff_hash: nullableHashSchema,
    workflow_revision: z.number().int().positive().nullable(),
    delivered: z.union([z.literal(0), z.literal(1)]),
    delivery_state: handoffDeliveryStateSchema,
    submitted_at: z.number().int().nonnegative().nullable(),
    acknowledged_at: z.number().int().nonnegative().nullable(),
    consumed_at: z.number().int().nonnegative().nullable(),
    created_at: z.number().int().nonnegative(),
  })
  .strict();

const deliveryAttemptStateSchema = z.enum([
  'reserved',
  'pasted',
  'accepted',
  'failed',
]);

const deliveryAttemptRowSchema = z.object({
  id: identifierSchema,
  handoff_id: identifierSchema,
  mission_id: identifierSchema,
  orchestrator_session_id: identifierSchema,
  attempt_no: z.number().int().positive(),
  state: deliveryAttemptStateSchema,
  started_at: z.number().int().nonnegative(),
  accept_deadline_at: z.number().int().nonnegative().nullable(),
  accepted_at: z.number().int().nonnegative().nullable(),
  failed_at: z.number().int().nonnegative().nullable(),
  failure_code: z.string().max(256).nullable(),
}).strict();

export interface HandoffDeliveryAttempt {
  readonly id: string;
  readonly handoffId: string;
  readonly missionId: string;
  readonly orchestratorSessionId: string;
  readonly attemptNo: number;
  readonly state: z.infer<typeof deliveryAttemptStateSchema>;
  readonly startedAt: number;
  readonly acceptDeadlineAt?: number;
  readonly acceptedAt?: number;
  readonly failedAt?: number;
  readonly failureCode?: string;
}

const currentWorkflowRowSchema = z
  .object({
    contract_hash: z.string().regex(/^[a-f0-9]{64}$/),
    context_revision: z.string().regex(/^[a-f0-9]{64}$/),
    workflow_revision: z.number().int().positive(),
    workflow_json: z.string(),
  })
  .strict();

const BINDING_KEYS: readonly (keyof EvidenceBinding)[] = [
  'projectId',
  'checkoutId',
  'missionId',
  'contractHash',
  'contextHash',
  'baseSha',
  'headSha',
  'diffHash',
];

const HANDOFF_SELECT = `
  SELECT id, mission_id, session_id, worker_incarnation_id, from_agent,
         authority_origin, status, summary,
         artifacts_json, evidence_ids_json, evidence_trusted,
         context_revision, contract_hash, base_sha, head_sha, diff_hash,
         workflow_revision, delivered, delivery_state, submitted_at,
         acknowledged_at, consumed_at, created_at
  FROM handoffs`;

export type ScopedHandoff = ScopedEntity<Handoff>;
export type SubmitHandoffInput = z.input<typeof submitHandoffInputSchema>;

export interface ListHandoffsFilter {
  missionId?: string;
  includeDelivered?: boolean;
}

interface ResolvedEvidence {
  readonly evidenceIds: string[];
  readonly binding?: HandoffEvidenceBinding;
}

function parseBoundedJson(raw: string, label: string): unknown {
  try {
    if (Buffer.byteLength(raw, 'utf8') > 4 * 1024 * 1024) {
      throw new Error(`${label} exceeds 4 MiB`);
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

function cloneBinding(
  binding: HandoffEvidenceBinding | undefined,
): HandoffEvidenceBinding | undefined {
  return binding ? Object.freeze({ ...binding }) : undefined;
}

function cloneHandoff(handoff: ScopedHandoff): ScopedHandoff {
  return {
    ...handoff,
    artifacts: parseJsonArray(
      encodeJsonArray(handoff.artifacts, 'handoff artifacts'),
      'handoff artifacts',
    ),
    evidenceIds: [...handoff.evidenceIds],
    evidenceBinding: cloneBinding(handoff.evidenceBinding),
  };
}

function toHandoffBinding(
  binding: EvidenceBinding,
  workflowRevision: number,
): HandoffEvidenceBinding {
  return Object.freeze({
    missionId: binding.missionId,
    contextRevision: binding.contextHash,
    contractHash: binding.contractHash,
    baseSha: binding.baseSha,
    headSha: binding.headSha,
    diffHash: binding.diffHash,
    workflowRevision,
  });
}

function sameHandoffBinding(
  left: HandoffEvidenceBinding,
  right: HandoffEvidenceBinding,
): boolean {
  return (
    left.missionId === right.missionId &&
    left.contextRevision === right.contextRevision &&
    left.contractHash === right.contractHash &&
    left.baseSha === right.baseSha &&
    left.headSha === right.headSha &&
    left.diffHash === right.diffHash &&
    left.workflowRevision === right.workflowRevision
  );
}

function assertEvidenceMatches(
  evidenceId: string,
  actual: EvidenceBinding,
  expected: EvidenceBinding,
): void {
  if (actual.missionId !== expected.missionId) {
    throw new Error(
      `trusted evidence "${evidenceId}" belongs to another mission`,
    );
  }
  if (
    actual.projectId !== expected.projectId ||
    actual.checkoutId !== expected.checkoutId
  ) {
    throw new Error(
      `trusted evidence "${evidenceId}" belongs to another project scope`,
    );
  }
  const mismatch = BINDING_KEYS.find((key) => actual[key] !== expected[key]);
  if (mismatch) {
    throw new Error(
      `trusted evidence "${evidenceId}" does not match the current ` +
        `workflow binding (${mismatch})`,
    );
  }
}

export class ScopedHandoffStore {
  readonly #binding: ScopedStoreBinding;

  constructor(
    runtimeManager: ProjectRuntimeManager,
    scope: ProjectExecutionScope,
    options: ScopedStoreOptions = {},
  ) {
    this.#binding = new ScopedStoreBinding(runtimeManager, scope, options);
  }

  get scope(): ProjectExecutionScope {
    return this.#binding.scope;
  }

  onChange(listener: ScopedStoreChangeListener): () => void {
    return this.#binding.onChange(listener);
  }

  submit(rawInput: SubmitHandoffInput): ScopedHandoff {
    return this.#submit(rawInput, 'agent');
  }

  /** Main-only semantic boundary used after an exact native operator click. */
  submitOperatorConfirmed(rawInput: SubmitHandoffInput): ScopedHandoff {
    return this.#submit(rawInput, 'operator-confirmed');
  }

  #submit(
    rawInput: SubmitHandoffInput,
    authorityOrigin: 'agent' | 'operator-confirmed',
  ): ScopedHandoff {
    const input = submitHandoffInputSchema.parse(rawInput);
    const artifactsJson = encodeJsonArray(
      input.artifacts ?? [],
      'handoff artifacts',
    );
    const evidenceIds = input.evidenceIds ?? [];
    const evidenceIdsJson = encodeJsonArray(
      evidenceIds,
      'handoff evidence IDs',
    );
    const id = this.#binding.makeId('handoff');
    const createdAt = this.#binding.now();
    const db = this.#binding.writeDatabase();

    const insert = db.transaction(() => {
      const resolved = this.#resolveEvidence(
        db,
        input.missionId,
        evidenceIds,
      );
      const handoff: ScopedHandoff = {
        id,
        missionId: input.missionId,
        sessionId: input.sessionId,
        workerIncarnationId: input.workerIncarnationId,
        fromAgent: input.fromAgent,
        authorityOrigin,
        status: input.status,
        claimTrust: 'untrusted',
        summary: input.summary,
        artifacts: parseJsonArray(artifactsJson, 'handoff artifacts'),
        evidenceIds: [...resolved.evidenceIds],
        evidenceTrust: resolved.binding ? 'nexus-trusted' : 'unverified',
        evidenceBinding: resolved.binding,
        delivered: false,
        deliveryState: 'queued',
        createdAt,
        ...this.#binding.coordinates,
      };
      db.prepare(
        `INSERT INTO handoffs
           (id, mission_id, session_id, worker_incarnation_id, from_agent,
            authority_origin, status, summary,
            artifacts_json, evidence_ids_json, evidence_trusted,
            context_revision, contract_hash, base_sha, head_sha, diff_hash,
            workflow_revision, delivered, delivery_state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'queued', ?)`,
      ).run(
        handoff.id,
        handoff.missionId ?? null,
        handoff.sessionId ?? null,
        handoff.workerIncarnationId ?? null,
        handoff.fromAgent ?? null,
        handoff.authorityOrigin,
        handoff.status,
        handoff.summary,
        artifactsJson,
        evidenceIdsJson,
        resolved.binding ? 1 : 0,
        resolved.binding?.contextRevision ?? null,
        resolved.binding?.contractHash ?? null,
        resolved.binding?.baseSha ?? null,
        resolved.binding?.headSha ?? null,
        resolved.binding?.diffHash ?? null,
        resolved.binding?.workflowRevision ?? null,
        handoff.createdAt,
      );
      return handoff;
    });

    const handoff = insert.immediate();
    this.#binding.emitChange();
    return cloneHandoff(handoff);
  }

  list(rawFilter: ListHandoffsFilter = {}): ScopedHandoff[] {
    const filter = z
      .object({
        missionId: identifierSchema.optional(),
        includeDelivered: z.boolean().optional(),
      })
      .strict()
      .parse(rawFilter);
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.missionId !== undefined) {
      clauses.push('mission_id = ?');
      params.push(filter.missionId);
    }
    if (!filter.includeDelivered) clauses.push('delivered = 0');
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const db = this.#binding.readDatabase();
    const rows = db
      .prepare(
        `${HANDOFF_SELECT} ${where}
         ORDER BY created_at ASC, id ASC`,
      )
      .all(...params);
    return rows.map((row) => this.#fromRow(row, db));
  }

  get(rawId: string): ScopedHandoff | null {
    const id = identifierSchema.parse(rawId);
    const db = this.#binding.readDatabase();
    const row = db.prepare(`${HANDOFF_SELECT} WHERE id = ?`).get(id);
    return row ? this.#fromRow(row, db) : null;
  }

  markDelivered(rawId: string): boolean {
    return this.markSubmitted(rawId);
  }

  markSubmitted(rawId: string): boolean {
    const id = identifierSchema.parse(rawId);
    const now = this.#binding.now();
    const result = this.#binding
      .writeDatabase()
      .prepare(
        `UPDATE handoffs
         SET delivered = 1, delivery_state = 'submitted', submitted_at = ?
         WHERE id = ? AND delivery_state = 'queued'`,
      )
      .run(now, id);
    if (result.changes === 0) return false;
    this.#binding.emitChange();
    return true;
  }

  reserveDeliveryAttempt(input: {
    readonly handoffId: string;
    readonly missionId: string;
    readonly orchestratorSessionId: string;
    readonly maxAttempts: number;
  }): HandoffDeliveryAttempt {
    const handoffId = identifierSchema.parse(input.handoffId);
    const missionId = identifierSchema.parse(input.missionId);
    const sessionId = identifierSchema.parse(input.orchestratorSessionId);
    const maxAttempts = z.number().int().positive().max(16).parse(input.maxAttempts);
    const now = this.#binding.now();
    const db = this.#binding.writeDatabase();
    const attempt = db.transaction(() => {
      const handoff = db.prepare(
        `SELECT h.mission_id, h.delivery_state, m.orch_session_id
         FROM handoffs AS h
         JOIN missions AS m ON m.id = h.mission_id
         WHERE h.id = ?`,
      ).get(handoffId) as {
        mission_id: string | null;
        delivery_state: string;
        orch_session_id: string | null;
      } | undefined;
      if (!handoff || handoff.mission_id !== missionId) {
        throw new Error('handoff delivery scope/mission mismatch');
      }
      if (handoff.orch_session_id !== sessionId) {
        throw new Error('handoff delivery orchestrator session is stale');
      }
      if (handoff.delivery_state !== 'queued') {
        throw new Error(`handoff delivery is already ${handoff.delivery_state}`);
      }
      // A process restart loses the in-memory acceptance observer. Preserve
      // the attempt as failed evidence before reserving the bounded retry.
      db.prepare(
        `UPDATE handoff_delivery_attempts
         SET state = 'failed', failed_at = ?, failure_code = ?
         WHERE handoff_id = ? AND state IN ('reserved', 'pasted')`,
      ).run(now, 'acceptance_observer_lost', handoffId);
      const latest = db.prepare(
        `SELECT COALESCE(MAX(attempt_no), 0) AS attempt_no
         FROM handoff_delivery_attempts WHERE handoff_id = ?`,
      ).get(handoffId) as { attempt_no: number };
      const attemptNo = latest.attempt_no + 1;
      if (attemptNo > maxAttempts) {
        throw new Error('handoff delivery attempt budget exhausted');
      }
      const id = this.#binding.makeId('handoff-delivery');
      db.prepare(
        `INSERT INTO handoff_delivery_attempts (
           id, handoff_id, mission_id, orchestrator_session_id,
           attempt_no, state, started_at
         ) VALUES (?, ?, ?, ?, ?, 'reserved', ?)`,
      ).run(id, handoffId, missionId, sessionId, attemptNo, now);
      return this.#deliveryAttemptFromDatabase(db, id);
    }).immediate();
    if (!attempt) throw new Error('handoff delivery attempt was not persisted');
    this.#binding.emitChange();
    return attempt;
  }

  markDeliveryAttemptPasted(input: {
    readonly attemptId: string;
    readonly handoffId: string;
    readonly acceptDeadlineAt: number;
  }): HandoffDeliveryAttempt {
    const attemptId = identifierSchema.parse(input.attemptId);
    const handoffId = identifierSchema.parse(input.handoffId);
    const deadline = z.number().int().nonnegative().parse(input.acceptDeadlineAt);
    const now = this.#binding.now();
    if (deadline < now) throw new Error('handoff acceptance deadline is already expired');
    const db = this.#binding.writeDatabase();
    const result = db.prepare(
      `UPDATE handoff_delivery_attempts
       SET state = 'pasted', accept_deadline_at = ?
       WHERE id = ? AND handoff_id = ? AND state = 'reserved'
         AND orchestrator_session_id = (
           SELECT orch_session_id FROM missions
           WHERE id = handoff_delivery_attempts.mission_id
         )`,
    ).run(deadline, attemptId, handoffId);
    if (result.changes !== 1) throw new Error('handoff paste attempt lost CAS');
    const attempt = this.#deliveryAttemptFromDatabase(db, attemptId);
    if (!attempt) throw new Error('handoff delivery attempt disappeared after paste');
    this.#binding.emitChange();
    return attempt;
  }

  failDeliveryAttempt(input: {
    readonly attemptId: string;
    readonly handoffId: string;
    readonly failureCode: string;
  }): boolean {
    const attemptId = identifierSchema.parse(input.attemptId);
    const handoffId = identifierSchema.parse(input.handoffId);
    const failureCode = identifierSchema.parse(input.failureCode);
    const result = this.#binding.writeDatabase().prepare(
      `UPDATE handoff_delivery_attempts
       SET state = 'failed', failed_at = ?, failure_code = ?
       WHERE id = ? AND handoff_id = ? AND state IN ('reserved', 'pasted')`,
    ).run(this.#binding.now(), failureCode, attemptId, handoffId);
    if (result.changes > 0) this.#binding.emitChange();
    return result.changes === 1;
  }

  acceptDeliveryAttempt(input: {
    readonly attemptId: string;
    readonly handoffId: string;
  }): boolean {
    const attemptId = identifierSchema.parse(input.attemptId);
    const handoffId = identifierSchema.parse(input.handoffId);
    const now = this.#binding.now();
    const db = this.#binding.writeDatabase();
    const accepted = db.transaction(() => {
      const result = db.prepare(
        `UPDATE handoff_delivery_attempts
         SET state = 'accepted', accepted_at = ?
         WHERE id = ? AND handoff_id = ? AND state = 'pasted'
           AND accept_deadline_at >= ?
           AND orchestrator_session_id = (
             SELECT orch_session_id FROM missions
             WHERE id = handoff_delivery_attempts.mission_id
           )`,
      ).run(now, attemptId, handoffId, now);
      if (result.changes !== 1) return false;
      const handoff = db.prepare(
        `UPDATE handoffs
         SET delivered = 1, delivery_state = 'submitted', submitted_at = ?
         WHERE id = ? AND delivery_state = 'queued'`,
      ).run(now, handoffId);
      if (handoff.changes !== 1) {
        throw new Error('handoff submission lost delivery-attempt CAS');
      }
      return true;
    }).immediate();
    if (accepted) this.#binding.emitChange();
    return accepted;
  }

  listDeliveryAttempts(rawHandoffId: string): HandoffDeliveryAttempt[] {
    const handoffId = identifierSchema.parse(rawHandoffId);
    const db = this.#binding.readDatabase();
    return db.prepare(
      `SELECT * FROM handoff_delivery_attempts
       WHERE handoff_id = ? ORDER BY attempt_no ASC`,
    ).all(handoffId).map((row) => this.#deliveryAttemptFromRow(row));
  }

  acknowledgeMission(rawMissionId: string): number {
    const missionId = identifierSchema.parse(rawMissionId);
    const result = this.#binding.writeDatabase().prepare(
      `UPDATE handoffs
       SET delivery_state = 'acknowledged', acknowledged_at = ?
       WHERE mission_id = ? AND delivery_state = 'submitted'`,
    ).run(this.#binding.now(), missionId);
    if (result.changes > 0) this.#binding.emitChange();
    return result.changes;
  }

  markConsumed(rawId: string, rawMissionId: string): boolean {
    const id = identifierSchema.parse(rawId);
    const missionId = identifierSchema.parse(rawMissionId);
    const result = this.#binding.writeDatabase().prepare(
      `UPDATE handoffs
       SET delivery_state = 'consumed',
           acknowledged_at = COALESCE(acknowledged_at, ?), consumed_at = ?
       WHERE id = ? AND mission_id = ?
         AND delivery_state IN ('submitted', 'acknowledged')`,
    ).run(this.#binding.now(), this.#binding.now(), id, missionId);
    if (result.changes === 0) return false;
    this.#binding.emitChange();
    return true;
  }

  hasTrustedFromSession(
    rawSessionId: string,
    rawWorkerIncarnationId?: string,
  ): boolean {
    const sessionId = identifierSchema.parse(rawSessionId);
    const workerIncarnationId = rawWorkerIncarnationId === undefined
      ? undefined
      : identifierSchema.parse(rawWorkerIncarnationId);
    const db = this.#binding.readDatabase();
    const rows = db
      .prepare(
        `${HANDOFF_SELECT}
         WHERE session_id = ? AND evidence_trusted = 1
         ORDER BY created_at DESC, id DESC`,
      )
      .all(sessionId);
    return rows.some(
      (row) => {
        const handoff = this.#fromRow(row, db);
        return handoff.evidenceTrust === 'nexus-trusted' &&
          (workerIncarnationId === undefined ||
            handoff.workerIncarnationId === workerIncarnationId);
      },
    );
  }

  /** Compatibility alias with fail-closed trusted semantics. */
  hasFromSession(rawSessionId: string): boolean {
    return this.hasTrustedFromSession(rawSessionId);
  }

  #deliveryAttemptFromDatabase(
    db: Database.Database,
    id: string,
  ): HandoffDeliveryAttempt | null {
    const row = db.prepare(
      `SELECT * FROM handoff_delivery_attempts WHERE id = ?`,
    ).get(id);
    return row ? this.#deliveryAttemptFromRow(row) : null;
  }

  #deliveryAttemptFromRow(raw: unknown): HandoffDeliveryAttempt {
    let row: z.infer<typeof deliveryAttemptRowSchema>;
    try {
      row = deliveryAttemptRowSchema.parse(raw);
    } catch (error) {
      throw new ScopedStoreCorruptionError('handoff delivery attempt', { cause: error });
    }
    return Object.freeze({
      id: row.id,
      handoffId: row.handoff_id,
      missionId: row.mission_id,
      orchestratorSessionId: row.orchestrator_session_id,
      attemptNo: row.attempt_no,
      state: row.state,
      startedAt: row.started_at,
      acceptDeadlineAt: row.accept_deadline_at ?? undefined,
      acceptedAt: row.accepted_at ?? undefined,
      failedAt: row.failed_at ?? undefined,
      failureCode: row.failure_code ?? undefined,
    });
  }

  #currentBinding(
    db: Database.Database,
    missionId: string,
  ): { binding: EvidenceBinding; revision: number } | null {
    const rawRow = db
      .prepare(
        `SELECT c.contract_hash, c.context_revision,
                w.revision AS workflow_revision, w.workflow_json
         FROM mission_contracts c
         JOIN workflow_states w ON w.mission_id = c.mission_id
         WHERE c.mission_id = ?`,
      )
      .get(missionId);
    if (!rawRow) return null;
    let row: z.infer<typeof currentWorkflowRowSchema>;
    try {
      row = currentWorkflowRowSchema.parse(rawRow);
    } catch (error) {
      throw new ScopedStoreCorruptionError('handoff workflow binding', {
        cause: error,
      });
    }
    const workflow = asCorruption('handoff workflow state', () =>
      parseWorkflowState(
        parseBoundedJson(row.workflow_json, 'handoff workflow state'),
      ),
    );
    if (
      workflow.binding.projectId !== this.scope.projectId ||
      workflow.binding.checkoutId !== this.scope.checkoutId ||
      workflow.binding.missionId !== missionId ||
      workflow.binding.contractHash !== row.contract_hash ||
      workflow.binding.contextHash !== row.context_revision ||
      workflow.revision !== row.workflow_revision
    ) {
      throw new ScopedStoreCorruptionError('handoff workflow binding');
    }
    return { binding: workflow.binding, revision: workflow.revision };
  }

  #resolveEvidence(
    db: Database.Database,
    missionId: string | undefined,
    evidenceIds: readonly string[],
  ): ResolvedEvidence {
    if (evidenceIds.length === 0) return { evidenceIds: [] };
    if (!missionId) {
      throw new Error('trusted handoff evidence requires missionId');
    }
    const current = this.#currentBinding(db, missionId);
    if (!current) {
      throw new Error(
        'handoff evidence requires a mission with a frozen current workflow',
      );
    }
    for (const evidenceId of evidenceIds) {
      const sensorRow = db
        .prepare('SELECT evidence_json FROM sensor_evidence WHERE id = ?')
        .get(evidenceId) as { evidence_json: string } | undefined;
      if (sensorRow) {
        const evidence = asCorruption('sensor evidence', () =>
          parseTrustedEvidence(
            parseBoundedJson(sensorRow.evidence_json, 'sensor evidence'),
          ),
        );
        if (evidence.id !== evidenceId) {
          throw new ScopedStoreCorruptionError('sensor evidence identity');
        }
        assertEvidenceMatches(evidenceId, evidence, current.binding);
        continue;
      }

      const reviewId = evidenceId.startsWith('review:')
        ? evidenceId.slice('review:'.length)
        : '';
      const reviewRow = reviewId
        ? (db
            .prepare(
              'SELECT report_json FROM review_reports WHERE review_id = ?',
            )
            .get(reviewId) as { report_json: string } | undefined)
        : undefined;
      if (!reviewRow) {
        throw new Error(`trusted evidence "${evidenceId}" not found`);
      }
      const report = asCorruption('review evidence', () =>
        parseReviewReport(
          parseBoundedJson(reviewRow.report_json, 'review evidence'),
        ),
      );
      if (`review:${report.reviewId}` !== evidenceId) {
        throw new ScopedStoreCorruptionError('review evidence identity');
      }
      assertEvidenceMatches(evidenceId, report.binding, current.binding);
    }
    return {
      evidenceIds: [...evidenceIds],
      binding: toHandoffBinding(current.binding, current.revision),
    };
  }

  #fromRow(rawRow: unknown, db: Database.Database): ScopedHandoff {
    let row: z.infer<typeof handoffRowSchema>;
    try {
      row = handoffRowSchema.parse(rawRow);
    } catch (error) {
      throw new ScopedStoreCorruptionError('handoff', { cause: error });
    }
    let evidenceIds: string[];
    try {
      evidenceIds = evidenceIdsSchema.parse(
        parseJsonArray(row.evidence_ids_json, 'handoff evidence IDs'),
      );
    } catch (error) {
      if (error instanceof ScopedStoreCorruptionError) throw error;
      throw new ScopedStoreCorruptionError('handoff evidence IDs', {
        cause: error,
      });
    }
    const bindingFields = [
      row.context_revision,
      row.contract_hash,
      row.base_sha,
      row.head_sha,
      row.diff_hash,
      row.workflow_revision,
    ];
    const wasTrusted = row.evidence_trusted === 1;
    if (
      (wasTrusted &&
        (!row.mission_id ||
          evidenceIds.length === 0 ||
          bindingFields.some((value) => value === null))) ||
      (!wasTrusted &&
        (evidenceIds.length > 0 || bindingFields.some((value) => value !== null)))
    ) {
      throw new ScopedStoreCorruptionError('handoff evidence binding');
    }
    const evidenceBinding = wasTrusted
      ? Object.freeze({
          missionId: row.mission_id!,
          contextRevision: row.context_revision!,
          contractHash: row.contract_hash!,
          baseSha: row.base_sha!,
          headSha: row.head_sha!,
          diffHash: row.diff_hash!,
          workflowRevision: row.workflow_revision!,
        })
      : undefined;
    let isCurrent = false;
    if (wasTrusted && evidenceBinding) {
      try {
        const resolved = this.#resolveEvidence(
          db,
          evidenceBinding.missionId,
          evidenceIds,
        );
        isCurrent =
          resolved.binding !== undefined &&
          sameHandoffBinding(resolved.binding, evidenceBinding);
      } catch (error) {
        if (error instanceof ScopedStoreCorruptionError) throw error;
        isCurrent = false;
      }
    }
    return {
      id: row.id,
      missionId: row.mission_id ?? undefined,
      sessionId: row.session_id ?? undefined,
      workerIncarnationId: row.worker_incarnation_id ?? undefined,
      fromAgent: row.from_agent ?? undefined,
      authorityOrigin: row.authority_origin,
      status: row.status,
      claimTrust: 'untrusted',
      summary: row.summary,
      artifacts: parseJsonArray(row.artifacts_json, 'handoff artifacts'),
      evidenceIds,
      evidenceTrust: !wasTrusted
        ? 'unverified'
        : isCurrent
          ? 'nexus-trusted'
          : 'stale',
      evidenceBinding,
      delivered: row.delivered === 1,
      deliveryState: row.delivery_state,
      submittedAt: row.submitted_at ?? undefined,
      acknowledgedAt: row.acknowledged_at ?? undefined,
      consumedAt: row.consumed_at ?? undefined,
      createdAt: row.created_at,
      ...this.#binding.coordinates,
    };
  }
}

export function createScopedHandoffStore(
  runtimeManager: ProjectRuntimeManager,
  scope: ProjectExecutionScope,
  options: ScopedStoreOptions = {},
): ScopedHandoffStore {
  return new ScopedHandoffStore(runtimeManager, scope, options);
}
