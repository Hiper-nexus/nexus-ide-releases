import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ProjectExecutionScope } from '../../shared/types';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import {
  ScopedStoreBinding,
  ScopedStoreCorruptionError,
  type ScopedStoreOptions,
} from '../orch/scoped-store';
import {
  normalizeContextAttestationSources,
  normalizeContextAuthorityTarget,
  type ContextAttestationActor,
  type ContextAttestationSource,
} from './context-attestation';
import { canonicalJson } from './canonical-json';

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40,64}$/;
const ATTESTATION_ID_PATTERN = /^att-[a-f0-9]{40}$/;
const MAX_CONTENT_BYTES = 1024 * 1024;

const identitySchema = z.object({
  id: z.string().trim().min(1).max(256),
  sessionId: z.string().trim().min(1).max(4_096),
  provider: z.string().trim().min(1).max(256),
}).strict();
const idSchema = z.string().trim().min(1).max(256);
const statusSchema = z.enum([
  'proposed',
  'approved',
  'applied',
  'rejected',
  'superseded',
]);

export type ContextDraftStatus = z.infer<typeof statusSchema>;
export type ContextDraftIdentity = ContextAttestationActor;

export interface ContextDraftRecord {
  readonly id: string;
  readonly missionId: string | null;
  readonly targetPath: string;
  readonly content: string;
  readonly contentHash: string;
  readonly expectedTargetHash: string | null;
  readonly sources: readonly ContextAttestationSource[];
  readonly status: ContextDraftStatus;
  readonly author: ContextDraftIdentity;
  readonly reviewer: ContextDraftIdentity | null;
  readonly reviewRationale: string | null;
  readonly attestationId: string | null;
  readonly appliedCommit: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly reviewedAt: number | null;
  readonly appliedAt: number | null;
}

export interface ProposeContextDraftInput {
  readonly missionId?: string | null;
  readonly targetPath: string;
  readonly content: string;
  readonly expectedTargetHash: string | null;
  readonly sources: readonly ContextAttestationSource[];
  readonly author: ContextDraftIdentity;
}

export interface ReviewContextDraftInput {
  readonly decision: 'approve' | 'reject';
  readonly reviewer: ContextDraftIdentity;
  readonly rationale: string;
}

