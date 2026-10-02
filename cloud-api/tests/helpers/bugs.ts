import type { SqliteD1 } from './sqlite-d1.js';

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Corpo mínimo e válido do POST /v1/bug-reports. */
export function validReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Terminal fecha sozinho',
    description: 'Ao abrir três painéis ao mesmo tempo o terminal fecha sem mensagem.',
    category: 'terminal',
    impact: 'blocks_work',
    app: { version: '0.76.110', platform: 'darwin', arch: 'arm64' },
    consent: { diagnostics: false },
    ...overrides,
  };
}

export interface SeedReport {
  readonly id?: string;
  readonly accountId?: string | null;
  readonly title?: string;
  readonly status?: string;
  readonly severity?: string;
  readonly category?: string;
  readonly fingerprint?: string;
  readonly createdAt?: number;
  readonly diagnosticsJson?: string | null;
  readonly diagnosticsExpiresAt?: number;
  readonly fixSummary?: string | null;
  readonly fixPrUrl?: string | null;
  readonly duplicateOf?: string | null;
}

let sequence = 0;
/** Insere um relato direto no banco (sem passar pela API) e devolve o id. */
export function seedReport(db: SqliteD1, options: SeedReport = {}): string {
  sequence += 1;
  const id = options.id ?? crypto.randomUUID();
  const createdAt = options.createdAt ?? Date.now() - sequence;
  db.sqlite.prepare(`INSERT INTO bug_reports
    (id, account_id, title, description, category, impact, severity, status, app_version, platform, arch, diagnostics_json, fingerprint,
     duplicate_of, fix_summary, fix_pr_url, created_at, updated_at, diagnostics_expires_at)
    VALUES (?, ?, ?, 'Descrição de teste do relato.', ?, 'annoying', ?, ?, '0.76.110', 'darwin', 'arm64', ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, options.accountId ?? null, options.title ?? `Relato ${sequence}`, options.category ?? 'ui', options.severity ?? 'medium', options.status ?? 'new',
      options.diagnosticsJson ?? null, options.fingerprint ?? String(sequence).padStart(64, '0'), options.duplicateOf ?? null, options.fixSummary ?? null, options.fixPrUrl ?? null,
      createdAt, createdAt, options.diagnosticsExpiresAt ?? createdAt + 180 * DAY_MS);
  return id;
}

export function count(db: SqliteD1, sql: string, ...values: Array<string | number>): number {
  return Number((db.sqlite.prepare(sql).get(...values) as { n: number }).n);
}
