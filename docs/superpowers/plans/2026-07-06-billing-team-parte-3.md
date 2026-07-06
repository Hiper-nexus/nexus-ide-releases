# Billing + Team — Plano de Implementação (Parte 3/4: licença + times)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Pré-requisito:** Partes 1–2 concluídas (entitlementFor, signLicense c/ TTL, billing/webhook montados, `setup` exportado de `billing-routes.test.ts`).

**Goal:** `GET /v1/license` (entitlement→JWT) e `/v1/team/*` (convite hasheado, join atômico com assento, gestão) + guarda LGPD do owner.

**Architecture:** `buildLicenseRouter` e `buildTeamRouter` com deps injetadas, `asyncHandler`, envelope `{ok,data?,error?}` — padrão idêntico ao Auth. Join serializa por time via `pg_advisory_xact_lock` (corrida do último assento).

**Tech Stack:** Express 4, Drizzle/pglite, supertest.

## Global Constraints

- Iguais às Partes 1–2 (sem concorrentes; pt-BR; envelope; hash de códigos via `hashToken`; atomicidade; reler arquivo antes de editar; `git add` por arquivo).

---

### Task 7: GET /v1/license + team-service (convite/join atômicos)

**Files:**
- Create: `server/src/billing/license-routes.ts`
- Test: `server/src/billing/license-routes.test.ts`
- Create: `server/src/team/team-service.ts`
- Test: `server/src/team/team-service.test.ts`
- Modify: `server/src/index.ts` (montar license router)

**Interfaces:**
- Consumes: `entitlementFor` (Parte 1), `signLicense(input, pem, now?, ttlSeconds?)`, `requireAuth`, `hashToken` de `../auth/tokens`, schema.
- Produces: `buildLicenseRouter(deps: {db: Db; env: Env; now?: () => number}): Router` → `GET /license` → `{ok, data:{licenca}}`. `createInvite(db, teamId, createdBy, now?): Promise<{code, codePrefix, expiresAt}>`; `joinTeam(db, accountId, rawCode, now?): Promise<{ok:true; teamId; name} | {ok:false; error}>`.

- [ ] **Step 1: Teste license falhando** — `server/src/billing/license-routes.test.ts` (reusar `setup` de `./test-helpers` da Parte 2, montando app local com `buildLicenseRouter`):

```ts
import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import * as schema from '../db/schema';
import { errorHandler } from '../middleware/errors';
import { setup } from './test-helpers';
import { buildLicenseRouter } from './license-routes';

describe('GET /v1/license', () => {
  it('reflete o entitlement e verifica com a chave pública', async () => {
    const { db, env, bearer, accountId } = await setup();
    const app = express();
    app.use(express.json());
    app.use('/v1', buildLicenseRouter({ db, env }));
    app.use(errorHandler);

    const r0 = await request(app).get('/v1/license').set('authorization', bearer);
    expect(r0.status).toBe(200);
    const { verifyLicense } = await import('../auth/license-signer');
    expect((await verifyLicense(r0.body.data.licenca, env.LICENSE_PUBLIC_KEY))!.plan).toBe('free');

    const [t] = await db.insert(schema.teams).values({ name: 'S', ownerAccountId: accountId })
      .returning({ id: schema.teams.id });
    await db.insert(schema.teamMembers).values({ teamId: t.id, accountId, role: 'owner' });
    await db.insert(schema.subscriptions).values({
      ownerType: 'team', teamId: t.id, stripeSubscriptionId: 's', stripeCustomerId: 'c',
      plan: 'team', status: 'active', seats: 3,
      currentPeriodEnd: new Date(Date.now() + 86_400_000),
    });
    const r1 = await request(app).get('/v1/license').set('authorization', bearer);
    expect((await verifyLicense(r1.body.data.licenca, env.LICENSE_PUBLIC_KEY))!.plan).toBe('team');

    expect((await request(app).get('/v1/license')).status).toBe(401);
  });
});
```

- [ ] **Step 2:** `cd server && npx vitest run src/billing/license-routes.test.ts` → FAIL.

- [ ] **Step 3: Implementar** — `server/src/billing/license-routes.ts`:

