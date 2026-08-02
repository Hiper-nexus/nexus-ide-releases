import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import request from 'supertest';
import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { issueTokens } from '../auth/session-service';
import type { Db } from '../db/client';
import { accounts, CREATE_TABLES_SQL } from '../db/schema';
import * as schema from '../db/schema';
import { errorHandler } from '../middleware/errors';
import { buildCronRouter } from './cron-routes';

const PROJECT_ID = '31781d36-3f22-41b8-ad9d-8690c85d3343';
const SCHEDULE_ID = '2a21a665-d7fd-45d5-b81f-41f433c665ad';

function definition(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    name: 'Nightly review',
    schedule: '0 0 * * *',
    brief: 'Review the project against its acceptance criteria.',
    target: { kind: 'agent', id: 'reviewer' },
    status: 'active',
    ...overrides,
  };
}

async function setup() {
  const client = new PGlite();
  // PGlite sobe um PostgreSQL WASM por fixture. Sem fechar, cada teste do
  // arquivo deixa mais um runtime residente e a rodada inteira disputa
  // CPU/memória com os demais workers. Fechar ao fim do teste mantém
  // exatamente um vivo por vez.
  onTestFinished(async () => {
    await client.close();
  });
  await client.exec(CREATE_TABLES_SQL);
  const db = drizzle(client, { schema }) as unknown as Db;
  const [account] = await db
    .insert(accounts)
    .values({ email: `cron-${crypto.randomUUID()}@test.local` })
    .returning({ id: accounts.id });
  const { session } = await issueTokens(db, account.id);
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.use('/v1', buildCronRouter({ db }));
  app.use(errorHandler);
  return {
    app,
    db,
    client,
    auth: { authorization: `Bearer ${session}` },
  };
}

