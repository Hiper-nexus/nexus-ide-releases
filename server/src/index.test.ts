import type { Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  isMainModule,
  sanitizeRuntimeEnvironment,
  startServer,
  type ServerBootDependencies,
} from './index';

const VALID_ENV = {
  DATABASE_URL: 'postgres://database.example/nexus',
  LICENSE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----',
  LICENSE_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----\nx\n-----END PUBLIC KEY-----',
  GITHUB_OAUTH_ID: 'github-id',
  GITHUB_OAUTH_SECRET: 'github-secret',
  GOOGLE_OAUTH_ID: 'google-id',
  GOOGLE_OAUTH_SECRET: 'google-secret',
  PUBLIC_BASE_URL: 'https://api.nexuside.app',
  APP_DEEP_LINK_BASE: 'nexus://auth',
  STRIPE_SECRET_KEY: 'stripe-secret',
  STRIPE_WEBHOOK_SECRET: 'webhook-secret',
  STRIPE_PRICE_PRO: 'price-pro',
  STRIPE_PRICE_TEAM: 'price-team',
  PUBLIC_SITE_URL: 'https://nexuside.app',
  PORT: '8080',
  DATABASE_CONNECTION_TIMEOUT_MS: '1500',
  DATABASE_QUERY_TIMEOUT_MS: '2500',
  DATABASE_STATEMENT_TIMEOUT_MS: '2000',
  DATABASE_READINESS_TIMEOUT_MS: '100',
  SERVER_CLEANUP_TIMEOUT_MS: '100',
};

function bootDependencies(overrides: Partial<ServerBootDependencies> = {}) {
  const db = {} as never;
  const pool = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    end: vi.fn().mockResolvedValue(undefined),
  };
  const server = {
    close: vi.fn((callback: (error?: Error) => void) => callback()),
  } as unknown as Server;
  const dependencies: ServerBootDependencies = {
    connectDatabase: vi.fn(() => ({ db, pool })),
    createStripe: vi.fn(() => ({} as never)),
    cleanupExpired: vi.fn().mockResolvedValue(undefined),
    assertReady: vi.fn().mockResolvedValue(undefined),
    listen: vi.fn().mockResolvedValue(server),
    scheduleReaper: vi.fn(),
    ...overrides,
  };
  return { dependencies, pool, server };
}

describe('server entrypoint', () => {
  it('recognizes both tsx dev and compiled ESM entrypoints as the main module', () => {
    const source = '/tmp/nexus/server/src/index.ts';
    const artifact = '/tmp/nexus/server/dist/index.js';

    expect(isMainModule(pathToFileURL(source).href, source)).toBe(true);
    expect(isMainModule(pathToFileURL(artifact).href, artifact)).toBe(true);
    expect(isMainModule(pathToFileURL(source).href, artifact)).toBe(false);
  });

  it('removes GitHub personal access tokens without mutating the input environment', () => {
    const raw = {
      SAFE_VALUE: 'kept',
      GITHUB_PERSONAL_ACCESS_TOKEN: 'must-not-reach-runtime',
    };

    const sanitized = sanitizeRuntimeEnvironment(raw);

    expect(sanitized).toEqual({ SAFE_VALUE: 'kept' });
    expect(raw.GITHUB_PERSONAL_ACCESS_TOKEN).toBe('must-not-reach-runtime');
  });

  it('fails closed and releases the pool before listen when DB/schema is not ready', async () => {
    const assertReady = vi.fn().mockRejectedValue(new Error('schema missing'));
    const { dependencies, pool } = bootDependencies({ assertReady });

    await expect(startServer(VALID_ENV, dependencies)).rejects.toThrow('schema missing');

    expect(dependencies.createStripe).not.toHaveBeenCalled();
    expect(dependencies.listen).not.toHaveBeenCalled();
    expect(dependencies.scheduleReaper).not.toHaveBeenCalled();
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it('fails boot within its deadline when readiness and pool shutdown never settle', async () => {
    const assertReady = vi.fn(() => new Promise<void>(() => undefined));
    const pool = {
      query: vi.fn(),
      end: vi.fn(() => new Promise<void>(() => undefined)),
    };
    const { dependencies } = bootDependencies({
      assertReady,
      connectDatabase: vi.fn(() => ({ db: {} as never, pool })),
    });
    const startedAt = Date.now();

    await expect(startServer(VALID_ENV, dependencies)).rejects.toThrow(
      /database readiness timed out/i,
    );

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(dependencies.listen).not.toHaveBeenCalled();
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it('passes validated timeout policy to the production database connector', async () => {
    const { dependencies } = bootDependencies();

    await startServer(VALID_ENV, dependencies);

    expect(dependencies.connectDatabase).toHaveBeenCalledWith(
      VALID_ENV.DATABASE_URL,
      {
        connectionTimeoutMs: 1500,
        queryTimeoutMs: 2500,
        statementTimeoutMs: 2000,
      },
    );
  });

  it('listens only after readiness and schedules maintenance after a successful boot', async () => {
    const order: string[] = [];
    const { dependencies, server } = bootDependencies({
      assertReady: vi.fn(async () => { order.push('ready'); }),
      createStripe: vi.fn(() => {
        order.push('stripe');
        return {} as never;
      }),
      listen: vi.fn(async () => {
        order.push('listen');
        return server;
      }),
      scheduleReaper: vi.fn(() => { order.push('reaper'); }),
    });

    await expect(startServer(VALID_ENV, dependencies)).resolves.toBe(server);

    expect(order).toEqual(['ready', 'stripe', 'listen', 'reaper']);
  });

  it('closes the listener and database when a post-listen boot step fails', async () => {
    const { dependencies, pool, server } = bootDependencies({
      scheduleReaper: vi.fn(() => { throw new Error('timer unavailable'); }),
    });

    await expect(startServer(VALID_ENV, dependencies)).rejects.toThrow('timer unavailable');

    expect(server.close).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();
  });
});
