import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteD1 } from './helpers/sqlite-d1.js';
import {
  environment,
  nativeLogin,
  seedAccount,
  seedSubscription,
  webLogin,
} from './helpers/fixtures.js';
import { createApp, cleanupExpired } from '../src/index.js';
const DAY = 86400000,
  START = Date.parse('2026-10-05T03:01:00Z');
const flags = {
  agentStarted: false,
  agentWorking: false,
  missionCompleted: false,
};
async function setup() {
  const db = new SqliteD1();
  await seedAccount(db, 'admin', { admin: true });
  await seedAccount(db, 'user');
  let now = START;
  const app = createApp({ now: () => now }),
    env = environment(db);
  const desktop = await nativeLogin(db, 'user'),
    admin = await webLogin(db, 'admin');
  const metrics = async () => {
    const r = await app.request('/v1/admin/activity', { headers: admin }, env);
    assert.equal(r.status, 200);
    return ((await r.json()) as { data: Record<string, any> }).data;
  };
  return {
    db,
    app,
    env,
    desktop,
    admin,
    setNow: (v: number) => {
      now = v;
    },
    post: (body: unknown = flags, headers = desktop) =>
      app.request(
        '/v1/activity',
        { method: 'POST', headers, body: JSON.stringify(body) },
        env,
      ),
    /** Pre-0012 aggregate keys only; the trial funnel depends on the real wall clock for trial windows. */
    legacy: async () => {
      const {
        trialFunnel: _funnel,
        missionsTotalCompleted: _total,
        missionsRunningNow: _running,
        ...rest
      } = await metrics();
      return rest;
    },
    metrics,
  };
}
test('activity desktop auth, access, strict flags and admin web authorization', async () => {
  const c = await setup();
  assert.equal((await c.post(flags, {})).status, 401);
  assert.equal((await c.post(flags, await webLogin(c.db, 'user'))).status, 401);
  for (const id of ['expired', 'blocked']) {
    await seedAccount(
      c.db,
      id,
      id === 'expired' ? { trialDays: -1 } : { suspended: true },
    );
    assert.equal(
      (await c.post(flags, await nativeLogin(c.db, id))).status,
      403,
    );
  }
  for (const body of [
    {},
    { ...flags, prompt: 'secret' },
    { ...flags, agentStarted: 1 },
    { ...flags, time: 123 },
  ])
    assert.equal((await c.post(body)).status, 400);
  for (const [headers, status] of [
    [{}, 401],
    [c.desktop, 401],
    [await webLogin(c.db, 'user'), 403],
  ] as const)
    assert.equal(
      (await c.app.request('/v1/admin/activity', { headers }, c.env)).status,
      status,
    );
  assert.deepEqual(await c.legacy(), {
    onlineNow: 0,
    usedToday: 0,
    used7d: 0,
    startedAgents: 0,
    completedMission: 0,
    returned: 0,
    paidAccounts: 0,
    trackedAccounts: 0,
    measuringSince: null,
  });
  c.db.close();
});
test('presence differs from use, retries deduplicate and only distinct Brazil usage days prove return', async () => {
  const c = await setup();
  assert.equal((await c.post()).status, 200);
  assert.deepEqual(await c.legacy(), {
    onlineNow: 1,
    usedToday: 0,
    used7d: 0,
    startedAgents: 0,
    completedMission: 0,
    returned: 0,
    paidAccounts: 0,
    trackedAccounts: 1,
    measuringSince: new Date(START).toISOString(),
  });
  for (let i = 0; i < 3; i++)
    await c.post({ ...flags, agentStarted: true, missionCompleted: true });
  assert.equal(
    (await c.db
      .prepare('SELECT count(*) AS n FROM account_activity_days')
      .first<{ n: number }>())!.n,
    1,
  );
  c.setNow(START + DAY - 120000);
  await c.post({ ...flags, agentWorking: true });
  assert.equal((await c.metrics()).returned, 0);
  c.setNow(START + DAY);
  await c.post({ ...flags, agentWorking: true });
  assert.deepEqual(await c.legacy(), {
    onlineNow: 1,
    usedToday: 1,
    used7d: 1,
    startedAgents: 1,
    completedMission: 1,
    returned: 1,
    paidAccounts: 0,
    trackedAccounts: 1,
    measuringSince: new Date(START).toISOString(),
  });
  c.db.close();
});
test('stale presence and seven-day windows expire; cleanup preserves return and milestones; deletion cascades', async () => {
  const c = await setup();
  await c.post({ ...flags, agentStarted: true });
  c.setNow(START + DAY);
  await c.post({ ...flags, missionCompleted: true });
  c.setNow(START + DAY + 300001);
  assert.equal((await c.metrics()).onlineNow, 0);
  c.setNow(START + 7 * DAY);
  assert.equal((await c.metrics()).used7d, 1);
  c.setNow(START + 8 * DAY);
  assert.equal((await c.metrics()).used7d, 0);
  await cleanupExpired(c.db, START + 100 * DAY);
  Object.assign(c.admin, await webLogin(c.db, 'admin'));
  c.setNow(START + 100 * DAY);
  assert.equal(
    (await c.db
      .prepare('SELECT count(*) AS n FROM account_activity_days')
      .first<{ n: number }>())!.n,
    0,
  );
  const m = await c.metrics();
  assert.equal(m.returned, 1);
  assert.equal(m.startedAgents, 1);
  assert.equal(m.completedMission, 1);
  assert.equal(m.measuringSince, new Date(START).toISOString());
  await c.db.prepare("DELETE FROM accounts WHERE id='user'").run();
  assert.equal((await c.metrics()).trackedAccounts, 0);
  assert.equal(
    (await c.db
      .prepare('SELECT count(*) AS n FROM account_activity')
      .first<{ n: number }>())!.n,
    0,
  );
  c.db.close();
});
test('authorized admins and codegrant courtesy are excluded; paid is only real active future Stripe', async () => {
  const c = await setup();
  for (const id of [
    'paid',
    'courtesy',
    'trialing',
    'pastdue',
    'ended',
    'unlisted',
  ])
    await seedAccount(
      c.db,
      id,
      id === 'unlisted' ? { admin: true, email: 'unlisted@example.test' } : {},
    );
  for (const id of ['paid', 'admin', 'courtesy'])
    await seedSubscription(c.db, id);
  await c.db
    .prepare(
      "UPDATE subscriptions SET stripe_subscription_id='codegrant:fixture:courtesy' WHERE account_id='courtesy'",
    )
    .run();
  await seedSubscription(c.db, 'trialing', { status: 'trialing' });
  await seedSubscription(c.db, 'pastdue', {
    status: 'past_due',
    graceUntil: Date.now() + DAY,
  });
  await seedSubscription(c.db, 'ended', { periodEnd: 1 });
  for (const id of ['admin', 'courtesy', 'paid', 'unlisted'])
    await c.post({ ...flags, agentStarted: true }, await nativeLogin(c.db, id));
  assert.deepEqual(await c.legacy(), {
    onlineNow: 2,
    usedToday: 2,
    used7d: 2,
    startedAgents: 2,
    completedMission: 0,
    returned: 0,
    paidAccounts: 1,
    trackedAccounts: 2,
    measuringSince: new Date(START).toISOString(),
  });
  c.db.close();
});
test('per-account limiter rejects before storing', async () => {
  const c = await setup(),
    keys: string[] = [];
  const env = environment(c.db, {
    API_RATE_LIMITER: {
      limit: async ({ key }: { key: string }) => {
        keys.push(key);
        return { success: !key.startsWith('activity:') };
      },
    },
  });
  assert.equal(
    (
      await c.app.request(
        '/v1/activity',
        { method: 'POST', headers: c.desktop, body: JSON.stringify(flags) },
        env,
      )
    ).status,
    429,
  );
  assert.deepEqual(keys, ['unknown', 'activity:user']);
  assert.equal((await c.metrics()).trackedAccounts, 0);
  c.db.close();
});
test('account list distinguishes OAuth entry from app presence', async () => {
  const c = await setup();
  await c.db
    .prepare("UPDATE accounts SET last_seen_at=? WHERE id='user'")
    .bind(START - 1000)
    .run();
  await c.post();
  const r = await c.app.request(
    '/v1/admin/accounts',
    { headers: c.admin },
    c.env,
  );
  const data = (await r.json()) as {
    data: {
      accounts: Array<{
        id: string;
        lastSeenAt: string | null;
        lastAppSeenAt: string | null;
      }>;
    };
  };
  const row = data.data.accounts.find((r) => r.id === 'user')!;
  assert.equal(row.lastSeenAt, new Date(START - 1000).toISOString());
  assert.equal(row.lastAppSeenAt, new Date(START).toISOString());
  assert.equal(
    data.data.accounts.find((r) => r.id === 'admin')!.lastAppSeenAt,
    null,
  );
  c.db.close();
});
test('retention keeps exactly 90 Brazil calendar days and account deletion removes daily usage', async () => {
  const c = await setup();
  await c.post({ ...flags, agentWorking: true });
  const day = (n: number) => new Date(n - 10800000).toISOString().slice(0, 10);
  await c.db.batch([
    c.db
      .prepare('INSERT INTO account_activity_days(account_id,day) VALUES(?,?)')
      .bind('user', day(START - 89 * DAY)),
    c.db
      .prepare('INSERT INTO account_activity_days(account_id,day) VALUES(?,?)')
      .bind('user', day(START - 90 * DAY)),
  ]);
  await cleanupExpired(c.db, START);
  assert.deepEqual(
    (
      await c.db
        .prepare('SELECT day FROM account_activity_days ORDER BY day')
        .all<{ day: string }>()
    ).results.map((r) => r.day),
    [day(START - 89 * DAY), day(START)],
  );
  await c.db.prepare("DELETE FROM accounts WHERE id='user'").run();
  assert.equal(
    (await c.db
      .prepare('SELECT count(*) AS n FROM account_activity_days')
      .first<{ n: number }>())!.n,
    0,
  );
  c.db.close();
});