interface DraftRow {
  id: string;
  mission_id: string | null;
  target_path: string;
  content: string;
  content_hash: string;
  expected_target_hash: string | null;
  source_refs_json: string;
  status: string;
  author_id: string;
  author_session_id: string;
  author_provider: string;
  reviewer_id: string | null;
  reviewer_session_id: string | null;
  reviewer_provider: string | null;
  review_rationale: string | null;
  attestation_id: string | null;
  applied_commit: string | null;
  created_at: number;
  updated_at: number;
  reviewed_at: number | null;
  applied_at: number | null;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function timestamp(value: unknown, label: string): number {
  return z.number().int().nonnegative().parse(value, { error: () => `${label} is invalid` });
}

function nullableTimestamp(value: unknown, label: string): number | null {
  return value === null ? null : timestamp(value, label);
}

function parseSources(raw: string, targetPath: string): readonly ContextAttestationSource[] {
  if (Buffer.byteLength(raw, 'utf8') > MAX_CONTENT_BYTES) {
    throw new Error('serialized sources exceed 1 MiB');
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error('serialized sources are not an array');
  return Object.freeze(normalizeContextAttestationSources(
    parsed as ContextAttestationSource[],
    targetPath,
  ).map((source) => Object.freeze({ ...source })));
}

function parseIdentity(
  id: string,
  sessionId: string,
  provider: string,
): ContextDraftIdentity {
  return Object.freeze(identitySchema.parse({ id, sessionId, provider }));
}

function parseDraftRow(row: DraftRow): ContextDraftRecord {
  try {
    const id = idSchema.parse(row.id);
    const missionId = row.mission_id === null ? null : idSchema.parse(row.mission_id);
    const targetPath = normalizeContextAuthorityTarget(row.target_path);
    if (
      typeof row.content !== 'string' ||
      Buffer.byteLength(row.content, 'utf8') > MAX_CONTENT_BYTES ||
      row.content.includes('\0')
    ) {
      throw new Error('draft content is invalid');
    }
    if (!HASH_PATTERN.test(row.content_hash) || sha256(row.content) !== row.content_hash) {
      throw new Error('draft content hash mismatch');
    }
    const expectedTargetHash = row.expected_target_hash === null
      ? null
      : z.string().regex(HASH_PATTERN).parse(row.expected_target_hash);
    const status = statusSchema.parse(row.status);
    const author = parseIdentity(row.author_id, row.author_session_id, row.author_provider);
    const reviewerFields = [row.reviewer_id, row.reviewer_session_id, row.reviewer_provider];
    const hasReviewer = reviewerFields.every((value) => value !== null);
    if (!hasReviewer && reviewerFields.some((value) => value !== null)) {
      throw new Error('partial reviewer identity');
    }
    const reviewer = hasReviewer
      ? parseIdentity(
        row.reviewer_id as string,
        row.reviewer_session_id as string,
        row.reviewer_provider as string,
      )
      : null;
    if (status === 'proposed' && reviewer !== null) {
      throw new Error('proposed draft already has reviewer data');
    }
    if (status !== 'proposed' && reviewer === null) {
      throw new Error('reviewed draft is missing reviewer data');
    }
    const attestationId = row.attestation_id === null
      ? null
      : z.string().regex(ATTESTATION_ID_PATTERN).parse(row.attestation_id);
    const appliedCommit = row.applied_commit === null
      ? null
      : z.string().regex(COMMIT_PATTERN).parse(row.applied_commit);
    const reviewedAt = nullableTimestamp(row.reviewed_at, 'reviewedAt');
    const appliedAt = nullableTimestamp(row.applied_at, 'appliedAt');
    if (status === 'applied' && (!attestationId || appliedAt === null)) {
      throw new Error('applied draft is missing portable attestation state');
    }
    if (
      status === 'superseded' &&
      (attestationId !== null || appliedAt === null || appliedCommit !== null)
    ) {
      throw new Error('superseded draft has invalid applied state');
    }
    if (
      status !== 'applied' &&
      status !== 'superseded' &&
      (attestationId || appliedAt !== null || appliedCommit)
    ) {
      throw new Error('non-applied draft has applied state');
    }
    const rationale = row.review_rationale === null
      ? null
      : z.string().trim().min(1).max(65_536).parse(row.review_rationale);
    return Object.freeze({
      id,
      missionId,
      targetPath,
      content: row.content,
      contentHash: row.content_hash,
      expectedTargetHash,
      sources: parseSources(row.source_refs_json, targetPath),
      status,
      author,
      reviewer,
      reviewRationale: rationale,
      attestationId,
      appliedCommit,
      createdAt: timestamp(row.created_at, 'createdAt'),
      updatedAt: timestamp(row.updated_at, 'updatedAt'),
      reviewedAt,
      appliedAt,
    });
  } catch (error) {
    throw new ScopedStoreCorruptionError('context draft', { cause: error });
  }
}

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

export class ContextDraftStore {
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

  propose(input: ProposeContextDraftInput): ContextDraftRecord {
    const targetPath = normalizeContextAuthorityTarget(input.targetPath);
    if (
      typeof input.content !== 'string' ||
      Buffer.byteLength(input.content, 'utf8') > MAX_CONTENT_BYTES ||
      input.content.includes('\0')
    ) {
      throw new Error('context draft content must be text smaller than 1 MiB');
    }
    const missionId = input.missionId == null ? null : idSchema.parse(input.missionId);
    const expectedTargetHash = input.expectedTargetHash === null
      ? null
      : z.string().regex(HASH_PATTERN).parse(input.expectedTargetHash);
    const sources = normalizeContextAttestationSources(input.sources, targetPath);
    const author = identitySchema.parse(input.author);
    const id = this.#binding.makeId('context-draft');
    const now = this.#binding.now();
    const contentHash = sha256(input.content);
    const db = this.#binding.writeDatabase();
    try {
      db.transaction(() => {
        if (missionId && !db.prepare('SELECT 1 FROM missions WHERE id = ?').get(missionId)) {
          throw new Error('context draft mission not found in project scope');
        }
        db.prepare(
          `INSERT INTO context_drafts
             (id, mission_id, target_path, content, content_hash,
              expected_target_hash, source_refs_json, status,
              author_id, author_session_id, author_provider,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?)`,
        ).run(
          id,
          missionId,
          targetPath,
          input.content,
          contentHash,
          expectedTargetHash,
          canonicalJson(sources),
          author.id,
          author.sessionId,
          author.provider,
          now,
          now,
        );
      })();
    } catch (error) {
      if (isUniqueConstraint(error)) {
        // O índice único é por target_path (cross-mission); um draft órfão de
        // OUTRA missão trava o target e o draft_list escopado por missão o
        // esconde — o pipeline emperra sem ID acionável. Surface o bloqueador
        // (id/status/missão) para que o orquestrador possa superá-lo.
        const blocker = this.activeForTarget(targetPath);
        const detail = blocker
          ? ` (draft ativo id=${blocker.id} status=${blocker.status} missão=${blocker.missionId ?? 'nenhuma'}; ` +
            `use nexus_context_draft_supersede com esse target para liberar)`
          : '';
        throw new Error(
          `an active context draft already exists for target: ${targetPath}${detail}`,
          { cause: error },
        );
      }
      throw error;
    }
    this.#binding.emitChange();
    return this.#required(id);
  }

  /**
   * Draft ATIVO (proposed/approved) que ocupa o target — regardless de missão.
   * É o que o índice único protege; usado para diagnosticar/liberar o wedge.
   */
  activeForTarget(rawTargetPath: string): ContextDraftRecord | null {
    const targetPath = normalizeContextAuthorityTarget(rawTargetPath);
    const row = this.#binding.readDatabase().prepare(
      `SELECT * FROM context_drafts
       WHERE target_path = ? AND status IN ('proposed', 'approved')
       ORDER BY created_at DESC LIMIT 1`,
    ).get(targetPath) as DraftRow | undefined;
    return row ? parseDraftRow(row) : null;
  }

  /**
   * Escape do wedge de draft-fantasma: cancela (rejeita) o draft ativo do
   * target, liberando o índice único para uma nova proposta. Rejeita — não
   * 'superseded' — porque 'superseded' só é válido na transição applied→
   * superseded (exige reviewer + appliedAt); um proposed órfão vira 'rejected'
   * com um revisor de sistema. Devolve o draft cancelado, ou null se livre.
   */
  supersedeActiveForTarget(rawTargetPath: string): ContextDraftRecord | null {
    const targetPath = normalizeContextAuthorityTarget(rawTargetPath);
    const now = this.#binding.now();
    const db = this.#binding.writeDatabase();
    const cleared = db.transaction(() => {
      const active = this.activeForTarget(targetPath);
      if (!active) return null;
      const result = db.prepare(
        `UPDATE context_drafts
         SET status = 'rejected',
             reviewer_id = ?, reviewer_session_id = ?, reviewer_provider = ?,
             review_rationale = ?, reviewed_at = ?, updated_at = ?
         WHERE id = ? AND status IN ('proposed', 'approved')`,
      ).run(
        'nexus-system',
        'nexus-system-supersede',
        'nexus',
        'draft órfão superado pelo orquestrador para destravar o pipeline de contexto',
        now,
        now,
        active.id,
      );
      return result.changes === 1 ? active.id : null;
    })();
    if (!cleared) return null;
    this.#binding.emitChange();
    return this.get(cleared);
  }

  get(rawId: string): ContextDraftRecord | null {
    const id = idSchema.parse(rawId);
    const row = this.#binding.readDatabase().prepare(
      'SELECT * FROM context_drafts WHERE id = ?',
    ).get(id) as DraftRow | undefined;
    return row ? parseDraftRow(row) : null;
  }

