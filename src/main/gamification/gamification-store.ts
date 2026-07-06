import type { Db } from '../persistence/db';
import type {
  StoredXpEvent,
  XpEventInput,
  XpEventKind,
} from '../../shared/gamification-types';
import { RULE_VERSION } from './xp-rules';

/**
 * Persistência da gamificação — event-sourced no SQLite compartilhado:
 * `xp_events` é a verdade (auditável, UNIQUE por entity_key = idempotência);
 * o agregado é derivável (recompute barato). Estado pequeno (streak,
 * prestígio, conquistas, skins, counters extras) vive em `gamification_meta`
 * como JSON. Funções puras sobre Db — testáveis in-memory.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS xp_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_key     TEXT    NOT NULL UNIQUE,
  kind           TEXT    NOT NULL,
  mission_id     TEXT,
  agent_category TEXT,
  effort         TEXT,
  cost_usd       REAL,
  evidence       TEXT,
  retro          INTEGER NOT NULL DEFAULT 0,
  points         INTEGER NOT NULL,
  rule_version   INTEGER NOT NULL,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_xp_events_day ON xp_events(created_at);
CREATE TABLE IF NOT EXISTS gamification_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function initGamificationStore(db: Db): void {
  db.exec(SCHEMA);
}

export function insertXpEvent(
  db: Db,
  input: XpEventInput,
  points: number,
): boolean {
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
    ) as { changes: number };
  return result.changes > 0;
}

interface XpRow {
  id: number;
  entity_key: string;
  kind: string;
  mission_id: string | null;
  agent_category: string | null;
  effort: string | null;
  cost_usd: number | null;
  evidence: string | null;
  retro: number;
  points: number;
  rule_version: number;
  created_at: number;
}

export function listXpEvents(db: Db): StoredXpEvent[] {
  const rows = db
    .prepare('SELECT * FROM xp_events ORDER BY created_at, id')
    .all() as XpRow[];
  return rows.map((r) => ({
    id: r.id,
    entityKey: r.entity_key,
    kind: r.kind as XpEventKind,
    missionId: r.mission_id,
    agentCategory: r.agent_category,
    effort: r.effort,
    costUsd: r.cost_usd,
    evidence: r.evidence,
    retro: r.retro === 1,
    points: r.points,
    ruleVersion: r.rule_version,
    createdAt: r.created_at,
  }));
}

/** Entregas de HOJE no mesmo bucket (kind + effort) — retorno decrescente. */
export function countTodaySameBucket(
  db: Db,
  kind: XpEventKind,
  effort: string | null | undefined,
  dayStart: number,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM xp_events
       WHERE kind = ? AND created_at >= ? AND retro = 0
         AND COALESCE(effort, 'medium') = COALESCE(?, 'medium')`,
    )
    .get(kind, dayStart, effort ?? null) as { n: number } | undefined;
  return row?.n ?? 0;
}

/** Dump ordenado do meta (export de perfil — checksum determinístico). */
export function dumpMeta(db: Db): Record<string, string> {
  const rows = db
    .prepare('SELECT key, value FROM gamification_meta ORDER BY key')
    .all() as Array<{ key: string; value: string }>;
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/** Substitui eventos+meta em transação (import de perfil). Lança em falha
 *  (rollback aplicado) — o chamador decide a mensagem. */
export function replaceProfile(
  db: Db,
  events: StoredXpEvent[],
  meta: Record<string, string>,
): void {
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM xp_events; DELETE FROM gamification_meta;');
    const insertEvent = db.prepare(
      `INSERT INTO xp_events
         (id, entity_key, kind, mission_id, agent_category, effort, cost_usd,
          evidence, retro, points, rule_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const ev of events) {
      insertEvent.run(
        ev.id,
        ev.entityKey,
        ev.kind,
        ev.missionId ?? null,
        ev.agentCategory ?? null,
        ev.effort ?? null,
        ev.costUsd ?? null,
        ev.evidence ?? null,
        ev.retro ? 1 : 0,
        ev.points,
        ev.ruleVersion,
        ev.createdAt,
      );
    }
    const insertMeta = db.prepare(
      'INSERT INTO gamification_meta (key, value) VALUES (?, ?)',
    );
    for (const [key, value] of Object.entries(meta)) {
      insertMeta.run(key, String(value));
    }
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // rollback melhor-esforço — o erro original é o que importa
    }
    throw err;
  }
}

export function getMeta(db: Db, key: string): string | null {
  const row = db
    .prepare('SELECT value FROM gamification_meta WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare(
    `INSERT INTO gamification_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}
