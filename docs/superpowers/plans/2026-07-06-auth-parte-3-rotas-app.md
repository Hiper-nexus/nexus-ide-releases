# Auth/Contas — Plan (Parte 3/3: rotas, rate-limit, encaixe no app)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> Sequência: Partes 1 e 2 são PRÉ-REQUISITOS. **Global Constraints:** ver Parte 1.
> Spec: `docs/superpowers/specs/2026-07-06-auth-contas-design.md`.

**Goal:** As rotas Express `/v1/auth/*` ligando os services, rate-limit por IP, `require-auth`, `/me` + `DELETE /me`, e o encaixe no app (caso `auth` no deep-link + `auth-client` + botão de login).

**Architecture:** Rotas são cascas finas que chamam os services puros das Partes 1–2. O `oauth_state` e o `auth_code` (só-hash) fecham o loop code-exchange. O app captura o code via deep-link e troca por tokens que guarda no Keychain.

**Tech Stack:** Express, Drizzle, supertest, vitest, pglite; app: Electron/TS.

## Interfaces das Partes 1–2 (consumidas aqui)

- Signer: `signLicense`, `freeLicenseInput` (`auth/license-signer.ts`).
- OAuth: `authorizeUrl(provider, {...})`, `exchangeCode(provider, {...}, {fetchFn})`, `makePkce`, `PROVIDERS`, `Provider`, `OAuthProfile`.
- Conta: `findOrCreateAccount(db, profile)`, `linkIdentity(db, accountId, profile)`.
- Sessão: `issueTokens(db, acc)`, `rotateRefresh(db, refresh)`, `revokeAll(db, acc)`, `sessionAccount(db, session)`.
- Tokens: `newToken`, `hashToken` (`auth/tokens.ts`).
- Db: `makeDb`, `Db`; schema `accounts/oauthStates/authCodes` etc.; `Env`/`parseEnv`.

---

### Task 8: middlewares — rate-limit + require-auth

**Files:**
- Create: `server/src/middleware/rate-limit.ts`
- Create: `server/src/middleware/require-auth.ts`
- Test: `server/src/middleware/rate-limit.test.ts`

**Interfaces:**
- Produces:
  - `rateLimit(opts: { windowMs: number; max: number; now?: () => number }): RequestHandler` — 429 quando estoura por IP; janela deslizante em memória.
  - `requireAuth(db: Db): RequestHandler` — Bearer → `req.accountId`; 401 se inválido. Augmenta `Express.Request` com `accountId?: string`.

- [ ] **Step 1: teste que falha (rate-limit puro via handler)**

```ts
// server/src/middleware/rate-limit.test.ts
import { describe, expect, it, vi } from 'vitest';
import { rateLimit } from './rate-limit';

function call(handler: ReturnType<typeof rateLimit>, ip: string) {
  const req = { ip } as never;
  const res = {
    statusCode: 200,
    status(c: number) { this.statusCode = c; return this; },
    json() { return this; },
  } as never;
  const next = vi.fn();
  handler(req, res, next);
  return { status: (res as { statusCode: number }).statusCode, nexted: (next as ReturnType<typeof vi.fn>).mock.calls.length > 0 };
}

describe('rateLimit', () => {
  it('libera até o teto e bloqueia (429) o excedente por IP', () => {
    let t = 0;
    const rl = rateLimit({ windowMs: 1000, max: 2, now: () => t });
    expect(call(rl, 'A').nexted).toBe(true);
    expect(call(rl, 'A').nexted).toBe(true);
    expect(call(rl, 'A').status).toBe(429); // 3ª estoura
    expect(call(rl, 'B').nexted).toBe(true); // outro IP livre
  });

  it('a janela desliza: após windowMs libera de novo', () => {
    let t = 0;
    const rl = rateLimit({ windowMs: 1000, max: 1, now: () => t });
    expect(call(rl, 'A').nexted).toBe(true);
    expect(call(rl, 'A').status).toBe(429);
    t = 1001;
    expect(call(rl, 'A').nexted).toBe(true);
  });
});
```

