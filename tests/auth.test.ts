import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { Hono } from 'hono';
import { SqliteD1 } from './helpers/sqlite-d1.js';
import { exchangeCode } from '../src/providers.js';
import { createAuthRoutes } from '../src/auth.js';
import { configFrom } from '../src/config.js';
import { pkceChallenge } from '../src/crypto.js';
import { issueTokens, sessionFor } from '../src/sessions.js';
import type { AppEnv } from '../src/context.js';
type Payload = {
    data: {
        authenticated?: boolean;
        csrfToken?: string;
        profile: {
            role: string;
            email: string;
        };
        session?: string;
        refresh?: string;
        licenca?: string;
    };
};
async function payload(response: Response): Promise<Payload> { return await response.json() as Payload; }
const SITE = 'https://www.nexuside.app';
const API = 'https://api.nexuside.app';
const VERIFIER = 'a'.repeat(43);
const keys = generateKeyPairSync('ed25519');
const config = configFrom({ PUBLIC_BASE_URL: API, PUBLIC_SITE_URL: SITE, APP_DEEP_LINK_BASE: 'nexus://auth', ADMIN_EMAILS: 'admin@example.test', GOOGLE_OAUTH_ID: 'test-google', GOOGLE_OAUTH_SECRET: 'fixture-secret', GITHUB_OAUTH_ID: 'test-github', GITHUB_OAUTH_SECRET: 'fixture-secret', LICENSE_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), LICENSE_PUBLIC_KEY: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() });
function environment(db: SqliteD1): CloudflareBindings { return { DB: db, AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) }, API_RATE_LIMITER: { limit: async () => ({ success: true }) }, PUBLIC_BASE_URL: 'https://nexuside.app', PUBLIC_SITE_URL: 'https://nexuside.app', APP_DEEP_LINK_BASE: 'nexus://auth', APP_MODE: 'staging', MIGRATION_READY: 'false', STRIPE_PRICE_PRO: '', STRIPE_PRICE_TEAM: '', GITHUB_OAUTH_ID: '', GOOGLE_OAUTH_ID: '' }; }
function app(fetchFn: typeof fetch = async () => Response.json({ access_token: 'provider-token' })) { const router = new Hono<AppEnv>(); router.use('*', async (c, next) => { c.set('config', config); await next(); }); router.route('/v1', createAuthRoutes(fetchFn)); return router; }
function googleFetch(verified = true): typeof fetch { return async (input, init) => { const url = String(input); if (url.includes('/token')) {
    assert.equal(new Headers(init?.headers).get('content-type'), 'application/x-www-form-urlencoded');
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get('redirect_uri'), API + '/v1/auth/google/callback');
    assert.ok(body.get('code_verifier'));
    return Response.json({ access_token: 'provider-token' });
} assert.equal(url, 'https://openidconnect.googleapis.com/v1/userinfo'); return Response.json({ sub: 'google-user', email: 'admin@example.test', email_verified: verified, name: 'Admin', picture: 'https://example.test/avatar.png' }); }; }
function cookies(response: Response): string { return response.headers.getSetCookie().map(value => value.split(';')[0]).join('; '); }
async function start(router: Hono<AppEnv>, env: CloudflareBindings, web = false) { const path = web ? '/v1/web/auth/google' : `/v1/auth/google?app_state=nonce&code_challenge=${await pkceChallenge(VERIFIER)}`; const response = await router.request(path, {}, env); assert.equal(response.status, 302); return { state: new URL(response.headers.get('location')!).searchParams.get('state')!, cookie: cookies(response), response }; }
async function callback(router: Hono<AppEnv>, env: CloudflareBindings, state: string, cookie = '') { return router.request(`/v1/auth/google/callback?code=provider-code&state=${state}`, { headers: { Cookie: cookie } }, env); }
async function account(db: SqliteD1) { await db.prepare("INSERT INTO accounts(id,email,name) VALUES('account','user@example.test','User')").run(); return issueTokens(db, 'account', 'web'); }
test('desktop initiation requires nonce and nonduplicated S256 challenge', async () => { const db = new SqliteD1(); const router = app(); const env = environment(db); for (const query of ['', `?app_state=nonce`, `?app_state=nonce&code_challenge=bad`, `?app_state=nonce&code_challenge=${'a'.repeat(43)}&code_challenge=${'b'.repeat(43)}`])
    assert.equal((await router.request('/v1/auth/google' + query, {}, env)).status, 400); assert.equal((await db.prepare('SELECT count(*) AS n FROM oauth_states').first<{
    n: number;
}>())?.n, 0); db.close(); });
test('web proof is validated before state consumption and callback is single use', async () => { const db = new SqliteD1(); const env = environment(db); const router = app(googleFetch()); const login = await start(router, env, true); assert.equal(new URL(login.response.headers.get('location')!).searchParams.get('redirect_uri'), API + '/v1/auth/google/callback'); assert.match(login.response.headers.getSetCookie()[0], /HttpOnly/); assert.equal((await callback(router, env, login.state)).status, 400); assert.ok(await db.prepare('SELECT state FROM oauth_states WHERE state=?').bind(login.state).first()); const result = await callback(router, env, login.state, login.cookie); assert.equal(result.status, 302); assert.equal(result.headers.get('location'), SITE + '/conta'); for (const cookie of result.headers.getSetCookie()) {
    assert.match(cookie, /Secure/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Path=\//);
} assert.equal((await callback(router, env, login.state, login.cookie)).status, 400); db.close(); });
test('desktop exchange enforces PKCE then atomically consumes code', async () => { const db = new SqliteD1(); const env = environment(db); const router = app(googleFetch()); const login = await start(router, env); const result = await callback(router, env, login.state); assert.equal(result.status, 302); const deepLink = new URL(result.headers.get('location')!); assert.equal(deepLink.protocol, 'nexus:'); assert.equal(deepLink.searchParams.get('state'), 'nonce'); const code = deepLink.pathname.split('/').at(-1); assert.ok(code); const exchange = (body: unknown) => router.request('/v1/auth/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, env); assert.equal((await exchange({ code })).status, 400); assert.equal((await exchange({ code, code_verifier: 'b'.repeat(43) })).status, 400); const winners = await Promise.all([exchange({ code, code_verifier: VERIFIER }), exchange({ code, code_verifier: VERIFIER })]); assert.deepEqual(winners.map(value => value.status).sort(), [200, 400]); const success = winners.find(value => value.status === 200)!; const data = (await payload(success)).data; assert.equal(typeof data.licenca, 'string'); assert.ok(await sessionFor(db, data.session!, 'desktop')); assert.equal(await sessionFor(db, data.session!, 'web'), null); db.close(); });
test('unverified Google email cannot acquire configured admin authority', async () => { const db = new SqliteD1(); const env = environment(db); const router = app(googleFetch(false)); const login = await start(router, env, true); const result = await callback(router, env, login.state, login.cookie); const session = await router.request('/v1/web/session', { headers: { Origin: SITE, Cookie: cookies(result) } }, env); assert.equal(session.status, 200); const body = await payload(session); assert.equal(body.data.profile.role, 'user'); assert.equal(body.data.profile.email, ''); assert.equal(JSON.stringify(body).includes('provider-token'), false); db.close(); });
test('web session rejects cross-origin reads and returns CSRF without auth tokens', async () => { const db = new SqliteD1(); const tokens = await account(db); const env = environment(db); const router = app(); const cookie = `__Host-nexus_session=${tokens.session}; __Host-nexus_refresh=${tokens.refresh}; __Host-nexus_csrf=${tokens.csrf}`; for (const origin of [undefined, 'https://evil.test', SITE + '.evil.test'])
    assert.equal((await router.request('/v1/web/session', { headers: { Cookie: cookie, ...(origin ? { Origin: origin } : {}) } }, env)).status, 403); const response = await router.request('/v1/web/session', { headers: { Cookie: cookie, Origin: SITE } }, env); const body = await payload(response); assert.equal(body.data.authenticated, true); assert.equal(body.data.csrfToken, tokens.csrf); assert.equal(body.data.session, undefined); assert.equal(body.data.refresh, undefined); assert.equal(response.headers.get('cache-control'), 'no-store'); db.close(); });
test('web refresh rotates expired session and refuses desktop refresh cookies', async () => { const db = new SqliteD1(); const tokens = await account(db); const env = environment(db); const router = app(); await db.exec('UPDATE sessions SET expires_at=1'); const response = await router.request('/v1/web/session', { headers: { Origin: SITE, Cookie: `__Host-nexus_refresh=${tokens.refresh}` } }, env); assert.equal(response.status, 200); assert.equal((await payload(response)).data.authenticated, true); assert.match(cookies(response), /__Host-nexus_session=/); const native = await issueTokens(db, 'account', 'desktop'); const invalid = await router.request('/v1/web/session', { headers: { Origin: SITE, Cookie: `__Host-nexus_refresh=${native.refresh}` } }, env); assert.equal((await payload(invalid)).data.authenticated, false); assert.ok(await sessionFor(db, native.session, 'desktop')); db.close(); });
test('web logout requires CSRF and only revokes web sessions', async () => { const db = new SqliteD1(); const web = await account(db); const native = await issueTokens(db, 'account', 'desktop'); const env = environment(db); const router = app(); const cookie = `__Host-nexus_session=${web.session}; __Host-nexus_csrf=${web.csrf}`; for (const token of [undefined, 'wrong'])
    assert.equal((await router.request('/v1/web/logout', { method: 'POST', headers: { Origin: SITE, Cookie: cookie, ...(token ? { 'X-CSRF-Token': token } : {}) } }, env)).status, 403); const response = await router.request('/v1/web/logout', { method: 'POST', headers: { Origin: SITE, Cookie: cookie, 'X-CSRF-Token': web.csrf! } }, env); assert.equal(response.status, 200); assert.equal(await sessionFor(db, web.session, 'web'), null); assert.ok(await sessionFor(db, native.session, 'desktop')); assert.match(response.headers.getSetCookie().join(' '), /Max-Age=0/); db.close(); });
test('expired OAuth states never reach provider and oversized provider response fails safely', async () => { const db = new SqliteD1(); const env = environment(db); let calls = 0; const router = app(async () => { calls++; return Response.json({ access_token: 'x'.repeat(70000) }); }); const login = await start(router, env); await db.exec('UPDATE oauth_states SET expires_at=1'); assert.equal((await callback(router, env, login.state)).status, 400); assert.equal(calls, 0); const second = await start(router, env); assert.equal((await callback(router, env, second.state)).status, 502); assert.equal((await db.prepare('SELECT count(*) AS n FROM accounts').first<{
    n: number;
}>())?.n, 0); db.close(); });
test('GitHub uses only verified primary email', async () => { const db = new SqliteD1(); const env = environment(db); const router = app(async (input) => { const url = String(input); if (url.endsWith('/access_token'))
    return Response.json({ access_token: 'token' }); if (url.endsWith('/emails'))
    return Response.json([{ email: 'admin@example.test', primary: true, verified: false }, { email: 'other@example.test', primary: false, verified: true }]); return Response.json({ id: 123, login: 'github-user', email: 'admin@example.test' }); }); const response = await router.request('/v1/web/auth/github', {}, env); const state = new URL(response.headers.get('location')!).searchParams.get('state'); const done = await router.request(`/v1/auth/github/callback?state=${state}&code=code`, { headers: { Cookie: cookies(response) } }, env); assert.equal(done.status, 302); const identity = await db.prepare('SELECT email,email_verified FROM identities').first<{
    email: string | null;
    email_verified: number;
}>(); assert.equal(identity?.email, null); assert.equal(identity?.email_verified, 0); db.close(); });

test('malformed provider identity is rejected without creating an account', async () => {
    const db = new SqliteD1();
    const env = environment(db);
    const router = app(async (input) => String(input).includes('/token') ? Response.json({ access_token: 'token' }) : Response.json({ sub: 123, email: 'admin@example.test', email_verified: true }));
    const login = await start(router, env, true);
    const response = await callback(router, env, login.state, login.cookie);
    assert.equal(response.status, 502);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM accounts').first<{ n: number }>())?.n, 0);
    assert.equal((await response.text()).includes('123'), false);
    db.close();
});

test('valid web session recovers missing or forged CSRF cookie with new cookie-bound proof', async () => {
    const db = new SqliteD1();
    const tokens = await account(db);
    let rawSession = tokens.session;
    const env = environment(db);
    const router = app();
    for (const csrfCookie of ['', '; __Host-nexus_csrf=forged']) {
        const response = await router.request('/v1/web/session', { headers: { Origin: SITE, Cookie: `__Host-nexus_session=${rawSession}${csrfCookie}` } }, env);
        assert.equal(response.status, 200);
        const result = await payload(response);
        assert.equal(result.data.authenticated, true);
        assert.notEqual(result.data.csrfToken, 'forged');
        const logout = await router.request('/v1/web/logout', { method: 'POST', headers: { Origin: SITE, Cookie: cookies(response), 'X-CSRF-Token': result.data.csrfToken! } }, env);
        assert.equal(logout.status, 200);
        if (!csrfCookie) {
            const fresh = await issueTokens(db, 'account', 'web');
            rawSession = fresh.session;
        }
    }
    db.close();
});

test('authenticated native profile refuses web bearer and web refresh replay stays channel-scoped', async () => {
    const db = new SqliteD1();
    const web = await account(db);
    const native = await issueTokens(db, 'account', 'desktop');
    const env = environment(db);
    const router = app();
    assert.equal((await router.request('/v1/me', { headers: { Authorization: `Bearer ${web.session}` } }, env)).status, 401);
    assert.equal((await router.request('/v1/me', { headers: { Authorization: `Bearer ${native.session}` } }, env)).status, 200);
    const refresh = () => router.request('/v1/web/session', { headers: { Origin: SITE, Cookie: `__Host-nexus_refresh=${web.refresh}` } }, env);
    assert.equal((await payload(await refresh())).data.authenticated, true);
    assert.equal((await payload(await refresh())).data.authenticated, false);
    assert.ok(await sessionFor(db, native.session, 'desktop'));
    db.close();
});


test('provider request deadline aborts stalled requests and rejects even if fetch ignores abort', { timeout: 1000 }, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let aborted = false;
    const stalled: typeof fetch = async (_input, init) => new Promise<Response>(() => {
        init?.signal?.addEventListener('abort', () => { aborted = true; });
    });
    const result = exchangeCode('google', { code: 'fixture', verifier: VERIFIER, clientId: 'id', clientSecret: 'secret', redirectUri: API + '/v1/auth/google/callback' }, stalled);
    const rejection = assert.rejects(result, error => error instanceof Error && 'status' in error && error.status === 502);
    t.mock.timers.tick(8000);
    assert.equal(aborted, true);
    await rejection;
});
