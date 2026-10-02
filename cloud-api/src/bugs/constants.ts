/** Valores do contrato v1 de relatos de bug. Espelham os CHECKs de migrations/0007_bug_reports.sql. */
export const BUG_CATEGORIES = ['crash', 'terminal', 'agents', 'license', 'billing', 'ui', 'performance', 'other'] as const;
export const BUG_IMPACTS = ['annoying', 'blocks_work'] as const;
export const BUG_SEVERITIES = ['low', 'medium', 'high', 'blocker'] as const;
export const BUG_STATUSES = ['new', 'triaged', 'needs_info', 'fix_proposed', 'approved', 'fixed', 'released', 'wont_fix', 'duplicate'] as const;
export const BUG_PLATFORMS = ['darwin', 'win32', 'linux'] as const;
export const BUG_EVENT_KINDS = ['created', 'status_changed', 'severity_changed', 'note', 'duplicate_marked', 'fix_proposed', 'approved', 'rejected', 'released'] as const;

export type BugCategory = typeof BUG_CATEGORIES[number];
export type BugImpact = typeof BUG_IMPACTS[number];
export type BugSeverity = typeof BUG_SEVERITIES[number];
export type BugStatus = typeof BUG_STATUSES[number];
export type BugPlatform = typeof BUG_PLATFORMS[number];
export type BugEventKind = typeof BUG_EVENT_KINDS[number];

const KIB = 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Corpo do POST /v1/bug-reports: rejeitado ANTES de parsear. */
export const MAX_REPORT_BODY_BYTES = 64 * KIB;
/** Relatos que uma conta pode enviar por hora. */
export const REPORTS_PER_HOUR = 5;
export const REPORT_WINDOW_MS = HOUR_MS;
/** O diagnóstico é zerado (o relato fica) depois disso. */
export const DIAGNOSTICS_RETENTION_MS = 180 * DAY_MS;
/** "Meus relatos" devolve os mais recentes. */
export const MINE_LIMIT = 50;
export const ADMIN_LIST_DEFAULT_LIMIT = 50;
export const ADMIN_LIST_MAX_LIMIT = 100;
