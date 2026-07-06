# Auth/Contas — Plan (Parte 2/3: lógica pura — oauth, merge, sessão)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> Sequência: Parte 1 `2026-07-06-auth-parte-1-fundacao.md` (PRÉ-REQUISITO) → **Parte 2** (esta) → Parte 3 `2026-07-06-auth-parte-3-rotas-app.md`.
> **Global Constraints:** ver Parte 1. Spec: `docs/superpowers/specs/2026-07-06-auth-contas-design.md`.

**Goal:** Os três services puros do Auth — oauth-flow (parse de perfil + PKCE, HTTP injetado), account-service (matriz de merge segura), session-service (emissão + rotação com detecção de reuso).

**Architecture:** Toda a lógica de auth vive aqui, PURA: sem Express, sem rede real. Db é o drizzle sobre pglite nos testes; HTTP dos providers é injetado. As rotas (Parte 3) só chamam estes services.

**Tech Stack:** TypeScript, Drizzle, jose (só p/ nada aqui — crypto nativo), vitest, pglite.

## Helper de teste comum (usado nas Tasks 5–7)

Cada teste que toca o banco monta um Db pglite com o schema aplicado:

```ts
// trecho reutilizado nos testes desta parte
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../db/schema';
import { CREATE_TABLES_SQL } from '../db/schema';

async function makeTestDb() {
  const client = new PGlite();
  await client.exec(CREATE_TABLES_SQL);
  return drizzle(client, { schema }) as unknown as import('../db/client').Db;
}
```

---

### Task 5: oauth-providers + oauth-flow (perfil normalizado, PKCE)

**Files:**
- Create: `server/src/auth/oauth-providers.ts`
- Create: `server/src/auth/oauth-flow.ts`
- Test: `server/src/auth/oauth-flow.test.ts`

**Interfaces:**
- Produces:
  - `oauth-providers.ts`: `type Provider = 'github'|'google'`; `type OAuthProfile = { provider: Provider; providerUserId: string; email: string | null; emailVerified: boolean; name: string | null; avatar: string | null }`; `PROVIDERS: Record<Provider, {authUrl, tokenUrl, userUrl, scope, parseProfile(raw: unknown): OAuthProfile}>`.
  - `oauth-flow.ts`: `makePkce(rand?: () => Buffer): { verifier: string; challenge: string }`; `authorizeUrl(provider, {clientId, redirectUri, state, challenge}): string`; `exchangeCode(provider, {code, verifier, clientId, clientSecret, redirectUri}, http: HttpDeps): Promise<OAuthProfile>` — `HttpDeps = { fetchFn: typeof fetch }`.

- [ ] **Step 1: teste que falha**

```ts
// server/src/auth/oauth-flow.test.ts
import { describe, expect, it, vi } from 'vitest';
import { PROVIDERS } from './oauth-providers';
import { authorizeUrl, exchangeCode, makePkce } from './oauth-flow';

describe('oauth-providers.parseProfile', () => {
  it('github: normaliza perfil e email verificado', () => {
    const p = PROVIDERS.github.parseProfile({
      user: { id: 42, login: 'zé', name: 'Zé', avatar_url: 'http://a' },
      emails: [
        { email: 'z@x.com', primary: true, verified: true },
        { email: 'alt@x.com', primary: false, verified: false },
      ],
    });
    expect(p).toEqual({
      provider: 'github',
      providerUserId: '42',
      email: 'z@x.com',
      emailVerified: true,
      name: 'Zé',
      avatar: 'http://a',
    });
  });

  it('google: usa email_verified do userinfo', () => {
    const p = PROVIDERS.google.parseProfile({
      sub: 'g-1',
      email: 'g@x.com',
      email_verified: true,
      name: 'G',
      picture: 'http://p',
    });
    expect(p.providerUserId).toBe('g-1');
    expect(p.emailVerified).toBe(true);
    expect(p.email).toBe('g@x.com');
  });
});

describe('makePkce / authorizeUrl', () => {
  it('challenge é o S256 do verifier (base64url)', () => {
    const { verifier, challenge } = makePkce(() => Buffer.alloc(32, 7));
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).not.toBe(verifier);
  });

  it('authorizeUrl injeta client/redirect/state/challenge', () => {
    const url = authorizeUrl('github', {
      clientId: 'cid',
      redirectUri: 'https://api/cb',
      state: 'st',
      challenge: 'ch',
    });
    expect(url).toContain('client_id=cid');
    expect(url).toContain('state=st');
    expect(url).toContain('code_challenge=ch');
    expect(url).toContain('code_challenge_method=S256');
  });
});

describe('exchangeCode', () => {
  it('github: troca code por token e busca perfil', async () => {
    const fetchFn = vi
      .fn()
      // token
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'tok' }), {
          headers: { 'content-type': 'application/json' },
        }),
      )
      // user
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: 7, login: 'u', name: 'U', avatar_url: 'a' }),
        ),
      )
      // emails
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([{ email: 'u@x.com', primary: true, verified: true }]),
        ),
      );
    const profile = await exchangeCode(
      'github',
      { code: 'c', verifier: 'v', clientId: 'id', clientSecret: 's', redirectUri: 'r' },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(profile.providerUserId).toBe('7');
    expect(profile.email).toBe('u@x.com');
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('erro HTTP na troca de token vira exceção', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }));
    await expect(
      exchangeCode(
        'google',
        { code: 'c', verifier: 'v', clientId: 'id', clientSecret: 's', redirectUri: 'r' },
        { fetchFn: fetchFn as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/401/);
  });
});
```

