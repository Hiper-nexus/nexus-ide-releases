import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteD1 } from './helpers/sqlite-d1.js';
import { SITE, environment, fakeStripe, seedAccount, webLogin } from './helpers/fixtures.js';
import { createApp, cleanupExpired } from '../src/index.js';

type Body = { ok: boolean; error?: string; data?: Record<string, any> };
const json = async (response: Response): Promise<Body> => await response.json() as Body;

test('public status reports price, trial limits and configured logins without exposing secrets', async () => {
  const db = new SqliteD1();
  const response = await createApp().request('/v1/public/status', {}, environment(db));
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.deepEqual(body.data, {
    ready: true,
    auth: { google: true, github: false },
    billing: { available: true, amount: 5999, currency: 'brl', interval: 'month' },
    trial: { days: 15, maxAgents: 2, cloudSync: false },
  });
  assert.equal(JSON.stringify(body).includes('fixture'), false);
  db.close();
});

test('billing is reported unavailable until Stripe and the migration are configured', async () => {
  const db = new SqliteD1();
  const app = createApp();
  const unconfigured = await json(await app.request('/v1/public/status', {}, environment(db, { STRIPE_WEBHOOK_SECRET: '' })));
  assert.equal(unconfigured.data?.billing.available, false);
  const notReady = await json(await app.request('/v1/public/status', {}, environment(db, { MIGRATION_READY: 'false' })));
  assert.equal(notReady.data?.ready, false);
  db.close();
});

test('CORS allows credentialed requests only from the configured site', async () => {
  const db = new SqliteD1();
  const app = createApp();
  const preflight = (origin: string) => app.request('/v1/web/checkout', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-csrf-token' } }, environment(db));
  const allowed = await preflight(SITE);
  assert.equal(allowed.headers.get('access-control-allow-origin'), SITE);
  assert.equal(allowed.headers.get('access-control-allow-credentials'), 'true');
  assert.match(allowed.headers.get('access-control-allow-headers') ?? '', /x-csrf-token/i);
  for (const origin of ['https://evil.test', SITE + '.evil.test', 'https://comunidade.nexuside.app']) {
    assert.equal((await preflight(origin)).headers.get('access-control-allow-origin'), null);
  }
  const denied = await app.request('/v1/web/checkout', { method: 'POST', headers: { Origin: SITE } }, environment(db));
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get('access-control-allow-origin'), SITE, 'the site must be able to read error envelopes');
  db.close();
});

test('errors are JSON envelopes that never leak internals', async () => {
  const db = new SqliteD1();
  const app = createApp();
  const missing = await app.request('/v1/unknown', {}, environment(db));
  assert.equal(missing.status, 404);
  assert.equal((await json(missing)).ok, false);
  const denied = await app.request('/v1/license', {}, environment(db));
  assert.equal(denied.status, 401);
  assert.deepEqual(await json(denied), { ok: false, error: 'Entre na sua conta para continuar.' });
  const broken = await app.request('/v1/public/status', {}, environment(db, { PUBLIC_SITE_URL: 'not a url' }));
  assert.equal(broken.status, 500);
  assert.deepEqual(await json(broken), { ok: false, error: 'Erro interno. Tente novamente.' });
  assert.equal(broken.headers.get('x-content-type-options'), 'nosniff');
  db.close();
});

test('rate limited clients receive 429 while Stripe webhooks are never throttled', async () => {
  const db = new SqliteD1();
  const fake = fakeStripe();
  fake.event = new Error('bad signature');
  const deny = { limit: async () => ({ success: false }) };
  const env = environment(db, { API_RATE_LIMITER: deny, AUTH_RATE_LIMITER: deny });
  const app = createApp({ stripeFor: () => fake.stripe });
  assert.equal((await app.request('/v1/public/status', {}, env)).status, 429);
  assert.equal((await app.request('/v1/web/auth/google', {}, env)).status, 429);
  assert.equal((await app.request('/v1/billing/webhook', { method: 'POST', body: '{}', headers: { 'stripe-signature': 'x' } }, env)).status, 400);
  db.close();
});

test('readiness follows the database and health stays independent of it', async () => {
  const db = new SqliteD1();
  const app = createApp();
  assert.equal((await app.request('/ready', {}, environment(db))).status, 200);
  assert.equal((await app.request('/health', {}, environment(db))).status, 200);
  db.close();
  const closed = await app.request('/ready', {}, environment(db));
  assert.equal(closed.status, 503);
  assert.equal((await app.request('/health', {}, environment(db))).status, 200);
});

test('web session is readable through the composed app with credentials', async () => {
  const db = new SqliteD1();
  await seedAccount(db, 'user');
  const response = await createApp().request('/v1/web/session', { headers: await webLogin(db, 'user') }, environment(db));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), SITE);
  const body = await json(response);
  assert.equal(body.data?.entitlement.access, 'trial');
  assert.equal(body.data?.entitlement.maxAgents, 2);
  db.close();
});

test('scheduled cleanup removes only expired login state and tokens', async () => {
  const db = new SqliteD1();
  await seedAccount(db, 'user');
  const now = Date.now();
  await db.batch([
    db.prepare("INSERT INTO oauth_states(state,provider,code_verifier,expires_at) VALUES('old','google','v',?),('new','google','v',?)").bind(now - 1, now + 60_000),
    db.prepare("INSERT INTO auth_codes(code_hash,account_id,expires_at) VALUES('old','user',?),('new','user',?)").bind(now - 1, now + 60_000),
    db.prepare("INSERT INTO sessions(id,account_id,token_hash,expires_at) VALUES('old','user','h1',?),('new','user','h2',?)").bind(now - 1, now + 60_000),
    db.prepare("INSERT INTO refresh_tokens(id,account_id,token_hash,expires_at) VALUES('old','user','h1',?),('new','user','h2',?)").bind(now - 1, now + 60_000),
  ]);
  await cleanupExpired(db, now);
  for (const [table, column] of [['oauth_states', 'state'], ['auth_codes', 'code_hash'], ['sessions', 'id'], ['refresh_tokens', 'id']]) {
    const rows = await db.prepare(`SELECT ${column} AS id FROM ${table}`).all<{ id: string }>();
    assert.deepEqual(rows.results.map(row => row.id), ['new'], table);
  }
  db.close();
});
