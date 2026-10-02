import { MINE_LIMIT, REPORTS_PER_HOUR, REPORT_WINDOW_MS } from './constants.js';
import type { BugStatus } from './constants.js';
import type { NewBugReport } from './build-report.js';

/**
 * Grava o relato e o evento `created` SÓ se a conta ainda estiver abaixo do teto da hora. A contagem e a gravação
 * são UMA instrução, então rajadas paralelas não passam do teto. Devolve falso quando o teto foi atingido
 * (nada é gravado, nem o evento).
 */
export async function insertReportWithinLimit(db: D1Database, report: NewBugReport): Promise<boolean> {
  const [inserted] = await db.batch<{ id: string }>([
    db.prepare(`INSERT INTO bug_reports
        (id, account_id, title, description, steps, category, impact, app_version, platform, arch, os_version, adapter, model,
         pane_count, mission_active, diagnostics_json, fingerprint, created_at, updated_at, diagnostics_expires_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
      WHERE (SELECT count(*) FROM bug_reports WHERE account_id=? AND created_at>?) < ?
      RETURNING id`).bind(
      report.id, report.accountId, report.title, report.description, report.steps, report.category, report.impact, report.appVersion,
      report.platform, report.arch, report.osVersion, report.adapter, report.model, report.paneCount, report.missionActive,
      report.diagnosticsJson, report.fingerprint, report.createdAt, report.createdAt, report.diagnosticsExpiresAt,
      report.accountId, report.createdAt - REPORT_WINDOW_MS, REPORTS_PER_HOUR),
    db.prepare(`INSERT INTO bug_report_events(id, report_id, actor_account_id, kind, details_json, created_at)
      SELECT ?,?,?,'created',?,? WHERE EXISTS(SELECT 1 FROM bug_reports WHERE id=?)`)
      .bind(crypto.randomUUID(), report.id, report.accountId, JSON.stringify({ diagnostics: report.diagnosticsJson !== null }), report.createdAt, report.id),
  ]);
  return inserted!.results.length > 0;
}

/** Segundos até o relato mais antigo da janela sair dela e a conta poder enviar de novo. */
export async function secondsUntilNextReport(db: D1Database, accountId: string, now: number): Promise<number> {
  const row = await db.prepare('SELECT min(created_at) AS oldest FROM bug_reports WHERE account_id=? AND created_at>?')
    .bind(accountId, now - REPORT_WINDOW_MS).first<{ oldest: number | null }>();
  const waitMs = row?.oldest == null ? REPORT_WINDOW_MS : row.oldest + REPORT_WINDOW_MS - now;
  return Math.max(1, Math.ceil(waitMs / 1000));
}

export interface MineItem { readonly id: string; readonly title: string; readonly status: BugStatus; readonly createdAt: string; readonly fixSummary: string | null }
interface MineRow { readonly id: string; readonly title: string; readonly status: BugStatus; readonly created_at: number; readonly fix_summary: string | null }

/** Os últimos relatos da conta. O resumo da correção só sai da consulta quando o relato já foi liberado. */
export async function listMine(db: D1Database, accountId: string): Promise<MineItem[]> {
  const rows = await db.prepare(`SELECT id, title, status, created_at, CASE WHEN status='released' THEN fix_summary END AS fix_summary
      FROM bug_reports WHERE account_id=? ORDER BY created_at DESC, id DESC LIMIT ?`).bind(accountId, MINE_LIMIT).all<MineRow>();
  return rows.results.map(row => ({ id: row.id, title: row.title, status: row.status, createdAt: new Date(row.created_at).toISOString(), fixSummary: row.fix_summary }));
}