- [ ] **Step 2: rodar e ver falhar** — FAIL
- [ ] **Step 3: implementar `rate-limit.ts`**

```ts
// server/src/middleware/rate-limit.ts
import type { RequestHandler } from 'express';

/** Rate limit por IP com janela deslizante em memória (espelha o padrão da
 *  remote-bridge do app). Suficiente p/ um container; multi-instância usaria
 *  um store compartilhado (fora do escopo v1). */
export function rateLimit(opts: {
  windowMs: number;
  max: number;
  now?: () => number;
}): RequestHandler {
  const now = opts.now ?? Date.now;
  const hits = new Map<string, number[]>();
  return (req, res, next) => {
    const ip = req.ip ?? 'unknown';
    const t = now();
    const arr = (hits.get(ip) ?? []).filter((ts) => t - ts < opts.windowMs);
    if (arr.length >= opts.max) {
      res.status(429).json({ ok: false, error: 'rate limited' });
      return;
    }
    arr.push(t);
    hits.set(ip, arr);
    next();
  };
}
```

- [ ] **Step 4: implementar `require-auth.ts`**

```ts
// server/src/middleware/require-auth.ts
import type { RequestHandler } from 'express';
import type { Db } from '../db/client';
import { sessionAccount } from '../auth/session-service';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      accountId?: string;
    }
  }
}

export function requireAuth(db: Db): RequestHandler {
  return async (req, res, next) => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
    const accountId = token ? await sessionAccount(db, token) : null;
    if (!accountId) {
      res.status(401).json({ ok: false, error: 'não autenticado' });
      return;
    }
    req.accountId = accountId;
    next();
  };
}
```

- [ ] **Step 5: rodar e ver passar** — PASS (2 testes)
- [ ] **Step 6: Commit** — `git add server/src/middleware && git commit -m "feat(server): middlewares rate-limit (por IP) + require-auth (Bearer→sessão)"`

---

### Task 9: auth-routes (o loop completo) + montagem no app

**Files:**
- Create: `server/src/auth/auth-routes.ts`
- Modify: `server/src/index.ts` (montar `/v1` quando o Db existe)
- Test: `server/src/auth/auth-routes.test.ts`

**Interfaces:**
- Consumes: tudo das Partes 1–2 + middlewares (Task 8).
- Produces: `buildAuthRouter(deps: AuthDeps): Router` onde `AuthDeps = { db: Db; env: Env; fetchFn: typeof fetch; now?: () => number }`. Rotas: `GET /auth/:provider`, `GET /auth/:provider/callback`, `POST /auth/exchange`, `POST /auth/refresh`, `POST /auth/link`, `POST /auth/logout`, `GET /me`, `DELETE /me`.

- [ ] **Step 1: teste de integração que falha (loop feliz + LGPD, providers mockados)**

