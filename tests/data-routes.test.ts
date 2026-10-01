import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { SqliteD1 } from './helpers/sqlite-d1.js';
import { issueTokens } from '../src/sessions.js';
import { configFrom } from '../src/config.js';
import type { AppEnv } from '../src/context.js';
import { compareAndSwapSyncProject, syncRoutes } from '../src/sync.js';
import { acquireCronLease, publishCronSchedule, renewCronLease, releaseCronLease, cronRoutes } from '../src/cron.js';
import { createInvite, joinTeam, teamRoutes } from '../src/teams.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const SCHEDULE = '22222222-2222-4222-8222-222222222222';
const mutation = (version = 1, value = 'safe summary') => ({ entityType: 'context-fact', entityId: 'fact1', entityVersion: version, baseVersion: version - 1, payload: { summary: value } });
const definition = { schemaVersion: 1 as const, name: 'Daily check', schedule: '0 12 * * *', brief: 'Review service health', target: { kind: 'agent' as const, id: 'codex' }, status: 'active' as const };

async function account(db: SqliteD1, id: string, paid = false) {
  // Accounts start in a running trial: cloud cron needs access, and sync still needs a paid plan.
  await db.prepare('INSERT INTO accounts(id,email,trial_started_at,trial_expires_at) VALUES(?,?,?,?)').bind(id, `${id}@example.test`, Date.now(), Date.now() + 86_400_000).run();
  if (paid) await db.prepare("INSERT INTO subscriptions(id,owner_type,account_id,stripe_subscription_id,stripe_customer_id,plan,status,current_period_end) VALUES(?,'account',?,?,?,'pro','active',?)").bind(`sub-${id}`, id, `stripe-${id}`, `cus-${id}`, Date.now() + 86_400_000).run();
  return issueTokens(db, id, 'desktop');
}
function environment(db: SqliteD1): CloudflareBindings {
  return { DB: db, AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) }, API_RATE_LIMITER: { limit: async () => ({ success: true }) }, REDEEM_RATE_LIMITER: { limit: async () => ({ success: true }) }, PUBLIC_BASE_URL: 'https://nexuside.app', PUBLIC_SITE_URL: 'https://nexuside.app', APP_DEEP_LINK_BASE: 'nexus://auth', SHOT_DEEP_LINK_BASE: 'nexus-shot://auth/callback', APP_MODE: 'staging', MIGRATION_READY: 'false', STRIPE_PRICE_PRO: '', STRIPE_PRICE_TEAM: '', GITHUB_OAUTH_ID: '', GOOGLE_OAUTH_ID: '', ADMIN_EMAILS: '', TRIAL_DAYS: '15', TRIAL_MAX_AGENTS: '2', TRIAL_CLOUD_SYNC: 'false' };
}
function app() {
  const router = new Hono<AppEnv>();
  router.use('*', async (c, next) => { c.set('config', configFrom(c.env)); await next(); });
  router.route('/v1', syncRoutes).route('/v1', cronRoutes).route('/v1', teamRoutes);
  return router;
}
async function team(db: SqliteD1, seats = 2) {
  await account(db, 'owner');
  await db.batch([
    db.prepare("INSERT INTO teams(id,name,owner_account_id) VALUES('team','Example','owner')"),
    db.prepare("INSERT INTO team_members(team_id,account_id,role) VALUES('team','owner','owner')"),
    db.prepare("INSERT INTO subscriptions(id,owner_type,team_id,stripe_subscription_id,stripe_customer_id,plan,status,seats,current_period_end) VALUES('team-sub','team','team','stripe-team','cus-team','team','active',?,?)").bind(seats, Date.now() + 86_400_000),
  ]);
  return createInvite(db, 'team', 'owner');
}

