import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { issueTokens } from '../auth/session-service';
import type { Db } from '../db/client';
import { accounts, CREATE_TABLES_SQL } from '../db/schema';
import * as schema from '../db/schema';
import { errorHandler } from '../middleware/errors';
import { buildSyncRouter } from './sync-routes';

const PROJECT_ID = '31781d36-3f22-41b8-ad9d-8690c85d3343';
const OTHER_PROJECT_ID = 'dca25e59-f3a7-4117-a9c7-e22734d38cb9';

function mutation(overrides: Record<string, unknown> = {}) {
  return {
    entityType: 'context-fact',
    entityId: 'fact-a',
    entityVersion: 1,
    baseVersion: 0,
    payload: { statement: 'Tenant obrigatório' },
    ...overrides,
  };
}

async function setup(options: {
  limits?: {
    maxProjectsPerAccount?: number;
    maxEntitiesPerProject?: number;
    maxStateBytes?: number;
  };
} = {}) {
  const client = new PGlite();
  await client.exec(CREATE_TABLES_SQL);
  const db = drizzle(client, { schema }) as unknown as Db;
  const [account] = await db
    .insert(accounts)
    .values({ email: `sync-${crypto.randomUUID()}@test.local` })
    .returning({ id: accounts.id });
  const { session } = await issueTokens(db, account.id);
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.use(
    '/v1',
    buildSyncRouter({
      db,
      now: () => 1_800_000_000_000,
      limits: options.limits,
    }),
  );
  app.use(errorHandler);
  return {
    app,
    db,
    client,
    auth: { authorization: `Bearer ${session}` },
  };
}

