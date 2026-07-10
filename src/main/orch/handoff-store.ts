import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  handoffStatusSchema,
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
    fromAgent: identifierSchema.optional(),
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
    from_agent: identifierSchema.nullable(),
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
    created_at: z.number().int().nonnegative(),
  })
  .strict();

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
  SELECT id, mission_id, session_id, from_agent, status, summary,
         artifacts_json, evidence_ids_json, evidence_trusted,
         context_revision, contract_hash, base_sha, head_sha, diff_hash,
         workflow_revision, delivered, created_at
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
        fromAgent: input.fromAgent,
        status: input.status,
        claimTrust: 'untrusted',
        summary: input.summary,
        artifacts: parseJsonArray(artifactsJson, 'handoff artifacts'),
        evidenceIds: [...resolved.evidenceIds],
        evidenceTrust: resolved.binding ? 'nexus-trusted' : 'unverified',
        evidenceBinding: resolved.binding,
        delivered: false,
        createdAt,
        ...this.#binding.coordinates,
      };
      db.prepare(
        `INSERT INTO handoffs
           (id, mission_id, session_id, from_agent, status, summary,
            artifacts_json, evidence_ids_json, evidence_trusted,
            context_revision, contract_hash, base_sha, head_sha, diff_hash,
            workflow_revision, delivered, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      ).run(
        handoff.id,
        handoff.missionId ?? null,
        handoff.sessionId ?? null,
        handoff.fromAgent ?? null,
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
    const id = identifierSchema.parse(rawId);
    const result = this.#binding
      .writeDatabase()
      .prepare(
        'UPDATE handoffs SET delivered = 1 WHERE id = ? AND delivered = 0',
      )
      .run(id);
    if (result.changes === 0) return false;
    this.#binding.emitChange();
    return true;
  }

  hasTrustedFromSession(rawSessionId: string): boolean {
    const sessionId = identifierSchema.parse(rawSessionId);
    const db = this.#binding.readDatabase();
    const rows = db
      .prepare(
        `${HANDOFF_SELECT}
         WHERE session_id = ? AND evidence_trusted = 1
         ORDER BY created_at DESC, id DESC`,
      )
      .all(sessionId);
    return rows.some(
      (row) => this.#fromRow(row, db).evidenceTrust === 'nexus-trusted',
    );
  }

  /** Compatibility alias with fail-closed trusted semantics. */
  hasFromSession(rawSessionId: string): boolean {
    return this.hasTrustedFromSession(rawSessionId);
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
      fromAgent: row.from_agent ?? undefined,
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