describe('cron control-plane routes', () => {
  let fixture: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    fixture = await setup();
  });

  it('requires the existing secret-backed account session', async () => {
    const response = await request(fixture.app).get(
      `/v1/cron/projects/${PROJECT_ID}/schedules`,
    );
    expect(response.status).toBe(401);
  });

  it('isolates identical portable project ids between authenticated accounts', async () => {
    await request(fixture.app)
      .put(`/v1/cron/projects/${PROJECT_ID}/schedules/${SCHEDULE_ID}`)
      .set(fixture.auth)
      .send({ expectedVersion: 0, definition: definition() })
      .expect(201);
    const [other] = await fixture.db
      .insert(accounts)
      .values({ email: `other-${crypto.randomUUID()}@test.local` })
      .returning({ id: accounts.id });
    const { session } = await issueTokens(fixture.db, other.id);

    const listed = await request(fixture.app)
      .get(`/v1/cron/projects/${PROJECT_ID}/schedules`)
      .set({ authorization: `Bearer ${session}` });
    expect(listed.status).toBe(200);
    expect(listed.body.data).toEqual([]);
  });

  it('publishes and lists a portable definition without machine coordinates', async () => {
    const created = await request(fixture.app)
      .put(`/v1/cron/projects/${PROJECT_ID}/schedules/${SCHEDULE_ID}`)
      .set(fixture.auth)
      .send({ expectedVersion: 0, definition: definition() });

    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      projectId: PROJECT_ID,
      scheduleId: SCHEDULE_ID,
      version: 1,
      definition: definition(),
    });
    expect(created.body.data.definitionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(created.body)).not.toMatch(
      /checkout|installation|workspacePath|rootRealPath/,
    );

    const listed = await request(fixture.app)
      .get(`/v1/cron/projects/${PROJECT_ID}/schedules`)
      .set(fixture.auth);
    expect(listed.status).toBe(200);
    expect(listed.body.data).toHaveLength(1);
  });

  it.each([
    ['credential material', { brief: 'Use Bearer placeholder' }],
    ['machine path', { name: 'Review /Users/alice/private-project' }],
  ])('rejects %s before persisting a definition', async (_case, override) => {
    await request(fixture.app)
      .put(`/v1/cron/projects/${PROJECT_ID}/schedules/${SCHEDULE_ID}`)
      .set(fixture.auth)
      .send({ expectedVersion: 0, definition: definition(override) })
      .expect(400, { ok: false, error: 'invalid-schedule' });

    const rows = await fixture.db.select().from(schema.cronSchedules);
    expect(rows).toHaveLength(0);
  });

  it('uses explicit CAS conflicts instead of last-write-wins', async () => {
    await request(fixture.app)
      .put(`/v1/cron/projects/${PROJECT_ID}/schedules/${SCHEDULE_ID}`)
      .set(fixture.auth)
      .send({ expectedVersion: 0, definition: definition() })
      .expect(201);

    const [left, right] = await Promise.all([
      request(fixture.app)
        .put(`/v1/cron/projects/${PROJECT_ID}/schedules/${SCHEDULE_ID}`)
        .set(fixture.auth)
        .send({
          expectedVersion: 1,
          definition: definition({ name: 'Review A' }),
        }),
      request(fixture.app)
        .put(`/v1/cron/projects/${PROJECT_ID}/schedules/${SCHEDULE_ID}`)
        .set(fixture.auth)
        .send({
          expectedVersion: 1,
          definition: definition({ name: 'Review B' }),
        }),
    ]);

    expect([left.status, right.status].sort()).toEqual([200, 409]);
    const conflict = left.status === 409 ? left : right;
    expect(conflict.body).toMatchObject({
      ok: false,
      error: 'version-conflict',
      conflict: { expectedVersion: 1, actualVersion: 2 },
    });
  });

  it('allows only one PC to acquire an occurrence and never reveals its token to peers', async () => {
    const published = await request(fixture.app)
      .put(`/v1/cron/projects/${PROJECT_ID}/schedules/${SCHEDULE_ID}`)
      .set(fixture.auth)
      .send({ expectedVersion: 0, definition: definition() });
    const definitionHash = published.body.data.definitionHash as string;
    const body = {
      projectId: PROJECT_ID,
      scheduleId: SCHEDULE_ID,
      definitionVersion: 1,
      definitionHash,
      occurrenceAt: 1_800_000_000_000,
      ttlMs: 90_000,
    };

    const [pcA, pcB] = await Promise.all([
      request(fixture.app)
        .post('/v1/cron/leases/acquire')
        .set(fixture.auth)
        .send(body),
      request(fixture.app)
        .post('/v1/cron/leases/acquire')
        .set(fixture.auth)
        .send(body),
    ]);

    const winner = pcA.body.data?.acquired ? pcA : pcB;
    const loser = winner === pcA ? pcB : pcA;
    expect(winner.status).toBe(200);
    expect(winner.body.data.token).toEqual(expect.any(String));
    expect(loser.status).toBe(409);
    expect(loser.body.data).toMatchObject({
      acquired: false,
      reason: 'held-by-peer',
    });
    expect(loser.body.data).not.toHaveProperty('token');
  });

  it('renews and releases only with the exact opaque token', async () => {
    const published = await request(fixture.app)
      .put(`/v1/cron/projects/${PROJECT_ID}/schedules/${SCHEDULE_ID}`)
      .set(fixture.auth)
      .send({ expectedVersion: 0, definition: definition() });
    const lease = {
      projectId: PROJECT_ID,
      scheduleId: SCHEDULE_ID,
      definitionVersion: 1,
      definitionHash: published.body.data.definitionHash,
      occurrenceAt: 1_800_000_000_000,
      ttlMs: 90_000,
    };
    const acquired = await request(fixture.app)
      .post('/v1/cron/leases/acquire')
      .set(fixture.auth)
      .send(lease);
    const token = acquired.body.data.token as string;

    await request(fixture.app)
      .post('/v1/cron/leases/renew')
      .set(fixture.auth)
      .send({ ...lease, token: 'fabricated/+ token' })
      .expect(409);
    const renewed = await request(fixture.app)
      .post('/v1/cron/leases/renew')
      .set(fixture.auth)
      .send({ ...lease, token });
    expect(renewed.status).toBe(200);
    expect(renewed.body.data.token).toBe(token);
    await request(fixture.app)
      .post('/v1/cron/leases/release')
      .set(fixture.auth)
      .send({ ...lease, token: 'wrong' })
      .expect(409);
    await request(fixture.app)
      .post('/v1/cron/leases/release')
      .set(fixture.auth)
      .send({ ...lease, token })
      .expect(200);
  });

  it('keeps lease state across a handler restart over the same database', async () => {
    const published = await request(fixture.app)
      .put(`/v1/cron/projects/${PROJECT_ID}/schedules/${SCHEDULE_ID}`)
      .set(fixture.auth)
      .send({ expectedVersion: 0, definition: definition() });
    const body = {
      projectId: PROJECT_ID,
      scheduleId: SCHEDULE_ID,
      definitionVersion: 1,
      definitionHash: published.body.data.definitionHash,
      occurrenceAt: 1_800_000_000_000,
      ttlMs: 90_000,
    };
    await request(fixture.app)
      .post('/v1/cron/leases/acquire')
      .set(fixture.auth)
      .send(body)
      .expect(200);

    const restarted = express();
    restarted.use(express.json());
    restarted.use('/v1', buildCronRouter({ db: fixture.db }));
    restarted.use(errorHandler);
    const afterRestart = await request(restarted)
      .post('/v1/cron/leases/acquire')
      .set(fixture.auth)
      .send(body);
    expect(afterRestart.status).toBe(409);
    expect(afterRestart.body.data.reason).toBe('held-by-peer');
  });

  it('rejects a stale definition version before granting execution authority', async () => {
    const first = await request(fixture.app)
      .put(`/v1/cron/projects/${PROJECT_ID}/schedules/${SCHEDULE_ID}`)
      .set(fixture.auth)
      .send({ expectedVersion: 0, definition: definition() });
    await request(fixture.app)
      .put(`/v1/cron/projects/${PROJECT_ID}/schedules/${SCHEDULE_ID}`)
      .set(fixture.auth)
      .send({ expectedVersion: 1, definition: definition({ name: 'Updated' }) })
      .expect(200);

    const response = await request(fixture.app)
      .post('/v1/cron/leases/acquire')
      .set(fixture.auth)
      .send({
        projectId: PROJECT_ID,
        scheduleId: SCHEDULE_ID,
        definitionVersion: 1,
        definitionHash: first.body.data.definitionHash,
        occurrenceAt: 1_800_000_000_000,
        ttlMs: 90_000,
      });
    expect(response.status).toBe(409);
    expect(response.body.data).toMatchObject({
      acquired: false,
      reason: 'definition-conflict',
      actualVersion: 2,
    });
  });
});