```ts
import { Router } from 'express';
import type { Db } from '../db/client';
import type { Env } from '../env';
import { entitlementFor } from './entitlement';
import { signLicense } from '../auth/license-signer';
import { asyncHandler as ah } from '../middleware/errors';
import { rateLimit } from '../middleware/rate-limit';
import { requireAuth } from '../middleware/require-auth';

/** Renovação de licença: o app chama no boot/reconexão e após o checkout. */
export function buildLicenseRouter(deps: { db: Db; env: Env; now?: () => number }): Router {
  const { db, env } = deps;
  const r = Router();
  r.get('/license', rateLimit({ windowMs: 60_000, max: 60 }), requireAuth(db),
    ah(async (req, res) => {
      const { input, ttlSeconds } = await entitlementFor(db, req.accountId!);
      const licenca = await signLicense(input, env.LICENSE_PRIVATE_KEY, undefined, ttlSeconds);
      res.json({ ok: true, data: { licenca } });
    }));
  return r;
}
```

Montar em `createApp` (index.ts — RELER antes): `app.use('/v1', buildLicenseRouter({ db: deps.db, env: deps.env }));` (sempre que `deps` existir, não depende de stripe).

- [ ] **Step 4: Teste team-service falhando** — `server/src/team/team-service.test.ts` (helpers pglite como nos testes da Parte 1; `mkTeam` insere time + owner + subscription com `status`/`seats` parametrizados):

```ts
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { CREATE_TABLES_SQL } from '../db/schema';
import type { Db } from '../db/client';
import { createInvite, joinTeam } from './team-service';

async function makeTestDb(): Promise<Db> {
  const client = new PGlite();
  await client.exec(CREATE_TABLES_SQL);
  return drizzle(client, { schema }) as unknown as Db;
}
async function acc(db: Db, email: string): Promise<string> {
  const [a] = await db.insert(schema.accounts).values({ email })
    .returning({ id: schema.accounts.id });
  return a.id;
}
async function mkTeam(db: Db, owner: string, seats = 3, status = 'active'): Promise<string> {
  const [t] = await db.insert(schema.teams).values({ name: 'S', ownerAccountId: owner })
    .returning({ id: schema.teams.id });
  await db.insert(schema.teamMembers).values({ teamId: t.id, accountId: owner, role: 'owner' });
  await db.insert(schema.subscriptions).values({
    ownerType: 'team', teamId: t.id, stripeSubscriptionId: `sub_${t.id}`,
    stripeCustomerId: 'cus', plan: 'team', status, seats,
    currentPeriodEnd: new Date(Date.now() + 86_400_000),
  });
  return t.id;
}

describe('createInvite / joinTeam', () => {
  it('cria convite AB12-CD34, guarda só o hash; join entra (com ou sem hífen)', async () => {
    const db = await makeTestDb();
    const owner = await acc(db, 'o@x.com');
    const teamId = await mkTeam(db, owner);
    const inv = await createInvite(db, teamId, owner);
    expect(inv.code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    const rows = await db.select().from(schema.teamInvites);
    expect(rows[0].codeHash).not.toContain(inv.code.slice(0, 4));
    expect(rows[0].codePrefix).toBe(inv.code.slice(0, 4));
    const member = await acc(db, 'm@x.com');
    const r = await joinTeam(db, member, inv.code.toLowerCase()); // normaliza
    expect(r.ok).toBe(true);
  });

  it('guardas: expirado, revogado, maxUses, já-em-time, assinatura morta, sem assento', async () => {
    const db = await makeTestDb();
    const owner = await acc(db, 'o2@x.com');
    const teamId = await mkTeam(db, owner, 2); // 1 vaga além do owner
    const inv = await createInvite(db, teamId, owner);
    // expirado
    await db.update(schema.teamInvites).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await joinTeam(db, await acc(db, 'a@x.com'), inv.code)).ok).toBe(false);
    await db.update(schema.teamInvites).set({ expiresAt: new Date(Date.now() + 86_400_000) });
    // revogado
    await db.update(schema.teamInvites).set({ revokedAt: new Date() });
    expect((await joinTeam(db, await acc(db, 'b@x.com'), inv.code)).ok).toBe(false);
    await db.update(schema.teamInvites).set({ revokedAt: null });
    // maxUses esgotado
    await db.update(schema.teamInvites).set({ usedCount: 10 });
    expect((await joinTeam(db, await acc(db, 'c@x.com'), inv.code)).ok).toBe(false);
    await db.update(schema.teamInvites).set({ usedCount: 0 });
    // entra (ocupa a última vaga)
    const m1 = await acc(db, 'm1@x.com');
    expect((await joinTeam(db, m1, inv.code)).ok).toBe(true);
    // já está num time
    const again = await joinTeam(db, m1, inv.code);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toMatch(/já está/);
    // sem assento
    const semVaga = await joinTeam(db, await acc(db, 'd@x.com'), inv.code);
    expect(semVaga.ok).toBe(false);
    if (!semVaga.ok) expect(semVaga.error).toMatch(/assento/);
    // assinatura morta
    await db.update(schema.subscriptions).set({ status: 'canceled' })
      .where(eq(schema.subscriptions.teamId, teamId));
    await db.delete(schema.teamMembers).where(eq(schema.teamMembers.accountId, m1));
    const morta = await joinTeam(db, await acc(db, 'e@x.com'), inv.code);
    expect(morta.ok).toBe(false);
    if (!morta.ok) expect(morta.error).toMatch(/ativa/);
  });

  it('corrida do último assento: 2 joins simultâneos → exatamente 1 entra', async () => {
    const db = await makeTestDb();
    const owner = await acc(db, 'o3@x.com');
    const teamId = await mkTeam(db, owner, 2); // 1 vaga
    const inv = await createInvite(db, teamId, owner);
    const [a, b] = await Promise.all([
      joinTeam(db, await acc(db, 'ra@x.com'), inv.code),
      joinTeam(db, await acc(db, 'rb@x.com'), inv.code),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });
});
```

