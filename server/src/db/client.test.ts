import { describe, expect, it } from 'vitest';
import {
  databasePoolConfig,
  DEFAULT_DATABASE_POOL_TIMEOUTS,
  makeDb,
} from './client';

describe('database pool timeout policy', () => {
  it('configures connection, client-query, and server-statement timeouts', async () => {
    const timeouts = {
      connectionTimeoutMs: 1_234,
      queryTimeoutMs: 2_345,
      statementTimeoutMs: 1_987,
    };

    expect(databasePoolConfig('postgres://database.example/nexus', timeouts)).toEqual({
      connectionString: 'postgres://database.example/nexus',
      connectionTimeoutMillis: 1_234,
      query_timeout: 2_345,
      statement_timeout: 1_987,
    });

    const { pool } = makeDb('postgres://database.example/nexus', timeouts);
    expect(pool.options).toMatchObject({
      connectionTimeoutMillis: 1_234,
      query_timeout: 2_345,
      statement_timeout: 1_987,
    });
    await pool.end();
  });

  it('never defaults any database operation timeout to unlimited', () => {
    expect(DEFAULT_DATABASE_POOL_TIMEOUTS.connectionTimeoutMs).toBeGreaterThan(0);
    expect(DEFAULT_DATABASE_POOL_TIMEOUTS.queryTimeoutMs).toBeGreaterThan(0);
    expect(DEFAULT_DATABASE_POOL_TIMEOUTS.statementTimeoutMs).toBeGreaterThan(0);
  });
});
