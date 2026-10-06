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
    metrics: async () => {
      const r = await app.request(
        '/v1/admin/activity',
        { headers: admin },
        env,
      );
      assert.equal(r.status, 200);
      return ((await r.json()) as { data: Record<string, any> }).data;
    },
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
  assert.deepEqual(await c.metrics(), {
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
  assert.deepEqual(await c.metrics(), {
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
  assert.deepEqual(await c.metrics(), {
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
  assert.deepEqual(await c.metrics(), {
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
  assert.deepEqual(await c.metrics(), {
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