describe('sync control-plane routes', () => {
  let fixture: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    fixture = await setup();
  });

  it('requires an existing account session', async () => {
    await request(fixture.app)
      .get(`/v1/sync/projects/${PROJECT_ID}`)
      .expect(401);
  });

  it('persists and reads only portable metadata with server authority time', async () => {
    const published = await request(fixture.app)
      .put(`/v1/sync/projects/${PROJECT_ID}`)
      .set(fixture.auth)
      .send({ expectedRevision: 0, entities: [mutation()] });
    expect(published.status).toBe(200);
    expect(published.body).toEqual({
      ok: true,
      data: { revision: 1, serverTime: 1_800_000_000_000 },
    });

    const read = await request(fixture.app)
      .get(`/v1/sync/projects/${PROJECT_ID}`)
      .set(fixture.auth);
    expect(read.status).toBe(200);
    expect(read.headers['cache-control']).toBe('no-store');
    expect(read.body).toEqual({
      ok: true,
      data: {
        projectId: PROJECT_ID,
        revision: 1,
        entities: [mutation()],
        serverTime: 1_800_000_000_000,
      },
    });
    expect(JSON.stringify(read.body)).not.toMatch(
      /installationId|checkoutId|rootRealPath|providerSession|sourceContents|prompt/i,
    );
  });

  it('isolates an identical project id between accounts', async () => {
    await request(fixture.app)
      .put(`/v1/sync/projects/${PROJECT_ID}`)
      .set(fixture.auth)
      .send({ expectedRevision: 0, entities: [mutation()] })
      .expect(200);
    const [other] = await fixture.db
      .insert(accounts)
      .values({ email: `sync-other-${crypto.randomUUID()}@test.local` })
      .returning({ id: accounts.id });
    const { session } = await issueTokens(fixture.db, other.id);

    const read = await request(fixture.app)
      .get(`/v1/sync/projects/${PROJECT_ID}`)
      .set({ authorization: `Bearer ${session}` });
    expect(read.body.data).toMatchObject({ revision: 0, entities: [] });
  });

  it('allows only one concurrent CAS and returns an explicit conflict', async () => {
    const body = { expectedRevision: 0, entities: [mutation()] };
    const [left, right] = await Promise.all([
      request(fixture.app)
        .put(`/v1/sync/projects/${PROJECT_ID}`)
        .set(fixture.auth)
        .send(body),
      request(fixture.app)
        .put(`/v1/sync/projects/${PROJECT_ID}`)
        .set(fixture.auth)
        .send(body),
    ]);

    expect([left.status, right.status].sort()).toEqual([200, 409]);
    const conflict = left.status === 409 ? left : right;
    expect(conflict.body).toMatchObject({
      ok: false,
      error: 'revision-conflict',
      conflict: { expectedRevision: 0, actualRevision: 1 },
    });
  });

  it('rejects entity version jumps and deletion outside the engine contract', async () => {
    const invalidInitial = await request(fixture.app)
      .put(`/v1/sync/projects/${OTHER_PROJECT_ID}`)
      .set(fixture.auth)
      .send({
        expectedRevision: 0,
        entities: [mutation({ entityVersion: 2, baseVersion: 1 })],
      });
    expect(invalidInitial.status).toBe(409);
    expect(invalidInitial.body).toMatchObject({
      error: 'entity-version-conflict',
      conflict: { actualRevision: 0 },
    });

    await request(fixture.app)
      .put(`/v1/sync/projects/${PROJECT_ID}`)
      .set(fixture.auth)
      .send({ expectedRevision: 0, entities: [mutation()] })
      .expect(200);

    for (const entities of [
      [mutation({ entityVersion: 3, baseVersion: 2 })],
      [],
    ]) {
      const response = await request(fixture.app)
        .put(`/v1/sync/projects/${PROJECT_ID}`)
        .set(fixture.auth)
        .send({ expectedRevision: 1, entities });
      expect(response.status).toBe(409);
      expect(response.body.error).toBe('entity-version-conflict');
    }
  });

  it('rejects secrets, prompts, source contents and every machine coordinate', async () => {
    const unsafe = [
      { prompts: ['system prompt'] },
      { sourceContents: 'const secret = true' },
      { relativePath: 'src/main.ts' },
      { installationId: 'install-a' },
      { checkoutId: 'checkout-a' },
      { providerSession: 'provider-a' },
      { accountCredentials: { email: 'alice@example.test' } },
      { token: 'secret-token' },
      { note: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature' },
    ];
    for (const payload of unsafe) {
      const response = await request(fixture.app)
        .put(`/v1/sync/projects/${PROJECT_ID}`)
        .set(fixture.auth)
        .send({
          expectedRevision: 0,
          entities: [mutation({ payload })],
        });
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid-sync-state');
    }
  });

  it('enforces entity, byte and account project quotas', async () => {
    const limited = await setup({
      limits: {
        maxProjectsPerAccount: 1,
        maxEntitiesPerProject: 1,
        maxStateBytes: 512,
      },
    });
    const tooMany = await request(limited.app)
      .put(`/v1/sync/projects/${PROJECT_ID}`)
      .set(limited.auth)
      .send({
        expectedRevision: 0,
        entities: [
          mutation(),
          mutation({ entityId: 'fact-b', payload: { statement: 'B' } }),
        ],
      });
    expect(tooMany.status).toBe(413);
    expect(tooMany.body.quota.name).toBe('entities-per-project');

    await request(limited.app)
      .put(`/v1/sync/projects/${PROJECT_ID}`)
      .set(limited.auth)
      .send({ expectedRevision: 0, entities: [mutation()] })
      .expect(200);
    const tooManyProjects = await request(limited.app)
      .put(`/v1/sync/projects/${OTHER_PROJECT_ID}`)
      .set(limited.auth)
      .send({ expectedRevision: 0, entities: [mutation()] });
    expect(tooManyProjects.status).toBe(413);
    expect(tooManyProjects.body.quota.name).toBe('projects-per-account');

    const tooLarge = await request(limited.app)
      .put(`/v1/sync/projects/${PROJECT_ID}`)
      .set(limited.auth)
      .send({
        expectedRevision: 1,
        entities: [
          mutation({
            entityVersion: 2,
            baseVersion: 1,
            payload: { statement: 'x'.repeat(800) },
          }),
        ],
      });
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.body.quota.name).toBe('bytes-per-project');
  });

  it('serializes concurrent project creation against the account quota', async () => {
    const limited = await setup({
      limits: { maxProjectsPerAccount: 1 },
    });
    const [left, right] = await Promise.all([
      request(limited.app)
        .put(`/v1/sync/projects/${PROJECT_ID}`)
        .set(limited.auth)
        .send({ expectedRevision: 0, entities: [mutation()] }),
      request(limited.app)
        .put(`/v1/sync/projects/${OTHER_PROJECT_ID}`)
        .set(limited.auth)
        .send({ expectedRevision: 0, entities: [mutation()] }),
    ]);
    expect([left.status, right.status].sort()).toEqual([200, 413]);
  });

  it('keeps state across a router restart on the same database', async () => {
    await request(fixture.app)
      .put(`/v1/sync/projects/${PROJECT_ID}`)
      .set(fixture.auth)
      .send({ expectedRevision: 0, entities: [mutation()] })
      .expect(200);
    const restarted = express();
    restarted.use(express.json({ limit: '256kb' }));
    restarted.use(
      '/v1',
      buildSyncRouter({
        db: fixture.db,
        now: () => 1_800_000_000_001,
      }),
    );
    restarted.use(errorHandler);

    const read = await request(restarted)
      .get(`/v1/sync/projects/${PROJECT_ID}`)
      .set(fixture.auth);
    expect(read.body.data).toMatchObject({ revision: 1, entities: [mutation()] });
    expect(read.body.data.serverTime).toBe(1_800_000_000_001);
  });
});