- [ ] **Step 5:** `npx vitest run src/team/team-service.test.ts` → FAIL.

- [ ] **Step 6: Implementar** — `server/src/team/team-service.ts`:

```ts
import crypto from 'node:crypto';
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { subscriptions, teamInvites, teamMembers, teams } from '../db/schema';
import { hashToken } from '../auth/tokens';

/**
 * Convites por código legível "AB12-CD34" (só o sha256 vai pro banco) e join
 * ATÔMICO: consumo do convite via UPDATE condicional + advisory lock por time
 * na checagem de assento (dois joins simultâneos na última vaga: 1 entra).
 */

const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function inviteCode(): string {
  const bytes = crypto.randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += B32[bytes[i] % 32];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}
/** Sem hífen, maiúsculo — colar com/sem traço funciona. */
function normalize(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z2-7]/g, '');
}

export async function createInvite(
  db: Db, teamId: string, createdBy: string, now: () => number = Date.now,
): Promise<{ code: string; codePrefix: string; expiresAt: Date }> {
  const code = inviteCode();
  const expiresAt = new Date(now() + INVITE_TTL_MS);
  await db.insert(teamInvites).values({
    codeHash: hashToken(normalize(code)),
    codePrefix: code.slice(0, 4),
    teamId, createdBy, expiresAt,
  });
  return { code, codePrefix: code.slice(0, 4), expiresAt };
}

export async function joinTeam(
  db: Db, accountId: string, rawCode: string, now: () => number = Date.now,
): Promise<{ ok: true; teamId: string; name: string } | { ok: false; error: string }> {
  const at = new Date(now());
  const [existing] = await db.select().from(teamMembers)
    .where(eq(teamMembers.accountId, accountId)).limit(1);
  if (existing) return { ok: false, error: 'você já está num time' };

  return db.transaction(async (tx) => {
    // Consumo atômico do convite (mesmo padrão do auth-code). Se uma guarda
    // abaixo falhar, retornamos {ok:false} SEM throw: o usedCount consumido
    // fica — aceitável (maxUses=10 é folga, não contrato).
    const [inv] = await tx.update(teamInvites)
      .set({ usedCount: sql`${teamInvites.usedCount} + 1` })
      .where(and(
        eq(teamInvites.codeHash, hashToken(normalize(rawCode))),
        isNull(teamInvites.revokedAt),
        gt(teamInvites.expiresAt, at),
        lt(teamInvites.usedCount, teamInvites.maxUses),
      ))
      .returning({ teamId: teamInvites.teamId });
    if (!inv) return { ok: false as const, error: 'convite inválido ou esgotado' };

    // Serializa joins do MESMO time — corrida do último assento.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${inv.teamId}))`);

    const [sub] = await tx.select().from(subscriptions).where(and(
      eq(subscriptions.ownerType, 'team'), eq(subscriptions.teamId, inv.teamId),
    )).limit(1);
    const live = sub && (['active', 'trialing'].includes(sub.status) ||
      (sub.status === 'past_due' && sub.graceUntil && sub.graceUntil.getTime() > now()));
    if (!live) return { ok: false as const, error: 'assinatura do time não está ativa' };

    const members = await tx.select().from(teamMembers)
      .where(eq(teamMembers.teamId, inv.teamId));
    if (members.length >= sub.seats) {
      return { ok: false as const, error: 'sem assento livre — peça ao dono' };
    }
    await tx.insert(teamMembers).values({ teamId: inv.teamId, accountId, role: 'member' });
    const [team] = await tx.select().from(teams).where(eq(teams.id, inv.teamId)).limit(1);
    return { ok: true as const, teamId: inv.teamId, name: team.name };
  });
}
```

- [ ] **Step 7:** os 2 arquivos de teste PASS; suíte verde; `npx tsc --noEmit` limpo.

- [ ] **Step 8: Commit** — `git add server/src/billing/license-routes.ts server/src/billing/license-routes.test.ts server/src/team/team-service.ts server/src/team/team-service.test.ts server/src/index.ts && git commit -m "feat(server): GET /v1/license + team-service (convite hasheado, join atômico c/ assento)"`

---

### Task 8: team-routes + guarda LGPD do owner

**Files:**
- Create: `server/src/team/team-routes.ts`
- Test: `server/src/team/team-routes.test.ts`
- Modify: `server/src/auth/auth-routes.ts` (guarda no DELETE /me) + `server/src/auth/auth-routes.test.ts`
- Modify: `server/src/index.ts` (montar)

**Interfaces:**
- Consumes: `createInvite`/`joinTeam` (Task 7), `requireAuth`, schema.
- Produces: `buildTeamRouter(deps: {db: Db; env: Env; now?: () => number}): Router` com: `POST /team/invites` (owner), `POST /team/join {code}`, `GET /team`, `DELETE /team/invites/:codePrefix` (owner), `DELETE /team/members/:accountId` (owner, não a si), `POST /team/leave` (member).

- [ ] **Step 1: Testes falhando** — `server/src/team/team-routes.test.ts`. Helpers completos no topo do arquivo (autossuficiente):

```ts
import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { generateKeyPair, exportPKCS8, exportSPKI } from 'jose';
import * as schema from '../db/schema';
import { CREATE_TABLES_SQL } from '../db/schema';
import type { Db } from '../db/client';
import type { Env } from '../env';
import { issueTokens } from '../auth/session-service';
import { errorHandler } from '../middleware/errors';
import { buildTeamRouter } from './team-routes';

