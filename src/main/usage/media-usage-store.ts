import type { Db } from '../persistence/db';
import type { AgentGateContext } from '../orch/gate';
import type {
  MediaGenerationResult,
  MediaUsageTotals,
} from '../../shared/media-types';

/**
 * Persistência de custo de GERAÇÃO DE MÍDIA (imagem/vídeo/áudio) no SQLite
 * compartilhado — mesma filosofia do token_usage: auditável, sobrevive ao
 * restart, alimenta o painel de custo (mídia entra no total de gasto do
 * workspace, não só os tokens).
 */

export interface MediaUsageRecord {
  kind: string;
  provider: string;
  model: string;
  path: string;
  costUsd: number | null;
  missionId?: string | null;
  agentName?: string | null;
  sessionId?: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS media_usage (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  INTEGER NOT NULL,
  kind        TEXT    NOT NULL,
  provider    TEXT    NOT NULL,
  model       TEXT    NOT NULL,
  path        TEXT    NOT NULL,
  cost_usd    REAL,
  mission_id  TEXT,
  agent_name  TEXT,
  session_id  TEXT
);
CREATE INDEX IF NOT EXISTS idx_media_usage_mission ON media_usage(mission_id);
`;

export function initMediaUsageStore(db: Db): void {
  db.exec(SCHEMA);
}

export function insertMediaUsage(
  db: Db,
  rec: MediaUsageRecord,
  now: number = Date.now(),
): void {
  db.prepare(
    `INSERT INTO media_usage
       (created_at, kind, provider, model, path, cost_usd, mission_id, agent_name, session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    now,
    rec.kind,
    rec.provider,
    rec.model,
    rec.path,
    rec.costUsd,
    rec.missionId ?? null,
    rec.agentName ?? null,
    rec.sessionId ?? null,
  );
}

interface TotalsRow {
  generations: number;
  cost_usd: number | null;
}

const TOTALS_SELECT =
  'SELECT COUNT(*) AS generations, SUM(cost_usd) AS cost_usd FROM media_usage';

export function mediaUsageTotalsGlobal(db: Db): MediaUsageTotals {
  const row = db.prepare(TOTALS_SELECT).get() as TotalsRow | undefined;
  return {
    generations: row?.generations ?? 0,
    costUsd: row?.cost_usd ?? 0,
  };
}

export function mediaUsageTotalsByMission(
  db: Db,
  missionId: string,
): MediaUsageTotals {
  const row = db
    .prepare(`${TOTALS_SELECT} WHERE mission_id = ?`)
    .get(missionId) as TotalsRow | undefined;
  return {
    generations: row?.generations ?? 0,
    costUsd: row?.cost_usd ?? 0,
  };
}

// ── Edge: conveniência para as MCP tools (nunca lança) ──────────────────────

let schemaReady = false;

export function recordMediaUsage(
  result: MediaGenerationResult,
  ctx: Pick<AgentGateContext, 'missionId' | 'agentName' | 'label' | 'sessionId'>,
): void {
  try {
    // Lazy require: persistence/db importa electron; manter fora do topo
    // preserva este módulo importável em unit tests (padrão do repo).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getDb } = require('../persistence/db') as typeof import('../persistence/db');
    const db = getDb();
    if (!db) return;
    if (!schemaReady) {
      initMediaUsageStore(db);
      schemaReady = true;
    }
    insertMediaUsage(db, {
      kind: result.kind,
      provider: result.provider,
      model: result.model,
      path: result.path,
      costUsd: result.estimatedCostUsd,
      missionId: ctx.missionId ?? null,
      agentName: ctx.agentName ?? ctx.label ?? null,
      sessionId: ctx.sessionId ?? null,
    });
    const { notifyMediaGenerated } =
      require('./usage-service') as typeof import('./usage-service');
    notifyMediaGenerated();
    const { recordMediaGeneratedForGamification } =
      require('../gamification/gamification-service') as typeof import('../gamification/gamification-service');
    recordMediaGeneratedForGamification(result.kind, ctx.missionId ?? null);
  } catch (err) {
    // Telemetria nunca derruba a geração — o arquivo já foi entregue.
    console.warn('[media-usage] falha ao registrar:', err);
  }
}

/** Test-only reset. */
export function resetMediaUsageForTests(): void {
  schemaReady = false;
}
