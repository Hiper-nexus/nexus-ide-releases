import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteD1 } from './helpers/sqlite-d1.js';
import { ADMIN_EMAIL, environment, nativeLogin, seedAccount, seedSubscription, webLogin } from './helpers/fixtures.js';
import { createApp } from '../src/index.js';
import { accountAccess } from '../src/access.js';
import { configFrom } from '../src/config.js';

type Body = { ok: boolean; error?: string; data?: Record<string, any> };
const json = async (response: Response): Promise<Body> => await response.json() as Body;
const DAY_MS = 24 * 60 * 60 * 1000;

async function setup() {
  const db = new SqliteD1();
  await seedAccount(db, 'admin', { admin: true });
  await seedAccount(db, 'trial');
  await seedAccount(db, 'expired', { trialDays: -1 });
  await seedAccount(db, 'paid', { trialDays: -1 });
  await seedSubscription(db, 'paid');
  await seedAccount(db, 'blocked', { suspended: true });
  const env = environment(db);
  const app = createApp();
  const admin = await webLogin(db, 'admin');
  const get = (path: string, headers = admin) => app.request(path, { headers }, env);
  const post = (path: string, body: unknown, headers = admin) => app.request(path, { method: 'POST', headers, body: JSON.stringify(body) }, env);
  const audit = async () => (await db.prepare('SELECT actor_account_id,target_account_id,action,details FROM admin_audit ORDER BY created_at,rowid').all<{ actor_account_id: string; target_account_id: string; action: string; details: string }>()).results;
  return { db, env, app, admin, get, post, audit };
}

test('administration refuses visitors, regular users and admins without a verified allowlisted email', async () => {
  const context = await setup();
  await seedAccount(context.db, 'unverified', { admin: true, verified: false, email: 'unverified@example.test', identityEmail: ADMIN_EMAIL });
  await seedAccount(context.db, 'unlisted', { admin: true, email: 'unlisted@example.test' });
  assert.equal((await context.get('/v1/admin/overview', { Origin: 'https://nexuside.app' })).status, 401);
  for (const id of ['trial', 'unverified', 'unlisted']) {
    const headers = await webLogin(context.db, id);
    assert.equal((await context.get('/v1/admin/overview', headers)).status, 403, id);
    assert.equal((await context.get('/v1/admin/accounts', headers)).status, 403, id);
    assert.equal((await context.post('/v1/admin/accounts/trial/suspend', { reason: 'x' }, headers)).status, 403, id);
  }
  assert.equal((await context.get('/v1/admin/overview', await nativeLogin(context.db, 'admin'))).status, 401);
  assert.deepEqual(await context.audit(), []);
  context.db.close();
});

test('overview counts each account in exactly one situation', async () => {
  const context = await setup();
  const response = await context.get('/v1/admin/overview');
  assert.equal(response.status, 200);
  assert.deepEqual((await json(response)).data, { accounts: 5, trial: 1, active: 2, suspended: 1, expired: 1 });
  context.db.close();
});

test('account list filters by situation and exposes only what the panel needs', async () => {
  const context = await setup();
  const listed = (await json(await context.get('/v1/admin/accounts?status=all&limit=50'))).data!;
  const all = listed.accounts as Record<string, unknown>[];
  assert.equal(all.length, 5);
  assert.equal(listed.nextCursor, null);
  const byId = Object.fromEntries(all.map(row => [row.id, row]));
  assert.deepEqual(Object.keys(byId.paid).sort(), ['access', 'email', 'id', 'lastSeenAt', 'name', 'role', 'subscriptionStatus', 'trialEndsAt']);
  assert.equal(byId.paid.lastSeenAt, null);
  assert.deepEqual([byId.paid.access, byId.paid.subscriptionStatus, byId.paid.role], ['pro', 'active', 'user']);
  assert.deepEqual([byId.trial.access, byId.trial.subscriptionStatus], ['trial', 'none']);
  assert.equal(byId.expired.access, 'expired');
  assert.equal(byId.blocked.access, 'suspended');
  assert.deepEqual([byId.admin.access, byId.admin.role], ['pro', 'admin']);
  assert.equal(typeof byId.trial.trialEndsAt, 'string');
  for (const [status, ids] of [['trial', ['trial']], ['active', ['admin', 'paid']], ['suspended', ['blocked']], ['expired', ['expired']]] as const) {
    const rows = (await json(await context.get(`/v1/admin/accounts?status=${status}`))).data!.accounts as { id: string }[];
    assert.deepEqual(rows.map(row => row.id).sort(), ids, status);
  }
  assert.equal(((await json(await context.get('/v1/admin/accounts?limit=2'))).data!.accounts as unknown[]).length, 2);
  for (const query of ['status=unknown', 'limit=51', 'limit=0', 'limit=abc']) assert.equal((await context.get('/v1/admin/accounts?' + query)).status, 400, query);
  context.db.close();
});