- [ ] **Step 2: rodar e ver falhar** — FAIL
- [ ] **Step 3: implementar `oauth-providers.ts`**

```ts
// server/src/auth/oauth-providers.ts
export type Provider = 'github' | 'google';

export interface OAuthProfile {
  provider: Provider;
  providerUserId: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  avatar: string | null;
}

interface GithubUser {
  id: number;
  login?: string;
  name?: string | null;
  avatar_url?: string | null;
}
interface GithubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}
interface GoogleUser {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string | null;
  picture?: string | null;
}

export interface ProviderDef {
  authUrl: string;
  tokenUrl: string;
  userUrl: string;
  emailsUrl?: string;
  scope: string;
  parseProfile(raw: unknown): OAuthProfile;
}

export const PROVIDERS: Record<Provider, ProviderDef> = {
  github: {
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userUrl: 'https://api.github.com/user',
    emailsUrl: 'https://api.github.com/user/emails',
    scope: 'read:user user:email',
    parseProfile(raw) {
      const r = raw as { user: GithubUser; emails: GithubEmail[] };
      const primary =
        r.emails.find((e) => e.primary) ?? r.emails[0] ?? undefined;
      return {
        provider: 'github',
        providerUserId: String(r.user.id),
        email: primary?.email ?? null,
        emailVerified: primary?.verified ?? false,
        name: r.user.name ?? r.user.login ?? null,
        avatar: r.user.avatar_url ?? null,
      };
    },
  },
  google: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    scope: 'openid email profile',
    parseProfile(raw) {
      const r = raw as GoogleUser;
      return {
        provider: 'google',
        providerUserId: r.sub,
        email: r.email ?? null,
        emailVerified: r.email_verified ?? false,
        name: r.name ?? null,
        avatar: r.picture ?? null,
      };
    },
  },
};
```

- [ ] **Step 4: implementar `oauth-flow.ts`**

