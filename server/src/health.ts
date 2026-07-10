import type { Express } from 'express';

export const REQUIRED_DATABASE_TABLES = Object.freeze([
  'accounts',
  'identities',
  'sessions',
  'refresh_tokens',
  'oauth_states',
  'auth_codes',
  'teams',
  'team_members',
  'team_invites',
  'subscriptions',
  'stripe_events',
  'cron_schedules',
  'cron_leases',
  'sync_projects',
] as const);

interface DatabaseTableRow {
  readonly tableName: string;
}

export interface DatabaseReadinessClient {
  query(
    text: string,
    values: unknown[],
  ): Promise<{ readonly rows: readonly DatabaseTableRow[] }>;
}

export type ReadinessProbe = () => Promise<void>;

export const DEFAULT_DATABASE_READINESS_TIMEOUT_MS = 5_000;
export const DEFAULT_SERVER_CLEANUP_TIMEOUT_MS = 2_000;

const DATABASE_SCHEMA_QUERY = `
  SELECT table_name AS "tableName"
  FROM information_schema.tables
  WHERE table_schema = $1
    AND table_name = ANY($2::text[])
`;

export async function assertDatabaseReady(
  database: DatabaseReadinessClient,
): Promise<void> {
  const result = await database.query(DATABASE_SCHEMA_QUERY, [
    'public',
    [...REQUIRED_DATABASE_TABLES],
  ]);
  const presentTables = new Set(result.rows.map((row) => row.tableName));
  const missingTables = REQUIRED_DATABASE_TABLES.filter(
    (tableName) => !presentTables.has(tableName),
  );
  if (missingTables.length > 0) {
    throw new Error(`database schema not ready: missing ${missingTables.join(', ')}`);
  }
}

export async function runWithDeadline<T>(
  label: string,
  timeoutMs: number,
  operation: () => Promise<T>,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`invalid ${label} timeout`);
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_fulfill, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function assertReadinessWithin(
  readinessProbe: ReadinessProbe,
  timeoutMs: number,
): Promise<void> {
  return runWithDeadline('database readiness', timeoutMs, readinessProbe);
}

export function registerHealthRoutes(
  app: Express,
  readinessProbe?: ReadinessProbe,
  readinessTimeoutMs = DEFAULT_DATABASE_READINESS_TIMEOUT_MS,
): void {
  if (!Number.isSafeInteger(readinessTimeoutMs) || readinessTimeoutMs <= 0) {
    throw new Error('invalid database readiness timeout');
  }
  app.get('/live', (_request, response) => {
    response.set('Cache-Control', 'no-store').json({ status: 'alive' });
  });
  app.get('/health', (_request, response) => {
    response.set('Cache-Control', 'no-store').json({ ok: true });
  });
  app.get('/ready', async (_request, response) => {
    if (!readinessProbe) {
      response.status(503).set('Cache-Control', 'no-store').json({ status: 'not_ready' });
      return;
    }
    try {
      await assertReadinessWithin(readinessProbe, readinessTimeoutMs);
      response.set('Cache-Control', 'no-store').json({ status: 'ready' });
    } catch {
      response.status(503).set('Cache-Control', 'no-store').json({ status: 'not_ready' });
    }
  });
}
