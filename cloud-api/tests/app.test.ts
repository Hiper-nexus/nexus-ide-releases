import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteD1 } from './helpers/sqlite-d1.js';
import { SITE, environment, fakeStripe, seedAccount, webLogin } from './helpers/fixtures.js';
import { createApp, cleanupExpired } from '../src/index.js';
import { pkceChallenge } from '../src/crypto.js';

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
    billing: {
      available: true, amount: 5999, currency: 'brl', interval: 'month',
      intervals: [
        { id: 'month', months: 1, amount: 5999, available: true },
        { id: 'quarter', months: 3, amount: 17997, available: false },
        { id: 'semiannual', months: 6, amount: 35994, available: false },
        { id: 'year', months: 12, amount: 71988, available: false },
      ],
    },
    trial: { days: 15, maxAgents: 6, cloudSync: false },
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
  assert.equal(body.data?.entitlement.maxAgents, 6);
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

async function startDesktopLogin(app: ReturnType<typeof createApp>, env: ReturnType<typeof environment>) {
  const started = await app.request(`/v1/auth/google?app_state=nonce&code_challenge=${await pkceChallenge('a'.repeat(43))}`, {}, env);
  assert.equal(started.status, 302);
  return new URL(started.headers.get('location')!).searchParams.get('state')!;
}
const googleProvider: typeof fetch = async input => String(input).includes('/token')
  ? Response.json({ access_token: 'tok' })
  : Response.json({ sub: 'g-1', email: 'a@example.test', email_verified: true, name: 'A' });

test('desktop login callback ends on a readable page that carries the deep link, under its own strict CSP', async () => {
  const db = new SqliteD1();
  const env = environment(db);
  const app = createApp({ fetchFn: googleProvider });
  const state = await startDesktopLogin(app, env);
  const page = await app.request(`/v1/auth/google/callback?code=provider-code&state=${state}`, {}, env);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type')!, /^text\/html/);
  const html = await page.text();
  assert.match(html, /Login concluído/);
  assert.match(html, /<a [^>]*href="nexus:\/\/auth\/[A-Za-z0-9_-]+\?state=nonce"/);
  assert.match(html, /http-equiv="refresh" content="1;url=nexus:\/\/auth\//);
  assert.doesNotMatch(html, /<script/i);
  const csp = page.headers.get('content-security-policy')!;
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /style-src 'unsafe-inline'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /script-src|unsafe-eval|https?:/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('cache-control'), 'no-store');
  db.close();
});

test('a failed login callback explains the problem and the way back instead of showing raw JSON', async () => {
  const db = new SqliteD1();
  const env = environment(db);
  const app = createApp({ fetchFn: async () => { throw new Error('boom'); } });
  const state = await startDesktopLogin(app, env);
  const page = await app.request(`/v1/auth/google/callback?code=provider-code&state=${state}`, {}, env);
  assert.equal(page.status, 502);
  assert.match(page.headers.get('content-type')!, /^text\/html/);
  const html = await page.text();
  assert.match(html, /Não foi possível concluir o login/);
  assert.match(html, /Não foi possível validar o login no provedor/);
  assert.match(html, /Abrir de novo/);
  assert.doesNotMatch(html, /\{"ok"/);
  assert.doesNotMatch(html, /boom|provider-code/);
  assert.match(page.headers.get('content-security-policy')!, /style-src 'unsafe-inline'/);
  db.close();
});

test('an expired or unknown login state also ends on the readable page, and API errors elsewhere stay JSON', async () => {
  const db = new SqliteD1();
  const env = environment(db);
  const app = createApp({ fetchFn: googleProvider });
  const page = await app.request(`/v1/auth/google/callback?code=x&state=${'a'.repeat(43)}`, {}, env);
  assert.equal(page.status, 400);
  assert.match(await page.text(), /Estado de login inválido ou vencido/);
  const api = await app.request('/v1/auth/nope', {}, env);
  assert.equal(api.status, 404);
  assert.match(api.headers.get('content-type')!, /json/);
  assert.equal(api.headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'");
  db.close();
});

test('the page HTML-escapes everything it echoes', async () => {
  const { loginErrorPage } = await import('../src/auth-pages.js');
  const { Hono } = await import('hono');
  const probe = new Hono();
  probe.get('/', c => loginErrorPage(c, '<img src=x onerror=alert(1)> & "quoted"', 400));
  const html = await (await probe.request('/')).text();
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; &amp; &quot;quoted&quot;/);
});