```ts
// server/src/auth/auth-routes.test.ts
import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { generateKeyPair, exportPKCS8, exportSPKI } from 'jose';
import * as schema from '../db/schema';
import { CREATE_TABLES_SQL } from '../db/schema';
import type { Db } from '../db/client';
import type { Env } from '../env';
import { buildAuthRouter } from './auth-routes';

async function setup() {
  const client = new PGlite();
  await client.exec(CREATE_TABLES_SQL);
  const db = drizzle(client, { schema }) as unknown as Db;
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const env = {
    LICENSE_PRIVATE_KEY: await exportPKCS8(privateKey),
    LICENSE_PUBLIC_KEY: await exportSPKI(publicKey),
    GITHUB_OAUTH_ID: 'gid', GITHUB_OAUTH_SECRET: 'gsec',
    GOOGLE_OAUTH_ID: 'ggid', GOOGLE_OAUTH_SECRET: 'ggsec',
    PUBLIC_BASE_URL: 'https://api.test', APP_DEEP_LINK_BASE: 'nexus://auth',
    DATABASE_URL: 'x', PORT: 8080,
  } as Env;
  // fetch mockado: token + user + emails (github)
  const fetchFn = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 't' }), { headers: { 'content-type': 'application/json' } }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: 1, login: 'u', name: 'U', avatar_url: 'a' })))
    .mockResolvedValueOnce(new Response(JSON.stringify([{ email: 'u@x.com', primary: true, verified: true }])));
  const app = express();
  app.use(express.json());
  app.use('/v1', buildAuthRouter({ db, env, fetchFn: fetchFn as unknown as typeof fetch }));
  return { app, db, fetchFn };
}

describe('auth-routes', () => {
  it('loop completo: authorize → callback → exchange → me', async () => {
    const { app } = await setup();
    // 1. authorize redireciona pro provider e grava state
    const auth = await request(app).get('/v1/auth/github');
    expect(auth.status).toBe(302);
    const loc = new URL(auth.headers.location);
    const state = loc.searchParams.get('state')!;
    expect(state).toBeTruthy();
    // 2. callback → redireciona pra nexus://auth/<code>
    const cb = await request(app).get(`/v1/auth/github/callback?code=abc&state=${state}`);
    expect(cb.status).toBe(302);
    const code = cb.headers.location.replace('nexus://auth/', '');
    expect(code).toBeTruthy();
    // 3. exchange code → tokens + licença
    const ex = await request(app).post('/v1/auth/exchange').send({ code });
    expect(ex.status).toBe(200);
    expect(ex.body.data.session).toBeTruthy();
    expect(ex.body.data.refresh).toBeTruthy();
    expect(ex.body.data.licenca).toBeTruthy();
    // 4. /me com a session
    const me = await request(app).get('/v1/me').set('authorization', `Bearer ${ex.body.data.session}`);
    expect(me.status).toBe(200);
    expect(me.body.data.plan).toBe('free');
    expect(me.body.data.email).toBe('u@x.com');
    // code de uso único: 2ª troca falha
    const ex2 = await request(app).post('/v1/auth/exchange').send({ code });
    expect(ex2.status).toBe(400);
  });

  it('callback com state inválido → 400', async () => {
    const { app } = await setup();
    const r = await request(app).get('/v1/auth/github/callback?code=x&state=naoexiste');
    expect(r.status).toBe(400);
  });

  it('DELETE /me apaga a conta (LGPD)', async () => {
    const { app, db } = await setup();
    const auth = await request(app).get('/v1/auth/github');
    const state = new URL(auth.headers.location).searchParams.get('state')!;
    const cb = await request(app).get(`/v1/auth/github/callback?code=abc&state=${state}`);
    const code = cb.headers.location.replace('nexus://auth/', '');
    const ex = await request(app).post('/v1/auth/exchange').send({ code });
    const del = await request(app).delete('/v1/me').set('authorization', `Bearer ${ex.body.data.session}`);
    expect(del.status).toBe(200);
    expect(await db.select().from(schema.accounts)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: rodar e ver falhar** — FAIL
- [ ] **Step 3: implementar `auth-routes.ts`**

```ts
// server/src/auth/auth-routes.ts
import crypto from 'node:crypto';
import { Router } from 'express';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import type { Env } from '../env';
import { accounts, authCodes, identities, oauthStates } from '../db/schema';
import { authorizeUrl, exchangeCode, makePkce } from './oauth-flow';
import { PROVIDERS, type Provider } from './oauth-providers';
import { findOrCreateAccount, linkIdentity } from './account-service';
import { issueTokens, rotateRefresh, revokeAll, sessionAccount } from './session-service';
import { hashToken, newToken } from './tokens';
import { freeLicenseInput, signLicense } from './license-signer';
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

  r.get('/auth/:provider', authLimit, async (req, res) => {
    const p = req.params.provider;
    if (!isProvider(p)) return res.status(404).json({ ok: false, error: 'provider' });
    const state = newToken();
    const { verifier, challenge } = makePkce();
    await db.insert(oauthStates).values({
      state, provider: p, codeVerifier: verifier,
      expiresAt: new Date(now() + STATE_TTL),
    });
    res.redirect(authorizeUrl(p, {
      clientId: providerCreds(env, p).id,
      redirectUri: redirectUri(p), state, challenge,
    }));
  });

  r.get('/auth/:provider/callback', authLimit, async (req, res) => {
    const p = req.params.provider;
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
    res.redirect(`${env.APP_DEEP_LINK_BASE}/${rawCode}`);
  });

  r.post('/auth/exchange', authLimit, async (req, res) => {
    const code = String((req.body as { code?: string }).code ?? '');
    const [row] = await db.select().from(authCodes)
      .where(eq(authCodes.codeHash, hashToken(code))).limit(1);
    if (!row || row.usedAt || row.expiresAt.getTime() < now()) {
      return res.status(400).json({ ok: false, error: 'code inválido' });
    }
    await db.update(authCodes).set({ usedAt: new Date(now()) })
      .where(eq(authCodes.codeHash, row.codeHash));
    const [acc] = await db.select().from(accounts).where(eq(accounts.id, row.accountId)).limit(1);
    const { session, refresh } = await issueTokens(db, row.accountId, now);
    const licenca = await signLicense(freeLicenseInput(acc.email), env.LICENSE_PRIVATE_KEY);
    res.json({ ok: true, data: { session, refresh, licenca } });
  });

  r.post('/auth/refresh', authLimit, async (req, res) => {
    const raw = String((req.body as { refresh?: string }).refresh ?? '');
    const out = await rotateRefresh(db, raw, now);
    if ('reuseDetected' in out) return res.status(401).json({ ok: false, error: 'refresh inválido' });
    res.json({ ok: true, data: out });
  });

  r.post('/auth/logout', requireAuth(db), async (req, res) => {
    await revokeAll(db, req.accountId!);
    res.json({ ok: true });
  });

  r.post('/auth/link', requireAuth(db), async (req, res) => {
    // Vincula um provider já autorizado (perfil vem no corpo, validado pela
    // sessão do usuário). Simplificação v1: recebe {code} de um novo fluxo
    // callback que NÃO fez merge (conta isolada criada); aqui só migramos a
    // identity para a conta logada. Escopo mínimo: rejeitar sem code.
    const code = String((req.body as { code?: string }).code ?? '');
    const [row] = await db.select().from(authCodes)
      .where(eq(authCodes.codeHash, hashToken(code))).limit(1);
    if (!row || row.usedAt || row.expiresAt.getTime() < now()) {
      return res.status(400).json({ ok: false, error: 'code inválido' });
    }
    await db.update(authCodes).set({ usedAt: new Date(now()) }).where(eq(authCodes.codeHash, row.codeHash));
    // move as identities da conta isolada para a conta logada e apaga a isolada
    if (row.accountId !== req.accountId) {
      await db.update(identities).set({ accountId: req.accountId! })
        .where(eq(identities.accountId, row.accountId));
      await db.delete(accounts).where(eq(accounts.id, row.accountId));
    }
    res.json({ ok: true });
  });

  r.get('/me', requireAuth(db), async (req, res) => {
    const [acc] = await db.select().from(accounts).where(eq(accounts.id, req.accountId!)).limit(1);
    res.json({ ok: true, data: { email: acc.email, name: acc.name, plan: acc.plan } });
  });

  r.delete('/me', requireAuth(db), async (req, res) => {
    await db.delete(accounts).where(eq(accounts.id, req.accountId!)); // cascade
    res.json({ ok: true });
  });

  return r;
}
```

- [ ] **Step 4: montar no `index.ts`** — `createApp` recebe deps opcionais e monta `/v1` quando há Db:

```ts
// substituir createApp em server/src/index.ts:
import express, { type Express } from 'express';
import type { AuthDeps } from './auth/auth-routes';
import { buildAuthRouter } from './auth/auth-routes';

