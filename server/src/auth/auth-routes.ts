import { Router } from 'express';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import type { Env } from '../env';
import { accounts, authCodes, identities, oauthStates } from '../db/schema';
import { authorizeUrl, exchangeCode, makePkce } from './oauth-flow';
import { type Provider } from './oauth-providers';
import { consumeAuthCode } from './auth-code-service';
import { findOrCreateAccount } from './account-service';
import { issueTokens, rotateRefresh, revokeAll } from './session-service';
import { hashToken, newToken } from './tokens';
import { freeLicenseInput, signLicense } from './license-signer';
import { asyncHandler as ah } from '../middleware/errors';
import { rateLimit } from '../middleware/rate-limit';
import { requireAuth } from '../middleware/require-auth';

export interface AuthDeps {
  db: Db;
  env: Env;
  fetchFn: typeof fetch;
  now?: () => number;
}

const STATE_TTL = 10 * 60 * 1000;
const CODE_TTL = 60 * 1000;
/** Nonce do desktop: mesmo conjunto seguro do deep link, com teto. */
const APP_STATE_RE = /^[A-Za-z0-9._~-]{1,128}$/;

function isProvider(p: string): p is Provider {
  return p === 'github' || p === 'google';
}
function providerCreds(env: Env, p: Provider) {
  return p === 'github'
    ? { id: env.GITHUB_OAUTH_ID, secret: env.GITHUB_OAUTH_SECRET }
    : { id: env.GOOGLE_OAUTH_ID, secret: env.GOOGLE_OAUTH_SECRET };
}

export function buildAuthRouter(deps: AuthDeps): Router {
  const { db, env, fetchFn } = deps;
  const now = deps.now ?? Date.now;
  const r = Router();
  const authLimit = rateLimit({ windowMs: 60_000, max: 20 });
  const redirectUri = (p: Provider) => `${env.PUBLIC_BASE_URL}/v1/auth/${p}/callback`;

  r.get('/auth/:provider', authLimit, ah(async (req, res) => {
    const p = String(req.params.provider);
    if (!isProvider(p)) return res.status(404).json({ ok: false, error: 'provider' });
    // O login SÓ nasce no desktop: sem o nonce local (app_state) não há como
    // o app validar o retorno, então o fluxo nem começa (anti login-CSRF).
    const appState = String(req.query.app_state ?? '');
    if (!APP_STATE_RE.test(appState)) {
      return res.status(400).json({ ok: false, error: 'app_state obrigatório' });
    }
    const state = newToken();
    const { verifier, challenge } = makePkce();
    await db.insert(oauthStates).values({
      state, provider: p, codeVerifier: verifier, appState,
      expiresAt: new Date(now() + STATE_TTL),
    });
    res.redirect(authorizeUrl(p, {
      clientId: providerCreds(env, p).id,
      redirectUri: redirectUri(p), state, challenge,
    }));
  }));

  r.get('/auth/:provider/callback', authLimit, ah(async (req, res) => {
    const p = String(req.params.provider);
    if (!isProvider(p)) return res.status(404).json({ ok: false, error: 'provider' });
    const code = String(req.query.code ?? '');
    const state = String(req.query.state ?? '');
    const [st] = await db.select().from(oauthStates)
      .where(and(eq(oauthStates.state, state), eq(oauthStates.provider, p))).limit(1);
    if (!st || st.expiresAt.getTime() < now()) {
      return res.status(400).json({ ok: false, error: 'state inválido' });
    }
    await db.delete(oauthStates).where(eq(oauthStates.state, state));
    const creds = providerCreds(env, p);
    const profile = await exchangeCode(p, {
      code, verifier: st.codeVerifier, clientId: creds.id,
      clientSecret: creds.secret, redirectUri: redirectUri(p),
    }, { fetchFn });
    const { accountId } = await findOrCreateAccount(db, profile);
    const rawCode = newToken();
    await db.insert(authCodes).values({
      codeHash: hashToken(rawCode), accountId,
      expiresAt: new Date(now() + CODE_TTL),
    });
    // Devolve o nonce do desktop: o app rejeita o deep link se não casar
    // com o login pendente que ele mesmo iniciou.
    res.redirect(`${env.APP_DEEP_LINK_BASE}/${rawCode}?state=${st.appState}`);
  }));

  r.post('/auth/exchange', authLimit, ah(async (req, res) => {
    const code = String((req.body as { code?: string }).code ?? '');
    const consumed = await consumeAuthCode(db, code, now); // atômico, single-use
    if (!consumed) {
      return res.status(400).json({ ok: false, error: 'code inválido' });
    }
    const [acc] = await db.select().from(accounts).where(eq(accounts.id, consumed.accountId)).limit(1);
    const { session, refresh } = await issueTokens(db, consumed.accountId, now);
    const licenca = await signLicense(freeLicenseInput(acc.email), env.LICENSE_PRIVATE_KEY);
    res.json({ ok: true, data: { session, refresh, licenca } });
  }));

  r.post('/auth/refresh', authLimit, ah(async (req, res) => {
    const raw = String((req.body as { refresh?: string }).refresh ?? '');
    const out = await rotateRefresh(db, raw, now);
    if ('reuseDetected' in out) return res.status(401).json({ ok: false, error: 'refresh inválido' });
    res.json({ ok: true, data: out });
  }));

  r.post('/auth/logout', requireAuth(db), ah(async (req, res) => {
    await revokeAll(db, req.accountId!);
    res.json({ ok: true });
  }));

  r.post('/auth/link', requireAuth(db), ah(async (req, res) => {
    // Vincula um provider já autorizado. Recebe {code} de um segundo fluxo
    // callback que criou uma conta isolada; move as identities para a conta
    // logada e apaga a isolada.
    const code = String((req.body as { code?: string }).code ?? '');
    const consumed = await consumeAuthCode(db, code, now); // atômico, single-use
    if (!consumed) {
      return res.status(400).json({ ok: false, error: 'code inválido' });
    }
    if (consumed.accountId !== req.accountId) {
      // Merge destrutivo bloqueado se a origem tem billing: apagar uma conta
      // com plano pago/Stripe descartaria a assinatura silenciosamente.
      const [src] = await db.select().from(accounts)
        .where(eq(accounts.id, consumed.accountId)).limit(1);
      if (src && (src.plan !== 'free' || src.stripeCustomerId)) {
        return res.status(409).json({
          ok: false,
          error: 'conta de origem tem billing ativo — contate o suporte',
        });
      }
      // Transação: mover identities e apagar a origem é tudo-ou-nada.
      await db.transaction(async (tx) => {
        await tx.update(identities).set({ accountId: req.accountId! })
          .where(eq(identities.accountId, consumed.accountId));
        await tx.delete(accounts).where(eq(accounts.id, consumed.accountId));
      });
    }
    res.json({ ok: true });
  }));

  r.get('/me', requireAuth(db), ah(async (req, res) => {
    const [acc] = await db.select().from(accounts).where(eq(accounts.id, req.accountId!)).limit(1);
    res.json({ ok: true, data: { email: acc.email, name: acc.name, plan: acc.plan } });
  }));

  r.delete('/me', requireAuth(db), ah(async (req, res) => {
    await db.delete(accounts).where(eq(accounts.id, req.accountId!)); // cascade
    res.json({ ok: true });
  }));

  return r;
}