test('suspending needs CSRF and a reason, blocks the account and records who did it', async () => {
  const context = await setup();
  const { 'X-CSRF-Token': _csrf, ...withoutCsrf } = context.admin;
  assert.equal((await context.post('/v1/admin/accounts/paid/suspend', { reason: 'fraude' }, withoutCsrf)).status, 403);
  for (const body of [{}, { reason: '' }, { reason: '   ' }, { reason: 'x'.repeat(501) }, { reason: 'ok', extra: 1 }]) {
    assert.equal((await context.post('/v1/admin/accounts/paid/suspend', body)).status, 400);
  }
  assert.equal((await context.post('/v1/admin/accounts/missing/suspend', { reason: 'fraude' })).status, 404);
  assert.equal((await context.post('/v1/admin/accounts/admin/suspend', { reason: 'engano' })).status, 409);
  assert.deepEqual(await context.audit(), []);

  const response = await context.post('/v1/admin/accounts/paid/suspend', { reason: '  chargeback  ' });
  assert.equal(response.status, 200);
  assert.deepEqual(await json(response), { ok: true, data: {} });
  assert.equal((await accountAccess(context.db, 'paid', configFrom(context.env))).access, 'suspended');
  assert.equal((await context.db.prepare("SELECT suspension_reason AS reason FROM accounts WHERE id='paid'").first<{ reason: string }>())?.reason, 'chargeback');
  assert.equal((await context.db.prepare("SELECT status FROM subscriptions WHERE account_id='paid'").first<{ status: string }>())?.status, 'active');
  const [entry] = await context.audit();
  assert.deepEqual([entry.actor_account_id, entry.target_account_id, entry.action, JSON.parse(entry.details)], ['admin', 'paid', 'suspend', { reason: 'chargeback' }]);
  assert.equal((await context.post('/v1/admin/accounts/paid/suspend', { reason: 'de novo' })).status, 409);
  assert.equal((await context.audit()).length, 1);
  context.db.close();
});

test('resuming restores the access the account had and is audited', async () => {
  const context = await setup();
  assert.equal((await context.post('/v1/admin/accounts/trial/resume', {})).status, 409);
  assert.equal((await context.post('/v1/admin/accounts/blocked/resume', {})).status, 200);
  assert.equal((await accountAccess(context.db, 'blocked', configFrom(context.env))).access, 'trial');
  const row = await context.db.prepare("SELECT suspended_at,suspension_reason FROM accounts WHERE id='blocked'").first();
  assert.deepEqual({ ...row }, { suspended_at: null, suspension_reason: null });
  assert.deepEqual((await context.audit()).map(entry => [entry.target_account_id, entry.action]), [['blocked', 'resume']]);
  context.db.close();
});

