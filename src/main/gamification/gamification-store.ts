import type Database from 'better-sqlite3';
import { z } from 'zod';
import type {
  StoredXpEvent,
  XpEventInput,
  XpEventKind,
} from '../../shared/gamification-types';
import { RULE_VERSION } from './xp-rules';

const xpEventKindSchema = z.enum([
  'mission_green',
  'mission_done',
  'handoff_green',
  'handoff_success',
  'task_done',
  'media_generated',
  'jarvis_action',
]);

const nullableText = (max: number) => z.string().min(1).max(max).nullable();

const xpEventInputSchema = z
  .object({
    kind: xpEventKindSchema,
    entityKey: z.string().min(1).max(512),
    missionId: nullableText(256).optional(),
    agentCategory: nullableText(128).optional(),
    effort: nullableText(64).optional(),
    costUsd: z.number().finite().nonnegative().nullable().optional(),
    evidence: nullableText(4_096).optional(),
    retro: z.boolean().optional(),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();

const storedXpEventSchema = xpEventInputSchema.extend({
  id: z.number().int().positive(),
  points: z.number().int().nonnegative(),
  ruleVersion: z.number().int().positive(),
});

const xpRowSchema = z
  .object({
    id: z.number().int().positive(),
    entity_key: z.string().min(1).max(512),
    kind: xpEventKindSchema,
    mission_id: nullableText(256),
    agent_category: nullableText(128),
    effort: nullableText(64),
    cost_usd: z.number().finite().nonnegative().nullable(),
    evidence: nullableText(4_096),
    retro: z.union([z.literal(0), z.literal(1)]),
    points: z.number().int().nonnegative(),
    rule_version: z.number().int().positive(),
    created_at: z.number().int().nonnegative(),
  })
  .strict();

const metaKeySchema = z.string().min(1).max(128);
const metaValueSchema = z.string().max(1_048_576);

const REQUIRED_COLUMNS = {
  xp_events: [
    'id',
    'entity_key',
    'kind',
    'mission_id',
    'agent_category',
    'effort',
    'cost_usd',
    'evidence',
    'retro',
    'points',
    'rule_version',
    'created_at',
  ],
  gamification_meta: ['key', 'value'],
} as const;

/** Verifies the migrated runtime schema without creating tables at runtime. */
export function initGamificationStore(db: Database.Database): void {
  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    const columns = new Set(
      (
        db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
          name?: unknown;
        }>
      )
        .map((row) => (typeof row.name === 'string' ? row.name : ''))
        .filter(Boolean),
    );
    for (const column of required) {
      if (!columns.has(column)) {
        throw new Error(`project runtime is missing ${table}.${column}`);
      }
    }
  }
}

export function insertXpEvent(
  db: Database.Database,
  rawInput: XpEventInput,
  rawPoints: number,
): boolean {
  const input = xpEventInputSchema.parse(rawInput);
  const points = z.number().int().nonnegative().parse(rawPoints);
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO xp_events
         (entity_key, kind, mission_id, agent_category, effort, cost_usd,
          evidence, retro, points, rule_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.entityKey,
      input.kind,
      input.missionId ?? null,
      input.agentCategory ?? null,
      input.effort ?? null,
      input.costUsd ?? null,
      input.evidence ?? null,
      input.retro ? 1 : 0,
      points,
      RULE_VERSION,
      input.createdAt,
    );
  return result.changes > 0;
}

export function listXpEvents(db: Database.Database): StoredXpEvent[] {
  const rows = db
    .prepare(
      `SELECT id, entity_key, kind, mission_id, agent_category, effort,
              cost_usd, evidence, retro, points, rule_version, created_at
       FROM xp_events ORDER BY created_at, id`,
    )
    .all();
  return rows.map((rawRow) => {
    const row = xpRowSchema.parse(rawRow);
    return {
      id: row.id,
      entityKey: row.entity_key,
      kind: row.kind,
      missionId: row.mission_id,
      agentCategory: row.agent_category,
      effort: row.effort,
      costUsd: row.cost_usd,
      evidence: row.evidence,
      retro: row.retro === 1,
      points: row.points,
      ruleVersion: row.rule_version,
      createdAt: row.created_at,
    };
  });
}

export function countTodaySameBucket(
  db: Database.Database,
  kind: XpEventKind,
  effort: string | null | undefined,
  dayStart: number,
): number {
  const parsedKind = xpEventKindSchema.parse(kind);
  const parsedEffort = effort == null ? null : nullableText(64).parse(effort);
  const parsedDayStart = z.number().int().nonnegative().parse(dayStart);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM xp_events
       WHERE kind = ? AND created_at >= ? AND retro = 0
         AND COALESCE(effort, 'medium') = COALESCE(?, 'medium')`,
    )
    .get(parsedKind, parsedDayStart, parsedEffort) as { n?: unknown } | undefined;
  if (!row || !Number.isSafeInteger(row.n) || Number(row.n) < 0) {
    throw new Error('project runtime returned an invalid XP bucket count');
  }
  return Number(row.n);
}

export function dumpMeta(db: Database.Database): Record<string, string> {
  const rows = db
    .prepare('SELECT key, value FROM gamification_meta ORDER BY key')
    .all() as Array<{ key?: unknown; value?: unknown }>;
  return Object.fromEntries(
    rows.map((row) => [
      metaKeySchema.parse(row.key),
      metaValueSchema.parse(row.value),
    ]),
  );
}

/** Atomically replaces the complete project profile. */
export function replaceProfile(
  db: Database.Database,
  rawEvents: StoredXpEvent[],
  rawMeta: Record<string, string>,
): void {
  const events = z.array(storedXpEventSchema).max(1_000_000).parse(rawEvents);
  const metaEntries = Object.entries(rawMeta).map(([key, value]) => [
    metaKeySchema.parse(key),
    metaValueSchema.parse(value),
  ] as const);
  if (metaEntries.length > 10_000) throw new Error('profile meta is too large');

  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DELETE FROM xp_events; DELETE FROM gamification_meta;');
    const insertEvent = db.prepare(
      `INSERT INTO xp_events
         (id, entity_key, kind, mission_id, agent_category, effort, cost_usd,
          evidence, retro, points, rule_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const event of events) {
      insertEvent.run(
        event.id,
        event.entityKey,
        event.kind,
        event.missionId ?? null,
        event.agentCategory ?? null,
        event.effort ?? null,
        event.costUsd ?? null,
        event.evidence ?? null,
        event.retro ? 1 : 0,
        event.points,
        event.ruleVersion,
        event.createdAt,
      );
    }
    const insertMeta = db.prepare(
      'INSERT INTO gamification_meta (key, value) VALUES (?, ?)',
    );
    for (const [key, value] of metaEntries) insertMeta.run(key, value);
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Preserve the original write failure.
    }
    throw error;
  }
}

export function getMeta(db: Database.Database, rawKey: string): string | null {
  const key = metaKeySchema.parse(rawKey);
  const row = db
    .prepare('SELECT value FROM gamification_meta WHERE key = ?')
    .get(key) as { value?: unknown } | undefined;
  return row === undefined ? null : metaValueSchema.parse(row.value);
}

export function setMeta(
  db: Database.Database,
  rawKey: string,
  rawValue: string,
): void {
  const key = metaKeySchema.parse(rawKey);
  const value = metaValueSchema.parse(rawValue);
  db.prepare(
    `INSERT INTO gamification_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}