export function createApp(deps?: AuthDeps): Express {
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.get('/health', (_req, res) => res.json({ ok: true }));
  if (deps) app.use('/v1', buildAuthRouter(deps));
  return app;
}
// no boot direto: parseEnv + makeDb + createApp({db, env, fetchFn: fetch}).listen(env.PORT)
```

- [ ] **Step 5: rodar e ver passar** — `cd server && npx vitest run src/auth/auth-routes.test.ts` → PASS (3 testes)
- [ ] **Step 6: typecheck + suite do server** — `cd server && npx tsc --noEmit && npx vitest run` → limpo/verde
- [ ] **Step 7: Commit** — `git add server/src/auth/auth-routes.ts server/src/index.ts server/src/auth/auth-routes.test.ts && git commit -m "feat(server): rotas /v1/auth (loop OAuth→code→exchange), /me, DELETE /me (LGPD)"`

---

### Task 10: encaixe no APP — deep-link `auth` + re-export de contract

**Files:**
- Modify: `src/main/deep-link.ts` (novo caso `auth`)
- Modify: `src/main/deep-link.test.ts` (casos do `auth`)
- Modify: `src/shared/billing-types.ts` (re-exportar `LicenseInfo`/`PlanId` de `shared/contract.ts`)

**Interfaces:**
- Consumes: o parser existente de `deep-link.ts` (`parseDeepLink`, casos `license`/`open`).
- Produces: `parseDeepLink('nexus://auth/<code>')` → `{ kind: 'auth', code: string }` (code no conjunto seguro `[A-Za-z0-9._~-]`, ≤512). O `DeepLink` type ganha a variante `{ kind: 'auth'; code: string }`.

- [ ] **Step 1: teste que falha (no test do app)**

```ts
// adicionar em src/main/deep-link.test.ts:
it('reconhece nexus://auth/<code> com code seguro', () => {
  expect(parseDeepLink('nexus://auth/abcXYZ_-.09')).toEqual({ kind: 'auth', code: 'abcXYZ_-.09' });
  expect(parseDeepLink('nexus://auth/')).toBeNull();
  expect(parseDeepLink('nexus://auth/tem espaço')).toBeNull();
  expect(parseDeepLink('nexus://auth/' + 'a'.repeat(5000))).toBeNull();
});
```

- [ ] **Step 2: rodar e ver falhar** — `npx vitest run src/main/deep-link.test.ts` → FAIL
- [ ] **Step 3: implementar o caso `auth` em `deep-link.ts`**

No `type DeepLink` adicionar `| { kind: 'auth'; code: string }`. Em
`parseDeepLink`, junto dos casos `license`/`open`, adicionar (o `SAFE_TOKEN` e
`TOKEN_MAX` já existem no arquivo):

```ts
  if (host === 'auth') {
    const code = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    if (!code || code.length > TOKEN_MAX || !SAFE_TOKEN.test(code)) return null;
    return { kind: 'auth', code };
  }
