import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey } from 'node:crypto';
import { jwtVerify } from 'jose';
import { SqliteD1 } from './helpers/sqlite-d1.js';
import { API, LICENSE_PUBLIC_KEY, PRICE_PRO, SITE, environment, fakeStripe, nativeLogin, seedAccount, seedSubscription, subscription, webLogin, type FakeStripe } from './helpers/fixtures.js';
import { createApp } from '../src/index.js';
import { accountAccess } from '../src/access.js';
import { configFrom } from '../src/config.js';
import { issueTokens } from '../src/sessions.js';

type Body = { ok: boolean; error?: string; data?: Record<string, any> };
const json = async (response: Response): Promise<Body> => await response.json() as Body;
const ATTEMPT = '11111111-1111-4111-8111-111111111111';
const DAY_MS = 24 * 60 * 60 * 1000;

async function setup(options: Parameters<typeof seedAccount>[2] = {}) {
  const db = new SqliteD1();
  await seedAccount(db, 'user', { customer: 'cus_user', ...options });
  const fake = fakeStripe();
  const env = environment(db);
  // A counter clock makes the order of concurrent steps deterministic.
  const clock = { value: Date.now() };
  const app = createApp({ stripeFor: () => fake.stripe, now: () => ++clock.value });
  const post = (path: string, headers: Record<string, string>, body?: unknown) =>
    app.request(path, { method: 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
  return { db, fake, env, app, post, clock };
}
const access = async (db: SqliteD1, env: CloudflareBindings, now = Date.now()) => accountAccess(db, 'user', configFrom(env), now);
async function deliver(context: Awaited<ReturnType<typeof setup>>, fake: FakeStripe, id: string, type = 'customer.subscription.updated') {
  fake.event = { id, type, data: { object: { id: 'sub_user', subscription: 'sub_user' } } };
  return context.post('/v1/billing/webhook', { 'stripe-signature': 'fixture' }, { ignored: true });
}

test('web checkout creates a Stripe session bound to the signed-in account', async () => {
  const context = await setup({ customer: undefined });
  const response = await context.post('/v1/web/checkout', await webLogin(context.db, 'user'), { plan: 'pro', attemptId: ATTEMPT });
  assert.equal(response.status, 200);
  assert.deepEqual((await json(response)).data, { url: 'https://checkout.stripe.com/c/pay/fixture' });
  const [params, options] = context.fake.calls.checkouts[0] as [Record<string, any>, { idempotencyKey: string }];
  assert.equal(params.mode, 'subscription');
  assert.equal(params.customer, 'cus_created');
  assert.equal(params.client_reference_id, 'user');
  assert.deepEqual(params.line_items, [{ price: PRICE_PRO, quantity: 1 }]);
  assert.deepEqual(params.subscription_data, { metadata: { accountId: 'user', plan: 'pro' } });
  assert.equal(params.success_url, SITE + '/conta/?checkout=success');
  assert.equal(params.cancel_url, SITE + '/conta/?checkout=cancel');
  assert.equal(options.idempotencyKey, 'checkout:user:1');
  assert.equal(typeof params.expires_at, 'number');
  assert.equal((await context.db.prepare("SELECT stripe_customer_id AS id FROM accounts WHERE id='user'").first<{ id: string }>())?.id, 'cus_created');
  context.db.close();
});

test('web checkout rejects missing CSRF, foreign origins and unknown plans before touching Stripe', async () => {
  const context = await setup();
  const headers = await webLogin(context.db, 'user');
  const { 'X-CSRF-Token': _csrf, ...withoutCsrf } = headers;
  assert.equal((await context.post('/v1/web/checkout', withoutCsrf, { plan: 'pro', attemptId: ATTEMPT })).status, 403);
  assert.equal((await context.post('/v1/web/checkout', { ...headers, Origin: 'https://evil.test' }, { plan: 'pro', attemptId: ATTEMPT })).status, 403);
  assert.equal((await context.post('/v1/web/checkout', { 'Content-Type': 'application/json', Origin: SITE }, { plan: 'pro', attemptId: ATTEMPT })).status, 401);
  for (const body of [{ plan: 'team', attemptId: ATTEMPT }, { plan: 'pro' }, { plan: 'pro', attemptId: 'not-a-uuid' }, { plan: 'pro', attemptId: ATTEMPT, price: 1 }]) {
    assert.equal((await context.post('/v1/web/checkout', headers, body)).status, 400);
  }
  assert.equal(context.fake.calls.prices.length + context.fake.calls.customers.length + context.fake.calls.checkouts.length, 0);
  context.db.close();
});

test('checkout refuses a Stripe price that is not BRL 59,99 monthly and creates no charge', async () => {
  const context = await setup();
  const headers = await webLogin(context.db, 'user');
  const valid = { id: PRICE_PRO, active: true, currency: 'brl', unit_amount: 5999, type: 'recurring', recurring: { interval: 'month', interval_count: 1 } };
  for (const price of [{ ...valid, currency: 'usd' }, { ...valid, unit_amount: 599 }, { ...valid, active: false }, { ...valid, recurring: { interval: 'year', interval_count: 1 } }, { ...valid, type: 'one_time', recurring: null }, { ...valid, id: 'price_other' }]) {
    context.fake.price = price;
    assert.equal((await context.post('/v1/web/checkout', headers, { plan: 'pro', attemptId: ATTEMPT })).status, 503);
  }
  context.fake.price = new Error('network');
  assert.equal((await context.post('/v1/web/checkout', headers, { plan: 'pro', attemptId: ATTEMPT })).status, 502);
  assert.equal(context.fake.calls.customers.length + context.fake.calls.checkouts.length, 0);
  context.db.close();
});

test('checkout refuses accounts that already have a live subscription or are suspended', async () => {
  for (const status of ['active', 'trialing', 'past_due']) {
    const context = await setup();
    await seedSubscription(context.db, 'user', { status });
    assert.equal((await context.post('/v1/web/checkout', await webLogin(context.db, 'user'), { plan: 'pro', attemptId: ATTEMPT })).status, 409);
    assert.equal(context.fake.calls.checkouts.length, 0);
    context.db.close();
  }
  const suspended = await setup({ suspended: true });
  assert.equal((await suspended.post('/v1/web/checkout', await webLogin(suspended.db, 'user'), { plan: 'pro', attemptId: ATTEMPT })).status, 403);
  assert.equal(suspended.fake.calls.prices.length, 0);
  suspended.db.close();
});

test('checkout stays closed until the operator opens sales, while the portal keeps working', async () => {
  const context = await setup();
  await context.db.prepare("UPDATE accounts SET stripe_customer_id='cus_user' WHERE id='user'").run();
  const env = environment(context.db, { MIGRATION_READY: 'false' });
  const headers = await webLogin(context.db, 'user');
  const request = (path: string, body: unknown) => context.app.request(path, { method: 'POST', headers, body: JSON.stringify(body) }, env);
  assert.equal((await request('/v1/web/checkout', { plan: 'pro', attemptId: ATTEMPT })).status, 503);
  assert.equal(context.fake.calls.prices.length + context.fake.calls.checkouts.length, 0);
  assert.equal((await request('/v1/web/portal', {})).status, 200);
  context.db.close();
});

test('billing routes answer 503 while Stripe is not configured', async () => {
  const context = await setup();
  const env = environment(context.db, { STRIPE_SECRET_KEY: '' });
  const headers = await webLogin(context.db, 'user');
  for (const [path, body] of [['/v1/web/checkout', { plan: 'pro', attemptId: ATTEMPT }], ['/v1/web/portal', {}]] as const) {
    assert.equal((await context.app.request(path, { method: 'POST', headers, body: JSON.stringify(body) }, env)).status, 503);
  }
  assert.equal((await context.app.request('/v1/billing/webhook', { method: 'POST', body: '{}' }, env)).status, 503);
  context.db.close();
});

test('desktop checkout and portal use the native bearer session and reuse the stored customer', async () => {
  const context = await setup({ customer: undefined });
  const native = await nativeLogin(context.db, 'user');
  const webSession = (await issueTokens(context.db, 'user', 'web')).session;
  assert.equal((await context.post('/v1/billing/checkout', { Authorization: `Bearer ${webSession}`, 'Content-Type': 'application/json' }, { plan: 'pro' })).status, 401);
  assert.equal((await context.post('/v1/billing/portal', native)).status, 409);
  assert.equal((await context.post('/v1/billing/checkout', native, { plan: 'team' })).status, 400);
  assert.equal((await context.post('/v1/billing/checkout', native, { plan: 'pro' })).status, 200);
  assert.equal((await context.post('/v1/billing/checkout', native, { plan: 'pro' })).status, 200);
  assert.equal(context.fake.calls.customers.length, 1);
  const portal = await context.post('/v1/billing/portal', native);
  assert.deepEqual((await json(portal)).data, { url: 'https://billing.stripe.com/p/session/fixture' });
  assert.deepEqual(context.fake.calls.portals[0][0], { customer: 'cus_created', return_url: SITE + '/conta/' });
  context.db.close();
});

test('web portal needs CSRF and stays available to a suspended subscriber', async () => {
  const context = await setup({ suspended: true });
  await context.db.prepare("UPDATE accounts SET stripe_customer_id='cus_user' WHERE id='user'").run();
  const headers = await webLogin(context.db, 'user');
  const { 'X-CSRF-Token': _csrf, ...withoutCsrf } = headers;
  assert.equal((await context.post('/v1/web/portal', withoutCsrf, {})).status, 403);
  assert.equal((await context.post('/v1/web/portal', headers, {})).status, 200);
  context.db.close();
});

test('webhook with an invalid signature is rejected and stores nothing', async () => {
  const context = await setup();
  context.fake.event = new Error('signature mismatch');
  const response = await context.post('/v1/billing/webhook', { 'stripe-signature': 'forged' }, { id: 'evt_forged' });
  assert.equal(response.status, 400);
  assert.equal((await context.post('/v1/billing/webhook', {}, { id: 'evt_unsigned' })).status, 400);
  assert.equal((await context.db.prepare('SELECT count(*) AS n FROM stripe_events').first<{ n: number }>())?.n, 0);
  assert.equal(context.fake.calls.retrieved.length, 0);
  context.db.close();
});

test('webhook grants Pro from the subscription read from Stripe, never from the event payload', async () => {
  const context = await setup();
  context.fake.subscription = subscription('user');
  context.fake.event = { id: 'evt_1', type: 'checkout.session.completed', data: { object: { subscription: 'sub_user', status: 'canceled', metadata: { accountId: 'someone-else' } } } };
  assert.equal((await context.post('/v1/billing/webhook', { 'stripe-signature': 'fixture' }, {})).status, 200);
  assert.deepEqual(context.fake.calls.retrieved, ['sub_user']);
  const view = await access(context.db, context.env);
  assert.equal(view.access, 'pro');
  assert.equal(view.cloudSync, true);
  const stored = await context.db.prepare("SELECT account_id,stripe_customer_id,plan,status FROM subscriptions WHERE stripe_subscription_id='sub_user'").first();
  assert.deepEqual({ ...stored }, { account_id: 'user', stripe_customer_id: 'cus_user', plan: 'pro', status: 'active' });
  context.db.close();
});

test('a delivered webhook event is processed once', async () => {
  const context = await setup();
  context.fake.subscription = subscription('user');
  assert.equal((await deliver(context, context.fake, 'evt_same')).status, 200);
  assert.equal((await deliver(context, context.fake, 'evt_same')).status, 200);
  assert.equal(context.fake.calls.retrieved.length, 1);
  context.db.close();
});

test('a webhook that fails while processing stays unprocessed so the Stripe retry applies it', async () => {
  const context = await setup();
  context.fake.subscription = new Error('stripe unavailable');
  assert.equal((await deliver(context, context.fake, 'evt_retry')).status, 500);
  assert.equal((await context.db.prepare("SELECT processed_at FROM stripe_events WHERE event_id='evt_retry'").first<{ processed_at: number | null }>())?.processed_at, null);
  assert.equal((await access(context.db, context.env)).access, 'trial');
  context.fake.subscription = subscription('user');
  assert.equal((await deliver(context, context.fake, 'evt_retry')).status, 200);
  assert.equal((await access(context.db, context.env)).access, 'pro');
  assert.notEqual((await context.db.prepare("SELECT processed_at FROM stripe_events WHERE event_id='evt_retry'").first<{ processed_at: number | null }>())?.processed_at, null);
  context.db.close();
});

test('subscriptions the product cannot own are acknowledged, recorded and never grant access', async () => {
  const context = await setup();
  await seedAccount(context.db, 'other');
  const reason = async (id: string) => JSON.parse((await context.db.prepare('SELECT payload FROM stripe_events WHERE event_id=? AND processed_at IS NOT NULL').bind(id).first<{ payload: string }>())!.payload).ignored;
  context.fake.subscription = subscription('user', { items: { data: [{ price: { id: 'price_other' }, current_period_end: Math.floor(Date.now() / 1000) + 3600 }] } });
  assert.equal((await deliver(context, context.fake, 'evt_price')).status, 200);
  assert.equal(await reason('evt_price'), 'foreign-price');
  context.fake.subscription = subscription('user', { metadata: {} });
  assert.equal((await deliver(context, context.fake, 'evt_owner')).status, 200);
  assert.equal(await reason('evt_owner'), 'missing-owner');
  context.fake.subscription = subscription('user', { metadata: { accountId: 'deleted-account' } });
  assert.equal((await deliver(context, context.fake, 'evt_unknown')).status, 200);
  assert.equal(await reason('evt_unknown'), 'unknown-owner');
  // A subscription paid by one customer can never be pointed at another account through metadata.
  context.fake.subscription = subscription('user', { metadata: { accountId: 'other', plan: 'pro' } });
  assert.equal((await deliver(context, context.fake, 'evt_hijack')).status, 200);
  assert.equal(await reason('evt_hijack'), 'customer-mismatch');
  assert.equal((await context.db.prepare('SELECT count(*) AS n FROM subscriptions').first<{ n: number }>())?.n, 0);
  assert.equal((await accountAccess(context.db, 'other', configFrom(context.env))).access, 'trial');
  assert.equal((await access(context.db, context.env)).access, 'trial');
  context.db.close();
});

test('a stale subscription snapshot never overwrites the newer one written by a concurrent delivery', async () => {
  const context = await setup({ trialDays: -1 });
  let reached!: () => void, release!: () => void;
  const atRetrieve = new Promise<void>((resolve) => { reached = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  // The first delivery reads "active" before the cancellation and is delayed on the network.
  context.fake.retrievals.push(async () => { reached(); await gate; return subscription('user'); });
  context.fake.subscription = subscription('user', { status: 'canceled' });
  const stale = deliver(context, context.fake, 'evt_stale', 'invoice.paid');
  await atRetrieve;
  assert.equal((await deliver(context, context.fake, 'evt_fresh', 'customer.subscription.deleted')).status, 200);
  release();
  assert.equal((await stale).status, 200);
  assert.equal((await context.db.prepare("SELECT status FROM subscriptions WHERE stripe_subscription_id='sub_user'").first<{ status: string }>())?.status, 'canceled');
  assert.equal((await access(context.db, context.env)).access, 'inactive');
  assert.equal(context.fake.calls.retrieved.length, 3, 'the delayed delivery reads Stripe again instead of writing its old snapshot');
  context.db.close();
});

test('every checkout attempt in the open window reuses one Stripe session, across site and app', async () => {
  const context = await setup();
  const web = await webLogin(context.db, 'user'), native = await nativeLogin(context.db, 'user');
  const attempts = await Promise.all([
    context.post('/v1/web/checkout', web, { plan: 'pro', attemptId: ATTEMPT }),
    context.post('/v1/billing/checkout', native, { plan: 'pro' }),
    context.post('/v1/web/checkout', web, { plan: 'pro', attemptId: '22222222-2222-4222-8222-222222222222' }),
  ]);
  assert.deepEqual(attempts.map(response => response.status), [200, 200, 200]);
  const [first, ...rest] = context.fake.calls.checkouts as Array<[Record<string, unknown>, { idempotencyKey: string }]>;
  for (const [params, options] of rest) {
    assert.equal(options.idempotencyKey, first[1].idempotencyKey);
    assert.deepEqual(params, first[0], 'identical parameters let Stripe replay the same session');
  }
  // Once the reserved window is over, the next attempt opens a new session.
  context.clock.value += 24 * 60 * 60 * 1000;
  await context.post('/v1/billing/checkout', native, { plan: 'pro' });
  assert.notEqual((context.fake.calls.checkouts.at(-1) as [unknown, { idempotencyKey: string }])[1].idempotencyKey, first[1].idempotencyKey);
  context.db.close();
});

test('a subscriber who cancels can subscribe again without being handed the finished checkout', async () => {
  const context = await setup();
  const native = await nativeLogin(context.db, 'user');
  await context.post('/v1/billing/checkout', native, { plan: 'pro' });
  context.fake.subscription = subscription('user');
  await deliver(context, context.fake, 'evt_paid', 'checkout.session.completed');
  context.fake.subscription = subscription('user', { status: 'canceled' });
  await deliver(context, context.fake, 'evt_canceled', 'customer.subscription.deleted');
  assert.equal((await context.post('/v1/billing/checkout', native, { plan: 'pro' })).status, 200);
  const keys = (context.fake.calls.checkouts as Array<[unknown, { idempotencyKey: string }]>).map(call => call[1].idempotencyKey);
  assert.deepEqual(keys, ['checkout:user:1', 'checkout:user:2']);
  context.db.close();
});

test('past due keeps Pro for one anchored grace period that retries cannot extend', async () => {
  const context = await setup();
  context.fake.subscription = subscription('user', { status: 'past_due' });
  await deliver(context, context.fake, 'evt_due_1', 'invoice.payment_failed');
  const first = await context.db.prepare("SELECT grace_until FROM subscriptions WHERE stripe_subscription_id='sub_user'").first<{ grace_until: number }>();
  assert.ok(first!.grace_until > Date.now() + 6 * DAY_MS && first!.grace_until <= Date.now() + 7 * DAY_MS + 1000);
  assert.equal((await access(context.db, context.env)).status, 'past_due');
  await context.db.prepare("UPDATE subscriptions SET grace_until=grace_until-1000 WHERE stripe_subscription_id='sub_user'").run();
  await deliver(context, context.fake, 'evt_due_2', 'invoice.payment_failed');
  const second = await context.db.prepare("SELECT grace_until FROM subscriptions WHERE stripe_subscription_id='sub_user'").first<{ grace_until: number }>();
  assert.equal(second!.grace_until, first!.grace_until - 1000);
  assert.equal((await access(context.db, context.env, first!.grace_until + 1)).access, 'trial');
  context.fake.subscription = subscription('user');
  await deliver(context, context.fake, 'evt_paid', 'invoice.paid');
  assert.equal((await context.db.prepare("SELECT grace_until FROM subscriptions WHERE stripe_subscription_id='sub_user'").first<{ grace_until: number | null }>())?.grace_until, null);
  context.db.close();
});

test('a canceled subscription removes paid access and an expired trial leaves the account inactive', async () => {
  const context = await setup({ trialDays: -1 });
  context.fake.subscription = subscription('user');
  await deliver(context, context.fake, 'evt_created', 'customer.subscription.created');
  assert.equal((await access(context.db, context.env)).access, 'pro');
  assert.equal((await context.db.prepare("SELECT plan FROM accounts WHERE id='user'").first<{ plan: string }>())?.plan, 'pro');
  context.fake.subscription = subscription('user', { status: 'canceled' });
  await deliver(context, context.fake, 'evt_deleted', 'customer.subscription.deleted');
  assert.equal((await access(context.db, context.env)).access, 'inactive');
  assert.equal((await context.db.prepare("SELECT plan FROM accounts WHERE id='user'").first<{ plan: string }>())?.plan, 'free');
  context.db.close();
});

test('events without a subscription are acknowledged and oversized bodies are refused', async () => {
  const context = await setup();
  context.fake.event = { id: 'evt_other', type: 'customer.created', data: { object: { id: 'cus_user' } } };
  assert.equal((await context.post('/v1/billing/webhook', { 'stripe-signature': 'fixture' }, {})).status, 200);
  assert.equal(context.fake.calls.retrieved.length, 0);
  const large = await context.app.request('/v1/billing/webhook', { method: 'POST', headers: { 'stripe-signature': 'fixture' }, body: 'x'.repeat(300 * 1024) }, context.env);
  assert.equal(large.status, 413);
  context.db.close();
});

test('the desktop license reflects trial, paid and suspended access and is signed for the app', async () => {
  const context = await setup();
  const native = await nativeLogin(context.db, 'user');
  const key = createPublicKey(LICENSE_PUBLIC_KEY);
  const claims = async () => {
    const response = await context.app.request('/v1/license', { headers: native }, context.env);
    assert.equal(response.status, 200);
    return (await jwtVerify((await json(response)).data!.licenca, key, { issuer: API, audience: 'nexus-desktop' })).payload;
  };
  const trial = await claims();
  assert.equal(trial.access, 'trial');
  assert.deepEqual(trial.limits, { maxAgents: 2, cloudSync: false });
  assert.equal(trial.sub, 'user');
  await seedSubscription(context.db, 'user');
  const paid = await claims();
  assert.equal(paid.access, 'pro');
  assert.deepEqual(paid.limits, { maxAgents: null, cloudSync: true });
  await context.db.prepare("UPDATE accounts SET suspended_at=1 WHERE id='user'").run();
  const suspended = await claims();
  assert.equal(suspended.access, 'suspended');
  assert.equal(suspended.plan, 'free');
  assert.ok(suspended.exp! - suspended.iat! <= 5 * 60);
  assert.equal((await context.app.request('/v1/license', { headers: await webLogin(context.db, 'user') }, context.env)).status, 401);
  context.db.close();
});
