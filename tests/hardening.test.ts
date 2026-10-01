import test from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import { SqliteD1 } from './helpers/sqlite-d1.js';
import { ADMIN_EMAIL, SITE, environment, nativeLogin, seedAccount, seedSubscription, webLogin } from './helpers/fixtures.js';
import { createApp, cleanupExpired } from '../src/index.js';
import { configFrom } from '../src/config.js';
import { issueTokens, revokeAll, rotateRefresh, sessionFor } from '../src/sessions.js';
import { stripeFrom } from '../src/stripe.js';

type Body = { ok: boolean; error?: string; data?: Record<string, any> };
const json = async (response: Response): Promise<Body> => await response.json() as Body;
const cookies = (response: Response): string => response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
const PROJECT = '11111111-1111-4111-8111-111111111111';
const SCHEDULE = '22222222-2222-4222-8222-222222222222';
const definition = { schemaVersion: 1, name: 'Daily check', schedule: '0 12 * * *', brief: 'Review service health', target: { kind: 'agent', id: 'codex' }, status: 'active' };

/** Runs `effect` once, right after the first statement matching `pattern` executes. */
function interleave(db: SqliteD1, pattern: RegExp, effect: () => Promise<void>): D1Database {
  let armed = true;
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
    get(target, property) {
      if (property === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
      if (property !== 'first' && property !== 'run' && property !== 'all') return Reflect.get(target, property);
      return async (...args: unknown[]) => {
        const result = await (Reflect.get(target, property) as (...inner: unknown[]) => Promise<unknown>).apply(target, args);
        if (armed) { armed = false; await effect(); }
        return result;
      };
    },
  });
  return new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') return (query: string) => armed && pattern.test(query) ? wrap(target.prepare(query)) : target.prepare(query);
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

test('an administrator loses authority when the provider stops confirming the allowlisted email', async () => {
  const db = new SqliteD1();
  const env = environment(db);
  let profile = { sub: 'google-admin', email: ADMIN_EMAIL, email_verified: true, name: 'Admin' };
  const app = createApp({ fetchFn: async input => String(input).includes('/token') ? Response.json({ access_token: 'provider-token' }) : Response.json(profile) });
  const login = async () => {
    const start = await app.request('/v1/web/auth/google', {}, env);
    const state = new URL(start.headers.get('location')!).searchParams.get('state');
    const done = await app.request(`/v1/auth/google/callback?code=provider-code&state=${state}`, { headers: { Cookie: cookies(start) } }, env);
    assert.equal(done.status, 302);
    return { Origin: SITE, Cookie: cookies(done) };
  };
  assert.equal((await app.request('/v1/admin/overview', { headers: await login() }, env)).status, 200);
  profile = { sub: 'google-admin', email: 'changed@example.test', email_verified: false, name: 'Admin' };
  const headers = await login();
  assert.equal((await app.request('/v1/admin/overview', { headers }, env)).status, 403);
  assert.equal((await json(await app.request('/v1/web/session', { headers }, env))).data?.profile.role, 'user');
  db.close();
});

test('a refresh rotation that loses the race with a revocation leaves no usable successor', async () => {
  const db = new SqliteD1();
  await seedAccount(db, 'user');
  const tokens = await issueTokens(db, 'user', 'desktop');
  // The replay detection revokes the whole family between the consumption and the issuance.
  const racing = interleave(db, /^UPDATE refresh_tokens SET used_at/, () => revokeAll(db, 'user', Date.now(), 'desktop'));
  const rotated = await rotateRefresh(racing, tokens.refresh, 'desktop');
  assert.equal(rotated, null);
  const live = await db.prepare('SELECT count(*) AS n FROM sessions WHERE revoked_at IS NULL').first<{ n: number }>();
  assert.equal(live?.n, 0);
  const normal = await issueTokens(db, 'user', 'desktop');
  const next = await rotateRefresh(db, normal.refresh, 'desktop');
  assert.ok(next && await sessionFor(db, next.tokens.session, 'desktop'), 'an uncontested rotation still works');
  db.close();
});

