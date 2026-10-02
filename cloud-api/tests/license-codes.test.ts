import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey } from 'node:crypto';
import { jwtVerify } from 'jose';
import { SqliteD1 } from './helpers/sqlite-d1.js';
import { API, LICENSE_PUBLIC_KEY, environment, fakeStripe, nativeLogin, seedAccount, webLogin } from './helpers/fixtures.js';
import { createApp } from '../src/index.js';
import { mintLicenseCode, normalizeLicenseCode, redeemLicenseCode } from '../src/license-codes.js';
import type { AccountRow } from '../src/db/schema.js';

type Body = { ok: boolean; error?: string; data?: Record<string, any> };
const json = async (response: Response): Promise<Body> => await response.json() as Body;
const DAY_MS = 24 * 60 * 60 * 1000;
const mint = (db: SqliteD1, fields: Partial<Parameters<typeof mintLicenseCode>[1]> = {}, now = Date.now()) =>
  mintLicenseCode(db, { createdBy: null, periodDays: null, maxUses: 1, note: '', expiresAt: null, ...fields }, now);
const claims = async (licenca: string) =>
  (await jwtVerify(licenca, createPublicKey(LICENSE_PUBLIC_KEY), { issuer: API, audience: 'nexus-desktop' })).payload;

async function setup(options: Parameters<typeof seedAccount>[2] = { trialDays: -1 }) {
  const db = new SqliteD1();
  await seedAccount(db, 'user', options);
  const env = environment(db);
  const clock = { value: Date.now() };
  const app = createApp({ stripeFor: () => fakeStripe().stripe, now: () => ++clock.value });
  const post = (path: string, headers: Record<string, string>, body?: unknown) =>
    app.request(path, { method: 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
  const get = (path: string, headers: Record<string, string>) => app.request(path, { headers }, env);
  const redeem = (headers: Record<string, string>, code: string) => post('/v1/license/redeem', headers, { code });
  return { db, env, post, get, redeem, clock };
}

test('redeem requires a desktop session', async () => {
  const context = await setup();
  assert.equal((await context.redeem({ 'Content-Type': 'application/json' }, 'NEXUS-AAAA-AAAA-AAAA')).status, 401);
  await seedAccount(context.db, 'admin', { admin: true });
  // Sessão web não vale: a rota é exclusiva do app desktop.
  assert.equal((await context.redeem(await webLogin(context.db, 'admin'), 'NEXUS-AAAA-AAAA-AAAA')).status, 401);
  context.db.close();
});

test('redeem grants pro access and returns a fresh signed license', async () => {
  const context = await setup();
  const minted = await mint(context.db, {}, context.clock.value);
  assert.match(minted.code, /^NEXUS-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  const response = await context.redeem(await nativeLogin(context.db, 'user'), minted.code);
  assert.equal(response.status, 200);
  const token = (await json(response)).data!.licenca;
  const payload = await claims(token);
  assert.equal(payload.access, 'pro');
  assert.equal(payload.plan, 'pro');
  assert.deepEqual(payload.limits, { maxAgents: null, cloudSync: true });
  const sub = await context.db.prepare('SELECT status,plan,stripe_customer_id FROM subscriptions WHERE stripe_subscription_id=?').bind(`codegrant:${minted.id}:user`).first<Record<string, unknown>>();
  assert.equal(sub?.status, 'active');
  assert.equal(sub?.plan, 'pro');
  assert.equal((await context.db.prepare("SELECT plan FROM accounts WHERE id='user'").first<{ plan: string }>())?.plan, 'pro');
  context.db.close();
});

test('typing the code without the NEXUS- prefix or dashes still redeems', async () => {
  const context = await setup();
  const minted = await mint(context.db, {}, context.clock.value);
  const partial = minted.code.slice('NEXUS-'.length).replaceAll('-', '').toLowerCase();
  assert.equal((await context.redeem(await nativeLogin(context.db, 'user'), partial)).status, 200);
  context.db.close();
});

test('invalid, expired and exhausted codes share one generic refusal', async () => {
  const context = await setup();
  const headers = await nativeLogin(context.db, 'user');
  for (const code of ['NEXUS-XXXX-XXXX-XXXX', 'lixo']) {
    const response = await context.redeem(headers, code);
    assert.equal(response.status, 400, code);
    assert.equal((await json(response)).error, 'Código inválido, expirado ou já utilizado.');
  }
  const expired = await mint(context.db, { expiresAt: context.clock.value - 1 }, context.clock.value - DAY_MS);
  assert.equal((await context.redeem(headers, expired.code)).status, 400);
  const once = await mint(context.db, { maxUses: 1 }, context.clock.value);
  await seedAccount(context.db, 'other', { trialDays: -1 });
  assert.equal((await context.redeem(await nativeLogin(context.db, 'other'), once.code)).status, 200);
  assert.equal((await context.redeem(headers, once.code)).status, 400);
  context.db.close();
});

test('re-redeeming on the same account is idempotent; multi-use caps distinct accounts', async () => {
  const context = await setup();
  const headers = await nativeLogin(context.db, 'user');
  const minted = await mint(context.db, { maxUses: 2 }, context.clock.value);
  assert.equal((await context.redeem(headers, minted.code)).status, 200);
  assert.equal((await context.redeem(headers, minted.code)).status, 200);
  assert.equal(await context.db.prepare('SELECT COUNT(*) AS n FROM license_redemptions WHERE code_id=?').bind(minted.id).first<number>('n'), 1);
  await seedAccount(context.db, 'other', { trialDays: -1 });
  assert.equal((await context.redeem(await nativeLogin(context.db, 'other'), minted.code)).status, 200);
  await seedAccount(context.db, 'third', { trialDays: -1 });
  assert.equal((await context.redeem(await nativeLogin(context.db, 'third'), minted.code)).status, 400);
  assert.equal(await context.db.prepare('SELECT COUNT(*) AS n FROM license_redemptions WHERE code_id=?').bind(minted.id).first<number>('n'), 2);
  context.db.close();
});

test('timed codes bound the granted period; perpetual codes get a far horizon', async () => {
  const context = await setup();
  const timed = await mint(context.db, { periodDays: 30 }, context.clock.value);
  assert.equal((await context.redeem(await nativeLogin(context.db, 'user'), timed.code)).status, 200);
  const sub = await context.db.prepare('SELECT current_period_end AS end FROM subscriptions WHERE stripe_subscription_id=?').bind(`codegrant:${timed.id}:user`).first<{ end: number }>();
  assert.ok(sub!.end >= context.clock.value + 29 * DAY_MS && sub!.end <= context.clock.value + 31 * DAY_MS);
  context.db.close();
});

test('suspended accounts cannot redeem', async () => {
  const context = await setup({ suspended: true, trialDays: -1 });
  const minted = await mint(context.db, {}, context.clock.value);
  const response = await context.redeem(await nativeLogin(context.db, 'user'), minted.code);
  assert.equal(response.status, 403);
  assert.equal((await json(response)).error, 'Conta suspensa. Fale com o suporte.');
  context.db.close();
});

test('admin mints, lists and revokes codes; revoke drops the grants', async () => {
  const context = await setup();
  await seedAccount(context.db, 'admin', { admin: true });
  const admin = await webLogin(context.db, 'admin');

  const mintedResponse = await context.post('/v1/admin/license-codes', admin, { maxUses: 5, note: 'minhas máquinas' });
  assert.equal(mintedResponse.status, 200);
  const minted = (await json(mintedResponse)).data! as { id: string; code: string };
  assert.match(minted.code, /^NEXUS-/);
  const auditRow = await context.db.prepare("SELECT action,actor_account_id FROM admin_audit WHERE action='mint_license_code'").first<Record<string, unknown>>();
  assert.equal(auditRow?.actor_account_id, 'admin');

  const list = await context.get('/v1/admin/license-codes', admin);
  const codes = (await json(list)).data!.codes as Record<string, unknown>[];
  assert.equal(codes.length, 1);
  assert.equal(codes[0].suffix, minted.code.slice(-4));
  assert.equal(codes[0].maxUses, 5);
  assert.equal(codes[0].uses, 0);
  assert.ok(!('code' in codes[0]) && !('code_hash' in codes[0]));

  // Quem não é admin não minta nem lista.
  assert.equal((await context.post('/v1/admin/license-codes', await webLogin(context.db, 'user'), {})).status, 403);
  assert.equal((await context.get('/v1/admin/license-codes', await webLogin(context.db, 'user'))).status, 403);
  // CSRF é obrigatório nas mutações.
  const { 'X-CSRF-Token': _csrf, ...withoutCsrf } = admin;
  assert.equal((await context.post('/v1/admin/license-codes', withoutCsrf, {})).status, 403);

  // O código mintado resgata de verdade; revogar derruba a concessão.
  assert.equal((await context.redeem(await nativeLogin(context.db, 'user'), minted.code)).status, 200);
  assert.equal((await context.post(`/v1/admin/license-codes/${minted.id}/revoke`, admin)).status, 200);
  assert.equal(await context.db.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE stripe_subscription_id LIKE 'codegrant:%'").first<number>('n'), 0);
  const after = await context.redeem(await nativeLogin(context.db, 'user'), 'NEXUS-XXXX-XXXX-XXXX');
  assert.equal(after.status, 400);
  const payload = await claims((await json(await context.get('/v1/license', await nativeLogin(context.db, 'user')))).data!.licenca);
  assert.equal(payload.access, 'inactive');
  assert.equal(await context.db.prepare("SELECT plan FROM accounts WHERE id='user'").first<{ plan: string }>('plan'), 'free');
  assert.equal((await context.post(`/v1/admin/license-codes/${minted.id}/revoke`, admin)).status, 409);
  context.db.close();
});

const expireGrants = (db: SqliteD1, at: number) =>
  db.prepare("UPDATE subscriptions SET current_period_end=? WHERE stripe_subscription_id LIKE 'codegrant:%'").bind(at).run();

test('a code grant (active or expired) never blocks buying Pro with Stripe', async () => {
  const context = await setup();
  const native = await nativeLogin(context.db, 'user');
  const minted = await mint(context.db, { periodDays: 30 }, context.clock.value);
  assert.equal((await context.redeem(native, minted.code)).status, 200);
  // Concessão por código não é assinatura da Stripe: o checkout segue aberto enquanto ela vale...
  assert.equal((await context.post('/v1/billing/checkout', native, { plan: 'pro' })).status, 200);
  // ...e, sobretudo, depois que ela vence (a linha continua 'active', só o período passou).
  await expireGrants(context.db, context.clock.value - 1);
  const afterExpiry = await context.post('/v1/billing/checkout', native, { plan: 'pro' });
  assert.equal(afterExpiry.status, 200, 'checkout bloqueado por uma concessão já vencida');
  context.db.close();
});

test('re-redeeming after the grant ended is refused, never reported as a working license', async () => {
  const context = await setup();
  const native = await nativeLogin(context.db, 'user');
  const minted = await mint(context.db, { periodDays: 30, maxUses: 1 }, context.clock.value);
  assert.equal((await context.redeem(native, minted.code)).status, 200);
  await expireGrants(context.db, context.clock.value - 1);
  const again = await context.redeem(native, minted.code);
  assert.equal(again.status, 400);
  assert.equal((await json(again)).error, 'Código inválido, expirado ou já utilizado.');
  context.db.close();
});

test('code grants never advertise a renewal date (a code does not renew)', async () => {
  const context = await setup();
  const native = await nativeLogin(context.db, 'user');
  const perpetual = await mint(context.db, {}, context.clock.value);
  const token = (await json(await context.redeem(native, perpetual.code))).data!.licenca;
  const payload = await claims(token);
  assert.equal(payload.access, 'pro');
  assert.equal(payload.renewsAt, null);
  context.db.close();
});

test('perpetual codes get a far horizon and timed codes stay bounded', async () => {
  const context = await setup();
  const perpetual = await mint(context.db, {}, context.clock.value);
  assert.equal((await context.redeem(await nativeLogin(context.db, 'user'), perpetual.code)).status, 200);
  const row = await context.db.prepare('SELECT current_period_end AS end FROM subscriptions WHERE stripe_subscription_id=?').bind(`codegrant:${perpetual.id}:user`).first<{ end: number }>();
  assert.ok(row!.end > context.clock.value + 99 * 365 * DAY_MS, 'código sem período deveria valer ~100 anos');
  context.db.close();
});

test('a code revoked between taking the redemption slot and granting never leaves a grant behind', async () => {
  const db = new SqliteD1();
  await seedAccount(db, 'user', { trialDays: -1 });
  const minted = await mint(db, { maxUses: 1 });
  // Simula a corrida: a revogação comita depois do INSERT do slot e antes do batch da concessão.
  const racing = new Proxy(db, {
    get(target, property, receiver) {
      if (property === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          await target.prepare('UPDATE license_codes SET revoked_at=? WHERE id=?').bind(Date.now(), minted.id).run();
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const account = await db.prepare("SELECT * FROM accounts WHERE id='user'").first<AccountRow>();
  assert.equal(await redeemLicenseCode(racing as unknown as D1Database, account!, minted.code), 'invalid');
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE stripe_subscription_id LIKE 'codegrant:%'").first<number>('n'), 0);
  assert.equal(await db.prepare("SELECT plan FROM accounts WHERE id='user'").first<string>('plan'), 'free');
  db.close();
});

test('a revoked code stays dead for the account that redeemed it and for everyone else', async () => {
  const context = await setup();
  await seedAccount(context.db, 'admin', { admin: true });
  await seedAccount(context.db, 'other', { trialDays: -1 });
  const admin = await webLogin(context.db, 'admin');
  const minted = await mint(context.db, { maxUses: 5 }, context.clock.value);
  assert.equal((await context.redeem(await nativeLogin(context.db, 'user'), minted.code)).status, 200);
  assert.equal((await context.post(`/v1/admin/license-codes/${minted.id}/revoke`, admin)).status, 200);
  // Com o código REAL (o teste antigo usava um código que nunca existiu e provava nada).
  assert.equal((await context.redeem(await nativeLogin(context.db, 'user'), minted.code)).status, 400);
  assert.equal((await context.redeem(await nativeLogin(context.db, 'other'), minted.code)).status, 400);
  assert.equal(await context.db.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE stripe_subscription_id LIKE 'codegrant:%'").first<number>('n'), 0);
  context.db.close();
});

test('admin limits and unknown ids are refused', async () => {
  const context = await setup();
  await seedAccount(context.db, 'admin', { admin: true });
  const admin = await webLogin(context.db, 'admin');
  for (const body of [{ maxUses: 101 }, { maxUses: 0 }, { periodDays: 0 }, { periodDays: 36501 }, { expiresInDays: 3651 }]) {
    assert.equal((await context.post('/v1/admin/license-codes', admin, body)).status, 400, JSON.stringify(body));
  }
  assert.equal(await context.db.prepare('SELECT COUNT(*) AS n FROM license_codes').first<number>('n'), 0);
  assert.equal((await context.post('/v1/admin/license-codes/does-not-exist/revoke', admin)).status, 404);
  context.db.close();
});

test('typed look-alikes fold to the characters the generator can emit', () => {
  // O/I/L nunca aparecem num código gerado: quem digita "O" em vez de "0" acerta.
  assert.equal(normalizeLicenseCode('nexus-ooil-ill1-0o1l'), 'NEXUS001111110011');
  assert.equal(normalizeLicenseCode(' NEXUS-AB12 '), 'NEXUSAB12');
});