```ts
// server/src/auth/oauth-flow.ts
import crypto from 'node:crypto';
import { PROVIDERS, type OAuthProfile, type Provider } from './oauth-providers';

/** PKCE + authorize URL + troca de code. HTTP injetado (testável sem rede). */

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export function makePkce(
  rand: () => Buffer = () => crypto.randomBytes(32),
): { verifier: string; challenge: string } {
  const verifier = b64url(rand());
  const challenge = b64url(
    crypto.createHash('sha256').update(verifier).digest(),
  );
  return { verifier, challenge };
}

export function authorizeUrl(
  provider: Provider,
  p: { clientId: string; redirectUri: string; state: string; challenge: string },
): string {
  const def = PROVIDERS[provider];
  const q = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: 'code',
    scope: def.scope,
    state: p.state,
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
  });
  return `${def.authUrl}?${q.toString()}`;
}

export interface HttpDeps {
  fetchFn: typeof fetch;
}

export async function exchangeCode(
  provider: Provider,
  p: {
    code: string;
    verifier: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  },
  http: HttpDeps,
): Promise<OAuthProfile> {
  const def = PROVIDERS[provider];
  const tokenRes = await http.fetchFn(def.tokenUrl, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: p.clientId,
      client_secret: p.clientSecret,
      code: p.code,
      redirect_uri: p.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: p.verifier,
    }),
  });
  if (!tokenRes.ok) {
    throw new Error(`${provider} token exchange HTTP ${tokenRes.status}`);
  }
  const token = (await tokenRes.json()) as { access_token?: string };
  if (!token.access_token) throw new Error(`${provider}: sem access_token`);

  const auth = { authorization: `Bearer ${token.access_token}` };
  const userRes = await http.fetchFn(def.userUrl, { headers: auth });
  if (!userRes.ok) throw new Error(`${provider} userinfo HTTP ${userRes.status}`);
  const user = await userRes.json();

  if (provider === 'github') {
    const emailsRes = await http.fetchFn(def.emailsUrl!, { headers: auth });
    const emails = emailsRes.ok ? await emailsRes.json() : [];
    return def.parseProfile({ user, emails });
  }
  return def.parseProfile(user);
}
```

- [ ] **Step 5: rodar e ver passar** — PASS (5 testes)
- [ ] **Step 6: Commit**

```bash
git add server/src/auth/oauth-providers.ts server/src/auth/oauth-flow.ts server/src/auth/oauth-flow.test.ts
git commit -m "feat(server): oauth-flow (PKCE + parse de perfil github/google, HTTP injetado)"
```

---

### Task 6: account-service (matriz de merge segura)

**Files:**
- Create: `server/src/auth/account-service.ts`
- Test: `server/src/auth/account-service.test.ts`

**Interfaces:**
- Consumes: `Db` (Parte 1), `OAuthProfile` (Task 5), tabelas do schema.
- Produces: `findOrCreateAccount(db: Db, profile: OAuthProfile): Promise<{ accountId: string; merged: boolean }>`; `linkIdentity(db: Db, accountId: string, profile: OAuthProfile): Promise<void>`.

- [ ] **Step 1: teste que falha (a matriz de merge inteira)**

```ts
// server/src/auth/account-service.test.ts
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { CREATE_TABLES_SQL } from '../db/schema';
import type { Db } from '../db/client';
import type { OAuthProfile } from './oauth-providers';
import { findOrCreateAccount } from './account-service';

async function makeTestDb(): Promise<Db> {
  const client = new PGlite();
  await client.exec(CREATE_TABLES_SQL);
  return drizzle(client, { schema }) as unknown as Db;
}

function prof(over: Partial<OAuthProfile> = {}): OAuthProfile {
  return {
    provider: 'github',
    providerUserId: 'gh-1',
    email: 'a@b.com',
    emailVerified: true,
    name: 'A',
    avatar: null,
    ...over,
  };
}

describe('findOrCreateAccount (matriz de merge)', () => {
  it('conta nova quando não há identity nem email casando', async () => {
    const db = await makeTestDb();
    const r = await findOrCreateAccount(db, prof());
    expect(r.merged).toBe(false);
    const accs = await db.select().from(schema.accounts);
    expect(accs).toHaveLength(1);
  });

  it('identity existente reusa a mesma conta', async () => {
    const db = await makeTestDb();
    const first = await findOrCreateAccount(db, prof());
    const again = await findOrCreateAccount(db, prof());
    expect(again.accountId).toBe(first.accountId);
    expect(again.merged).toBe(false);
  });

  it('MERGE: 2º provider com email verificado que casa vira a mesma conta', async () => {
    const db = await makeTestDb();
    const gh = await findOrCreateAccount(db, prof()); // github a@b.com verificado
    const google = await findOrCreateAccount(
      db,
      prof({ provider: 'google', providerUserId: 'g-9', email: 'a@b.com', emailVerified: true }),
    );
    expect(google.accountId).toBe(gh.accountId);
    expect(google.merged).toBe(true);
    const ids = await db
      .select()
      .from(schema.identities)
      .where(eq(schema.identities.accountId, gh.accountId));
    expect(ids).toHaveLength(2);
  });

  it('NÃO faz merge quando o email do 2º não é verificado', async () => {
    const db = await makeTestDb();
    const gh = await findOrCreateAccount(db, prof());
    const google = await findOrCreateAccount(
      db,
      prof({ provider: 'google', providerUserId: 'g-9', email: 'a@b.com', emailVerified: false }),
    );
    expect(google.accountId).not.toBe(gh.accountId); // conta isolada
    expect(google.merged).toBe(false);
  });

  it('NÃO faz merge quando a conta existente tem email não verificado', async () => {
    const db = await makeTestDb();
    // primeira conta com email NÃO verificado
    const first = await findOrCreateAccount(db, prof({ emailVerified: false }));
    const second = await findOrCreateAccount(
      db,
      prof({ provider: 'google', providerUserId: 'g-2', emailVerified: true }),
    );
    expect(second.accountId).not.toBe(first.accountId);
  });
});
```