test('only current courtesy without real active Stripe is excluded from activation', async () => {
  const c = await setup();
  const ids = [
    'expired-paid',
    'concurrent-paid',
    'expired-grant',
    'current-grant',
    'grace-grant',
    'revoked-grant',
  ];
  for (const id of ids) {
    await seedAccount(c.db, id);
    const current = [
      'concurrent-paid',
      'current-grant',
      'revoked-grant',
    ].includes(id);
    await c.db
      .prepare(
        `INSERT INTO subscriptions(id,owner_type,account_id,stripe_subscription_id,stripe_customer_id,plan,status,current_period_end,grace_until)
      VALUES(?,'account',?,?,?,'pro',?,?,?)`,
      )
      .bind(
        `grant-${id}`,
        id,
        `codegrant:fixture:${id}`,
        `cus_${id}`,
        id === 'revoked-grant'
          ? 'canceled'
          : id === 'grace-grant'
            ? 'past_due'
            : 'active',
        current ? START + DAY : START - DAY,
        id === 'grace-grant' ? START + DAY : null,
      )
      .run();
    if (id.endsWith('-paid'))
      await seedSubscription(c.db, id, { periodEnd: START + DAY });
    assert.equal(
      (
        await c.post(
          { ...flags, agentStarted: true },
          await nativeLogin(c.db, id),
        )
      ).status,
      200,
    );
  }
  assert.deepEqual(await c.legacy(), {
    onlineNow: 4,
    usedToday: 4,
    used7d: 4,
    startedAgents: 4,
    completedMission: 0,
    returned: 0,
    paidAccounts: 2,
    trackedAccounts: 4,
    measuringSince: new Date(START).toISOString(),
  });
  c.db.close();
});

