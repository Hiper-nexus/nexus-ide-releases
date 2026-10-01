// F-234: registro durável do veredito de integração ("código só integra/push
// após veredito de modelo de ponta"). Uma linha por `nexus_review_verdict`,
// atada ao HEAD EXATO do checkout da missão — o portão de push/integração
// (`integration-review-gate.ts`) consulta `latestFor(missionId, headSha)` e só
// aceita `approve` + `frontier` + árvore limpa. Não reutiliza `review_reports`
// (council PREVC, binding por contractHash — a Via Rápida não tem contrato).
import { z } from 'zod';
import {
  ScopedStoreBinding,
  ScopedStoreCorruptionError,
} from './scoped-store';

const entityIdSchema = z.string().min(1).max(256);
const headShaSchema = z.string().regex(/^[a-f0-9]{40}$|^[a-f0-9]{64}$/u);

const reviewVerdictRowSchema = z
  .object({
    verdict_id: entityIdSchema,
    mission_id: entityIdSchema,
    head_sha: headShaSchema,
    tree_dirty: z.union([z.literal(0), z.literal(1)]),
    verdict: z.enum(['approve', 'reject']),
    reviewer_adapter: z.string().min(1).max(128),
    reviewer_model: z.string().min(1).max(256).nullable(),
    reviewer_session: z.string().min(1).max(256).nullable(),
    frontier: z.union([z.literal(0), z.literal(1)]),
    findings_json: z.string().max(16_384),
    summary: z.string().max(2_000),
    created_at: z.number().int().nonnegative(),
  })
  .strict();

export interface RecordMissionReviewVerdict {
  readonly missionId: string;
  readonly headSha: string;
  readonly treeDirty: boolean;
  readonly verdict: 'approve' | 'reject';
  readonly reviewerAdapter: string;
  readonly reviewerModel?: string;
  readonly reviewerSession?: string;
  readonly frontier: boolean;
  readonly findings?: readonly string[];
  readonly summary: string;
}

export interface MissionReviewVerdict {
  readonly verdictId: string;
  readonly missionId: string;
  readonly headSha: string;
  readonly treeDirty: boolean;
  readonly verdict: 'approve' | 'reject';
  readonly reviewerAdapter: string;
  readonly reviewerModel?: string;
  readonly reviewerSession?: string;
  readonly frontier: boolean;
  readonly findings: readonly string[];
  readonly summary: string;
  readonly createdAt: number;
}

function reviewVerdictFromRow(raw: unknown): MissionReviewVerdict {
  let row: z.infer<typeof reviewVerdictRowSchema>;
  try {
    row = reviewVerdictRowSchema.parse(raw);
  } catch (error) {
    throw new ScopedStoreCorruptionError('mission review verdict', {
      cause: error,
    });
  }
  let findings: string[];
  try {
    const parsed = JSON.parse(row.findings_json) as unknown;
    findings = Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch (error) {
    throw new ScopedStoreCorruptionError('mission review verdict', {
      cause: error,
    });
  }
  return Object.freeze({
    verdictId: row.verdict_id,
    missionId: row.mission_id,
    headSha: row.head_sha,
    treeDirty: row.tree_dirty === 1,
    verdict: row.verdict,
    reviewerAdapter: row.reviewer_adapter,
    ...(row.reviewer_model === null ? {} : { reviewerModel: row.reviewer_model }),
    ...(row.reviewer_session === null
      ? {}
      : { reviewerSession: row.reviewer_session }),
    frontier: row.frontier === 1,
    findings: Object.freeze(findings),
    summary: row.summary,
    createdAt: row.created_at,
  });
}

/**
 * Append-only verdict ledger sharing the mission store's binding (same
 * transaction/clock/id semantics as the route-reservation ledger).
 */
export class MissionReviewVerdictLedger {
  readonly #binding: ScopedStoreBinding;

  constructor(binding: ScopedStoreBinding) {
    this.#binding = binding;
  }

  record(rawInput: RecordMissionReviewVerdict): MissionReviewVerdict {
    const input = z
      .object({
        missionId: entityIdSchema,
        headSha: headShaSchema,
        treeDirty: z.boolean(),
        verdict: z.enum(['approve', 'reject']),
        reviewerAdapter: z.string().min(1).max(128),
        reviewerModel: z.string().min(1).max(256).optional(),
        reviewerSession: z.string().min(1).max(256).optional(),
        frontier: z.boolean(),
        findings: z.array(z.string().min(1).max(500)).max(40).optional(),
        summary: z.string().min(1).max(2_000),
      })
      .strict()
      .parse(rawInput);
    const verdictId = this.#binding.makeId('review-verdict');
    const createdAt = this.#binding.now();
    const db = this.#binding.writeDatabase();
    db.transaction(() => {
      const mission = db
        .prepare('SELECT id FROM missions WHERE id = ?')
        .get(input.missionId);
      if (!mission) {
        throw new Error(`review_verdict_invalid: missão não encontrada: ${input.missionId}`);
      }
      db.prepare(
        `INSERT INTO mission_review_verdicts
           (verdict_id, mission_id, head_sha, tree_dirty, verdict,
            reviewer_adapter, reviewer_model, reviewer_session, frontier,
            findings_json, summary, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        verdictId,
        input.missionId,
        input.headSha,
        input.treeDirty ? 1 : 0,
        input.verdict,
        input.reviewerAdapter,
        input.reviewerModel ?? null,
        input.reviewerSession ?? null,
        input.frontier ? 1 : 0,
        JSON.stringify(input.findings ?? []),
        input.summary,
        createdAt,
      );
    })();
    const recorded = this.#getFromDatabase(db, verdictId);
    if (!recorded) {
      throw new Error('mission review verdict was not persisted');
    }
    this.#binding.emitChange();
    return recorded;
  }

  /** Veredito mais recente para (missão, HEAD exato); o portão só olha o topo. */
  latestFor(
    rawMissionId: string,
    rawHeadSha: string,
  ): MissionReviewVerdict | null {
    const missionId = entityIdSchema.parse(rawMissionId);
    const headSha = headShaSchema.parse(rawHeadSha.toLowerCase());
    const raw = this.#binding
      .readDatabase()
      .prepare(
        `SELECT verdict_id, mission_id, head_sha, tree_dirty, verdict,
                reviewer_adapter, reviewer_model, reviewer_session, frontier,
                findings_json, summary, created_at
         FROM mission_review_verdicts
         WHERE mission_id = ? AND head_sha = ?
         ORDER BY created_at DESC, verdict_id DESC
         LIMIT 1`,
      )
      .get(missionId, headSha);
    return raw === undefined ? null : reviewVerdictFromRow(raw);
  }

  #getFromDatabase(
    db: ReturnType<ScopedStoreBinding['readDatabase']>,
    verdictId: string,
  ): MissionReviewVerdict | null {
    const raw = db
      .prepare(
        `SELECT verdict_id, mission_id, head_sha, tree_dirty, verdict,
                reviewer_adapter, reviewer_model, reviewer_session, frontier,
                findings_json, summary, created_at
         FROM mission_review_verdicts WHERE verdict_id = ?`,
      )
      .get(verdictId);
    return raw === undefined ? null : reviewVerdictFromRow(raw);
  }
}