/** 2 contas logadas (owner/member) + app com o team router. */
async function setupTwo() {
  const client = new PGlite();
  await client.exec(CREATE_TABLES_SQL);
  const db = drizzle(client, { schema }) as unknown as Db;
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const env = {
    LICENSE_PRIVATE_KEY: await exportPKCS8(privateKey),
    LICENSE_PUBLIC_KEY: await exportSPKI(publicKey),
    GITHUB_OAUTH_ID: 'g', GITHUB_OAUTH_SECRET: 'g', GOOGLE_OAUTH_ID: 'g', GOOGLE_OAUTH_SECRET: 'g',
    PUBLIC_BASE_URL: 'https://api.test', APP_DEEP_LINK_BASE: 'nexus://auth',
    DATABASE_URL: 'x', PORT: 8080,
    STRIPE_SECRET_KEY: 'sk', STRIPE_WEBHOOK_SECRET: 'whsec',
    STRIPE_PRICE_PRO: 'price_pro', STRIPE_PRICE_TEAM: 'price_team',
    PUBLIC_SITE_URL: 'https://nexuside.app',
  } as Env;
  const app = express();
  app.use(express.json());
  app.use('/v1', buildTeamRouter({ db, env }));
  app.use(errorHandler);
  const mk = async (email: string) => {
    const [a] = await db.insert(schema.accounts).values({ email })
      .returning({ id: schema.accounts.id });
    const { session } = await issueTokens(db, a.id);
    return { id: a.id, bearer: `Bearer ${session}` };
  };
  const owner = await mk('owner@x.com');
  const member = await mk('member@x.com');
  return {
    app, db, ownerId: owner.id, memberId: member.id,
    ownerBearer: owner.bearer, memberBearer: member.bearer,
  };
}

