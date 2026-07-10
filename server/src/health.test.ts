import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from './index';
import { assertDatabaseReady, REQUIRED_DATABASE_TABLES } from './health';

describe('health', () => {
  it('GET /live reports process liveness without database dependencies', async () => {
    const res = await request(createApp()).get('/live');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'alive' });
  });

  it('keeps the legacy GET /health contract as a liveness-compatible alias', async () => {
    const res = await request(createApp()).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('GET /ready succeeds only after the database readiness probe succeeds', async () => {
    const readinessProbe = vi.fn().mockResolvedValue(undefined);

    const res = await request(createApp(undefined, { readinessProbe })).get('/ready');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready' });
    expect(readinessProbe).toHaveBeenCalledOnce();
  });

  it('GET /ready fails closed without leaking database error details', async () => {
    const readinessProbe = vi.fn().mockRejectedValue(
      new Error('password=do-not-leak host=internal-db'),
    );

    const res = await request(createApp(undefined, { readinessProbe })).get('/ready');

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'not_ready' });
    expect(res.text).not.toContain('do-not-leak');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('GET /ready is unavailable when no database probe is configured', async () => {
    const res = await request(createApp()).get('/ready');

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'not_ready' });
  });

  it('GET /ready returns 503 within its deadline when the probe never settles', async () => {
    const readinessProbe = vi.fn(() => new Promise<void>(() => undefined));
    const startedAt = Date.now();

    const res = await request(
      createApp(undefined, { readinessProbe, readinessTimeoutMs: 25 }),
    ).get('/ready');

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'not_ready' });
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(readinessProbe).toHaveBeenCalledOnce();
  });
});

describe('assertDatabaseReady', () => {
  it('accepts a reachable database containing every required table', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: REQUIRED_DATABASE_TABLES.map((tableName) => ({ tableName })),
    });

    await expect(assertDatabaseReady({ query })).resolves.toBeUndefined();

    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[1]).toEqual(['public', [...REQUIRED_DATABASE_TABLES]]);
  });

  it('rejects an outdated schema and identifies only missing table names', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: REQUIRED_DATABASE_TABLES.slice(1).map((tableName) => ({ tableName })),
    });

    await expect(assertDatabaseReady({ query })).rejects.toThrow(
      `database schema not ready: missing ${REQUIRED_DATABASE_TABLES[0]}`,
    );
  });
});