test('D1 fixture rolls back all statements in a failed batch', async () => {
  const db = new SqliteD1();
  await assert.rejects(db.batch([db.prepare("INSERT INTO accounts(id,email) VALUES('rollback','rollback@example.test')"), db.prepare("INSERT INTO accounts(id,email) VALUES('rollback','other@example.test')")]));
  assert.equal(await db.prepare("SELECT id FROM accounts WHERE id='rollback'").first(), null);
  db.close();
});
test('sync native routes reject missing and web-channel tokens; free accounts cannot sync', async () => {
  const db = new SqliteD1(); const native = await account(db, 'free'); const web = await issueTokens(db, 'free', 'web'); const router = app(); const env = environment(db);
  for (const token of [undefined, web.session]) {
    const response = await router.request('/v1/sync/projects/p', { headers: token ? { Authorization: `Bearer ${token}` } : {} }, env);
    assert.equal(response.status, 401);
  }
  const response = await router.request('/v1/sync/projects/p', { headers: { Authorization: `Bearer ${native.session}` } }, env);
  assert.equal(response.status, 403); db.close();
});
test('sync compatibility preserves account scope, revisions and safe payload validation', async () => {
  const db = new SqliteD1(); const tokens = await account(db, 'paid', true); const other = await account(db, 'other', true); const router = app(); const env = environment(db);
  const put = (token: string, body: unknown) => router.request('/v1/sync/projects/p', { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, env);
  assert.equal((await put(tokens.session, { expectedRevision: 0, entities: [mutation()] })).status, 200);
  const conflict = await put(tokens.session, { expectedRevision: 0, entities: [mutation()] });
  assert.equal(conflict.status, 409); assert.equal((await conflict.json() as { error: string }).error, 'revision-conflict');
  const isolated = await router.request('/v1/sync/projects/p', { headers: { Authorization: `Bearer ${other.session}` } }, env);
  assert.equal((await isolated.json() as { data: { revision: number } }).data.revision, 0); assert.equal(isolated.headers.get('cache-control'), 'no-store');
  assert.equal((await put(tokens.session, { expectedRevision: 1, entities: [mutation(2, '/Users/private/file')] })).status, 400);
  assert.equal((await put(tokens.session, { expectedRevision: 1, entities: [] })).status, 409);
  assert.equal((await put(tokens.session, { expectedRevision: 1, entities: [mutation(2, 'updated summary')] })).status, 200);
  db.close();
});
test('sync conditional creates enforce account quota and updates have one CAS winner', async () => {
  const db = new SqliteD1(); await account(db, 'a'); const deps = { db, limits: { maxProjectsPerAccount: 1 } };
  const creates = await Promise.all(['p', 'q'].map((projectId) => compareAndSwapSyncProject(deps, { accountId: 'a', projectId, expectedRevision: 0, entities: [mutation()] })));
  assert.equal(creates.filter((row) => row.ok).length, 1);
  assert.equal(creates.filter((row) => !row.ok && row.reason === 'projects-per-account').length, 1);
  const projectId = creates[0].ok ? 'p' : 'q';
  const updates = await Promise.all(['first summary', 'second summary'].map((value) => compareAndSwapSyncProject(deps, { accountId: 'a', projectId, expectedRevision: 1, entities: [mutation(2, value)] })));
  assert.equal(updates.filter((row) => row.ok).length, 1); db.close();
});
test('cron publishes with CAS and leases fence token owner, account and changed definitions', async () => {
  const db = new SqliteD1(); await account(db, 'a'); await account(db, 'b'); const deps = { db, now: () => 1_000_000 }; const input = { accountId: 'a', projectId: PROJECT, scheduleId: SCHEDULE, expectedVersion: 0, definition };
  const published = await publishCronSchedule(deps, input); assert.equal(published.ok, true); if (!published.ok) return;
  assert.equal((await publishCronSchedule(deps, input)).ok, false);
  const coordinates = { projectId: PROJECT, scheduleId: SCHEDULE, definitionVersion: 1, definitionHash: published.schedule.definitionHash, occurrenceAt: 1_000_000, ttlMs: 10_000 };
  const leases = await Promise.all([acquireCronLease(deps, 'a', coordinates), acquireCronLease(deps, 'a', coordinates)]);
  assert.equal(leases.filter((row) => row.acquired).length, 1); const held = leases.find((row) => row.acquired); assert.ok(held?.acquired);
  assert.equal((await acquireCronLease(deps, 'b', coordinates)).acquired, false);
  assert.equal((await renewCronLease(deps, 'a', { ...coordinates, token: 'invalid' })).acquired, false);
  assert.equal((await renewCronLease(deps, 'a', { ...coordinates, token: held.token })).acquired, true);
  const row = await db.prepare('SELECT token_hash FROM cron_leases').first<{ token_hash: string }>(); assert.notEqual(row?.token_hash, held.token);
  await publishCronSchedule(deps, { ...input, expectedVersion: 1, definition: { ...definition, status: 'paused' } });
  const denied = await renewCronLease(deps, 'a', { ...coordinates, token: held.token }); assert.equal(denied.acquired, false); if (!denied.acquired) assert.equal(denied.reason, 'definition-conflict');
  assert.equal(await releaseCronLease(deps, 'a', { ...coordinates, token: held.token }), true);
  db.close();
});
test('cron expired lease takeover fences former owner and reused token', async () => {
  const db = new SqliteD1(); await account(db, 'a'); const published = await publishCronSchedule({ db }, { accountId: 'a', projectId: PROJECT, scheduleId: SCHEDULE, expectedVersion: 0, definition }); assert.ok(published.ok);
  const coordinates = { projectId: PROJECT, scheduleId: SCHEDULE, definitionVersion: 1, definitionHash: published.schedule.definitionHash, occurrenceAt: 1000, ttlMs: 1000 };
  const first = await acquireCronLease({ db, now: () => 1000 }, 'a', coordinates); assert.ok(first.acquired);
  const second = await acquireCronLease({ db, now: () => 2000 }, 'a', coordinates); assert.ok(second.acquired); assert.notEqual(second.token, first.token);
  assert.equal(await releaseCronLease({ db, now: () => 2000 }, 'a', { ...coordinates, token: first.token }), false);
  db.close();
});
test('team join has one winner for one free seat and only consumes successful invitation', async () => {
  const db = new SqliteD1(); const invite = await team(db); await account(db, 'a'); await account(db, 'b');
  const joined = await Promise.all(['a', 'b'].map((id) => joinTeam(db, id, invite.code)));
  assert.equal(joined.filter((row) => row.ok).length, 1);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM team_members').first<{ n: number }>())?.n, 2);
  assert.equal((await db.prepare('SELECT used_count FROM team_invites').first<{ used_count: number }>())?.used_count, 1);
  const winner = joined[0].ok ? 'a' : 'b'; assert.equal((await joinTeam(db, winner, invite.code)).ok, false);
  assert.equal((await db.prepare('SELECT used_count FROM team_invites').first<{ used_count: number }>())?.used_count, 1);
  db.close();
});
test('team joins reject expired, revoked, exhausted and unpaid invites without member creation', async () => {
  for (const column of ['revoked_at=1', 'expires_at=1', 'used_count=max_uses']) {
    const db = new SqliteD1(); const invite = await team(db); await account(db, 'a'); await db.exec(`UPDATE team_invites SET ${column}`);
    assert.equal((await joinTeam(db, 'a', invite.code)).ok, false); db.close();
  }
  const db = new SqliteD1(); const invite = await team(db); await account(db, 'a'); await db.exec("UPDATE subscriptions SET status='canceled'");
  assert.equal((await joinTeam(db, 'a', invite.code)).ok, false);
  assert.equal((await db.prepare('SELECT used_count FROM team_invites').first<{ used_count: number }>())?.used_count, 0); db.close();
});
test('native team routes expose ISO invitation expiry and refuse owner removal', async () => {
  const db = new SqliteD1(); await team(db); const tokens = await issueTokens(db, 'owner', 'desktop'); const router = app(); const env = environment(db); const headers = { Authorization: `Bearer ${tokens.session}` };
  const response = await router.request('/v1/team', { headers }, env); assert.equal(response.status, 200); const body = await response.json() as { data: { team: { role: string }; seats: { used: number }; invites: { expiresAt: string }[] } };
  assert.equal(body.data.team.role, 'owner'); assert.equal(body.data.seats.used, 1); assert.match(body.data.invites[0].expiresAt, /^\d{4}-/);
  assert.equal((await router.request('/v1/team/members/owner', { method: 'DELETE', headers }, env)).status, 400);
  db.close();
});

test('sync payload quotas reject oversized states and metadata that could expose credentials', async () => {
  const db = new SqliteD1(); await account(db, 'a'); const input = { accountId: 'a', projectId: 'p', expectedRevision: 0, entities: [mutation()] };
  await assert.rejects(compareAndSwapSyncProject({ db, limits: { maxStateBytes: 1 } }, input), /sync quota exceeded: bytes-per-project/);
  await assert.rejects(compareAndSwapSyncProject({ db, limits: { maxEntitiesPerProject: 0 } }, input), /sync quota exceeded: entities-per-project/);
  await assert.rejects(compareAndSwapSyncProject({ db }, { ...input, entities: [{ ...mutation(), payload: { apiKey: 'not-a-real-key' } }] }), /sync-safe/);
  assert.equal(await db.prepare('SELECT project_id FROM sync_projects').first(), null); db.close();
});

test('cron native HTTP contract publishes, lists and leases without requiring paid sync', async () => {
  const db = new SqliteD1(); const tokens = await account(db, 'free'); const env = environment(db); const router = app(); const headers = { Authorization: `Bearer ${tokens.session}`, 'Content-Type': 'application/json' };
  const path = `/v1/cron/projects/${PROJECT}/schedules/${SCHEDULE}`;
  const created = await router.request(path, { method: 'PUT', headers, body: JSON.stringify({ expectedVersion: 0, definition }) }, env);
  assert.equal(created.status, 201);
  const body = await created.json() as { data: { definitionHash: string; updatedAt: number } }; assert.match(body.data.definitionHash, /^[a-f0-9]{64}$/); assert.ok(body.data.updatedAt > 0);
  const listed = await router.request(`/v1/cron/projects/${PROJECT}/schedules`, { headers }, env); assert.equal(listed.status, 200); assert.equal((await listed.json() as { data: unknown[] }).data.length, 1);
  const input = { projectId: PROJECT, scheduleId: SCHEDULE, definitionVersion: 1, definitionHash: body.data.definitionHash, occurrenceAt: Date.now(), ttlMs: 1000 };
  const acquired = await router.request('/v1/cron/leases/acquire', { method: 'POST', headers, body: JSON.stringify(input) }, env); assert.equal(acquired.status, 200);
  const token = (await acquired.json() as { data: { token: string } }).data.token;
  const release = await router.request('/v1/cron/leases/release', { method: 'POST', headers, body: JSON.stringify({ ...input, token }) }, env); assert.equal(release.status, 200);
  assert.equal((await router.request(path, { method: 'PUT', headers, body: JSON.stringify({ expectedVersion: 0, definition: { ...definition, brief: 'Bearer fake-secret-material123' } }) }, env)).status, 400);
  assert.equal((await router.request('/v1/cron/leases/acquire', { method: 'POST', headers, body: '{' }, env)).status, 400);
  db.close();
});

test('team HTTP member cannot invite or remove; owner can revoke, remove and member can leave', async () => {
  const db = new SqliteD1(); const invite = await team(db, 3); const member = await account(db, 'a'); const second = await account(db, 'b'); const owner = await issueTokens(db, 'owner', 'desktop'); const router = app(); const env = environment(db);
  const request = (path: string, method: string, token: string, body?: unknown) => router.request(path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
  assert.equal((await request('/v1/team/join', 'POST', member.session, { code: invite.code })).status, 200);
  assert.equal((await request('/v1/team/invites', 'POST', member.session)).status, 403);
  assert.equal((await request('/v1/team/members/owner', 'DELETE', member.session)).status, 403);
  assert.equal((await request('/v1/team/leave', 'POST', owner.session)).status, 409);
  assert.equal((await request('/v1/team/members/a', 'DELETE', owner.session)).status, 200);
  assert.equal(await db.prepare("SELECT team_id FROM team_members WHERE account_id='a'").first(), null);
  assert.equal((await request('/v1/team/join', 'POST', second.session, { code: invite.code })).status, 200);
  assert.equal((await request('/v1/team/leave', 'POST', second.session)).status, 200);
  assert.equal((await request(`/v1/team/invites/${invite.codePrefix}`, 'DELETE', owner.session)).status, 200);
  assert.equal((await request('/v1/team/join', 'POST', member.session, { code: invite.code })).status, 409);
  db.close();
});

test('same account cannot concurrently consume two invitations into different teams', async () => {
  const db = new SqliteD1(); const first = await team(db, 3); await account(db, 'owner2'); await account(db, 'a');
  await db.batch([
    db.prepare("INSERT INTO teams(id,name,owner_account_id) VALUES('team2','Other','owner2')"),
    db.prepare("INSERT INTO team_members(team_id,account_id,role) VALUES('team2','owner2','owner')"),
    db.prepare("INSERT INTO subscriptions(id,owner_type,team_id,stripe_subscription_id,stripe_customer_id,plan,status,seats) VALUES('team2-sub','team','team2','stripe2','cus2','team','active',3)"),
  ]);
  const second = await createInvite(db, 'team2', 'owner2');
  const joined = await Promise.all([joinTeam(db, 'a', first.code), joinTeam(db, 'a', second.code)]);
  assert.equal(joined.filter((row) => row.ok).length, 1);
  assert.equal((await db.prepare('SELECT sum(used_count) AS n FROM team_invites').first<{ n: number }>())?.n, 1); db.close();
});
