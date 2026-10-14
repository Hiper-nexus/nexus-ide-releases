import type { ProjectExecutionScope } from '../../shared/types';
import type { Db } from './db';

/**
 * F-1483: esperas do failover que sobrevivem ao reinício — o pane de missão
 * que aguardava uma conta liberar (`account`) ou a tarefa que ficou sem pane
 * aguardando a próxima tentativa (`task`). Mesmo DB dos blocos de cooldown;
 * uma linha por pane. Best-effort: falha de disco nunca atrapalha a troca.
 */
export interface FailoverWaitRow {
  readonly paneId: string;
  readonly sessionId: string;
  readonly missionId: string;
  readonly scope: ProjectExecutionScope;
  readonly adapterId: string;
  readonly accountId: string | null;
  readonly waitKind: 'account' | 'task';
  readonly limitKind: string;
  readonly reason: string;
  readonly cooldownMs: number;
  readonly attempt: number;
  readonly retryAt: number;
  readonly deadlineAt: number;
}

interface WaitDbRow {
  pane_id: string;
  session_id: string;
  mission_id: string;
  scope_json: string;
  adapter_id: string;
  account_id: string | null;
  wait_kind: string;
  limit_kind: string;
  reason: string;
  cooldown_ms: number;
  attempt: number;
  retry_at: number;
  deadline_at: number;
}

/** DDL defensivo (CREATE IF NOT EXISTS), como o de `account_cooldown_blocks`. */
const FAILOVER_WAITS_DDL = `
CREATE TABLE IF NOT EXISTS failover_waits (
  pane_id     TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  mission_id  TEXT NOT NULL,
  scope_json  TEXT NOT NULL,
  adapter_id  TEXT NOT NULL,
  account_id  TEXT,
  wait_kind   TEXT NOT NULL,
  limit_kind  TEXT NOT NULL DEFAULT '',
  reason      TEXT NOT NULL DEFAULT '',
  cooldown_ms INTEGER NOT NULL DEFAULT 0,
  attempt     INTEGER NOT NULL DEFAULT 0,
  retry_at    INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL
);`;

let db: Db | null = null;

function warn(action: string, error: unknown): void {
  console.warn(`[failover-waits] ${action} falhou:`, error instanceof Error ? error.message : error);
}

export function initFailoverWaits(database: Db | null): void {
  db = database;
  if (!database) return;
  try {
    database.exec(FAILOVER_WAITS_DDL);
  } catch (error) {
    warn('criar a tabela', error);
    db = null;
  }
}

export function saveFailoverWait(row: FailoverWaitRow): void {
  if (!db) return;
  try {
    db.prepare(
      `INSERT OR REPLACE INTO failover_waits
         (pane_id, session_id, mission_id, scope_json, adapter_id, account_id, wait_kind,
          limit_kind, reason, cooldown_ms, attempt, retry_at, deadline_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.paneId,
      row.sessionId,
      row.missionId,
      JSON.stringify(row.scope),
      row.adapterId,
      row.accountId,
      row.waitKind,
      row.limitKind,
      row.reason,
      Math.round(row.cooldownMs),
      row.attempt,
      Math.round(row.retryAt),
      Math.round(row.deadlineAt),
    );
  } catch (error) {
    warn('gravar a espera', error);
  }
}

export function deleteFailoverWait(paneId: string): void {
  if (!db) return;
  try {
    db.prepare('DELETE FROM failover_waits WHERE pane_id = ?').run(paneId);
  } catch (error) {
    warn('apagar a espera', error);
  }
}

export function listFailoverWaits(): FailoverWaitRow[] {
  if (!db) return [];
  try {
    return (db.prepare('SELECT * FROM failover_waits ORDER BY retry_at').all() as WaitDbRow[]).map((row) => ({
      paneId: row.pane_id,
      sessionId: row.session_id,
      missionId: row.mission_id,
      scope: JSON.parse(row.scope_json) as ProjectExecutionScope,
      adapterId: row.adapter_id,
      accountId: row.account_id,
      waitKind: row.wait_kind === 'task' ? 'task' : 'account',
      limitKind: row.limit_kind,
      reason: row.reason,
      cooldownMs: row.cooldown_ms,
      attempt: row.attempt,
      retryAt: row.retry_at,
      deadlineAt: row.deadline_at,
    }));
  } catch (error) {
    warn('ler as esperas', error);
    return [];
  }
}