test('real active team membership overrides courtesy and counts each account once', async () => {
  const c = await setup();
  for (const id of ['team-owner', 'team-member']) {
    await seedAccount(c.db, id);
    await seedSubscription(c.db, id);
    await c.db
      .prepare(
        'UPDATE subscriptions SET stripe_subscription_id=? WHERE account_id=?',
      )
      .bind(`codegrant:fixture:${id}`, id)
      .run();
    await c.post({ ...flags, agentStarted: true }, await nativeLogin(c.db, id));
  }
  await c.db
    .prepare(
      "INSERT INTO teams(id,name,owner_account_id) VALUES('paid-team','Private team','team-owner')",
    )
    .run();
  await c.db.batch(
    ['team-owner', 'team-member'].map((id) =>
      c.db
        .prepare(
          'INSERT INTO team_members(team_id,account_id,role) VALUES(?,?,?)',
        )
        .bind('paid-team', id, id === 'team-owner' ? 'owner' : 'member'),
    ),
  );
  await c.db
    .prepare(
      `INSERT INTO subscriptions(id,owner_type,team_id,stripe_subscription_id,stripe_customer_id,plan,status,current_period_end)
    VALUES('team-sub','team','paid-team','sub_team','cus_team','team','active',?)`,
    )
    .bind(START + DAY)
    .run();
  const metrics = await c.metrics();
  assert.equal(metrics.paidAccounts, 2);
  assert.equal(metrics.trackedAccounts, 2);
  assert.equal(metrics.usedToday, 2);
  c.db.close();
});

