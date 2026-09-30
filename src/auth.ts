import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { AppEnv } from './context.js';
import type { AccountRow, OAuthStateRow, Provider } from './db/schema.js';
import { authConfigured, type Config } from './config.js';
import { findOrCreateAccount } from './accounts.js';
import { consumeAuthCode, issueTokens, rotateRefresh, revokeAll, sessionFor, SESSION_TTL_MS, REFRESH_TTL_MS, type Tokens } from './sessions.js';
import { hashToken, pkceChallenge, randomToken, safeEqual } from './crypto.js';
import { authorizeUrl, exchangeCode } from './providers.js';
import { jsonBody, isAllowedWebOrigin } from './http.js';
import { accountAccess } from './access.js';
import { isAuthorizedAdmin } from './admin-identity.js';
import { licenseForAccount } from './licences.js';
import { requireNativeAuth, requireWebAuth, requireCsrf } from './middleware.js';
const STATE_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 60 * 1000;
const APP_STATE = /^[A-Za-z0-9._~-]{1,128}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const TOKEN = z.string().regex(CHALLENGE);
const exchangeSchema = z.strictObject({ code: TOKEN, code_verifier: z.string().regex(VERIFIER) });
const refreshSchema = z.strictObject({ refresh: TOKEN });
const WEB_COOKIES = ['__Host-nexus_session', '__Host-nexus_refresh', '__Host-nexus_csrf', '__Host-nexus_oauth_state'] as const;
const cookieOptions = { httpOnly: true, secure: true, sameSite: 'Lax' as const, path: '/' };
type AuthContext = Context<AppEnv>;
export function setWebCookies(c: AuthContext, tokens: Tokens): void {
    setCookie(c, '__Host-nexus_session', tokens.session, { ...cookieOptions, maxAge: SESSION_TTL_MS / 1000 });
    setCookie(c, '__Host-nexus_refresh', tokens.refresh, { ...cookieOptions, maxAge: REFRESH_TTL_MS / 1000 });
    if (tokens.csrf)
        setCookie(c, '__Host-nexus_csrf', tokens.csrf, { ...cookieOptions, maxAge: SESSION_TTL_MS / 1000 });
}
export function clearWebCookies(c: AuthContext): void {
    for (const cookie of WEB_COOKIES)
        setCookie(c, cookie, '', { ...cookieOptions, maxAge: 0 });
}
function providerOf(value: string): Provider {
    if (value !== 'google' && value !== 'github')
        throw new HTTPException(404, { message: 'Provedor não disponível.' });
    return value;
}
function credentials(config: Config, provider: Provider) {
    if (!authConfigured(config, provider))
        throw new HTTPException(503, { message: 'Este login ainda não está disponível.' });
    return provider === 'google' ? { clientId: config.GOOGLE_OAUTH_ID, clientSecret: config.GOOGLE_OAUTH_SECRET } : { clientId: config.GITHUB_OAUTH_ID, clientSecret: config.GITHUB_OAUTH_SECRET };
}
function query(c: AuthContext, name: string): string {
    const values = c.req.queries(name);
    if (!values || values.length !== 1)
        throw new HTTPException(400, { message: 'Parâmetros de login inválidos.' });
    return values[0];
}
function callbackUri(config: Config, provider: Provider): string { return `${config.PUBLIC_BASE_URL}/v1/auth/${provider}/callback`; }
async function profileFor(c: AuthContext, accountId: string) {
    const account = await c.env.DB.prepare('SELECT * FROM accounts WHERE id=?').bind(accountId).first<AccountRow>();
    if (!account)
        throw new HTTPException(401, { message: 'Conta não disponível.' });
    const role = await isAuthorizedAdmin(c.env.DB, account.id, c.get('config')) ? 'admin' : 'user';
    return { id: account.id, email: account.email.includes('@') ? account.email : '', name: account.name, plan: account.plan, role };
}
async function startOAuth(c: AuthContext, web: boolean) {
    const provider = providerOf(c.req.param('provider') ?? '');
    const config = c.get('config');
    const creds = credentials(config, provider);
    const appState = web ? null : query(c, 'app_state');
    const desktopChallenge = web ? null : query(c, 'code_challenge');
    if ((!web && (!APP_STATE.test(appState!) || !CHALLENGE.test(desktopChallenge!))))
        throw new HTTPException(400, { message: 'Estado e PKCE válidos são obrigatórios.' });
    const state = randomToken(), verifier = randomToken(), proof = web ? randomToken() : null;
    const now = Date.now();
    await c.env.DB.prepare('INSERT INTO oauth_states(state,provider,code_verifier,app_state,code_challenge,created_at,expires_at,flow,web_state_hash) VALUES(?,?,?,?,?,?,?,?,?)').bind(state, provider, verifier, appState, desktopChallenge, now, now + STATE_TTL_MS, web ? 'web' : 'desktop', proof ? await hashToken(proof) : null).run();
    if (proof)
        setCookie(c, '__Host-nexus_oauth_state', proof, { ...cookieOptions, maxAge: STATE_TTL_MS / 1000 });
    return c.redirect(authorizeUrl(provider, { ...creds, redirectUri: callbackUri(config, provider), state, challenge: await pkceChallenge(verifier) }));
}
async function consumeState(c: AuthContext, provider: Provider): Promise<OAuthStateRow> {
    const state = query(c, 'state');
    if (!CHALLENGE.test(state))
        throw new HTTPException(400, { message: 'Estado de login inválido.' });
    const row = await c.env.DB.prepare('SELECT * FROM oauth_states WHERE state=? AND provider=? AND expires_at>?').bind(state, provider, Date.now()).first<OAuthStateRow>();
    if (!row)
        throw new HTTPException(400, { message: 'Estado de login inválido ou vencido.' });
    if (row.flow === 'web') {
        const proof = getCookie(c, '__Host-nexus_oauth_state');
        if (!proof || !row.web_state_hash || !safeEqual(await hashToken(proof), row.web_state_hash))
            throw new HTTPException(400, { message: 'O login deve ser concluído no navegador que o iniciou.' });
    }
    else if (!row.app_state || !APP_STATE.test(row.app_state) || !row.code_challenge || !CHALLENGE.test(row.code_challenge)) {
        throw new HTTPException(400, { message: 'Estado de login inválido.' });
    }
    const consumed = await c.env.DB.prepare('DELETE FROM oauth_states WHERE state=? AND provider=? AND expires_at>? RETURNING *').bind(state, provider, Date.now()).first<OAuthStateRow>();
    if (!consumed)
        throw new HTTPException(400, { message: 'Este login já foi concluído.' });
    return consumed;
}
async function finishOAuth(c: AuthContext, fetchFn: typeof fetch) {
    const provider = providerOf(c.req.param('provider') ?? '');
    const config = c.get('config');
    const creds = credentials(config, provider);
    const code = query(c, 'code');
    if (!code || code.length > 2048)
        throw new HTTPException(400, { message: 'Código de login inválido.' });
    const state = await consumeState(c, provider);
    const profile = await exchangeCode(provider, { ...creds, code, verifier: state.code_verifier, redirectUri: callbackUri(config, provider) }, fetchFn);
    const account = await findOrCreateAccount(c.env.DB, profile, config);
    if (state.flow === 'web') {
        setWebCookies(c, await issueTokens(c.env.DB, account.id, 'web'));
        setCookie(c, '__Host-nexus_oauth_state', '', { ...cookieOptions, maxAge: 0 });
        return c.redirect(`${config.PUBLIC_SITE_URL}/conta`);
    }
    const rawCode = randomToken(), now = Date.now();
    await c.env.DB.prepare('INSERT INTO auth_codes(code_hash,account_id,expires_at,created_at,code_challenge) VALUES(?,?,?,?,?)').bind(await hashToken(rawCode), account.id, now + CODE_TTL_MS, now, state.code_challenge).run();
    return c.redirect(`${config.APP_DEEP_LINK_BASE}/${rawCode}?state=${encodeURIComponent(state.app_state!)}`);
}
async function webSession(c: AuthContext) {
    const rawSession = getCookie(c, '__Host-nexus_session'), rawRefresh = getCookie(c, '__Host-nexus_refresh');
    if (!rawSession && !rawRefresh)
        return c.json({ ok: true, data: { authenticated: false } });
    const config = c.get('config');
    if (!isAllowedWebOrigin(c.req.header('Origin'), config.PUBLIC_SITE_URL))
        throw new HTTPException(403, { message: 'Origem não autorizada.' });
    const session = rawSession ? await sessionFor(c.env.DB, rawSession, 'web') : null;
    let accountId = session?.account_id, csrf = getCookie(c, '__Host-nexus_csrf');
    if (!session) {
        const rotated = rawRefresh ? await rotateRefresh(c.env.DB, rawRefresh, 'web') : null;
        if (!rotated) {
            clearWebCookies(c);
            return c.json({ ok: true, data: { authenticated: false } });
        }
        accountId = rotated.accountId;
        csrf = rotated.tokens.csrf ?? undefined;
        setWebCookies(c, rotated.tokens);
    }
    else if (!csrf || !session.csrf_hash || !safeEqual(await hashToken(csrf), session.csrf_hash)) {
        const tokens = await issueTokens(c.env.DB, session.account_id, 'web');
        csrf = tokens.csrf ?? undefined;
        setWebCookies(c, tokens);
    }
    const profile = await profileFor(c, accountId!);
    // Managing billing depends on having a Stripe customer, never on app access: a suspended subscriber must still reach the portal.
    const customer = await c.env.DB.prepare('SELECT stripe_customer_id AS id FROM accounts WHERE id=?').bind(accountId).first<{ id: string | null }>();
    return c.json({ ok: true, data: { authenticated: true, csrfToken: csrf, profile, entitlement: await accountAccess(c.env.DB, accountId!, config), billing: { portal: Boolean(customer?.id) } } });
}
export function createAuthRoutes(fetchFn: typeof fetch = fetch): Hono<AppEnv> {
    const routes = new Hono<AppEnv>();
    routes.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
    routes.get('/auth/:provider', c => startOAuth(c, false));
    routes.get('/web/auth/:provider', c => startOAuth(c, true));
    routes.get('/auth/:provider/callback', c => finishOAuth(c, fetchFn));
    routes.post('/auth/exchange', async (c) => {
        const body = await jsonBody(c.req.raw, exchangeSchema);
        const accountId = await consumeAuthCode(c.env.DB, body.code, body.code_verifier, pkceChallenge);
        if (!accountId)
            throw new HTTPException(400, { message: 'Código de login inválido ou já utilizado.' });
        const licenca = await licenseForAccount(c.env.DB, accountId, c.get('config'));
        const { session, refresh } = await issueTokens(c.env.DB, accountId, 'desktop');
        return c.json({ ok: true, data: { session, refresh, licenca } });
    });
    routes.post('/auth/refresh', async (c) => {
        const body = await jsonBody(c.req.raw, refreshSchema);
        const rotated = await rotateRefresh(c.env.DB, body.refresh, 'desktop');
        if (!rotated)
            throw new HTTPException(401, { message: 'Sessão inválida. Entre novamente.' });
        const { session, refresh } = rotated.tokens;
        return c.json({ ok: true, data: { session, refresh, licenca: await licenseForAccount(c.env.DB, rotated.accountId, c.get('config')) } });
    });
    routes.post('/auth/logout', requireNativeAuth, async (c) => { await revokeAll(c.env.DB, c.get('session').account_id); return c.json({ ok: true }); });
    routes.get('/me', requireNativeAuth, async (c) => c.json({ ok: true, data: await profileFor(c, c.get('session').account_id) }));
    routes.get('/web/session', webSession);
    routes.post('/web/logout', requireWebAuth, requireCsrf, async (c) => { await revokeAll(c.env.DB, c.get('session').account_id, Date.now(), 'web'); clearWebCookies(c); return c.json({ ok: true, data: {} }); });
    return routes;
}
export const authRoutes = createAuthRoutes();