```

(O roteamento do `auth` no `defaultHandler`/`auth-client` fica para a Task 11 —
esta task só ensina o parser a reconhecê-lo, com o teste verde.)

- [ ] **Step 4: re-export do contract** — em `src/shared/billing-types.ts`, no topo:

```ts
export type { PlanId, LicenseInfo } from '../../shared/contract';
```

E remover as declarações locais de `PlanId`/`LicenseInfo` do arquivo (se
existirem) para não duplicar — o resto do app já importa desses nomes, agora
vindos da fonte única. Rodar `npm run typecheck` na raiz para confirmar que
nada quebrou.

- [ ] **Step 5: rodar e ver passar** — `npx vitest run src/main/deep-link.test.ts && npm run typecheck` → PASS/limpo
- [ ] **Step 6: Commit** — `git add src/main/deep-link.ts src/main/deep-link.test.ts src/shared/billing-types.ts && git commit -m "feat(app): deep-link caso auth + contract compartilhado com o backend"`

---

### Task 11: auth-client no app + botão de login + verificação final

**Files:**
- Create: `src/main/auth-client.ts`
- Modify: `src/main/deep-link.ts` (rotear `auth` → auth-client)
- Modify: `src/renderer/components/settings/AccountSection.tsx` (botões de login)
- Test: `src/main/auth-client.test.ts`

**Interfaces:**
- Consumes: `secrets-store` (Keychain), `billing-ipc.applyLicenseToken`, `setSecret/getSecret`.
- Produces: `exchangeAuthCode(code: string, deps?): Promise<{ ok: boolean; error?: string }>` — `POST <backend>/v1/auth/exchange`, guarda `session`/`refresh` no Keychain (`setSecret('auth:session'|'auth:refresh', ...)`) e aplica a licença via `applyLicenseToken`. Deps injetáveis (`fetchFn`, `backendUrl`, `store`) p/ teste.

- [ ] **Step 1: teste que falha (exchange guarda tokens, aplica licença — tudo injetado)**

```ts
// src/main/auth-client.test.ts
import { describe, expect, it, vi } from 'vitest';
import { exchangeAuthCode } from './auth-client';