/** Time + owner + subscription (mesmo helper da Task 7). */
async function mkTeam(db: Db, owner: string, seats = 3, status = 'active'): Promise<string> {
  const [t] = await db.insert(schema.teams).values({ name: 'S', ownerAccountId: owner })
    .returning({ id: schema.teams.id });
  await db.insert(schema.teamMembers).values({ teamId: t.id, accountId: owner, role: 'owner' });
  await db.insert(schema.subscriptions).values({
    ownerType: 'team', teamId: t.id, stripeSubscriptionId: `sub_${t.id}`,
    stripeCustomerId: 'cus', plan: 'team', status, seats,
    currentPeriodEnd: new Date(Date.now() + 86_400_000),
  });
  return t.id;
}
it('fluxo: owner cria convite → membro entra → GET /team mostra os dois', async () => {
  const { app, db, ownerBearer, memberBearer, ownerId } = await setupTwo();
  await mkTeam(db, ownerId, 3);
  const inv = await request(app).post('/v1/team/invites').set('authorization', ownerBearer);
  expect(inv.status).toBe(200);
  expect(inv.body.data.code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
  expect(inv.body.data.url).toContain('/join/');
  const join = await request(app).post('/v1/team/join')
    .set('authorization', memberBearer).send({ code: inv.body.data.code });
  expect(join.status).toBe(200);
  const team = await request(app).get('/v1/team').set('authorization', memberBearer);
  expect(team.body.data.members).toHaveLength(2);
  expect(team.body.data.seats).toEqual({ used: 2, total: 3 });
});

it('member não cria convite (403); owner não sai (409); member sai (200)', async () => {
  const { app, db, ownerBearer, memberBearer, ownerId, memberId } = await setupTwo();
  const teamId = await mkTeam(db, ownerId, 3);
  await db.insert(schema.teamMembers).values({ teamId, accountId: memberId, role: 'member' });
  expect((await request(app).post('/v1/team/invites')
    .set('authorization', memberBearer)).status).toBe(403);
  expect((await request(app).post('/v1/team/leave')
    .set('authorization', ownerBearer)).status).toBe(409);
  expect((await request(app).post('/v1/team/leave')
    .set('authorization', memberBearer)).status).toBe(200);
});

it('owner remove membro (200) mas não a si (400); revogado impede join', async () => {
  const { app, db, ownerBearer, memberBearer, ownerId, memberId } = await setupTwo();
  const teamId = await mkTeam(db, ownerId, 3);
  await db.insert(schema.teamMembers).values({ teamId, accountId: memberId, role: 'member' });
  expect((await request(app).delete(`/v1/team/members/${ownerId}`)
    .set('authorization', ownerBearer)).status).toBe(400);
  expect((await request(app).delete(`/v1/team/members/${memberId}`)
    .set('authorization', ownerBearer)).status).toBe(200);
  const inv = await request(app).post('/v1/team/invites').set('authorization', ownerBearer);
  const prefix = inv.body.data.codePrefix as string;
  expect((await request(app).delete(`/v1/team/invites/${prefix}`)
    .set('authorization', ownerBearer)).status).toBe(200);
  expect((await request(app).post('/v1/team/join')
    .set('authorization', memberBearer).send({ code: inv.body.data.code })).status).toBe(409);
});

it('sem time → GET /team responde {team:null}', async () => {
  const { app, memberBearer } = await setupTwo();
  const r = await request(app).get('/v1/team').set('authorization', memberBearer);
  expect(r.status).toBe(200);
  expect(r.body.data.team).toBeNull();
});
```

E em `server/src/auth/auth-routes.test.ts` (RELER o arquivo; usar o loop OAuth do teste de DELETE existente como base):

```ts
it('DELETE /me de owner com assinatura de time ativa → 409; cancelada → 200', async () => {
  const { app, db } = await setup();
  const auth = await request(app).get('/v1/auth/github?app_state=n5');
  const state = new URL(auth.headers.location).searchParams.get('state')!;
  const cb = await request(app).get(`/v1/auth/github/callback?code=abc&state=${state}`);
  const code = deepLinkCode(cb.headers.location);
  const ex = await request(app).post('/v1/auth/exchange').send({ code });
  const bearer = `Bearer ${ex.body.data.session}`;
  const accountId = (await db.select().from(schema.accounts))[0].id;
  const [t] = await db.insert(schema.teams).values({ name: 'S', ownerAccountId: accountId })
    .returning({ id: schema.teams.id });
  await db.insert(schema.teamMembers).values({ teamId: t.id, accountId, role: 'owner' });
  await db.insert(schema.subscriptions).values({
    ownerType: 'team', teamId: t.id, stripeSubscriptionId: 's1', stripeCustomerId: 'c1',
    plan: 'team', status: 'active', seats: 3, currentPeriodEnd: new Date(Date.now() + 86_400_000),
  });
  expect((await request(app).delete('/v1/me').set('authorization', bearer)).status).toBe(409);
  const { eq } = await import('drizzle-orm');
  await db.update(schema.subscriptions).set({ status: 'canceled' })
    .where(eq(schema.subscriptions.teamId, t.id));
  expect((await request(app).delete('/v1/me').set('authorization', bearer)).status).toBe(200);
});
```

- [ ] **Step 2:** rodar os 2 arquivos → FAIL.

- [ ] **Step 3: Implementar team-routes** — `server/src/team/team-routes.ts`:

```ts
import { Router } from 'express';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Db } from '../db/client';
import type { Env } from '../env';
import { accounts, subscriptions, teamInvites, teamMembers, teams } from '../db/schema';
import { createInvite, joinTeam } from './team-service';
import { asyncHandler as ah } from '../middleware/errors';
import { rateLimit } from '../middleware/rate-limit';
import { requireAuth } from '../middleware/require-auth';

