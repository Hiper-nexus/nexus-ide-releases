import type { BugReportEventRow, BugReportRow } from '../db/schema.js';
import {
  BUG_CATEGORIES, BUG_SEVERITIES, BUG_STATUSES,
  type BugCategory, type BugSeverity, type BugStatus,
} from './constants.js';
import { encodeCursor, type ListCursor } from './cursor.js';
import type { PatchPlan, PatchTarget } from './patch-plan.js';
import type { ListQuery } from './schemas.js';

/** Ainda exigem trabalho: o resto foi liberado, corrigido, descartado ou é duplicata. */
const OPEN_STATUSES: readonly BugStatus[] = ['new', 'triaged', 'needs_info', 'fix_proposed', 'approved'];

const iso = (epochMs: number): string => new Date(epochMs).toISOString();
/** O e-mail da conta sai SÓ nas rotas admin, e `provedor:id` (login sem e-mail verificado) nunca é tratado como endereço. */
const deliverable = (email: string | null): string | null => (email !== null && email.includes('@') ? email : null);

export interface ListItem {
  readonly id: string; readonly title: string; readonly status: BugStatus; readonly severity: BugSeverity; readonly category: BugCategory;
  readonly impact: string; readonly appVersion: string; readonly platform: string; readonly createdAt: string; readonly updatedAt: string;
  readonly occurrences: number; readonly duplicateOf: string | null; readonly hasDiagnostics: boolean; readonly reporterEmail: string | null;
}
interface ListRow extends Pick<BugReportRow, 'id' | 'title' | 'status' | 'severity' | 'category' | 'impact' | 'app_version' | 'platform' | 'created_at' | 'updated_at' | 'duplicate_of'> {
  readonly has_diagnostics: number; readonly occurrences: number; readonly reporter_email: string | null;
}

function toListItem(row: ListRow): ListItem {
  return {
    id: row.id, title: row.title, status: row.status, severity: row.severity, category: row.category, impact: row.impact,
    appVersion: row.app_version, platform: row.platform, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    occurrences: row.occurrences, duplicateOf: row.duplicate_of, hasDiagnostics: row.has_diagnostics === 1, reporterEmail: deliverable(row.reporter_email),
  };
}

/** Uma página da lista (mais novos primeiro). Pede um item a mais para saber se há próxima página. */
export async function listReports(db: D1Database, query: ListQuery, cursor: ListCursor | null): Promise<{ reports: ListItem[]; nextCursor: string | null }> {
  const rows = await db.prepare(`SELECT r.id, r.title, r.status, r.severity, r.category, r.impact, r.app_version, r.platform, r.created_at, r.updated_at, r.duplicate_of,
      (r.diagnostics_json IS NOT NULL) AS has_diagnostics,
      (SELECT count(*) FROM bug_reports o WHERE o.fingerprint=r.fingerprint) AS occurrences,
      a.email AS reporter_email
    FROM bug_reports r LEFT JOIN accounts a ON a.id=r.account_id
    WHERE (?1 IS NULL OR r.status=?1) AND (?2 IS NULL OR r.category=?2) AND (?3 IS NULL OR r.severity=?3)
      AND (?4 IS NULL OR instr(lower(r.title), lower(?4))>0)
      AND (?5 IS NULL OR r.created_at<?5 OR (r.created_at=?5 AND r.id<?6))
    ORDER BY r.created_at DESC, r.id DESC LIMIT ?7`)
    .bind(query.status ?? null, query.category ?? null, query.severity ?? null, query.q ? query.q : null, cursor?.createdAt ?? null, cursor?.id ?? null, query.limit + 1)
    .all<ListRow>();
  const page = rows.results.slice(0, query.limit);
  const last = rows.results.length > query.limit ? rows.results[query.limit - 1] : undefined;
  return { reports: page.map(toListItem), nextCursor: last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null };
}

interface DetailRow extends BugReportRow { readonly reporter_email: string | null; readonly reporter_name: string | null; readonly occurrences: number }
interface EventRow extends Pick<BugReportEventRow, 'id' | 'kind' | 'actor_account_id' | 'details_json' | 'created_at'> { readonly actor_email: string | null }

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