test('trial engagement: counters, running state, strict bounds and trial-only funnel', async () => {
  const c = await setup();
  for (const body of [
    { ...flags, missionsStarted: 51 },
    { ...flags, missionsCompleted: -1 },
    { ...flags, missionsStarted: 1.5 },
    { ...flags, missionRunning: 'yes' },
  ])
    assert.equal((await c.post(body)).status, 400);
  await c.db
    .prepare("UPDATE accounts SET last_seen_at=? WHERE id='user'")
    .bind(START - 1000)
    .run();
  // Running mission: productive signal, no completion yet.
  await c.post({ ...flags, missionRunning: true, missionsStarted: 2 });
  const row = () =>
    c.db
      .prepare('SELECT * FROM account_activity WHERE account_id=?')
      .bind('user')
      .first<Record<string, number | null>>();
  let r = (await row())!;
  assert.equal(r.last_active_at, START);
  assert.equal(r.last_mission_at, START);
  assert.equal(r.first_mission_at, null);
  assert.deepEqual(
    [r.missions_started_count, r.missions_completed_count, r.last_mission_running, r.last_agent_working],
    [2, 0, 1, 0],
  );
  let m = await c.metrics();
  assert.equal(m.completedMission, 0);
  assert.equal(m.missionsRunningNow, 1);
  assert.deepEqual(m.trialFunnel, {
    totalTrial: 1, loggedIn: 1, openedApp: 1, usedSystem: 1, ranMissions: 1,
    activeToday: 1, active7d: 1, onlineNow: 1,
  });
  // Legacy payload still counts one started + one completed; running flag is overwritten.
  c.setNow(START + 60_000);
  await c.post({ ...flags, missionCompleted: true });
  await c.post({ ...flags, missionsCompleted: 3 });
  r = (await row())!;
  assert.deepEqual(
    [r.missions_started_count, r.missions_completed_count, r.last_mission_running],
    [3, 4, 0],
  );
  // The first completion, and only it, sets the milestone.
  assert.equal(r.first_mission_at, START + 60_000);
  // A presence-only post must not move last_active_at.
  await c.post();
  assert.equal((await row())!.last_active_at, START + 60_000);
  m = await c.metrics();
  assert.equal(m.completedMission, 1);
  assert.equal(m.missionsTotalCompleted, 4);
  assert.equal(m.missionsRunningNow, 0);
  // Courtesy / admin accounts stay out of the trial funnel.
  assert.equal(m.trialFunnel.totalTrial, 1);
  await seedSubscription(c.db, 'user');
  assert.equal((await c.metrics()).trialFunnel.totalTrial, 0);
  c.db.close();
});

test('a started or running mission is mission activity, but only a completion is the completedMission milestone', async () => {
  const c = await setup();
  const row = () =>
    c.db
      .prepare('SELECT * FROM account_activity WHERE account_id=?')
      .bind('user')
      .first<Record<string, number | null>>();
  const listed = async () => {
    const r = await c.app.request('/v1/admin/accounts', { headers: c.admin }, c.env);
    assert.equal(r.status, 200);
    const body = (await r.json()) as {
      data: { accounts: Array<{ id: string; engagementStage: string; firstMissionAt: string | null; lastMissionAt: string | null }> };
    };
    return body.data.accounts.find((a) => a.id === 'user')!;
  };
  // Presence only: nothing about missions yet.
  await c.post();
  assert.equal((await listed()).engagementStage, 'app_only');
  assert.equal((await c.metrics()).trialFunnel.ranMissions, 0);
  // One mission started and is running; none completed.
  c.setNow(START + 60_000);
  await c.post({ ...flags, missionRunning: true, missionsStarted: 1 });
  let r = (await row())!;
  assert.equal(r.first_mission_at, null);
  assert.equal(r.last_mission_at, START + 60_000);
  assert.equal(r.missions_started_count, 1);
  assert.equal(r.missions_completed_count, 0);
  let m = await c.metrics();
  assert.equal(m.completedMission, 0);
  assert.equal(m.trialFunnel.ranMissions, 1);
  let account = await listed();
  assert.equal(account.engagementStage, 'mission_active');
  assert.equal(account.firstMissionAt, null);
  assert.equal(account.lastMissionAt, new Date(START + 60_000).toISOString());
  // The next heartbeat of the same running mission moves last_mission_at, never the milestone.
  c.setNow(START + 120_000);
  await c.post({ ...flags, missionRunning: true });
  r = (await row())!;
  assert.equal(r.first_mission_at, null);
  assert.equal(r.last_mission_at, START + 120_000);
  assert.equal((await c.metrics()).completedMission, 0);
  // The first completion sets the milestone; a later one does not move it.
  c.setNow(START + 180_000);
  await c.post({ ...flags, missionCompleted: true });
  c.setNow(START + 240_000);
  await c.post({ ...flags, missionCompleted: true });
  r = (await row())!;
  assert.equal(r.first_mission_at, START + 180_000);
  assert.equal(r.last_mission_at, START + 240_000);
  m = await c.metrics();
  assert.equal(m.completedMission, 1);
  assert.equal((await listed()).firstMissionAt, new Date(START + 180_000).toISOString());
  c.db.close();
});

