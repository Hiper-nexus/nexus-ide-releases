import type { Db } from '../persistence/db';
import { priceForModel } from '../orch/pricing';
import type { UsageEvent } from './claude-transcript';

/**
 * Persistência de USO REAL de tokens (fonte: transcript watchers), no SQLite
 * compartilhado (persistence/db.ts). Distinto do cost-tracker (heurística por
 * bytes, em memória): aqui é auditável, sobrevive ao restart e deduplica por
 * (session_id, message_id) com "último snapshot vence" — o CLI Claude regrava
 * a mesma mensagem a cada content block do streaming.
 *
 * Custo de cache derivado das razões de preço padrão da Anthropic sobre a
 * tabela de pricing existente: read = 0.1×input, write 5m = 1.25×input,
 * write 1h = 2×input.
 */

export interface UsageRecord extends UsageEvent {
  paneId?: string | null;
  missionId?: string | null;
  workspacePath?: string | null;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  turns: number;
}

const CACHE_READ_RATIO = 0.1;
const CACHE_WRITE_5M_RATIO = 1.25;
const CACHE_WRITE_1H_RATIO = 2;

/** Custo real em USD de um evento de uso, com tiers de cache. Puro. */
export function computeRealCost(ev: UsageEvent): number {
  const price = priceForModel(ev.model);
  return (
    (ev.inputTokens / 1_000_000) * price.inputPerM +
    (ev.outputTokens / 1_000_000) * price.outputPerM +
    (ev.cacheReadTokens / 1_000_000) * price.inputPerM * CACHE_READ_RATIO +
    (ev.cacheWrite5mTokens / 1_000_000) * price.inputPerM * CACHE_WRITE_5M_RATIO +
    (ev.cacheWrite1hTokens / 1_000_000) * price.inputPerM * CACHE_WRITE_1H_RATIO
  );
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS token_usage (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT    NOT NULL,
  message_id      TEXT,
  pane_id         TEXT,
  mission_id      TEXT,
  workspace_path  TEXT,
  model           TEXT    NOT NULL,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_write_5m_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd        REAL    NOT NULL DEFAULT 0,
  event_ts        INTEGER,
  recorded_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_token_usage_msg
  ON token_usage(session_id, message_id);
CREATE INDEX IF NOT EXISTS idx_token_usage_session ON token_usage(session_id);
CREATE INDEX IF NOT EXISTS idx_token_usage_workspace ON token_usage(workspace_path);
`;

export function initUsageStore(db: Db): void {
  db.exec(SCHEMA);
}

/**
 * Grava um evento de uso. Upsert por (session_id, message_id): o último
 * snapshot da mensagem vence. message_id NULL fica fora do índice único
 * (SQLite trata NULLs como distintos) e insere sempre — correto para formatos
 * sem id de mensagem.
 */
export function recordUsage(db: Db, rec: UsageRecord, now: number = Date.now()): void {
  const cost = computeRealCost(rec);
  db.prepare(
    `INSERT INTO token_usage (
       session_id, message_id, pane_id, mission_id, workspace_path, model,
       input_tokens, output_tokens, cache_read_tokens,
       cache_write_5m_tokens, cache_write_1h_tokens, cost_usd, event_ts, recorded_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, message_id) DO UPDATE SET
       pane_id = excluded.pane_id,
       mission_id = excluded.mission_id,
       workspace_path = excluded.workspace_path,
       model = excluded.model,
       input_tokens = excluded.input_tokens,
       output_tokens = excluded.output_tokens,
       cache_read_tokens = excluded.cache_read_tokens,
       cache_write_5m_tokens = excluded.cache_write_5m_tokens,
       cache_write_1h_tokens = excluded.cache_write_1h_tokens,
       cost_usd = excluded.cost_usd,
       event_ts = excluded.event_ts,
       recorded_at = excluded.recorded_at`,
  ).run(
    rec.sessionId,
    rec.messageId,
    rec.paneId ?? null,
    rec.missionId ?? null,
    rec.workspacePath ?? null,
    rec.model,
    rec.inputTokens,
    rec.outputTokens,
    rec.cacheReadTokens,
    rec.cacheWrite5mTokens,
    rec.cacheWrite1hTokens,
    cost,
    rec.timestamp,
    now,
  );
}

interface TotalsRow {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_usd: number | null;
  turns: number | null;
}

function toTotals(row: TotalsRow | undefined): UsageTotals {
  return {
    inputTokens: row?.input_tokens ?? 0,
    outputTokens: row?.output_tokens ?? 0,
    cacheReadTokens: row?.cache_read_tokens ?? 0,
    cacheWriteTokens: row?.cache_write_tokens ?? 0,
    costUsd: row?.cost_usd ?? 0,
    turns: row?.turns ?? 0,
  };
}

const TOTALS_SELECT = `
  SELECT SUM(input_tokens) AS input_tokens,
         SUM(output_tokens) AS output_tokens,
         SUM(cache_read_tokens) AS cache_read_tokens,
         SUM(cache_write_5m_tokens + cache_write_1h_tokens) AS cache_write_tokens,
         SUM(cost_usd) AS cost_usd,
         COUNT(*) AS turns
  FROM token_usage`;

export function usageTotalsBySession(db: Db, sessionId: string): UsageTotals {
  const row = db
    .prepare(`${TOTALS_SELECT} WHERE session_id = ?`)
    .get(sessionId) as TotalsRow | undefined;
  return toTotals(row);
}

export function usageTotalsByWorkspace(db: Db, workspacePath: string): UsageTotals {
  const row = db
    .prepare(`${TOTALS_SELECT} WHERE workspace_path = ?`)
    .get(workspacePath) as TotalsRow | undefined;
  return toTotals(row);
}

export function usageTotalsByMission(db: Db, missionId: string): UsageTotals {
  const row = db
    .prepare(`${TOTALS_SELECT} WHERE mission_id = ?`)
    .get(missionId) as TotalsRow | undefined;
  return toTotals(row);
}

export function usageTotalsGlobal(db: Db): UsageTotals {
  const row = db.prepare(TOTALS_SELECT).get() as TotalsRow | undefined;
  return toTotals(row);
}

export function usageBreakdownByModel(
  db: Db,
): Array<{ model: string } & UsageTotals> {
  const rows = db
    .prepare(`${TOTALS_SELECT.replace('SELECT', 'SELECT model,')} GROUP BY model`)
    .all() as Array<TotalsRow & { model: string }>;
  return rows.map((r) => ({ model: r.model, ...toTotals(r) }));
}
