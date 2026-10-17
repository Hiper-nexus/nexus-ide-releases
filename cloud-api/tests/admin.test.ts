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
  assert.deepEqual(Object.keys(byId.paid).sort(), ['access', 'activeDays30d', 'activeDays7d', 'agentWorkingNow', 'createdAt', 'email', 'engagementStage', 'firstAgentAt', 'firstAppSeenAt', 'firstMissionAt', 'id', 'lastActiveAt', 'lastAppSeenAt', 'lastMissionAt', 'lastSeenAt', 'missionRunningNow', 'missionsCompletedCount', 'missionsStartedCount', 'name', 'onlineNow', 'role', 'subscriptionStatus', 'suspendedAt', 'suspensionReason', 'trialEndsAt', 'trialStartedAt']);
  assert.equal(byId.paid.engagementStage, 'never_seen');
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

test('account list exposes engagement stage, live flags and filters by engagement', async () => {
  const context = await setup();
  const now = Date.now(), day = (offset: number) => new Date(now - offset * DAY_MS - 3 * 3_600_000).toISOString().slice(0, 10);
  for (const id of ['mission', 'using', 'appOnly', 'webOnly']) await seedAccount(context.db, id);
  await context.db.batch([
    context.db.prepare("UPDATE accounts SET last_seen_at=? WHERE id IN ('webOnly','appOnly')").bind(now - 5000),
    context.db.prepare('INSERT INTO account_activity(account_id,first_app_seen_at,last_app_seen_at,first_agent_at,first_mission_at,last_active_at,last_mission_at,missions_started_count,missions_completed_count,last_agent_working,last_mission_running) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .bind('mission', now - DAY_MS, now - 1000, now - DAY_MS, now - DAY_MS, now - 1000, now - 1000, 3, 2, 1, 1),
    context.db.prepare('INSERT INTO account_activity(account_id,first_app_seen_at,last_app_seen_at,first_agent_at,last_active_at) VALUES(?,?,?,?,?)')
      .bind('using', now - 9 * DAY_MS, now - 600_000, now - 9 * DAY_MS, now - 9 * DAY_MS),
    context.db.prepare('INSERT INTO account_activity(account_id,first_app_seen_at,last_app_seen_at) VALUES(?,?,?)').bind('appOnly', now - DAY_MS, now - 1000),
    ...[0, 1, 2, 10].map(offset => context.db.prepare('INSERT INTO account_activity_days(account_id,day) VALUES(?,?)').bind('mission', day(offset))),
    context.db.prepare('INSERT INTO account_activity_days(account_id,day) VALUES(?,?)').bind('using', day(9)),
  ]);
  const list = async (query = '') => (await json(await context.get(`/v1/admin/accounts?limit=50${query}`))).data!.accounts as Record<string, any>[];
  const byId = Object.fromEntries((await list()).map(row => [row.id, row]));
  assert.deepEqual(['mission', 'using', 'appOnly', 'webOnly', 'trial'].map(id => byId[id].engagementStage), ['mission_active', 'using_system', 'app_only', 'web_only', 'never_seen']);
  assert.deepEqual([byId.mission.onlineNow, byId.mission.agentWorkingNow, byId.mission.missionRunningNow, byId.mission.activeDays7d, byId.mission.activeDays30d, byId.mission.missionsStartedCount, byId.mission.missionsCompletedCount], [true, true, true, 3, 4, 3, 2]);
  assert.deepEqual([byId.using.onlineNow, byId.using.agentWorkingNow, byId.using.activeDays7d, byId.using.activeDays30d], [false, false, 0, 1]);
  assert.equal(byId.mission.lastMissionAt, new Date(now - 1000).toISOString());
  const ids = async (query: string) => (await list(query)).map(row => row.id).sort();
  assert.deepEqual(await ids('&engagement=mission_active'), ['mission']);
  assert.deepEqual(await ids('&engagement=using_system'), ['using']);
  assert.deepEqual(await ids('&engagement=app_only'), ['appOnly']);
  assert.deepEqual(await ids('&engagement=web_only'), ['webOnly']);
  assert.deepEqual(await ids('&engagement=inactive'), ['admin', 'appOnly', 'blocked', 'expired', 'paid', 'trial', 'using', 'webOnly']);
  assert.equal((await list('&engagement=all')).length, 9);
  assert.equal((await context.get('/v1/admin/accounts?engagement=bogus')).status, 400);
  context.db.close();
});

// ---- Financeiro (/v1/admin/finance) -------------------------------------------------------------------------------

const brazilDate = (ms: number) => new Date(ms - 3 * 3_600_000).toISOString().slice(0, 10);

/** Carteira com todos os casos do contrato: ciclos, cupom, atraso, cancelada, vencida, cortesia, eventos. */
async function financeSetup() {
  const context = await setup();
  const { db } = context;
  const now = Date.now(), ago = (days: number) => now - days * DAY_MS;
  for (const id of ['q', 's', 'y', 'co', 'ca', 'pd', 'lapsed', 'cg']) await seedAccount(db, id, { trialDays: -1 });
  await seedAccount(db, 'cn'); // cancelada, mas o teste ainda corre
  const add = (account: string, o: { interval: string | null; status?: string; seats?: number; end?: number | null; grace?: number | null; created: number }) => db.prepare(
    "INSERT INTO subscriptions(id,owner_type,account_id,stripe_subscription_id,stripe_customer_id,plan,status,seats,current_period_end,grace_until,created_at,updated_at,billing_interval) VALUES(?,'account',?,?,?,'pro',?,?,?,?,?,?,?)")
    .bind(`row-${account}`, account, account === 'cg' ? 'codegrant:code1:cg' : `sub_${account}`, `cus_${account}`, o.status ?? 'active', o.seats ?? 1, o.end === undefined ? now + 30 * DAY_MS : o.end, o.grace ?? null, o.created, o.created, o.interval);
  await db.batch([
    db.prepare("UPDATE subscriptions SET created_at=?1,updated_at=?1 WHERE account_id='paid'").bind(ago(100)), // legada: billing_interval nulo
    add('q', { interval: 'quarter', created: ago(100) }),
    add('s', { interval: 'semiannual', created: ago(101) }),
    add('y', { interval: 'year', seats: 2, created: ago(5) }),
    add('co', { interval: 'month', created: ago(2) }),
    add('ca', { interval: 'quarter', created: ago(60) }),
    add('pd', { interval: 'month', status: 'past_due', end: now + 5 * DAY_MS, grace: now + 3 * DAY_MS, created: ago(3) }),
    add('cn', { interval: 'quarter', status: 'canceled', created: ago(10) }),
    add('lapsed', { interval: 'month', end: now - DAY_MS, created: ago(150) }),
    add('cg', { interval: null, end: null, created: ago(5) }),
    db.prepare("INSERT INTO discount_coupons(id,code,kind,value,intervals,created_at,updated_at) VALUES('c-pct','PCT10','percent',10,'[\"month\"]',?1,?1),('c-amt','AMT10','amount',1000,'[\"quarter\"]',?1,?1)").bind(ago(200)),
    db.prepare("INSERT INTO coupon_redemptions(id,coupon_id,account_id,interval,stripe_subscription_id,created_at) VALUES('r1','c-pct','co','month','sub_co',?),('r2','c-amt','ca','quarter','sub_ca',?),('r3','c-pct','trial','month','sub_gone',?)").bind(ago(2), ago(60), ago(400)),
    db.prepare("INSERT INTO stripe_events(event_id,type,processed_at,payload,created_at) VALUES('e1','invoice.paid',?,?,?),('e2','customer.subscription.updated',?,?,?),('e3','invoice.paid',NULL,?,?),('e4','invoice.paid',?,?,?),('e5','checkout.session.completed',?,?,?)")
      .bind(ago(2), '{"subscription":"sub_co"}', ago(2), ago(1), '{"subscription":"sub_pd","ignored":"foreign-price"}', ago(1), '{"subscription":"sub_q"}', now - 1000, ago(60), '{"subscription":null}', ago(60), ago(400), '{}', ago(400)),
    ...[['paid', 0], ['q', 0], ['paid', 1], ['admin', 0]].map(([account, offset]) => db.prepare('INSERT INTO account_activity_days(account_id,day) VALUES(?,?)').bind(account, brazilDate(now - (offset as number) * DAY_MS))),
  ]);
  const finance = async (query = '') => { const response = await context.get(`/v1/admin/finance${query}`); assert.equal(response.status, 200); return (await json(response)).data as Record<string, any>; };
  return { ...context, now, ago, finance };
}

test('finance refuses visitors, native sessions and non-admins, and rejects an unknown period', async () => {
  const context = await setup();
  assert.equal((await context.get('/v1/admin/finance', { Origin: 'https://nexuside.app' })).status, 401);
  assert.equal((await context.get('/v1/admin/finance', await nativeLogin(context.db, 'admin'))).status, 401);
  for (const id of ['trial', 'paid', 'blocked']) {
    const headers = await webLogin(context.db, id);
    assert.equal((await context.get('/v1/admin/finance', headers)).status, 403, id);
    assert.equal((await context.get('/v1/admin/overview?include=finance', headers)).status, 403, id);
  }
  for (const period of ['', '1d', '30D', '365d', 'toString', '7d,30d']) {
    for (const path of [`/v1/admin/finance?period=${period}`, `/v1/admin/overview?include=finance&period=${period}`]) {
      const response = await context.get(path);
      assert.equal(response.status, 400, path);
      assert.deepEqual(await response.json(), { ok: false, error: 'invalid_query', message: 'Período financeiro inválido.' }, path);
    }
  }
  // Sem include=finance o período nem é lido: a visão geral continua sendo só a contagem de contas.
  assert.equal((await context.get('/v1/admin/overview?period=bogus')).status, 200);
  context.db.close();
});

test('finance windows follow the Brazil day and an empty book reports zeros', async () => {
  const db = new SqliteD1();
  await seedAccount(db, 'admin', { admin: true });
  const app = createApp(), env = environment(db), admin = await webLogin(db, 'admin');
  const get = async (period?: string) => (await json(await app.request(`/v1/admin/finance${period ? `?period=${period}` : ''}`, { headers: admin }, env))).data as Record<string, any>;
  for (const [period, days] of [[undefined, 30], ['7d', 7], ['30d', 30], ['90d', 90], ['12m', 365]] as const) {
    const data = await get(period);
    const asOf = Date.parse(data.asOf);
    assert.equal(data.currency, 'BRL');
    assert.deepEqual(data.period, { key: period ?? '30d', days, from: brazilDate(asOf - (days - 1) * DAY_MS), to: brazilDate(asOf), timeZone: 'America/Sao_Paulo' }, String(period));
    assert.equal(data.series.length, days);
    assert.equal(data.series[0].day, data.period.from);
    assert.equal(data.series.at(-1).day, data.period.to);
    assert.deepEqual(Object.keys(data.series[0]), ['day', 'newSubscriptions', 'newPaidSubscriptions', 'webhookEvents', 'invoicePaidEvents', 'newAccounts', 'activeAccounts', 'estimatedNewMrrCents']);
  }
  const data = await get();
  assert.deepEqual(data.kpis, { mrrCents: 0, arrCents: 0, grossCommitmentCents: 0, netCommitmentCents: 0, paidActiveSubscriptions: 0, paidActiveSeats: 0, pastDueSubscriptions: 0, pastDueAtRiskCents: 0, canceledSubscriptions: 0, codeGrantActive: 0, couponRedemptionsTotal: 0, couponRedemptionsInPeriod: 0, estimatedDiscountCents: 0, trialConversionRatePct: 0 });
  assert.deepEqual(data.byInterval.map((row: any) => [row.interval, row.label, row.months, row.catalogPriceCents, row.monthlyEquivalentCents, row.activeCount, row.sharePct]),
    [['month', 'Mensal', 1, 5999, 5999, 0, 0], ['quarter', 'Trimestral', 3, 17997, 5999, 0, 0], ['semiannual', 'Semestral', 6, 35994, 5999, 0, 0], ['year', 'Anual', 12, 71988, 5999, 0, 0]]);
  assert.deepEqual(data.walletBreakdown.map((row: any) => [row.key, row.label, row.count, row.sharePct]),
    [['paid', 'Assinantes Pagos (Stripe)', 0, 0], ['trial', 'Em Teste (Trial)', 0, 0], ['courtesy', 'Cortesia / Licença', 0, 0], ['past_due', 'Em Atraso (Grace)', 0, 0], ['expired', 'Expirados / Inativos', 0, 0]]);
  assert.deepEqual([data.entries, data.recentWebhookEvents], [[], []]);
  assert.equal(data.reportSummary.basisNote, 'Receita recorrente mensal (MRR) calculada pelo catálogo oficial (R$ 59,99/mês equivalente) sobre assinaturas Stripe pagas ativas vigentes; cupons (duration: once) reduzem apenas o compromisso líquido do primeiro ciclo enquanto ele não vence. Eventos invoice.paid refletem confirmações de webhook processadas no banco (sem ledger de valores por fatura).');
  db.close();
});

test('finance KPIs count only active Stripe subscriptions in MRR and split every cycle', async () => {
  const context = await financeSetup();
  const data = await context.finance('?period=30d');
  // Ativas vigentes: paid (legada = mensal), q, s, y (2 assentos), co, ca. Fora: past_due, cancelada, vencida e cortesia.
  assert.deepEqual(data.kpis, {
    mrrCents: 41_993, arrCents: 503_916, grossCommitmentCents: 227_962, netCommitmentCents: 226_362,
    paidActiveSubscriptions: 6, paidActiveSeats: 7, pastDueSubscriptions: 1, pastDueAtRiskCents: 5999, canceledSubscriptions: 1, codeGrantActive: 1,
    couponRedemptionsTotal: 3, couponRedemptionsInPeriod: 1, estimatedDiscountCents: 1600, trialConversionRatePct: 54.5,
  });
  assert.deepEqual(data.byInterval.map((row: any) => ({ ...row, label: undefined })), [
    { interval: 'month', months: 1, catalogPriceCents: 5999, monthlyEquivalentCents: 5999, activeCount: 2, seats: 2, mrrCents: 11_998, arrCents: 143_976, grossCommitmentCents: 11_998, sharePct: 28.6 },
    { interval: 'quarter', months: 3, catalogPriceCents: 17_997, monthlyEquivalentCents: 5999, activeCount: 2, seats: 2, mrrCents: 11_998, arrCents: 143_976, grossCommitmentCents: 35_994, sharePct: 28.6 },
    { interval: 'semiannual', months: 6, catalogPriceCents: 35_994, monthlyEquivalentCents: 5999, activeCount: 1, seats: 1, mrrCents: 5999, arrCents: 71_988, grossCommitmentCents: 35_994, sharePct: 14.3 },
    { interval: 'year', months: 12, catalogPriceCents: 71_988, monthlyEquivalentCents: 5999, activeCount: 1, seats: 2, mrrCents: 11_998, arrCents: 143_976, grossCommitmentCents: 143_976, sharePct: 28.6 },
  ].map(row => ({ ...row, label: undefined })));
  assert.deepEqual(data.byInterval.map((row: any) => row.label), ['Mensal', 'Trimestral', 'Semestral', 'Anual']);
  // MRR líquido de cupom: 41.993 bruto - 600 (10% mensal) - 333 (R$ 10 em ciclo trimestral). Conversão = pagas / contas com teste já resolvido (11).
  // 13 contas fora o admin; o suspenso sem pagar conta como inativo.
  assert.deepEqual(data.walletBreakdown.map((row: any) => [row.key, row.count, row.sharePct]), [['paid', 6, 46.2], ['trial', 2, 15.4], ['courtesy', 1, 7.7], ['past_due', 1, 7.7], ['expired', 3, 23.1]]);
  context.db.close();
});

test('finance entries carry cycle, coupon discount and ordering; the report nets the discount by month', async () => {
  const context = await financeSetup();
  const data = await context.finance();
  const entries = data.entries as Record<string, any>[];
  assert.deepEqual(entries.map(entry => entry.accountId), ['co', 'pd', 'cg', 'y', 'cn', 'ca', 'paid', 'q', 's', 'lapsed']);
  const by = Object.fromEntries(entries.map(entry => [entry.accountId, entry]));
  assert.deepEqual(Object.keys(by.co), ['id', 'stripeSubscriptionId', 'kind', 'source', 'customerEmail', 'customerName', 'accountId', 'plan', 'interval', 'intervalLabel', 'status', 'seats', 'catalogAmountCents', 'mrrContributionCents', 'couponCode', 'discountCents', 'netCommitmentCents', 'periodEnd', 'graceUntil', 'createdAt', 'updatedAt']);
  assert.deepEqual(
    { ...by.co, id: undefined, periodEnd: undefined, createdAt: undefined, updatedAt: undefined },
    { id: undefined, stripeSubscriptionId: 'sub_co', kind: 'subscription', source: 'stripe', customerEmail: 'co@example.test', customerName: 'Name co', accountId: 'co', plan: 'pro', interval: 'month', intervalLabel: 'Mensal', status: 'active', seats: 1, catalogAmountCents: 5999, mrrContributionCents: 5999, couponCode: 'PCT10', discountCents: 600, netCommitmentCents: 5399, periodEnd: undefined, graceUntil: null, createdAt: undefined, updatedAt: undefined });
  assert.deepEqual([by.ca.couponCode, by.ca.discountCents, by.ca.netCommitmentCents, by.ca.catalogAmountCents, by.ca.mrrContributionCents, by.ca.intervalLabel], ['AMT10', 1000, 16_997, 17_997, 5999, 'Trimestral']);
  assert.deepEqual([by.y.seats, by.y.catalogAmountCents, by.y.mrrContributionCents, by.y.intervalLabel], [2, 143_976, 11_998, 'Anual']);
  assert.deepEqual([by.paid.interval, by.paid.intervalLabel, by.paid.couponCode, by.paid.discountCents, by.paid.netCommitmentCents], ['month', 'Mensal', null, 0, 5999]);
  assert.deepEqual([by.cg.source, by.cg.stripeSubscriptionId, by.cg.interval, by.cg.intervalLabel, by.cg.catalogAmountCents, by.cg.mrrContributionCents, by.cg.netCommitmentCents, by.cg.periodEnd], ['code_grant', 'codegrant:code1:cg', null, 'Cortesia', 0, 0, 0, null]);
  assert.deepEqual([by.pd.status, by.pd.mrrContributionCents, by.pd.graceUntil === null], ['past_due', 5999, false]);
  assert.equal(by.cn.status, 'canceled');
  assert.equal(by.co.createdAt, by.co.updatedAt);
  assert.equal(typeof by.co.periodEnd, 'string');
  // Bruto 41.993 - desconto mensal (600 + 1000/3 = 933) = líquido 41.060; o compromisso do ciclo fica nos KPIs.
  assert.deepEqual(data.reportSummary, {
    basisNote: data.reportSummary.basisNote,
    grossRecurringMrrCents: 41_993, estimatedCouponDiscountCents: 1600, netRecurringMrrCents: 41_993, projectedArrCents: 503_916,
    grossCommitmentCents: 227_962, netCommitmentCents: 226_362, pastDueAtRiskCents: 5999,
    totalAccounts: 13, activeTrialAccounts: 2, paidAccounts: 6, courtesyAccounts: 1, pastDueAccounts: 1, canceledSubscriptions: 1,
    couponRedemptionsTotal: 3, couponRedemptionsInPeriod: 1, webhookEventsInPeriod: 3, invoicePaidEventsInPeriod: 2,
  });
  context.db.close();
});

test('finance series places subscriptions, events, accounts and activity on their Brazil day', async () => {
  const context = await financeSetup();
  const data = await context.finance('?period=30d');
  const at = (days: number) => data.series.find((point: any) => point.day === brazilDate(context.now - days * DAY_MS));
  const picked = (point: any) => [point.newSubscriptions, point.newPaidSubscriptions, point.estimatedNewMrrCents];
  assert.deepEqual(picked(at(2)), [1, 1, 5999]); // co: MRR de catálogo; o cupom once só reduz o compromisso
  assert.deepEqual(picked(at(3)), [1, 0, 0]); // pd: em atraso não é assinatura paga nova
  assert.deepEqual(picked(at(5)), [2, 1, 11_998]); // cortesia entra como assinatura nova, mas não como paga
  assert.deepEqual(picked(at(10)), [1, 0, 0]); // cn: cancelada
  assert.equal(data.series.reduce((total: number, point: any) => total + point.newSubscriptions, 0), 5);
  assert.deepEqual([at(2), at(1), data.series.at(-1)].map(point => [point.webhookEvents, point.invoicePaidEvents]), [[1, 1], [1, 0], [1, 1]]);
  assert.equal(data.series.reduce((total: number, point: any) => total + point.webhookEvents, 0), 3);
  assert.equal(data.series.reduce((total: number, point: any) => total + point.newAccounts, 0), 13);
  assert.deepEqual([data.series.at(-1).activeAccounts, at(1).activeAccounts], [2, 1]); // o admin não conta
  context.db.close();
});

test('finance period changes the window for coupons and webhooks but not the book', async () => {
  const context = await financeSetup();
  const expected: Record<string, [number, number, number, number]> = { '7d': [1, 3, 2, 7], '30d': [1, 3, 2, 30], '90d': [2, 4, 3, 90], '12m': [2, 4, 3, 365] };
  for (const [period, [coupons, events, paid, length]] of Object.entries(expected)) {
    const data = await context.finance(`?period=${period}`);
    assert.deepEqual([data.kpis.couponRedemptionsInPeriod, data.reportSummary.webhookEventsInPeriod, data.reportSummary.invoicePaidEventsInPeriod, data.series.length], [coupons, events, paid, length], period);
    assert.deepEqual([data.kpis.mrrCents, data.kpis.couponRedemptionsTotal, data.kpis.paidActiveSubscriptions], [41_993, 3, 6], period);
  }
  // A cobrança da assinatura ca, criada há 60 dias, só aparece de 90 dias em diante.
  const ninety = await context.finance('?period=90d');
  assert.deepEqual(ninety.series.find((point: any) => point.day === brazilDate(context.now - 60 * DAY_MS)).newPaidSubscriptions, 1);
  context.db.close();
});

test('finance lists recent webhook events with the subscription owner and the processing outcome', async () => {
  const context = await financeSetup();
  const events = (await context.finance()).recentWebhookEvents as Record<string, any>[];
  assert.deepEqual(events.map(event => [event.eventId, event.type, event.processingStatus]), [
    ['e3', 'invoice.paid', 'pending'], ['e2', 'customer.subscription.updated', 'ignored'], ['e1', 'invoice.paid', 'processed'],
    ['e4', 'invoice.paid', 'processed'], ['e5', 'checkout.session.completed', 'processed'],
  ]);
  assert.deepEqual(Object.keys(events[0]), ['eventId', 'type', 'subscriptionId', 'customerEmail', 'processingStatus', 'ignoredReason', 'receivedAt', 'processedAt']);
  assert.deepEqual([events[0].subscriptionId, events[0].customerEmail, events[0].ignoredReason, events[0].processedAt], ['sub_q', 'q@example.test', null, null]);
  assert.deepEqual([events[1].subscriptionId, events[1].customerEmail, events[1].ignoredReason], ['sub_pd', 'pd@example.test', 'foreign-price']);
  assert.deepEqual([events[2].customerEmail, typeof events[2].processedAt, new Date(events[2].receivedAt).toISOString() === events[2].receivedAt], ['co@example.test', 'string', true]);
  assert.deepEqual([events[3].subscriptionId, events[3].customerEmail], [null, null]);
  context.db.close();
});

test('finance caps an amount coupon at the cycle price and a 100% coupon at zero, and prices team seats at nothing', async () => {
  const context = await setup();
  const { db } = context, now = Date.now();
  for (const id of ['big', 'full']) await seedAccount(db, id, { trialDays: -1 });
  await db.batch([
    db.prepare("INSERT INTO subscriptions(id,owner_type,account_id,stripe_subscription_id,stripe_customer_id,plan,status,seats,current_period_end,created_at,updated_at,billing_interval) VALUES('row-big','account','big','sub_big','cus_big','pro','trialing',3,?,?,?,'month'),('row-full','account','full','sub_full','cus_full','pro','active',1,NULL,?,?,'year')").bind(now + DAY_MS, now, now, now - DAY_MS, now - DAY_MS),
    db.prepare("INSERT INTO discount_coupons(id,code,kind,value,intervals,created_at,updated_at) VALUES('c-big','BIG','amount',99999999,'[\"month\"]',?1,?1),('c-full','FULL','percent',100,'[\"year\"]',?1,?1)").bind(now),
    db.prepare("INSERT INTO coupon_redemptions(id,coupon_id,account_id,interval,stripe_subscription_id,created_at) VALUES('rb','c-big','big','month','sub_big',?),('rf','c-full','full','year','sub_full',?)").bind(now, now),
    db.prepare("INSERT INTO teams(id,name,owner_account_id) VALUES('team1','Time','trial')"),
    db.prepare("INSERT INTO subscriptions(id,owner_type,team_id,stripe_subscription_id,stripe_customer_id,plan,status,seats,current_period_end,created_at,updated_at) VALUES('row-team','team','team1','sub_team','cus_team','team','active',5,?,?,?)").bind(now + DAY_MS, now - 2 * DAY_MS, now - 2 * DAY_MS),
  ]);
  const data = (await json(await context.get('/v1/admin/finance'))).data as Record<string, any>;
  const by = Object.fromEntries((data.entries as Record<string, any>[]).map(entry => [entry.stripeSubscriptionId, entry]));
  // 3 assentos mensais = 3 x 5999, o cupom de valor fixo nunca passa do preço e o MRR líquido é zero.
  assert.deepEqual([by.sub_big.catalogAmountCents, by.sub_big.mrrContributionCents, by.sub_big.discountCents, by.sub_big.netCommitmentCents], [17_997, 0, 17_997, 0]);
  assert.deepEqual([by.sub_full.catalogAmountCents, by.sub_full.mrrContributionCents, by.sub_full.discountCents, by.sub_full.netCommitmentCents], [71_988, 0, 71_988, 0]);
  // Time: sem preço de catálogo, mas é uma assinatura Stripe ativa com o dono do time como cliente.
  assert.deepEqual([by.sub_team.plan, by.sub_team.interval, by.sub_team.intervalLabel, by.sub_team.catalogAmountCents, by.sub_team.mrrContributionCents, by.sub_team.accountId, by.sub_team.customerEmail, by.sub_team.seats], ['team', null, 'Equipe', 0, 0, 'trial', 'trial@example.test', 5]);
  assert.deepEqual([data.kpis.paidActiveSubscriptions, data.kpis.paidActiveSeats, data.kpis.mrrCents, data.kpis.grossCommitmentCents, data.kpis.netCommitmentCents, data.kpis.estimatedDiscountCents],
    [2, 6, 5999, 5999, 5999, 0]);
  // trialing (sub_big) ainda não cobra e o cupom de 100% (sub_full) não gera receita: nenhum dos dois é paga ativa.
  assert.deepEqual([data.reportSummary.grossRecurringMrrCents, data.reportSummary.estimatedCouponDiscountCents, data.reportSummary.netRecurringMrrCents], [5999, 0, 5999]);
  context.db.close();
});

test('overview with include=finance adds the finance object and nothing else changes', async () => {
  const context = await financeSetup();
  const plain = (await json(await context.get('/v1/admin/overview'))).data!;
  assert.deepEqual(Object.keys(plain).sort(), ['accounts', 'active', 'expired', 'suspended', 'trial']);
  assert.deepEqual((await json(await context.get('/v1/admin/overview?include=other'))).data, plain);
  const merged = (await json(await context.get('/v1/admin/overview?include=finance&period=30d'))).data!;
  assert.deepEqual(Object.keys(merged).sort(), ['accounts', 'active', 'expired', 'finance', 'suspended', 'trial']);
  const { finance, ...counts } = merged;
  assert.deepEqual(counts, plain);
  const standalone = await context.finance('?period=30d');
  assert.equal(finance.period.key, '30d');
  assert.deepEqual({ ...finance, asOf: undefined }, { ...standalone, asOf: undefined });
  assert.equal(((await json(await context.get('/v1/admin/overview?include=finance'))).data!.finance as Record<string, any>).period.key, '30d');
  assert.equal(((await json(await context.get('/v1/admin/overview?include=finance&period=7d'))).data!.finance as Record<string, any>).period.days, 7);
  context.db.close();
});

test('finance trial conversion ignores direct purchases and open trials, and trialing or fully discounted subscriptions are not paid', async () => {
  const context = await setup();
  const { db } = context, now = Date.now();
  // direct: assinou sem teste. open: teste em aberto. conv: teste e depois pagou. lost: teste expirou sem pagar. tri: Stripe em trialing.
  await seedAccount(db, 'direct', { trialDays: null });
  await seedAccount(db, 'conv', { trialDays: -1 });
  await seedAccount(db, 'lost', { trialDays: -1 });
  await seedAccount(db, 'tri', { trialDays: -1 });
  await seedAccount(db, 'free', { trialDays: -1 });
  const sub = (account: string, status: string, interval: string, created = now) => db.prepare(
    "INSERT INTO subscriptions(id,owner_type,account_id,stripe_subscription_id,stripe_customer_id,plan,status,seats,current_period_end,created_at,updated_at,billing_interval) VALUES(?,'account',?,?,?,'pro',?,1,?,?,?,?)")
    .bind(`row-${account}`, account, `sub_${account}`, `cus_${account}`, status, now + 30 * DAY_MS, created, created, interval);
  await db.batch([
    sub('direct', 'active', 'month'), sub('conv', 'active', 'month'), sub('tri', 'trialing', 'month'), sub('free', 'active', 'year'),
    db.prepare("INSERT INTO discount_coupons(id,code,kind,value,intervals,created_at,updated_at) VALUES('c-100','FREE100','percent',100,'[\"year\"]',?1,?1),('c-20','OFF20','percent',20,'[\"month\"]',?1,?1)").bind(now),
    db.prepare("INSERT INTO coupon_redemptions(id,coupon_id,account_id,interval,stripe_subscription_id,created_at) VALUES('r100','c-100','free','year','sub_free',?),('r20','c-20','conv','month','sub_conv',?)").bind(now, now),
  ]);
  const data = (await json(await context.get('/v1/admin/finance'))).data as Record<string, any>;
  // Paga ativa: a conta 'paid' do fixture, direct e conv (com 20% de desconto). Fora: trialing e 100% de cupom (nem no MRR nem como nova paga).
  assert.deepEqual([data.kpis.paidActiveSubscriptions, data.kpis.mrrCents], [3, 5999 * 3]);
  assert.equal(data.series.reduce((total: number, point: any) => total + point.newPaidSubscriptions, 0), 3); // inclui a assinatura do fixture; tri (trialing) e free (100%) ficam fora
  assert.equal(data.series.reduce((total: number, point: any) => total + point.estimatedNewMrrCents, 0), 5999 * 3);
  const wallet = Object.fromEntries(data.walletBreakdown.map((row: any) => [row.key, row.count]));
  assert.equal(wallet.paid, 3);
  // O trial em aberto da conta 'trial' e a assinatura trialing da conta 'tri' contam como teste.
  assert.ok(wallet.trial >= 2);
  // Convertidas: conv e a conta 'paid' do fixture. Resolvidas (teste iniciado e fora de teste): essas duas, mais expired, blocked (suspensa), lost e free.
  // Ficam de fora: direct (nunca teve teste), o teste aberto de 'trial' e tri (Stripe trialing).
  assert.equal(data.kpis.trialConversionRatePct, 33.3);
  context.db.close();
});

test('a mission measured through POST /v1/activity (1/1, equal marks) is not flagged as a backfilled floor', async () => {
  const context = await setup();
  const desktop = await nativeLogin(context.db, 'trial');
  const posted = await context.app.request('/v1/activity', { method: 'POST', headers: desktop, body: JSON.stringify({ agentStarted: false, agentWorking: false, missionCompleted: true }) }, context.env);
  assert.equal(posted.status, 200);
  const rows = (await json(await context.get('/v1/admin/accounts?limit=50'))).data!.accounts as Record<string, any>[];
  const measured = rows.find(row => row.id === 'trial')!;
  assert.equal(measured.firstMissionAt, measured.lastMissionAt);
  assert.deepEqual([measured.missionsStartedCount, measured.missionsCompletedCount], [1, 1]);
  context.db.close();
});

test('finance judges a subscription by its latest coupon redemption in both the book and the wallet', async () => {
  const context = await setup();
  const { db } = context, now = Date.now();
  await seedAccount(db, 'swap', { trialDays: -1 });
  const read = async () => {
    const data = (await json(await context.get('/v1/admin/finance'))).data as Record<string, any>;
    return { paid: data.kpis.paidActiveSubscriptions, mrr: data.kpis.mrrCents, wallet: data.walletBreakdown.find((row: any) => row.key === 'paid').count, rate: data.kpis.trialConversionRatePct };
  };
  const before = await read();
  await db.batch([
    db.prepare("INSERT INTO subscriptions(id,owner_type,account_id,stripe_subscription_id,stripe_customer_id,plan,status,seats,current_period_end,created_at,updated_at,billing_interval) VALUES('row-swap','account','swap','sub_swap','cus_swap','pro','active',1,?,?,?,'month')").bind(now + 30 * DAY_MS, now, now),
    db.prepare("INSERT INTO discount_coupons(id,code,kind,value,intervals,created_at,updated_at) VALUES('c-100','FREE100','percent',100,'[\"month\"]',?1,?1),('c-20','OFF20','percent',20,'[\"month\"]',?1,?1)").bind(now),
    db.prepare("INSERT INTO coupon_redemptions(id,coupon_id,account_id,interval,stripe_subscription_id,created_at) VALUES('r-old','c-100','swap','month','sub_swap',?),('r-new','c-20','swap','month','sub_swap',?)").bind(now - 1000, now),
  ]);
  const after = await read();
  assert.deepEqual([after.paid - before.paid, after.mrr - before.mrr, after.wallet - before.wallet], [1, 5999, 1]);
  assert.ok(after.rate > before.rate);
  context.db.close();
});

test('a duration:once coupon only counts in the first cycle; after renewal the subscription is paid at catalog price', async () => {
  const context = await setup();
  const { db } = context, now = Date.now();
  for (const id of ['full', 'part']) await seedAccount(db, id, { trialDays: -1 });
  const sub = (id: string) => db.prepare("INSERT INTO subscriptions(id,owner_type,account_id,stripe_subscription_id,stripe_customer_id,plan,status,seats,current_period_end,created_at,updated_at,billing_interval) VALUES(?,'account',?,?,?,'pro','active',1,?,?,?,'month')")
    .bind(`row-${id}`, id, `sub_${id}`, `cus_${id}`, now + 20 * DAY_MS, now - 40 * DAY_MS, now - 40 * DAY_MS);
  const redeem = (id: string, coupon: string, at: number) => db.prepare("INSERT INTO coupon_redemptions(id,coupon_id,account_id,interval,stripe_subscription_id,created_at) VALUES(?,?,?,'month',?,?)").bind(`r-${id}`, coupon, id, `sub_${id}`, at);
  await db.batch([
    sub('full'), sub('part'),
    db.prepare("INSERT INTO discount_coupons(id,code,kind,value,intervals,created_at,updated_at) VALUES('c-100','FREE100','percent',100,'[\"month\"]',?1,?1),('c-20','OFF20','percent',20,'[\"month\"]',?1,?1)").bind(now),
    redeem('full', 'c-100', now - 40 * DAY_MS), redeem('part', 'c-20', now - 40 * DAY_MS),
  ]);
  const read = async () => (await json(await context.get('/v1/admin/finance'))).data as Record<string, any>;
  // 2º ciclo: o cupom once não vale mais.
  let data = await read();
  const by = Object.fromEntries(data.entries.map((entry: any) => [entry.accountId, entry]));
  for (const id of ['full', 'part']) assert.deepEqual([by[id].couponCode, by[id].discountCents, by[id].netCommitmentCents, by[id].mrrContributionCents], [null, 0, 5999, 5999], id);
  const base = data.kpis.paidActiveSubscriptions, baseMrr = data.kpis.mrrCents, baseWallet = data.walletBreakdown.find((row: any) => row.key === 'paid').count;
  // Mesmo resgate dentro do 1º ciclo: o 100% fica fora do pago; o parcial só reduz o compromisso líquido.
  await db.batch([
    db.prepare('UPDATE coupon_redemptions SET created_at=? WHERE id IN (?,?)').bind(now - 5 * DAY_MS, 'r-full', 'r-part'),
    db.prepare('UPDATE subscriptions SET created_at=?, current_period_end=? WHERE id IN (?,?)').bind(now - 5 * DAY_MS, now + 25 * DAY_MS, 'row-full', 'row-part'),
  ]);
  data = await read();
  const first = Object.fromEntries(data.entries.map((entry: any) => [entry.accountId, entry]));
  assert.deepEqual([first.full.couponCode, first.full.netCommitmentCents, first.full.mrrContributionCents], ['FREE100', 0, 0]);
  assert.deepEqual([first.part.couponCode, first.part.discountCents, first.part.netCommitmentCents, first.part.mrrContributionCents], ['OFF20', 1200, 4799, 5999]);
  assert.deepEqual([data.kpis.paidActiveSubscriptions, data.kpis.mrrCents, data.walletBreakdown.find((row: any) => row.key === 'paid').count], [base - 1, baseMrr - 5999, baseWallet - 1]);
  context.db.close();
});