export async function getReportDetail(db: D1Database, id: string) {
  const [report, events] = await db.batch<DetailRow | EventRow>([
    db.prepare(`SELECT r.*, a.email AS reporter_email, a.name AS reporter_name,
        (SELECT count(*) FROM bug_reports o WHERE o.fingerprint=r.fingerprint) AS occurrences
      FROM bug_reports r LEFT JOIN accounts a ON a.id=r.account_id WHERE r.id=?`).bind(id),
    db.prepare(`SELECT e.id, e.kind, e.actor_account_id, e.details_json, e.created_at, a.email AS actor_email
      FROM bug_report_events e LEFT JOIN accounts a ON a.id=e.actor_account_id WHERE e.report_id=? ORDER BY e.created_at, e.rowid`).bind(id),
  ]);
  const row = report!.results[0] as DetailRow | undefined;
  if (!row) return null;
  return {
    report: {
      id: row.id, title: row.title, description: row.description, steps: row.steps, status: row.status, severity: row.severity, category: row.category, impact: row.impact,
      appVersion: row.app_version, platform: row.platform, arch: row.arch, osVersion: row.os_version,
      context: { adapter: row.adapter, model: row.model, paneCount: row.pane_count, missionActive: row.mission_active === null ? null : row.mission_active === 1 },
      diagnostics: parseJson(row.diagnostics_json), diagnosticsExpiresAt: iso(row.diagnostics_expires_at),
      occurrences: row.occurrences, duplicateOf: row.duplicate_of, fixSummary: row.fix_summary, fixPrUrl: row.fix_pr_url,
      reporter: row.account_id === null ? null : { id: row.account_id, email: deliverable(row.reporter_email), name: row.reporter_name },
      createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    },
    events: (events!.results as EventRow[]).map(event => ({
      id: event.id, kind: event.kind, details: parseJson(event.details_json) ?? {}, createdAt: iso(event.created_at),
      actor: event.actor_account_id === null ? null : { id: event.actor_account_id, email: deliverable(event.actor_email) },
    })),
  };
}

export async function findReport(db: D1Database, id: string): Promise<(PatchTarget & Pick<BugReportRow, 'updated_at'>) | null> {
  return db.prepare('SELECT id, status, severity, duplicate_of, fix_summary, fix_pr_url, updated_at FROM bug_reports WHERE id=?').bind(id).first();
}

const zeroed = <K extends string>(keys: readonly K[]): Record<K, number> => Object.fromEntries(keys.map(key => [key, 0])) as Record<K, number>;
const filled = <K extends string>(keys: readonly K[], rows: ReadonlyArray<{ key: K; n: number }>): Record<K, number> =>
  rows.reduce((totals, row) => ({ ...totals, [row.key]: row.n }), zeroed(keys));

/** Contagens do painel: por status, por categoria e os abertos por gravidade (chaves sem relato vêm com zero). */
export async function reportStats(db: D1Database) {
  const open = OPEN_STATUSES.map(status => `'${status}'`).join(',');
  const [byStatus, byCategory, openBySeverity] = await db.batch<{ key: string; n: number }>([
    db.prepare('SELECT status AS key, count(*) AS n FROM bug_reports GROUP BY status'),
    db.prepare('SELECT category AS key, count(*) AS n FROM bug_reports GROUP BY category'),
    db.prepare(`SELECT severity AS key, count(*) AS n FROM bug_reports WHERE status IN (${open}) GROUP BY severity`),
  ]);
  const statusTotals = filled(BUG_STATUSES, byStatus!.results as Array<{ key: BugStatus; n: number }>);
  return {
    total: Object.values(statusTotals).reduce((sum, n) => sum + n, 0),
    byStatus: statusTotals,
    byCategory: filled(BUG_CATEGORIES, byCategory!.results as Array<{ key: BugCategory; n: number }>),
    openBySeverity: filled(BUG_SEVERITIES, openBySeverity!.results as Array<{ key: BugSeverity; n: number }>),
  };
}

/**
 * Aplica o plano numa batch atômica. Os eventos entram ANTES do UPDATE, os dois guardados pelo estado que o admin
 * viu (status + updated_at): quem perdeu a corrida não grava evento nem muda a linha. Devolve falso nesse caso.
 */
export async function applyPatch(db: D1Database, current: PatchTarget & Pick<BugReportRow, 'updated_at'>, plan: PatchPlan, actorId: string, now: number): Promise<boolean> {
  // Sempre avança, mesmo que o relógio não tenha andado: updated_at também serve de versão da linha.
  const updatedAt = Math.max(now, current.updated_at + 1);
  const guard = 'id=? AND status=? AND updated_at=?';
  const guardValues = [current.id, current.status, current.updated_at];
  const events = plan.events.map(event => db.prepare(`INSERT INTO bug_report_events(id, report_id, actor_account_id, kind, details_json, created_at)
      SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM bug_reports WHERE ${guard})`)
    .bind(crypto.randomUUID(), current.id, actorId, event.kind, JSON.stringify(event.details), updatedAt, ...guardValues));
  const columns = Object.entries(plan.columns);
  const assignments = [...columns.map(([column]) => `${column}=?`), 'updated_at=?'].join(',');
  const update = db.prepare(`UPDATE bug_reports SET ${assignments} WHERE ${guard} RETURNING id`)
    .bind(...columns.map(([, value]) => value), updatedAt, ...guardValues);
  const results = await db.batch<{ id: string }>([...events, update]);
  return results[results.length - 1]!.results.length > 0;
}