test('a delayed heartbeat cannot overwrite the newer working and running state', async () => {
  const c = await setup();
  const state = async () => ({
    ...(await c.db
      .prepare('SELECT last_app_seen_at,last_agent_working,last_mission_running FROM account_activity WHERE account_id=?')
      .bind('user')
      .first<Record<string, number>>())!,
  });
  c.setNow(START + 60_000);
  await c.post({ ...flags, agentWorking: true, missionRunning: true, missionsStarted: 1 });
  // Processed late: its timestamp is older than what is already stored.
  c.setNow(START);
  assert.equal((await c.post()).status, 200);
  assert.deepEqual(await state(), { last_app_seen_at: START + 60_000, last_agent_working: 1, last_mission_running: 1 });
  // The same instant is not stale: the report processed last wins.
  c.setNow(START + 60_000);
  await c.post();
  assert.deepEqual(await state(), { last_app_seen_at: START + 60_000, last_agent_working: 0, last_mission_running: 0 });
  // A genuinely newer heartbeat can turn the state back on.
  c.setNow(START + 120_000);
  await c.post({ ...flags, agentWorking: true });
  assert.deepEqual(await state(), { last_app_seen_at: START + 120_000, last_agent_working: 1, last_mission_running: 0 });
  c.db.close();
});

test('a retried delivery never counts its missions twice, even when the retry is wider', async () => {
  const c = await setup();
  const counts = async () =>
    (await c.db
      .prepare('SELECT missions_started_count AS s,missions_completed_count AS d FROM account_activity WHERE account_id=?')
      .bind('user')
      .first<{ s: number; d: number }>())!;
  const post = (deliveryId: string, missionsStarted: number, missionsCompleted: number) =>
    c.post({ ...flags, missionsStarted, missionsCompleted, deliveryId });
  assert.equal((await post('stream1:0-2:0-1', 2, 1)).status, 200);
  // The response was lost: the client resends the same range.
  assert.equal((await post('stream1:0-2:0-1', 2, 1)).status, 200);
  assert.deepEqual(await counts(), { s: 2, d: 1 });
  // Resent wider after one more completion: only the unapplied delta lands.
  assert.equal((await post('stream1:0-2:0-2', 2, 2)).status, 200);
  assert.deepEqual(await counts(), { s: 2, d: 2 });
  // The next range of the same stream continues from the acknowledged sequence.
  assert.equal((await post('stream1:2-3:2-2', 1, 0)).status, 200);
  assert.deepEqual(await counts(), { s: 3, d: 2 });
  // A new stream (app restart or another login) counts in full; an opaque key is its own stream.
  assert.equal((await post('stream2:0-1:0-0', 1, 0)).status, 200);
  assert.equal((await post('req-123', 1, 0)).status, 200);
  assert.equal((await post('req-123', 1, 0)).status, 200);
  assert.deepEqual(await counts(), { s: 5, d: 2 });
  // Without deliveryId the counters keep adding, and a range that disagrees with the counts is refused.
  assert.equal((await c.post({ ...flags, missionsStarted: 1 })).status, 200);
  assert.deepEqual(await counts(), { s: 6, d: 2 });
  assert.equal((await post('stream1:0-5:0-0', 1, 0)).status, 400);
  assert.deepEqual(await counts(), { s: 6, d: 2 });
  c.db.close();
});

