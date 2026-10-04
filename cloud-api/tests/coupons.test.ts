import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteD1 } from './helpers/sqlite-d1.js';
import { PRICE_PRO, PRICE_QUARTER, PRICE_SEMI, PRICE_YEAR, environment, fakeStripe, nativeLogin, seedAccount, subscription, webLogin } from './helpers/fixtures.js';
import { createApp } from '../src/index.js';
import { accountAccess } from '../src/access.js';
import { configFrom } from '../src/config.js';

type Body = { ok: boolean; error?: string; data?: Record<string, any> };
const json = async (response: Response): Promise<Body> => await response.json() as Body;
const ATTEMPT = '11111111-1111-4111-8111-111111111111';
const INTERVALS = [
  { id: 'month', price: PRICE_PRO, amount: 5999 },
  { id: 'quarter', price: PRICE_QUARTER, amount: 17997 },
  { id: 'semiannual', price: PRICE_SEMI, amount: 35994 },
  { id: 'year', price: PRICE_YEAR, amount: 71988 },
] as const;

function pricedEnv(db: SqliteD1) {
  return environment(db, {
    STRIPE_PRICE_PRO_QUARTERLY: PRICE_QUARTER,
    STRIPE_PRICE_PRO_SEMIANNUAL: PRICE_SEMI,
    STRIPE_PRICE_PRO_ANNUAL: PRICE_YEAR,
  });
}