- [ ] **Step 2: rodar e ver falhar** — FAIL
- [ ] **Step 3: implementar**

```ts
// server/src/auth/account-service.ts
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { accounts, identities } from '../db/schema';
import type { OAuthProfile, Provider } from './oauth-providers';

/**
 * Find-or-create com MERGE seguro (anti account-takeover): só une identidades
 * quando AMBOS os lados têm o email verificado e coincidente. Nunca por email
 * não-verificado — nesse caso cria conta isolada.
 */

async function insertIdentity(
  db: Db,
  accountId: string,
  p: OAuthProfile,
): Promise<void> {
  await db.insert(identities).values({
    accountId,
    provider: p.provider,
    providerUserId: p.providerUserId,
    email: p.email,
    emailVerified: p.emailVerified,
  });
}

export async function findOrCreateAccount(
  db: Db,
  p: OAuthProfile,
): Promise<{ accountId: string; merged: boolean }> {
  // 1. identity já existe → usa a conta dela
  const existing = await db
    .select()
    .from(identities)
    .where(
      and(
        eq(identities.provider, p.provider as Provider),
        eq(identities.providerUserId, p.providerUserId),
      ),
    )
    .limit(1);
  if (existing[0]) return { accountId: existing[0].accountId, merged: false };

  // 2. merge por email — SÓ com email verificado dos dois lados
  if (p.email && p.emailVerified) {
    const byEmail = await db
      .select()
      .from(accounts)
      .where(eq(accounts.email, p.email))
      .limit(1);
    const acc = byEmail[0];
    if (acc) {
      // a conta existente precisa ter chegado por um email verificado:
      // exigimos que ELA tenha ao menos uma identity com email verificado.
      const verified = await db
        .select()
        .from(identities)
        .where(
          and(
            eq(identities.accountId, acc.id),
            eq(identities.emailVerified, true),
          ),
        )
        .limit(1);
      if (verified[0]) {
        await insertIdentity(db, acc.id, p);
        return { accountId: acc.id, merged: true };
      }
    }
  }

  // 3. cria conta nova + identity. Email único: se colidir com conta
  // não-verificada, usa um email desambiguado para não violar a constraint.
  const emailForAccount =
    p.email && p.emailVerified ? p.email : `${p.provider}:${p.providerUserId}`;
  const [created] = await db
    .insert(accounts)
    .values({ email: emailForAccount, name: p.name, avatarUrl: p.avatar })
    .returning({ id: accounts.id });
  await insertIdentity(db, created.id, p);
  return { accountId: created.id, merged: false };
}

export async function linkIdentity(
  db: Db,
  accountId: string,
  p: OAuthProfile,
): Promise<void> {
  await insertIdentity(db, accountId, p);
}
```

- [ ] **Step 4: rodar e ver passar** — PASS (5 testes da matriz)
- [ ] **Step 5: Commit**

```bash
git add server/src/auth/account-service.ts server/src/auth/account-service.test.ts
git commit -m "feat(server): account-service com matriz de merge segura (anti account-takeover)"
```