  list(options: { status?: ContextDraftStatus; missionId?: string | null } = {}): readonly ContextDraftRecord[] {
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (options.status !== undefined) {
      clauses.push('status = ?');
      args.push(statusSchema.parse(options.status));
    }
    if (options.missionId !== undefined) {
      if (options.missionId === null) clauses.push('mission_id IS NULL');
      else {
        clauses.push('mission_id = ?');
        args.push(idSchema.parse(options.missionId));
      }
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.#binding.readDatabase().prepare(
      `SELECT * FROM context_drafts ${where} ORDER BY created_at, id`,
    ).all(...args) as DraftRow[];
    return Object.freeze(rows.map(parseDraftRow));
  }

  review(rawId: string, input: ReviewContextDraftInput): ContextDraftRecord {
    const id = idSchema.parse(rawId);
    const decision = z.enum(['approve', 'reject']).parse(input.decision);
    const reviewer = identitySchema.parse(input.reviewer);
    const rationale = z.string().trim().min(1).max(65_536).parse(input.rationale);
    const current = this.#required(id);
    if (current.status !== 'proposed') throw new Error('only a proposed context draft can be reviewed');
    if (
      current.author.id === reviewer.id ||
      current.author.sessionId === reviewer.sessionId
    ) {
      throw new Error('context draft review must be independent from the author');
    }
    if (current.author.provider === reviewer.provider) {
      throw new Error('context draft review requires a different provider');
    }
    const now = this.#binding.now();
    const result = this.#binding.writeDatabase().prepare(
      `UPDATE context_drafts
       SET status = ?, reviewer_id = ?, reviewer_session_id = ?,
           reviewer_provider = ?, review_rationale = ?, reviewed_at = ?, updated_at = ?
       WHERE id = ? AND status = 'proposed'`,
    ).run(
      decision === 'approve' ? 'approved' : 'rejected',
      reviewer.id,
      reviewer.sessionId,
      reviewer.provider,
      rationale,
      now,
      now,
      id,
    );
    if (result.changes !== 1) throw new Error('context draft review concurrency conflict');
    this.#binding.emitChange();
    return this.#required(id);
  }

  markApplied(rawId: string, rawAttestationId: string): ContextDraftRecord {
    const id = idSchema.parse(rawId);
    const attestationId = z.string().regex(ATTESTATION_ID_PATTERN).parse(rawAttestationId);
    const now = this.#binding.now();
    const db = this.#binding.writeDatabase();
    db.transaction(() => {
      const result = db.prepare(
        `UPDATE context_drafts
         SET status = 'applied', attestation_id = ?, applied_at = ?, updated_at = ?
         WHERE id = ? AND status = 'approved'`,
      ).run(attestationId, now, now, id);
      if (result.changes !== 1) {
        throw new Error('only an approved context draft can be applied');
      }
      db.prepare(
        `UPDATE context_drafts
         SET status = 'superseded', attestation_id = NULL,
             applied_commit = NULL, updated_at = ?
         WHERE id <> ? AND status = 'applied' AND applied_commit IS NULL
           AND target_path = (
             SELECT target_path FROM context_drafts WHERE id = ?
           )`,
      ).run(now, id, id);
    })();
    this.#binding.emitChange();
    return this.#required(id);
  }

  markCommitted(rawId: string, rawCommitSha: string): ContextDraftRecord {
    const id = idSchema.parse(rawId);
    const commitSha = z.string().regex(COMMIT_PATTERN).parse(rawCommitSha);
    const now = this.#binding.now();
    const result = this.#binding.writeDatabase().prepare(
      `UPDATE context_drafts
       SET applied_commit = ?, updated_at = ?
       WHERE id = ? AND status = 'applied' AND applied_commit IS NULL`,
    ).run(commitSha, now, id);
    if (result.changes !== 1) {
      const current = this.#required(id);
      if (current.status !== 'applied') throw new Error('only an applied context draft can be committed');
      if (current.appliedCommit === commitSha) return current;
      throw new Error('context draft commit concurrency conflict');
    }
    this.#binding.emitChange();
    return this.#required(id);
  }

  markSuperseded(rawId: string): ContextDraftRecord {
    const id = idSchema.parse(rawId);
    const now = this.#binding.now();
    const result = this.#binding.writeDatabase().prepare(
      `UPDATE context_drafts
       SET status = 'superseded', attestation_id = NULL,
           applied_commit = NULL, updated_at = ?
       WHERE id = ? AND status = 'applied' AND applied_commit IS NULL`,
    ).run(now, id);
    if (result.changes !== 1) {
      const current = this.#required(id);
      if (current.status === 'superseded') return current;
      throw new Error('only an uncommitted applied context draft can be superseded');
    }
    this.#binding.emitChange();
    return this.#required(id);
  }

  #required(id: string): ContextDraftRecord {
    const record = this.get(id);
    if (!record) throw new Error('context draft not found');
    return record;
  }
}