test('a delayed restore cannot erase a suspension applied after it was read', async () => {
  const db = new SqliteD1();
  await seedAccount(db, 'admin', { admin: true });
  await seedAccount(db, 'target', { suspended: true });
  const headers = await webLogin(db, 'admin');
  // Between the read and the write, another admin restores and suspends again for a new reason.
  const racing = interleave(db, /^SELECT \* FROM accounts WHERE id=\?$/, async () => {
    await db.prepare("UPDATE accounts SET suspended_at=?,suspension_reason='novo motivo' WHERE id='target'").bind(Date.now() + 5000).run();
  });
  const response = await createApp().request('/v1/admin/accounts/target/resume', { method: 'POST', headers, body: '{}' }, environment(racing as SqliteD1));
  assert.equal(response.status, 409);
  const row = await db.prepare("SELECT suspension_reason AS reason FROM accounts WHERE id='target'").first<{ reason: string | null }>();
  assert.equal(row?.reason, 'novo motivo');
  assert.equal((await db.prepare('SELECT count(*) AS n FROM admin_audit').first<{ n: number }>())?.n, 0);
  db.close();
});

test('the session tells the site whether billing can be managed, independently of app access', async () => {
  const db = new SqliteD1();
  await seedAccount(db, 'subscriber', { suspended: true, customer: 'cus_subscriber' });
  await seedSubscription(db, 'subscriber');
  await seedAccount(db, 'trial');
  const app = createApp(), env = environment(db);
  const session = async (id: string) => (await json(await app.request('/v1/web/session', { headers: await webLogin(db, id) }, env))).data!;
  const suspended = await session('subscriber');
  assert.equal(suspended.entitlement.access, 'suspended');
  assert.deepEqual(suspended.billing, { portal: true });
  assert.deepEqual((await session('trial')).billing, { portal: false });
  db.close();
});

test('cloud cron refuses writes from accounts without access and keeps storage bounded', async () => {
  const db = new SqliteD1();
  await seedAccount(db, 'active');
  await seedAccount(db, 'expired', { trialDays: -1 });
  await seedAccount(db, 'blocked', { suspended: true });
  const app = createApp(), env = environment(db);
  const publish = async (id: string, schedule = SCHEDULE) => app.request(`/v1/cron/projects/${PROJECT}/schedules/${schedule}`, { method: 'PUT', headers: await nativeLogin(db, id), body: JSON.stringify({ expectedVersion: 0, definition }) }, env);
  assert.equal((await publish('expired')).status, 403);
  assert.equal((await publish('blocked')).status, 403);
  const created = await publish('active');
  assert.equal(created.status, 201);
  const stored = (await json(created)).data!;
  const lease = { projectId: PROJECT, scheduleId: SCHEDULE, definitionVersion: stored.version, definitionHash: stored.definitionHash, ttlMs: 60_000 };
  const acquire = async (id: string, occurrenceAt: number) => app.request('/v1/cron/leases/acquire', { method: 'POST', headers: await nativeLogin(db, id), body: JSON.stringify({ ...lease, occurrenceAt }) }, env);
  assert.equal((await acquire('expired', 1)).status, 403);
  assert.equal((await acquire('active', 1)).status, 200);

  const future = Date.now() + 3_600_000;
  await db.batch(Array.from({ length: 999 }, (_, index) => db.prepare("INSERT INTO cron_leases(account_id,project_id,schedule_id,occurrence_at,token_hash,version,expires_at) VALUES('active',?,?,?,'h',1,?)").bind(PROJECT, SCHEDULE, index + 10, future)));
  const over = await acquire('active', 5000);
  assert.equal(over.status, 409);
  assert.equal((await json(over)).data?.reason, 'lease-quota');

  await db.batch(Array.from({ length: 499 }, (_, index) => db.prepare("INSERT INTO cron_schedules(account_id,project_id,schedule_id,version,definition,definition_hash,status) VALUES('active',?,?,1,'{}','h','paused')").bind(PROJECT, `filler-${index}`)));
  const full = await publish('active', '33333333-3333-4333-8333-333333333333');
  assert.equal(full.status, 409);
  assert.equal((await json(full)).error, 'schedule-quota');
  db.close();
});

test('scheduled cleanup removes cron leases that expired more than an hour ago', async () => {
  const db = new SqliteD1();
  await seedAccount(db, 'user');
  const now = Date.now();
  await db.batch([[1, now - 2 * 3_600_000], [2, now - 60_000], [3, now + 60_000]].map(([occurrence, expires]) =>
    db.prepare("INSERT INTO cron_leases(account_id,project_id,schedule_id,occurrence_at,token_hash,version,expires_at) VALUES('user','p','s',?,NULL,1,?)").bind(occurrence, expires)));
  await cleanupExpired(db, now);
  assert.deepEqual((await db.prepare('SELECT occurrence_at AS at FROM cron_leases ORDER BY occurrence_at').all<{ at: number }>()).results.map(row => row.at), [2, 3]);
  db.close();
});