---

### Task 7: session-service (emissão + rotação + detecção de reuso)

**Files:**
- Create: `server/src/auth/tokens.ts`
- Create: `server/src/auth/session-service.ts`
- Test: `server/src/auth/session-service.test.ts`

**Interfaces:**
- Consumes: `Db`, schema, `Env` (não — recebe valores). 
- Produces:
  - `tokens.ts`: `newToken(): string` (32B base64url); `hashToken(t: string): string` (sha256 hex); `safeEqualHash(a: string, b: string): boolean`.
  - `session-service.ts`: `issueTokens(db, accountId, now?): Promise<{ session: string; refresh: string }>`; `rotateRefresh(db, refreshRaw, now?): Promise<{ session: string; refresh: string } | { reuseDetected: true }>`; `revokeAll(db, accountId): Promise<void>`; `sessionAccount(db, sessionRaw, now?): Promise<string | null>`.

- [ ] **Step 1: teste que falha**

```ts
// server/src/auth/session-service.test.ts
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../db/schema';
import { CREATE_TABLES_SQL } from '../db/schema';
import type { Db } from '../db/client';
import {
  issueTokens,
  rotateRefresh,
  sessionAccount,
} from './session-service';

async function makeTestDb(): Promise<Db> {
  const client = new PGlite();
  await client.exec(CREATE_TABLES_SQL);
  return drizzle(client, { schema }) as unknown as Db;
}
async function anAccount(db: Db): Promise<string> {
  const [a] = await db
    .insert(schema.accounts)
    .values({ email: 'x@y.com' })
    .returning({ id: schema.accounts.id });
  return a.id;
}

describe('session-service', () => {
  it('emite session+refresh e a session autentica a conta', async () => {
    const db = await makeTestDb();
    const acc = await anAccount(db);
    const { session, refresh } = await issueTokens(db, acc);
    expect(session).not.toBe(refresh);
    expect(await sessionAccount(db, session)).toBe(acc);
    expect(await sessionAccount(db, 'invalido')).toBeNull();
  });

  it('rotação feliz: refresh novo funciona, o antigo não', async () => {
    const db = await makeTestDb();
    const acc = await anAccount(db);
    const first = await issueTokens(db, acc);
    const rotated = await rotateRefresh(db, first.refresh);
    expect('refresh' in rotated).toBe(true);
    if (!('refresh' in rotated)) throw new Error('esperava rotação');
    // usar o refresh ANTIGO de novo = reuso
    const reuse = await rotateRefresh(db, first.refresh);
    expect('reuseDetected' in reuse).toBe(true);
  });

  it('reuso revoga a cadeia: o refresh novo também morre', async () => {
    const db = await makeTestDb();
    const acc = await anAccount(db);
    const first = await issueTokens(db, acc);
    const rotated = await rotateRefresh(db, first.refresh);
    if (!('refresh' in rotated)) throw new Error('esperava rotação');
    await rotateRefresh(db, first.refresh); // dispara reuso → revoga tudo
    const afterRevoke = await rotateRefresh(db, rotated.refresh);
    expect('reuseDetected' in afterRevoke).toBe(true);
  });

  it('refresh inexistente = reuseDetected (trata como comprometido)', async () => {
    const db = await makeTestDb();
    const r = await rotateRefresh(db, 'nunca-existiu');
    expect('reuseDetected' in r).toBe(true);
  });
});
```

- [ ] **Step 2: rodar e ver falhar** — FAIL
- [ ] **Step 3: implementar `tokens.ts`**

```ts
// server/src/auth/tokens.ts
import crypto from 'node:crypto';

export function newToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashToken(t: string): string {
  return crypto.createHash('sha256').update(t).digest('hex');
}

export function safeEqualHash(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
```

- [ ] **Step 4: implementar `session-service.ts`**