test('interleaved streams from two devices keep independent watermarks and never double count', async () => {
  const c = await setup();
  const counts = async () =>
    (await c.db
      .prepare('SELECT missions_started_count AS s,missions_completed_count AS d FROM account_activity WHERE account_id=?')
      .bind('user')
      .first<{ s: number; d: number }>())!;
  const post = (deliveryId: string, missionsStarted: number, missionsCompleted: number) =>
    c.post({ ...flags, missionsStarted, missionsCompleted, deliveryId });
  assert.equal((await post('streamA:0-1:0-0', 1, 0)).status, 200);
  assert.deepEqual(await counts(), { s: 1, d: 0 });
  assert.equal((await post('streamB:0-1:0-0', 1, 0)).status, 200);
  assert.deepEqual(await counts(), { s: 2, d: 0 });
  // Device A retries after device B wrote: its own watermark still dedups.
  assert.equal((await post('streamA:0-1:0-0', 1, 0)).status, 200);
  assert.deepEqual(await counts(), { s: 2, d: 0 });
  assert.equal((await post('opaque1', 0, 1)).status, 200);
  assert.equal((await post('opaque1', 0, 1)).status, 200);
  assert.deepEqual(await counts(), { s: 2, d: 1 });
  // Device A resends wider: only the unapplied delta lands.
  assert.equal((await post('streamA:0-2:0-1', 2, 1)).status, 200);
  assert.deepEqual(await counts(), { s: 3, d: 2 });
  assert.equal((await post('streamB:0-1:0-0', 1, 0)).status, 200);
  assert.deepEqual(await counts(), { s: 3, d: 2 });
  c.db.close();
});

test('an older or inactive heartbeat never moves last_active_at and last_mission_at backwards', async () => {
  const c = await setup();
  const times = async () =>
    (await c.db
      .prepare('SELECT last_active_at AS a,last_mission_at AS m FROM account_activity WHERE account_id=?')
      .bind('user')
      .first<{ a: number; m: number }>())!;
  c.setNow(START + 120_000);
  await c.post({ ...flags, agentWorking: true, missionRunning: true });
  assert.deepEqual(await times(), { a: START + 120_000, m: START + 120_000 });
  // Processed late with an older timestamp.
  c.setNow(START + 60_000);
  await c.post({ ...flags, agentWorking: true, missionRunning: true });
  assert.deepEqual(await times(), { a: START + 120_000, m: START + 120_000 });
  // An exact retry carries no new mission and no running mission: the mission clock stays put.
  c.setNow(START + 180_000);
  await c.post({ ...flags, missionsCompleted: 1, deliveryId: 's:0-0:0-1' });
  assert.equal((await times()).m, START + 180_000);
  c.setNow(START + 240_000);
  await c.post({ ...flags, agentWorking: true, missionsCompleted: 1, deliveryId: 's:0-0:0-1' });
  assert.deepEqual(await times(), { a: START + 240_000, m: START + 180_000 });
  c.db.close();
});

test('an idle second device never clears another device\'s running mission or working agent', async () => {
  const c = await setup();
  const now = START + 1000;
  c.setNow(now);
  await c.post({ ...flags, agentWorking: true, missionRunning: true, deliveryId: 'streamA:0-0:0-0' });
  c.setNow(now + 30_000);
  await c.post({ ...flags, missionRunning: false, deliveryId: 'streamB:0-0:0-0' });
  let m = await c.metrics();
  assert.equal(m.missionsRunningNow, 1);
  const working = async () => (await c.db.prepare('SELECT last_agent_working AS w FROM account_activity WHERE account_id=?').bind('user').first<{ w: number }>())!.w;
  assert.equal(await working(), 1);
  c.setNow(now + 60_000);
  await c.post({ ...flags, missionRunning: false, deliveryId: 'streamA:0-0:0-0' });
  m = await c.metrics();
  assert.equal(m.missionsRunningNow, 0);
  assert.equal(await working(), 0);
});

test('120 distinct streams keep their watermarks: a retry of the first stream adds nothing', async () => {
  const c = await setup();
  const id = (i: number) => `${String(i).padStart(16, '0')}:0-1:0-0`;
  for (let i = 0; i < 120; i++) assert.equal((await c.post({ ...flags, missionsStarted: 1, deliveryId: id(i) })).status, 200);
  assert.equal((await c.post({ ...flags, missionsStarted: 1, deliveryId: id(0) })).status, 200);
  const row = await c.db.prepare('SELECT missions_started_count AS s FROM account_activity WHERE account_id=?').bind('user').first<{ s: number }>();
  assert.equal(row!.s, 120);
});