test('the panel shows the effective subscription of a legacy team owner', async () => {
  const db = new SqliteD1();
  await seedAccount(db, 'admin', { admin: true });
  await seedAccount(db, 'owner', { trialDays: -1 });
  await db.batch([
    db.prepare("INSERT INTO teams(id,name,owner_account_id) VALUES('team','Example','owner')"),
    db.prepare("INSERT INTO team_members(team_id,account_id,role) VALUES('team','owner','owner')"),
    db.prepare("INSERT INTO subscriptions(id,owner_type,team_id,stripe_subscription_id,stripe_customer_id,plan,status,seats,current_period_end) VALUES('team-sub','team','team','sub_team','cus_team','team','active',2,?)").bind(Date.now() + 86_400_000),
  ]);
  const rows = (await json(await createApp().request('/v1/admin/accounts', { headers: await webLogin(db, 'admin') }, environment(db)))).data!.accounts as Array<Record<string, unknown>>;
  const owner = rows.find(row => row.id === 'owner')!;
  assert.deepEqual([owner.access, owner.subscriptionStatus], ['pro', 'active']);
  db.close();
});

test('readiness checks are rate limited like the rest of the API', async () => {
  const db = new SqliteD1();
  const deny = { limit: async () => ({ success: false }) };
  assert.equal((await createApp().request('/ready', {}, environment(db, { API_RATE_LIMITER: deny }))).status, 429);
  db.close();
});

test('license code redemption has its own, stricter rate limiter and never spends the general API budget', async () => {
  const db = new SqliteD1();
  const allow = { limit: async () => ({ success: true }) };
  const deny = { limit: async () => ({ success: false }) };
  const request = (env: CloudflareBindings) => createApp().request('/v1/license/redeem', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'NEXUS-AAAA-BBBB-CCCC' }) }, env);
  // O limite do resgate nega mesmo com o geral livre: o código é a única barreira e merece teto próprio.
  assert.equal((await request(environment(db, { API_RATE_LIMITER: allow, REDEEM_RATE_LIMITER: deny }))).status, 429);
  // O resgate não gasta o orçamento geral: com o geral esgotado e o do resgate livre, a rota segue (401 por falta de sessão, nunca 429).
  assert.equal((await request(environment(db, { API_RATE_LIMITER: deny, REDEEM_RATE_LIMITER: allow }))).status, 401);
  db.close();
});

test('redemption keeps working on a deploy that predates the dedicated limiter binding', async () => {
  const db = new SqliteD1();
  const denied = (await createApp().request('/v1/license/redeem', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'NEXUS-AAAA-BBBB-CCCC' }) }, environment(db, { REDEEM_RATE_LIMITER: undefined }))).status;
  assert.notEqual(denied, 429, 'sem o binding novo cai no limite geral, sem lançar');
  assert.notEqual(denied, 500);
  db.close();
});

test('the production webhook verifier accepts only the exact signed body within the time tolerance', async () => {
  const secret = 'whsec_fixture_only';
  const payload = JSON.stringify({ id: 'evt_signed', object: 'event', type: 'invoice.paid', data: { object: { id: 'in_1', subscription: 'sub_1' } } });
  const stripe = new Stripe('fixture-key');
  const verifier = stripeFrom(configFrom(environment(new SqliteD1()))).webhooks;
  const signed = async (timestamp = Math.floor(Date.now() / 1000), signingSecret = secret) => stripe.webhooks.generateTestHeaderStringAsync({ payload, secret: signingSecret, timestamp });
  const event = await verifier.constructEventAsync(payload, await signed(), secret);
  assert.equal(event.id, 'evt_signed');
  await assert.rejects(verifier.constructEventAsync(payload.replace('sub_1', 'sub_2'), await signed(), secret));
  await assert.rejects(verifier.constructEventAsync(payload, await signed(undefined, 'whsec_other'), secret));
  await assert.rejects(verifier.constructEventAsync(payload, await signed(Math.floor(Date.now() / 1000) - 301), secret));
});