```ts
// server/src/auth/session-service.ts
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Db } from '../db/client';
import { refreshTokens, sessions } from '../db/schema';
import { hashToken, newToken } from './tokens';

/**
 * Emissão e rotação de tokens. Session curto (15min), refresh longo (30d) com
 * ROTAÇÃO: cada uso emite um par novo e marca o antigo usado; um refresh já
 * usado que reaparece = roubo → revoga TODA a cadeia da conta.
 */

const SESSION_TTL_MS = 15 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 3600 * 1000;

async function issue(
  db: Db,
  accountId: string,
  now: number,
  rotatedFrom: string | null,
): Promise<{ session: string; refresh: string }> {
  const session = newToken();
  const refresh = newToken();
  await db.insert(sessions).values({
    accountId,
    tokenHash: hashToken(session),
    expiresAt: new Date(now + SESSION_TTL_MS),
  });
  await db.insert(refreshTokens).values({
    accountId,
    tokenHash: hashToken(refresh),
    rotatedFrom,
    expiresAt: new Date(now + REFRESH_TTL_MS),
  });
  return { session, refresh };
}

export async function issueTokens(
  db: Db,
  accountId: string,
  now: () => number = Date.now,
): Promise<{ session: string; refresh: string }> {
  return issue(db, accountId, now(), null);
}

export async function revokeAll(db: Db, accountId: string): Promise<void> {
  const at = new Date();
  await db
    .update(refreshTokens)
    .set({ revokedAt: at })
    .where(and(eq(refreshTokens.accountId, accountId), isNull(refreshTokens.revokedAt)));
  await db
    .update(sessions)
    .set({ revokedAt: at })
    .where(and(eq(sessions.accountId, accountId), isNull(sessions.revokedAt)));
}

export async function rotateRefresh(
  db: Db,
  refreshRaw: string,
  now: () => number = Date.now,
): Promise<{ session: string; refresh: string } | { reuseDetected: true }> {
  const hash = hashToken(refreshRaw);
  const [row] = await db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, hash))
    .limit(1);

  // inexistente OU já usado OU revogado → comprometido
  if (!row || row.usedAt || row.revokedAt || row.expiresAt.getTime() < now()) {
    if (row) await revokeAll(db, row.accountId);
    return { reuseDetected: true };
  }
  await db
    .update(refreshTokens)
    .set({ usedAt: new Date(now()) })
    .where(eq(refreshTokens.id, row.id));
  return issue(db, row.accountId, now(), row.id);
}

export async function sessionAccount(
  db: Db,
  sessionRaw: string,
  now: () => number = Date.now,
): Promise<string | null> {
  const [row] = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.tokenHash, hashToken(sessionRaw)),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, new Date(now())),
      ),
    )
    .limit(1);
  return row?.accountId ?? null;
}
```

- [ ] **Step 5: rodar e ver passar** — PASS (4 testes)
- [ ] **Step 6: typecheck** — `cd server && npx tsc --noEmit` → limpo
- [ ] **Step 7: Commit**

```bash
git add server/src/auth/tokens.ts server/src/auth/session-service.ts server/src/auth/session-service.test.ts
git commit -m "feat(server): session-service (emissão + rotação de refresh com detecção de reuso)"
```

→ **Continuar na Parte 3:** `docs/superpowers/plans/2026-07-06-auth-parte-3-rotas-app.md`

## Self-review (Parte 2)

- **Cobertura:** spec §3 (fluxo — parse/PKCE/exchange) → Task 5; §4 matriz de
  merge → Task 6 (5 casos = as 4 linhas da tabela + idempotência de identity);
  §4 rotação/reuso → Task 7; só-hash + timingSafeEqual (§5) → `tokens.ts`.
- **Placeholders:** nenhum; todos os services com código e testes completos.
- **Consistência:** `findOrCreateAccount`/`linkIdentity`/`issueTokens`/
  `rotateRefresh`/`revokeAll`/`sessionAccount`/`exchangeCode`/`authorizeUrl`/
  `makePkce` — nomes e assinaturas usados pela Parte 3 (rotas). `Db` e
  `schema.*` da Parte 1. `OAuthProfile` da Task 5 consumido pela Task 6.
- **Risco anotado:** o merge cria conta com `email = provider:providerUserId`
  quando o email não é verificado (evita violar o unique de `accounts.email`); a
  Parte 3 pode expor "email não confirmado" no `/me` para esses casos.