describe('exchangeAuthCode', () => {
  it('troca o code, guarda session/refresh e aplica a licença', async () => {
    const store: Record<string, string> = {};
    const applied: string[] = [];
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: { session: 's', refresh: 'r', licenca: 'jwt' } }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    const res = await exchangeAuthCode('code123', {
      backendUrl: 'https://api.test',
      fetchFn: fetchFn as unknown as typeof fetch,
      setSecret: (k, v) => { store[k] = v; return { ok: true }; },
      applyLicense: (jwt) => { applied.push(jwt); return { ok: true }; },
    });
    expect(res.ok).toBe(true);
    expect(store['auth:session']).toBe('s');
    expect(store['auth:refresh']).toBe('r');
    expect(applied).toEqual(['jwt']);
    expect(fetchFn).toHaveBeenCalledWith('https://api.test/v1/auth/exchange', expect.objectContaining({ method: 'POST' }));
  });

  it('erro do backend não guarda nada', async () => {
    const store: Record<string, string> = {};
    const fetchFn = vi.fn().mockResolvedValue(new Response('nope', { status: 400 }));
    const res = await exchangeAuthCode('x', {
      backendUrl: 'https://api.test',
      fetchFn: fetchFn as unknown as typeof fetch,
      setSecret: (k, v) => { store[k] = v; return { ok: true }; },
      applyLicense: () => ({ ok: true }),
    });
    expect(res.ok).toBe(false);
    expect(Object.keys(store)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: rodar e ver falhar** — FAIL
- [ ] **Step 3: implementar `auth-client.ts`**

```ts
// src/main/auth-client.ts
/**
 * Cliente de auth do app: troca o code do deep-link nexus://auth por
 * session/refresh (guardados no Keychain) + licença (aplicada offline). Deps
 * injetáveis p/ teste; a borda default usa secrets-store e billing-ipc.
 */

export interface ExchangeDeps {
  backendUrl: string;
  fetchFn: typeof fetch;
  setSecret: (key: string, value: string) => { ok: boolean; error?: string };
  applyLicense: (jwt: string) => { ok: boolean; error?: string };
}

function defaultDeps(): ExchangeDeps {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const secrets = require('./persistence/secrets-store') as typeof import('./persistence/secrets-store');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const billing = require('./persistence/billing-ipc') as typeof import('./persistence/billing-ipc');
  return {
    backendUrl: process.env.NEXUS_BACKEND_URL ?? 'https://api.nexuside.app',
    fetchFn: fetch,
    setSecret: (k, v) => secrets.setSecret(k, v),
    applyLicense: (jwt) => billing.applyLicenseToken(jwt),
  };
}

export async function exchangeAuthCode(
  code: string,
  deps: ExchangeDeps = defaultDeps(),
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await deps.fetchFn(`${deps.backendUrl}/v1/auth/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    if (!res.ok) return { ok: false, error: `exchange HTTP ${res.status}` };
    const json = (await res.json()) as {
      ok: boolean;
      data?: { session: string; refresh: string; licenca: string };
    };
    if (!json.ok || !json.data) return { ok: false, error: 'resposta inválida' };
    deps.setSecret('auth:session', json.data.session);
    deps.setSecret('auth:refresh', json.data.refresh);
    deps.applyLicense(json.data.licenca);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
```

- [ ] **Step 4: rotear no deep-link** — em `deep-link.ts` `defaultHandler`, no `else if (link.kind === 'auth')`:

```ts
  } else if (link.kind === 'auth') {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { exchangeAuthCode } = require('./auth-client') as typeof import('./auth-client');
    void exchangeAuthCode(link.code).then((r) => {
      if (!r.ok) console.warn('[auth] exchange falhou:', r.error);
      const { BILLING_CHANNELS } = require('../shared/billing-types') as typeof import('../shared/billing-types');
      win?.webContents.send(BILLING_CHANNELS.changed);
    });
  }
```

- [ ] **Step 5: botões de login na AccountSection** — adicionar em
  `src/renderer/components/settings/AccountSection.tsx` dois botões que abrem o
  browser no backend:

```tsx
<button className="settings-btn" onClick={() =>
  window.nexus.billing.openExternal?.(`${'https://api.nexuside.app'}/v1/auth/github`)
    ?? window.open(`https://api.nexuside.app/v1/auth/github`)
}>Entrar com GitHub</button>
<button className="settings-btn" onClick={() =>
  window.open(`https://api.nexuside.app/v1/auth/google`)
}>Entrar com Google</button>
```

(Se `window.nexus.billing` não expõe `openExternal`, adicionar um IPC
`billing:openExternal` que chama `shell.openExternal(url)` no main — mesmo
padrão do checkout existente em `billing-ipc.ts`.)

- [ ] **Step 6: rodar e ver passar** — `npx vitest run src/main/auth-client.test.ts && npm run typecheck` → PASS/limpo
- [ ] **Step 7: verificação final** — `cd server && npx vitest run && npx tsc --noEmit` (backend verde) + na raiz `npm test && npm run typecheck` (app verde).
- [ ] **Step 8: Commit** — `git add src/main/auth-client.ts src/main/auth-client.test.ts src/main/deep-link.ts src/renderer/components/settings/AccountSection.tsx && git commit -m "feat(app): auth-client (code→tokens no Keychain + licença) + botões de login"`

---

## Self-review (Parte 3)

- **Cobertura:** spec §3 (endpoints) → Tasks 8–9; §4 signer no exchange → Task 9;
  §5 rate-limit → Task 8; §6 encaixe no app (deep-link auth, auth-client,
  botões, re-export contract) → Tasks 10–11; `DELETE /me` (LGPD) testado na
  Task 9. §7 testes: unit (middlewares, auth-client) + integração (supertest com
  providers mockados).
- **Placeholders:** nenhum; rotas e app com código completo. O `/auth/link` tem
  escopo v1 explícito (migra identities via um segundo code) — implementação
  real, não placeholder.
- **Consistência:** `buildAuthRouter(AuthDeps)`, `createApp(deps?)`,
  `rateLimit`/`requireAuth`, `exchangeAuthCode(ExchangeDeps)` — todos definidos
  aqui; consomem as assinaturas exatas das Partes 1–2. `SAFE_TOKEN`/`TOKEN_MAX`
  reusados do `deep-link.ts` existente (verificados no repo).
- **Risco anotado:** `AccountSection.tsx` pode precisar de um IPC
  `billing:openExternal` se ainda não existir — a task aponta o fallback e o
  padrão a copiar (`billing-ipc` checkout já faz `shell.openExternal`).