export function buildTeamRouter(deps: { db: Db; env: Env; now?: () => number }): Router {
  const { db, env } = deps;
  const now = deps.now ?? Date.now;
  const r = Router();
  const limit = rateLimit({ windowMs: 60_000, max: 30 });

  /** Time da conta logada (ou null) + papel. */
  async function myTeam(accountId: string) {
    const [m] = await db.select().from(teamMembers)
      .where(eq(teamMembers.accountId, accountId)).limit(1);
    if (!m) return null;
    const [team] = await db.select().from(teams).where(eq(teams.id, m.teamId)).limit(1);
    return { team, role: m.role };
  }

  r.post('/team/invites', limit, requireAuth(db), ah(async (req, res) => {
    const mine = await myTeam(req.accountId!);
    if (!mine) return res.status(404).json({ ok: false, error: 'sem time' });
    if (mine.role !== 'owner') return res.status(403).json({ ok: false, error: 'só o dono convida' });
    const inv = await createInvite(db, mine.team.id, req.accountId!, now);
    res.json({ ok: true, data: {
      code: inv.code, codePrefix: inv.codePrefix,
      url: `${env.PUBLIC_SITE_URL}/join/${inv.code}`,
      expiresAt: inv.expiresAt.toISOString(),
    } });
  }));

  r.post('/team/join', limit, requireAuth(db), ah(async (req, res) => {
    const code = String((req.body as { code?: string }).code ?? '');
    const out = await joinTeam(db, req.accountId!, code, now);
    if (!out.ok) return res.status(409).json({ ok: false, error: out.error });
    res.json({ ok: true, data: { teamId: out.teamId, name: out.name } });
  }));

  r.get('/team', limit, requireAuth(db), ah(async (req, res) => {
    const mine = await myTeam(req.accountId!);
    if (!mine) return res.json({ ok: true, data: { team: null } });
    const members = await db.select({
      accountId: teamMembers.accountId, role: teamMembers.role,
      name: accounts.name, email: accounts.email, avatarUrl: accounts.avatarUrl,
    }).from(teamMembers)
      .innerJoin(accounts, eq(accounts.id, teamMembers.accountId))
      .where(eq(teamMembers.teamId, mine.team.id));
    const [sub] = await db.select().from(subscriptions).where(and(
      eq(subscriptions.ownerType, 'team'), eq(subscriptions.teamId, mine.team.id),
    )).limit(1);
    const invites = mine.role === 'owner'
      ? await db.select({
          codePrefix: teamInvites.codePrefix, usedCount: teamInvites.usedCount,
          maxUses: teamInvites.maxUses, expiresAt: teamInvites.expiresAt,
        }).from(teamInvites).where(and(
          eq(teamInvites.teamId, mine.team.id),
          isNull(teamInvites.revokedAt),
          gt(teamInvites.expiresAt, new Date(now())),
        ))
      : [];
    res.json({ ok: true, data: {
      team: { id: mine.team.id, name: mine.team.name, role: mine.role },
      members,
      seats: { used: members.length, total: sub?.seats ?? 0 },
      overLimit: sub ? members.length > sub.seats : false,
      status: sub?.status ?? 'none',
      invites,
    } });
  }));

  r.delete('/team/invites/:codePrefix', limit, requireAuth(db), ah(async (req, res) => {
    const mine = await myTeam(req.accountId!);
    if (!mine || mine.role !== 'owner') return res.status(403).json({ ok: false, error: 'só o dono' });
    await db.update(teamInvites).set({ revokedAt: new Date(now()) }).where(and(
      eq(teamInvites.teamId, mine.team.id),
      eq(teamInvites.codePrefix, String(req.params.codePrefix)),
      isNull(teamInvites.revokedAt),
    ));
    res.json({ ok: true });
  }));

  r.delete('/team/members/:accountId', limit, requireAuth(db), ah(async (req, res) => {
    const mine = await myTeam(req.accountId!);
    if (!mine || mine.role !== 'owner') return res.status(403).json({ ok: false, error: 'só o dono' });
    const target = String(req.params.accountId);
    if (target === req.accountId) {
      return res.status(400).json({ ok: false, error: 'o dono não remove a si — cancele no portal' });
    }
    await db.delete(teamMembers).where(and(
      eq(teamMembers.teamId, mine.team.id), eq(teamMembers.accountId, target),
    ));
    res.json({ ok: true });
  }));

  r.post('/team/leave', limit, requireAuth(db), ah(async (req, res) => {
    const mine = await myTeam(req.accountId!);
    if (!mine) return res.status(404).json({ ok: false, error: 'sem time' });
    if (mine.role === 'owner') {
      return res.status(409).json({ ok: false, error: 'o dono não sai — cancele a assinatura' });
    }
    await db.delete(teamMembers).where(and(
      eq(teamMembers.teamId, mine.team.id), eq(teamMembers.accountId, req.accountId!),
    ));
    res.json({ ok: true });
  }));

  return r;
}
```

- [ ] **Step 4: Guarda LGPD** — em `auth-routes.ts` (RELER antes), o DELETE /me vira:

```ts
r.delete('/me', requireAuth(db), ah(async (req, res) => {
  // Dono de time com assinatura viva: apagar a conta descartaria o billing
  // do time inteiro — exige cancelar no portal primeiro.
  const owned = await db.select().from(teams)
    .where(eq(teams.ownerAccountId, req.accountId!));
  for (const t of owned) {
    const [sub] = await db.select().from(subscriptions).where(and(
      eq(subscriptions.ownerType, 'team'), eq(subscriptions.teamId, t.id),
    )).limit(1);
    const live = sub && ['active', 'trialing', 'past_due'].includes(sub.status);
    if (live) {
      return res.status(409).json({ ok: false, error: 'cancele a assinatura do time primeiro' });
    }
  }
  await db.delete(accounts).where(eq(accounts.id, req.accountId!)); // cascade
  res.json({ ok: true });
}));
```

(adicionar `teams`, `subscriptions` ao import do schema em auth-routes.ts)

- [ ] **Step 5: Montar** — `createApp`: `app.use('/v1', buildTeamRouter({ db: deps.db, env: deps.env }));` junto do license router.

- [ ] **Step 6:** todos os testes PASS; suíte inteira `npx vitest run` verde; `npx tsc --noEmit` limpo.

- [ ] **Step 7: Commit** — `git add server/src/team/team-routes.ts server/src/team/team-routes.test.ts server/src/auth/auth-routes.ts server/src/auth/auth-routes.test.ts server/src/index.ts && git commit -m "feat(server): rotas de time (convite/join/gestão) + guarda LGPD do owner"`