test('extending a trial adds whole days from the later of now and the current end', async () => {
  const context = await setup();
  for (const body of [{}, { days: 0 }, { days: 31 }, { days: 1.5 }, { days: '7' }]) {
    assert.equal((await context.post('/v1/admin/accounts/expired/extend-trial', body)).status, 400);
  }
  const before = Date.now();
  assert.equal((await context.post('/v1/admin/accounts/expired/extend-trial', { days: 7 })).status, 200);
  const expired = await context.db.prepare("SELECT trial_expires_at AS end FROM accounts WHERE id='expired'").first<{ end: number }>();
  assert.ok(expired!.end >= before + 7 * DAY_MS && expired!.end <= Date.now() + 7 * DAY_MS);
  assert.equal((await accountAccess(context.db, 'expired', configFrom(context.env))).access, 'trial');

  const running = await context.db.prepare("SELECT trial_expires_at AS end FROM accounts WHERE id='trial'").first<{ end: number }>();
  assert.equal((await context.post('/v1/admin/accounts/trial/extend-trial', { days: 3 })).status, 200);
  assert.equal((await context.db.prepare("SELECT trial_expires_at AS end FROM accounts WHERE id='trial'").first<{ end: number }>())?.end, running!.end + 3 * DAY_MS);
  const entries = await context.audit();
  assert.deepEqual(entries.map(entry => entry.action), ['extend_trial', 'extend_trial']);
  assert.equal(JSON.parse(entries[1].details).days, 3);
  assert.equal((await context.post('/v1/admin/accounts/missing/extend-trial', { days: 3 })).status, 404);
  context.db.close();
});

test('email search combines with status, last entry is last_seen_at, and pages pass the cap of 50', async () => {
  const context = await setup();
  const seen = 1_700_000_000_000;
  await context.db.prepare("UPDATE accounts SET last_seen_at=? WHERE id='trial'").bind(seen).run();
  for (const [id, created] of Object.entries({ admin: 50, trial: 40, expired: 30, paid: 20, blocked: 10 })) {
    await context.db.prepare('UPDATE accounts SET created_at=? WHERE id=?').bind(created, id).run();
  }

  const trialSearch = (await json(await context.get('/v1/admin/accounts?status=trial&email=TRIAL@example'))).data!;
  assert.deepEqual(trialSearch.accounts.map((row: { id: string }) => row.id), ['trial']);
  assert.equal(trialSearch.accounts[0].lastSeenAt, new Date(seen).toISOString());
  assert.equal(trialSearch.nextCursor, null);
  assert.deepEqual((await json(await context.get('/v1/admin/accounts?status=active&email=trial@example.test'))).data!.accounts, []);
  assert.deepEqual((await json(await context.get('/v1/admin/accounts?email=' + encodeURIComponent('%')))).data!.accounts, []);
  assert.equal(((await json(await context.get('/v1/admin/accounts?email=%20%20&status=all'))).data!.accounts as unknown[]).length, 5);
  const paid = ((await json(await context.get('/v1/admin/accounts?status=all'))).data!.accounts as { id: string; lastSeenAt: string | null }[]).find(row => row.id === 'paid');
  assert.equal(paid?.lastSeenAt, null);

  await seedAccount(context.db, 'm', { email: 'm@people.test' });
  await seedAccount(context.db, 'z', { email: 'z@people.test' });
  await context.db.prepare("UPDATE accounts SET created_at=25 WHERE id IN ('m','z')").run();

  const seenIds: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 6; page++) {
    const data = (await json(await context.get('/v1/admin/accounts?status=all&limit=2' + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '')))).data as { accounts: { id: string }[]; nextCursor: string | null };
    assert.ok(data.accounts.length > 0, `página ${page}`);
    seenIds.push(...data.accounts.map(row => row.id));
    cursor = data.nextCursor;
    if (!cursor) break;
  }
  assert.equal(cursor, null);
  assert.deepEqual(seenIds, ['admin', 'trial', 'expired', 'm', 'z', 'paid', 'blocked']);

  const testers: string[] = [];
  cursor = null;
  for (;;) {
    const data = (await json(await context.get('/v1/admin/accounts?status=trial&email=people.test&limit=1' + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '')))).data as { accounts: { id: string }[]; nextCursor: string | null };
    testers.push(...data.accounts.map(row => row.id));
    if (testers.length > 4) break;
    cursor = data.nextCursor;
    if (!cursor) break;
  }
  assert.deepEqual(testers, ['m', 'z']);

  for (const query of ['cursor=%%%', 'cursor=abc', 'cursor=bm9wZQ', `email=${'a'.repeat(201)}`]) {
    assert.equal((await context.get('/v1/admin/accounts?' + query)).status, 400, query);
  }
  context.db.close();
});