async function setup() {
  const db = new SqliteD1();
  await seedAccount(db, 'user', { customer: 'cus_user' });
  await seedAccount(db, 'admin', { admin: true, customer: 'cus_admin' });
  const fake = fakeStripe();
  const env = pricedEnv(db);
  const clock = { value: Date.now() };
  const app = createApp({ stripeFor: () => fake.stripe, now: () => ++clock.value });
  const post = (path: string, headers: Record<string, string>, body?: unknown) =>
    app.request(path, { method: 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
  return { db, fake, env, app, post, clock };
}

async function createCoupon(context: Awaited<ReturnType<typeof setup>>, body: Record<string, unknown>) {
  const headers = await webLogin(context.db, 'admin');
  const response = await context.post('/v1/admin/coupons', headers, body);
  return { response, body: await json(response), headers };
}

test('admin cria, lista e desliga um cupom sem apagar o histórico', async () => {
  const context = await setup();
  const created = await createCoupon(context, {
    code: 'verao 10', kind: 'percent', value: 10, intervals: ['year', 'month'], maxRedemptions: 2,
  });
  assert.equal(created.response.status, 200);
  assert.equal(created.body.data?.code, 'VERAO10');
  assert.deepEqual(created.body.data?.intervals, ['month', 'year']);
  assert.equal(created.body.data?.active, true);
  assert.equal(created.body.data?.uses, 0);
  assert.equal(JSON.stringify(created.body).includes('nxc_'), false);
  const listed = await json(await context.app.request('/v1/admin/coupons', { headers: created.headers }, context.env));
  assert.equal(listed.data?.coupons[0].code, 'VERAO10');
  assert.equal(listed.data?.coupons[0].kind, 'percent');
  assert.equal(listed.data?.coupons[0].value, 10);
  const id = created.body.data?.id as string;
  assert.equal((await context.post(`/v1/admin/coupons/${id}/disable`, created.headers)).status, 200);
  const after = await json(await context.app.request('/v1/admin/coupons', { headers: created.headers }, context.env));
  assert.equal(after.data?.coupons[0].active, false);
  assert.equal((await context.post(`/v1/admin/coupons/${id}/disable`, created.headers)).status, 409);
  const duplicate = await createCoupon(context, { code: 'VERAO10', kind: 'percent', value: 10, intervals: ['month'] });
  assert.equal(duplicate.response.status, 409);
  const stranger = await context.post('/v1/admin/coupons', await webLogin(context.db, 'user'), { code: 'OUTRO', kind: 'percent', value: 10, intervals: ['month'] });
  assert.equal(stranger.status, 403);
  context.db.close();
});

test('cupom inválido, expirado, esgotado ou de outro período não abre checkout', async () => {
  const context = await setup();
  const headers = await webLogin(context.db, 'user');
  const admin = await webLogin(context.db, 'admin');
  const checkout = (body: Record<string, unknown>) => context.post('/v1/web/checkout', headers, { plan: 'pro', attemptId: ATTEMPT, ...body });
  assert.equal((await checkout({ coupon: 'NAO-EXISTE' })).status, 400);
  assert.equal((await json(await checkout({ coupon: '!!' }))).error, 'Cupom inválido.');
  const percent = await createCoupon(context, { code: 'SO-MES', kind: 'percent', value: 15, intervals: ['month'] });
  assert.equal((await json(await checkout({ interval: 'quarter', coupon: 'SO-MES' }))).error, 'Este cupom não vale para o período escolhido.');
  await context.post(`/v1/admin/coupons/${percent.body.data?.id}/disable`, admin);
  assert.equal((await json(await checkout({ coupon: 'SO-MES' }))).error, 'Este cupom não está mais ativo.');
  const dated = await createCoupon(context, { code: 'VELHO', kind: 'percent', value: 5, intervals: ['month', 'quarter', 'semiannual', 'year'], expiresAt: '2099-01-01T23:59:59.999Z' });
  await context.db.prepare('UPDATE discount_coupons SET expires_at=? WHERE id=?').bind(1, dated.body.data?.id).run();
  assert.equal((await json(await checkout({ coupon: 'VELHO' }))).error, 'Este cupom expirou.');
  const limited = await createCoupon(context, { code: 'UNICO', kind: 'percent', value: 5, intervals: ['year'], maxRedemptions: 1 });
  await context.db.prepare('UPDATE discount_coupons SET redeemed_count=1 WHERE id=?').bind(limited.body.data?.id).run();
  assert.equal((await json(await checkout({ interval: 'year', coupon: 'UNICO' }))).error, 'Este cupom já atingiu o limite de usos.');
  const huge = await createCoupon(context, { code: 'GRANDE', kind: 'amount', value: 60_000, intervals: ['month'] });
  assert.equal(huge.response.status, 400);
  assert.equal(huge.body.error, 'Este cupom é maior que o valor do período escolhido.');
  const yearly = await createCoupon(context, { code: 'ANO', kind: 'amount', value: 60_000, intervals: ['year'] });
  assert.equal(yearly.response.status, 200);
  assert.equal((await json(await checkout({ interval: 'month', coupon: 'ANO' }))).error, 'Este cupom não vale para o período escolhido.');
  assert.equal(context.fake.calls.customers.length + context.fake.calls.checkouts.length + context.fake.calls.coupons.length, 0);
  context.db.close();
});

test('checkout de cada período abre com e sem cupom válido e a assinatura fica Pro', async () => {
  const context = await setup();
  const headers = await webLogin(context.db, 'user');
  const minted = await createCoupon(context, { code: 'NEXUS10', kind: 'percent', value: 10, intervals: ['month', 'quarter', 'semiannual', 'year'] });
  assert.equal(minted.response.status, 200);
  for (const spec of INTERVALS) {
    const plain = await context.post('/v1/billing/checkout', await nativeLogin(context.db, 'user'), { plan: 'pro', interval: spec.id });
    assert.equal(plain.status, 200, spec.id);
    const withCode = await context.post('/v1/web/checkout', headers, { plan: 'pro', attemptId: ATTEMPT, interval: spec.id, coupon: 'nexus10' });
    assert.equal(withCode.status, 200, spec.id);
  }
  const checkouts = context.fake.calls.checkouts as Array<[Record<string, any>, { idempotencyKey: string }]>;
  for (const spec of INTERVALS) {
    const plain = checkouts.find(call => call[0].line_items[0].price === spec.price && !call[0].discounts);
    const discounted = checkouts.find(call => call[0].line_items[0].price === spec.price && call[0].discounts);
    assert.ok(plain, spec.id);
    assert.equal(plain?.[0].subscription_data.metadata.interval, spec.id);
    assert.equal(plain?.[0].subscription_data.metadata.plan, 'pro');
    assert.ok(discounted?.[0].discounts[0].coupon.startsWith('nxc_'));
  }
  assert.equal(context.fake.calls.coupons.length, 1, 'o cupom da Stripe nasce uma vez e os períodos seguintes reutilizam o id');
  const stripeCouponId = (context.fake.calls.coupons[0][0] as { id: string }).id;
  const couponParams = context.fake.calls.coupons[0][0] as { duration: string; percent_off: number; name: string };
  assert.equal(couponParams.duration, 'once');
  assert.equal(couponParams.percent_off, 10);
  assert.equal(couponParams.name, 'NEXUS10');
  context.fake.subscription = subscription('user', {
    items: { data: [{ quantity: 1, price: { id: PRICE_YEAR }, current_period_end: Math.floor(Date.now() / 1000) + 3600 }] },
    discounts: [{ coupon: { id: stripeCouponId } }],
  });
  context.fake.event = { id: 'evt_year', type: 'checkout.session.completed', data: { object: { subscription: 'sub_user' } } };
  assert.equal((await context.post('/v1/billing/webhook', { 'stripe-signature': 'fixture' }, {})).status, 200);
  const access = await accountAccess(context.db, 'user', configFrom(context.env));
  assert.equal(access.access, 'pro');
  const stored = await context.db.prepare("SELECT plan, billing_interval AS interval FROM subscriptions WHERE stripe_subscription_id='sub_user'").first<{ plan: string; interval: string }>();
  assert.deepEqual(stored, { plan: 'pro', interval: 'year' });
  const uses = await context.db.prepare('SELECT redeemed_count AS uses, active FROM discount_coupons WHERE code=?').bind('NEXUS10').first<{ uses: number; active: number }>();
  assert.equal(uses?.uses, 1);
  await context.post(`/v1/admin/coupons/${minted.body.data?.id}/disable`, await webLogin(context.db, 'admin'));
  const kept = await context.db.prepare('SELECT COUNT(*) AS n FROM coupon_redemptions').first<{ n: number }>();
  assert.equal(kept?.n, 1);
  const listed = await json(await context.app.request('/v1/admin/coupons', { headers: await webLogin(context.db, 'admin') }, context.env));
  assert.equal(listed.data?.coupons.find((coupon: { code: string }) => coupon.code === 'NEXUS10').uses, 1);
  assert.equal(listed.data?.coupons.find((coupon: { code: string }) => coupon.code === 'NEXUS10').active, false);
  assert.equal(JSON.stringify(listed).includes(stripeCouponId), false);
  context.db.close();
});

test('assinatura incomplete com cupom não consome o uso; active da mesma assinatura conta uma vez', async () => {
  const context = await setup();
  const headers = await webLogin(context.db, 'user');
  const minted = await createCoupon(context, { code: 'NEXUS10', kind: 'percent', value: 10, maxRedemptions: 1, intervals: ['month'] });
  assert.equal(minted.response.status, 200);
  assert.equal((await context.post('/v1/web/checkout', headers, { plan: 'pro', attemptId: ATTEMPT, interval: 'month', coupon: 'NEXUS10' })).status, 200);
  const stripeCouponId = (context.fake.calls.coupons[0][0] as { id: string }).id;
  const priced = {
    items: { data: [{ quantity: 1, price: { id: PRICE_PRO }, current_period_end: Math.floor(Date.now() / 1000) + 3600 }] },
    discounts: [{ coupon: { id: stripeCouponId } }],
  };
  const uses = () => context.db.prepare('SELECT redeemed_count AS uses FROM discount_coupons WHERE code=?').bind('NEXUS10').first<{ uses: number }>();
  const redemptions = () => context.db.prepare('SELECT COUNT(*) AS n FROM coupon_redemptions').first<{ n: number }>();
  const webhook = (id: string, type: string) => {
    context.fake.event = { id, type, data: { object: { id: 'sub_user', subscription: 'sub_user' } } };
    return context.post('/v1/billing/webhook', { 'stripe-signature': 'fixture' }, {});
  };

  const plan = () => context.db.prepare('SELECT plan FROM accounts WHERE id=?').bind('user').first<{ plan: string }>();
  context.fake.subscription = subscription('user', { ...priced, status: 'incomplete' });
  assert.equal((await webhook('evt_incomplete', 'customer.subscription.created')).status, 200);
  assert.equal((await uses())?.uses, 0);
  assert.equal((await redemptions())?.n, 0);
  assert.equal((await plan())?.plan, 'free');

  context.fake.subscription = subscription('user', { ...priced, status: 'active' });
  assert.equal((await webhook('evt_active', 'customer.subscription.updated')).status, 200);
  assert.equal((await uses())?.uses, 1);
  assert.equal((await redemptions())?.n, 1);
  assert.equal((await plan())?.plan, 'pro');

  assert.equal((await webhook('evt_active_retry', 'customer.subscription.updated')).status, 200);
  assert.equal((await uses())?.uses, 1);
  assert.equal((await redemptions())?.n, 1);

  await context.post(`/v1/admin/coupons/${minted.body.data?.id}/disable`, await webLogin(context.db, 'admin'));
  assert.equal((await redemptions())?.n, 1);
  context.db.close();
});

test('trocar o período dentro da janela encerra a sessão anterior', async () => {
  const context = await setup();
  const native = await nativeLogin(context.db, 'user');
  assert.equal((await context.post('/v1/billing/checkout', native, { plan: 'pro', interval: 'month' })).status, 200);
  assert.equal((await context.post('/v1/billing/checkout', native, { plan: 'pro', interval: 'quarter' })).status, 200);
  assert.deepEqual(context.fake.calls.expires, ['cs_1']);
  const keys = (context.fake.calls.checkouts as Array<[unknown, { idempotencyKey: string }]>).map(call => call[1].idempotencyKey);
  assert.deepEqual(keys, ['checkout:user:1', 'checkout:user:2']);
  context.fake.expireError = new Error('already complete');
  assert.equal((await context.post('/v1/billing/checkout', native, { plan: 'pro', interval: 'year' })).status, 409);
  assert.equal(context.fake.calls.checkouts.length, 2);
  context.db.close();
});

test('período sem preço configurado não consulta a Stripe', async () => {
  const db = new SqliteD1();
  await seedAccount(db, 'user', { customer: 'cus_user' });
  const fake = fakeStripe();
  const app = createApp({ stripeFor: () => fake.stripe, now: () => Date.now() });
  const response = await app.request('/v1/billing/checkout', {
    method: 'POST', headers: await nativeLogin(db, 'user'), body: JSON.stringify({ plan: 'pro', interval: 'quarter' }),
  }, environment(db));
  assert.equal(response.status, 503);
  assert.match((await json(response)).error ?? '', /trimestral/);
  assert.equal(fake.calls.prices.length + fake.calls.checkouts.length, 0);
  db.close();
});
