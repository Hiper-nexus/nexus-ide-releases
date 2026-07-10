import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;

export interface DatabasePoolTimeouts {
  readonly connectionTimeoutMs: number;
  readonly queryTimeoutMs: number;
  readonly statementTimeoutMs: number;
}

export const DEFAULT_DATABASE_POOL_TIMEOUTS = Object.freeze({
  connectionTimeoutMs: 5_000,
  queryTimeoutMs: 10_000,
  statementTimeoutMs: 8_000,
} satisfies DatabasePoolTimeouts);

export function databasePoolTimeoutsFrom(environment: {
  readonly DATABASE_CONNECTION_TIMEOUT_MS: number;
  readonly DATABASE_QUERY_TIMEOUT_MS: number;
  readonly DATABASE_STATEMENT_TIMEOUT_MS: number;
}): DatabasePoolTimeouts {
  return Object.freeze({
    connectionTimeoutMs: environment.DATABASE_CONNECTION_TIMEOUT_MS,
    queryTimeoutMs: environment.DATABASE_QUERY_TIMEOUT_MS,
    statementTimeoutMs: environment.DATABASE_STATEMENT_TIMEOUT_MS,
  });
}

export function databasePoolConfig(
  connectionString: string,
  timeouts: DatabasePoolTimeouts = DEFAULT_DATABASE_POOL_TIMEOUTS,
): PoolConfig {
  return {
    connectionString,
    connectionTimeoutMillis: timeouts.connectionTimeoutMs,
    query_timeout: timeouts.queryTimeoutMs,
    statement_timeout: timeouts.statementTimeoutMs,
  };
}

export function makeDb(
  connectionString: string,
  timeouts: DatabasePoolTimeouts = DEFAULT_DATABASE_POOL_TIMEOUTS,
): { db: Db; pool: Pool } {
  const pool = new Pool(databasePoolConfig(connectionString, timeouts));
  return { db: drizzle(pool, { schema }), pool };
}
