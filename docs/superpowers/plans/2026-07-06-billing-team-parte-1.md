# Billing + Team — Plano de Implementação (Parte 1/3: fundação server)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fundação do Billing no `server/`: env Stripe, schema (5 tabelas), cliente Stripe injetável, subscription-service (estado→banco) e entitlement→licença.

**Architecture:** Stripe é a fonte de verdade; o banco guarda o espelho mínimo (`subscriptions`). O webhook (Parte 2) SEMPRE busca o estado atual na API e chama `applySubscriptionState`. `GET /v1/license` calcula o entitlement na hora via `entitlementFor` e assina o JWT Ed25519 já existente.

**Tech Stack:** Express, Drizzle/Postgres (pglite nos testes), stripe (npm, sempre injetado), jose, vitest.

## Global Constraints

- NUNCA mencionar concorrentes em código/comentários/docs.
- Comentários em pt-BR, seguindo o estilo dos arquivos do Auth.
- Envelope `{ok, data?, error?}` em toda resposta HTTP.
- Tokens/códigos NUNCA em claro no banco — só sha256 (`hashToken` de `server/src/auth/tokens.ts`).
- Operações single-use/contadas = atômicas (`UPDATE ... WHERE ... RETURNING`), como no Auth pós-review.
- Testes: pglite + deps injetadas; rodar com `cd server && npx vitest run <arquivo>`; typecheck `npx tsc --noEmit`.
- Sessões concorrentes mexem no working tree: **releia cada arquivo imediatamente antes de editar**; `git add` sempre por arquivo, nunca `-A`.

---

### Task 1: Env Stripe + dependência + cliente injetável

**Files:**
- Modify: `server/src/env.ts`
- Modify: `server/src/env.test.ts`
- Create: `server/src/billing/stripe-like.ts`
- Modify: `server/package.json` (dep `stripe`)

**Interfaces:**
- Produces: `Env` ganha `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_TEAM`, `PUBLIC_SITE_URL`. `StripeLike` (subconjunto injetável), `StripeSubscription`, `StripeEvent`, `makeFakeStripe()` p/ testes.

- [ ] **Step 1: Teste falhando** — em `server/src/env.test.ts`, dentro do describe existente, adicionar (usar o objeto base válido que os testes atuais já montam, acrescentando os campos novos):

```ts
it('exige as vars do Stripe', () => {
  const base = validEnv(); // helper existente do arquivo; se não houver, montar objeto completo
  expect(() => parseEnv({ ...base, STRIPE_SECRET_KEY: undefined } as never)).toThrow(/STRIPE_SECRET_KEY/);
  const ok = parseEnv({
    ...base,
    STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x',
    STRIPE_PRICE_PRO: 'price_pro', STRIPE_PRICE_TEAM: 'price_team',
    PUBLIC_SITE_URL: 'https://nexuside.app',
  });
  expect(ok.STRIPE_PRICE_PRO).toBe('price_pro');
});
```

IMPORTANTE: os testes existentes de env montam o objeto completo — eles vão QUEBRAR ao adicionar campos obrigatórios. Atualizar o objeto base deles com os 5 campos novos.

- [ ] **Step 2:** `cd server && npx vitest run src/env.test.ts` → FAIL.

- [ ] **Step 3: Implementar** — em `server/src/env.ts`, adicionar ao `schema`:

```ts
  STRIPE_SECRET_KEY: z.string().min(1),
  STRIPE_WEBHOOK_SECRET: z.string().min(1),
  STRIPE_PRICE_PRO: z.string().min(1),
  STRIPE_PRICE_TEAM: z.string().min(1),
  PUBLIC_SITE_URL: z.string().url(),
```

- [ ] **Step 4: Criar `server/src/billing/stripe-like.ts`:**

```ts
/**
 * Subconjunto ESTRUTURAL do SDK do Stripe que o backend usa — sempre injetado
 * (nunca `new Stripe()` dentro de service/rota; só no boot). Testes usam
 * makeFakeStripe(). O SDK real satisfaz este shape por tipagem estrutural.
 */

export interface StripeSubscription {
  id: string;
  customer: string;
  status: string; // active | trialing | past_due | canceled | ...
  items: { data: Array<{ quantity?: number; price: { id: string } }> };
  current_period_end: number; // epoch segundos
  metadata: Record<string, string>;
}

export interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

export interface StripeLike {
  customers: {
    create(p: { email?: string; metadata?: Record<string, string> }): Promise<{ id: string }>;
  };
  checkout: {
    sessions: {
      create(p: Record<string, unknown>): Promise<{ url: string | null }>;
    };
  };
  billingPortal: {
    sessions: {
      create(p: { customer: string; return_url: string }): Promise<{ url: string }>;
    };
  };
  subscriptions: {
    retrieve(id: string): Promise<StripeSubscription>;
  };
  webhooks: {
    constructEvent(body: Buffer | string, sig: string, secret: string): StripeEvent;
  };
}

/** Fake p/ testes: grava chamadas e responde o que o teste programar. */
export function makeFakeStripe(over: Partial<{
  subscription: StripeSubscription;
  checkoutUrl: string;
  portalUrl: string;
  event: StripeEvent | Error;
}> = {}) {
  const calls: Record<string, unknown[]> = {
    customersCreate: [], checkoutCreate: [], portalCreate: [], retrieve: [],
  };
  const stripe: StripeLike = {
    customers: {
      create: async (p) => { calls.customersCreate.push(p); return { id: 'cus_fake' }; },
    },
    checkout: {
      sessions: {
        create: async (p) => { calls.checkoutCreate.push(p); return { url: over.checkoutUrl ?? 'https://stripe.test/checkout' }; },
      },
    },
    billingPortal: {
      sessions: {
        create: async (p) => { calls.portalCreate.push(p); return { url: over.portalUrl ?? 'https://stripe.test/portal' }; },
      },
    },
    subscriptions: {
      retrieve: async (id) => {
        calls.retrieve.push(id);
        if (!over.subscription) throw new Error('fake: sem subscription programada');
        return over.subscription;
      },
    },
    webhooks: {
      constructEvent: () => {
        if (over.event instanceof Error) throw over.event;
        if (!over.event) throw new Error('fake: sem event programado');
        return over.event;
      },
    },
  };
  return { stripe, calls };
}
```

- [ ] **Step 5:** `cd server && npm install stripe` (dep de produção).

- [ ] **Step 6:** `npx vitest run src/env.test.ts` → PASS; `npx tsc --noEmit` → limpo.

- [ ] **Step 7: Commit** — `git add server/src/env.ts server/src/env.test.ts server/src/billing/stripe-like.ts server/package.json server/package-lock.json && git commit -m "feat(server): env Stripe + StripeLike injetável com fake de teste"`

---

### Task 2: Schema — teams, team_members, team_invites, subscriptions, stripe_events

**Files:**
- Modify: `server/src/db/schema.ts` (tabelas + `CREATE_TABLES_SQL`)
- Modify: `server/src/db/schema.test.ts`

**Interfaces:**
- Consumes: `pgTable`, enums existentes (`planEnum`), padrão do arquivo.
- Produces: exports `teams`, `teamMembers`, `teamInvites`, `subscriptions`, `stripeEvents`; enums `ownerTypeEnum('account'|'team')`, `teamRoleEnum('owner'|'member')`. DDL de teste atualizada.

- [ ] **Step 1: Teste falhando** — em `server/src/db/schema.test.ts`:

```ts
it('billing: tabelas novas aceitam o fluxo mínimo', async () => {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await client.exec(CREATE_TABLES_SQL);
  const [acc] = await db.insert(schema.accounts).values({ email: 't@x.com' }).returning({ id: schema.accounts.id });
  const [team] = await db.insert(schema.teams).values({ name: 'Squad', ownerAccountId: acc.id }).returning({ id: schema.teams.id });
  await db.insert(schema.teamMembers).values({ teamId: team.id, accountId: acc.id, role: 'owner' });
  // 1 time por conta (UNIQUE accountId)
  const [team2] = await db.insert(schema.teams).values({ name: 'Outro', ownerAccountId: acc.id }).returning({ id: schema.teams.id });
  await expect(
    db.insert(schema.teamMembers).values({ teamId: team2.id, accountId: acc.id, role: 'member' }),
  ).rejects.toBeTruthy();
  await db.insert(schema.subscriptions).values({
    ownerType: 'team', teamId: team.id, stripeSubscriptionId: 'sub_1',
    stripeCustomerId: 'cus_1', plan: 'team', status: 'active', seats: 5,
    currentPeriodEnd: new Date(Date.now() + 86_400_000),
  });
  await db.insert(schema.stripeEvents).values({ eventId: 'evt_1', type: 'x', payload: {} });
  // idempotência: mesmo eventId não duplica
  await db.insert(schema.stripeEvents).values({ eventId: 'evt_1', type: 'x', payload: {} })
    .onConflictDoNothing();
  expect(await db.select().from(schema.stripeEvents)).toHaveLength(1);
});
```

- [ ] **Step 2:** `npx vitest run src/db/schema.test.ts` → FAIL.

- [ ] **Step 3: Implementar** — em `server/src/db/schema.ts` (imports extras: `integer`, `jsonb`, `unique` já existe):

```ts
export const ownerTypeEnum = pgEnum('owner_type', ['account', 'team']);
export const teamRoleEnum = pgEnum('team_role', ['owner', 'member']);

export const teams = pgTable('teams', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  ownerAccountId: uuid('owner_account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const teamMembers = pgTable(
  'team_members',
  {
    teamId: uuid('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
    role: teamRoleEnum('role').notNull(),
    joinedAt: timestamp('joined_at').notNull().defaultNow(),
  },
  // 1 time por conta no v1 → entitlement determinístico (fase 2: soltar)
  (t) => [
    unique('team_members_pk').on(t.teamId, t.accountId),
    unique('team_members_one_team_per_account').on(t.accountId),
  ],
);

export const teamInvites = pgTable('team_invites', {
  codeHash: text('code_hash').primaryKey(), // sha256 — nunca em claro
  codePrefix: text('code_prefix').notNull(), // 4 chars p/ listar/revogar
  teamId: uuid('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  createdBy: uuid('created_by').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  maxUses: integer('max_uses').notNull().default(10),
  usedCount: integer('used_count').notNull().default(0),
  expiresAt: timestamp('expires_at').notNull(),
  revokedAt: timestamp('revoked_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const subscriptions = pgTable('subscriptions', {
  id: uuid('id').defaultRandom().primaryKey(),
  ownerType: ownerTypeEnum('owner_type').notNull(),
  accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }),
  stripeSubscriptionId: text('stripe_subscription_id').notNull().unique(),
  stripeCustomerId: text('stripe_customer_id').notNull(),
  plan: planEnum('plan').notNull(),
  status: text('status').notNull(), // espelho Stripe
  seats: integer('seats').notNull().default(1),
  currentPeriodEnd: timestamp('current_period_end'),
  graceUntil: timestamp('grace_until'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const stripeEvents = pgTable('stripe_events', {
  eventId: text('event_id').primaryKey(),
  type: text('type').notNull(),
  processedAt: timestamp('processed_at'),
  payload: jsonb('payload').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});
```

E no fim de `CREATE_TABLES_SQL` (antes do fechamento do template):

```sql
CREATE TYPE owner_type AS ENUM ('account','team');
CREATE TYPE team_role AS ENUM ('owner','member');
CREATE TABLE teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  owner_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at timestamp NOT NULL DEFAULT now());
CREATE TABLE team_members (
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role team_role NOT NULL,
  joined_at timestamp NOT NULL DEFAULT now(),
  UNIQUE(team_id, account_id), UNIQUE(account_id));
CREATE TABLE team_invites (
  code_hash text PRIMARY KEY, code_prefix text NOT NULL,
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  max_uses int NOT NULL DEFAULT 10, used_count int NOT NULL DEFAULT 0,
  expires_at timestamp NOT NULL, revoked_at timestamp,
  created_at timestamp NOT NULL DEFAULT now());
CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type owner_type NOT NULL,
  account_id uuid REFERENCES accounts(id) ON DELETE CASCADE,
  team_id uuid REFERENCES teams(id) ON DELETE CASCADE,
  stripe_subscription_id text NOT NULL UNIQUE,
  stripe_customer_id text NOT NULL,
  plan plan NOT NULL, status text NOT NULL, seats int NOT NULL DEFAULT 1,
  current_period_end timestamp, grace_until timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now());
CREATE TABLE stripe_events (
  event_id text PRIMARY KEY, type text NOT NULL,
  processed_at timestamp, payload jsonb NOT NULL,
  created_at timestamp NOT NULL DEFAULT now());
```

- [ ] **Step 4:** `npx vitest run src/db/schema.test.ts` → PASS; suíte inteira `npx vitest run` → verde (nada existente quebra).

- [ ] **Step 5: Migration** — `npx drizzle-kit generate --name billing_team` → confere que `drizzle/0003_billing_team.sql` cria as 5 tabelas + 2 enums.

- [ ] **Step 6: Commit** — `git add server/src/db/schema.ts server/src/db/schema.test.ts server/drizzle && git commit -m "feat(server): schema billing+team (subscriptions, teams, invites, stripe_events)"`

---

### Task 3: subscription-service — estado do Stripe → banco

**Files:**
- Create: `server/src/billing/subscription-service.ts`
- Test: `server/src/billing/subscription-service.test.ts`

**Interfaces:**
- Consumes: `subscriptions`, `accounts`, `teams` do schema; `StripeSubscription` da Task 1.
- Produces: `applySubscriptionState(db, sub: StripeSubscription, env: PriceMap, now?): Promise<void>` onde `type PriceMap = { pricePro: string; priceTeam: string }`. `GRACE_MS = 7*24*3600*1000`.

- [ ] **Step 1: Teste falhando** — `server/src/billing/subscription-service.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { CREATE_TABLES_SQL } from '../db/schema';
import type { Db } from '../db/client';
import type { StripeSubscription } from './stripe-like';
import { applySubscriptionState } from './subscription-service';

const PRICES = { pricePro: 'price_pro', priceTeam: 'price_team' };

async function makeTestDb(): Promise<Db> {
  const client = new PGlite();
  await client.exec(CREATE_TABLES_SQL);
  return drizzle(client, { schema }) as unknown as Db;
}
async function anAccount(db: Db): Promise<string> {
  const [a] = await db.insert(schema.accounts).values({ email: 'x@y.com' })
    .returning({ id: schema.accounts.id });
  return a.id;
}
function sub(accountId: string, over: Partial<StripeSubscription> = {}): StripeSubscription {
  return {
    id: 'sub_1', customer: 'cus_1', status: 'active',
    items: { data: [{ quantity: 1, price: { id: 'price_pro' } }] },
    current_period_end: Math.floor(Date.now() / 1000) + 86_400,
    metadata: { accountId, plan: 'pro' },
    ...over,
  };
}

describe('applySubscriptionState', () => {
  it('active pro: upsert + accounts.plan vira cache', async () => {
    const db = await makeTestDb();
    const acc = await anAccount(db);
    await applySubscriptionState(db, sub(acc), PRICES);
    const [row] = await db.select().from(schema.subscriptions);
    expect(row.plan).toBe('pro');
    expect(row.status).toBe('active');
    expect(row.graceUntil).toBeNull();
    const [a] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, acc));
    expect(a.plan).toBe('pro');
  });

  it('past_due liga graceUntil (+7d) e MANTÉM o plano no cache', async () => {
    const db = await makeTestDb();
    const acc = await anAccount(db);
    await applySubscriptionState(db, sub(acc), PRICES);
    await applySubscriptionState(db, sub(acc, { status: 'past_due' }), PRICES);
    const [row] = await db.select().from(schema.subscriptions);
    expect(row.status).toBe('past_due');
    expect(row.graceUntil!.getTime()).toBeGreaterThan(Date.now());
    const [a] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, acc));
    expect(a.plan).toBe('pro'); // grace mantém
  });

  it('canceled: cache volta a free; reprocessar o MESMO estado é idempotente', async () => {
    const db = await makeTestDb();
    const acc = await anAccount(db);
    await applySubscriptionState(db, sub(acc), PRICES);
    await applySubscriptionState(db, sub(acc, { status: 'canceled' }), PRICES);
    await applySubscriptionState(db, sub(acc, { status: 'canceled' }), PRICES);
    expect(await db.select().from(schema.subscriptions)).toHaveLength(1);
    const [a] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, acc));
    expect(a.plan).toBe('free');
  });

  it('team: seats do quantity; sem accountId no cache', async () => {
    const db = await makeTestDb();
    const acc = await anAccount(db);
    const [team] = await db.insert(schema.teams)
      .values({ name: 'S', ownerAccountId: acc }).returning({ id: schema.teams.id });
    await applySubscriptionState(db, sub(acc, {
      items: { data: [{ quantity: 5, price: { id: 'price_team' } }] },
      metadata: { accountId: acc, teamId: team.id, plan: 'team' },
    }), PRICES);
    const [row] = await db.select().from(schema.subscriptions);
    expect(row.ownerType).toBe('team');
    expect(row.seats).toBe(5);
    expect(row.teamId).toBe(team.id);
  });
});
```

- [ ] **Step 2:** `npx vitest run src/billing/subscription-service.test.ts` → FAIL (módulo não existe).

- [ ] **Step 3: Implementar** — `server/src/billing/subscription-service.ts`:

```ts
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { accounts, subscriptions } from '../db/schema';
import type { StripeSubscription } from './stripe-like';

/**
 * Aplica o estado ATUAL de uma assinatura (vindo da API do Stripe — nunca do
 * payload de um evento) no espelho local. Idempotente: reaplicar o mesmo
 * estado não muda nada. É o ÚNICO caminho de escrita em `subscriptions`.
 */

export const GRACE_MS = 7 * 24 * 3600 * 1000;
export type PriceMap = { pricePro: string; priceTeam: string };

const PAID_STATUSES = new Set(['active', 'trialing', 'past_due']);

export async function applySubscriptionState(
  db: Db,
  sub: StripeSubscription,
  prices: PriceMap,
  now: () => number = Date.now,
): Promise<void> {
  const priceId = sub.items.data[0]?.price.id ?? '';
  const plan = priceId === prices.priceTeam || sub.metadata.plan === 'team' ? 'team' : 'pro';
  const teamId = sub.metadata.teamId || null;
  const accountId = sub.metadata.accountId || null;
  const graceUntil = sub.status === 'past_due' ? new Date(now() + GRACE_MS) : null;
  const values = {
    ownerType: (teamId ? 'team' : 'account') as 'team' | 'account',
    accountId: teamId ? null : accountId,
    teamId,
    stripeSubscriptionId: sub.id,
    stripeCustomerId: sub.customer,
    plan: plan as 'pro' | 'team',
    status: sub.status,
    seats: sub.items.data[0]?.quantity ?? 1,
    currentPeriodEnd: new Date(sub.current_period_end * 1000),
    graceUntil,
    updatedAt: new Date(now()),
  };
  await db
    .insert(subscriptions)
    .values(values)
    .onConflictDoUpdate({ target: subscriptions.stripeSubscriptionId, set: values });

  // Cache do plano PESSOAL (time não mexe em accounts.plan — o entitlement
  // de membro é calculado na licença).
  if (!teamId && accountId) {
    const inGrace = sub.status === 'past_due' && graceUntil !== null;
    const effective = PAID_STATUSES.has(sub.status) || inGrace ? plan : 'free';
    await db.update(accounts).set({ plan: effective as 'free' | 'pro' | 'team' })
      .where(eq(accounts.id, accountId));
  }
}
```

- [ ] **Step 4:** `npx vitest run src/billing/subscription-service.test.ts` → PASS (4 testes).

- [ ] **Step 5: Commit** — `git add server/src/billing/subscription-service.* && git commit -m "feat(server): subscription-service — estado Stripe→banco, grace +7d, cache de plano"`

---

### Task 4: entitlement + licença com TTL variável

**Files:**
- Modify: `server/src/auth/license-signer.ts` (TTL opcional)
- Create: `server/src/billing/entitlement.ts`
- Test: `server/src/billing/entitlement.test.ts`
- Modify: `server/src/auth/license-signer.test.ts` (teste do TTL)

**Interfaces:**
- Consumes: schema; `SignInput` do license-signer.
- Produces: `signLicense(input, pem, now?, ttlSeconds?)` (4º param, default 30d — retrocompatível). `entitlementFor(db, accountId, now?): Promise<{ input: SignInput; ttlSeconds: number }>`; `TTL_PERSONAL = 30*24*3600`, `TTL_TEAM_MEMBER = 7*24*3600`.

- [ ] **Step 1: Teste falhando (TTL)** — em `server/src/auth/license-signer.test.ts` adicionar:

```ts
it('aceita TTL customizado (licença de time = 7d)', async () => {
  const jwt = await signLicense(
    { plan: 'team', email: 'a@b.com', status: 'active' },
    privateKeyPem, // fixture existente do arquivo
    () => 1_000_000,
    7 * 24 * 3600,
  );
  const payload = await verifyLicense(jwt, publicKeyPem);
  expect(payload!.exp).toBe(1_000_000 + 7 * 24 * 3600);
});
```

- [ ] **Step 2: Teste falhando (entitlement)** — `server/src/billing/entitlement.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../db/schema';
import { CREATE_TABLES_SQL } from '../db/schema';
import type { Db } from '../db/client';
import { entitlementFor, TTL_PERSONAL, TTL_TEAM_MEMBER } from './entitlement';

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
async function teamWith(db: Db, owner: string, member: string, status = 'active') {
  const [t] = await db.insert(schema.teams).values({ name: 'S', ownerAccountId: owner })
    .returning({ id: schema.teams.id });
  await db.insert(schema.teamMembers).values([
    { teamId: t.id, accountId: owner, role: 'owner' },
    { teamId: t.id, accountId: member, role: 'member' },
  ]);
  await db.insert(schema.subscriptions).values({
    ownerType: 'team', teamId: t.id, stripeSubscriptionId: 'sub_t',
    stripeCustomerId: 'cus_t', plan: 'team', status, seats: 5,
    currentPeriodEnd: new Date(Date.now() + 86_400_000),
  });
  return t.id;
}

describe('entitlementFor', () => {
  it('sem nada → free/none, TTL pessoal', async () => {
    const db = await makeTestDb();
    const a = await acc(db, 'free@x.com');
    const r = await entitlementFor(db, a);
    expect(r.input.plan).toBe('free');
    expect(r.input.status).toBe('none');
    expect(r.ttlSeconds).toBe(TTL_PERSONAL);
  });

  it('assinatura pessoal ativa → pro com renewsAt', async () => {
    const db = await makeTestDb();
    const a = await acc(db, 'pro@x.com');
    await db.insert(schema.subscriptions).values({
      ownerType: 'account', accountId: a, stripeSubscriptionId: 'sub_p',
      stripeCustomerId: 'cus_p', plan: 'pro', status: 'active', seats: 1,
      currentPeriodEnd: new Date(Date.now() + 86_400_000),
    });
    const r = await entitlementFor(db, a);
    expect(r.input.plan).toBe('pro');
    expect(r.input.status).toBe('active');
    expect(r.input.renewsAt).toBeTruthy();
    expect(r.ttlSeconds).toBe(TTL_PERSONAL);
  });

  it('membro de time ativo → team com TTL CURTO (7d)', async () => {
    const db = await makeTestDb();
    const owner = await acc(db, 'own@x.com');
    const member = await acc(db, 'mem@x.com');
    await teamWith(db, owner, member);
    const r = await entitlementFor(db, member);
    expect(r.input.plan).toBe('team');
    expect(r.ttlSeconds).toBe(TTL_TEAM_MEMBER);
  });

  it('time past_due DENTRO da grace mantém team; cancelado → free', async () => {
    const db = await makeTestDb();
    const owner = await acc(db, 'o2@x.com');
    const member = await acc(db, 'm2@x.com');
    const teamId = await teamWith(db, owner, member, 'past_due');
    const { eq } = await import('drizzle-orm');
    await db.update(schema.subscriptions)
      .set({ graceUntil: new Date(Date.now() + 3_600_000) })
      .where(eq(schema.subscriptions.teamId, teamId));
    const inGrace = await entitlementFor(db, member);
    expect(inGrace.input.plan).toBe('team');
    expect(inGrace.input.status).toBe('past_due');
    await db.update(schema.subscriptions).set({ status: 'canceled', graceUntil: null })
      .where(eq(schema.subscriptions.teamId, teamId));
    const after = await entitlementFor(db, member);
    expect(after.input.plan).toBe('free');
  });
});
```

- [ ] **Step 3:** rodar os dois arquivos → FAIL.

- [ ] **Step 4: Implementar TTL** — em `license-signer.ts`, assinatura vira:

```ts
export async function signLicense(
  input: SignInput,
  privateKeyPem: string,
  now: () => number = () => Math.floor(Date.now() / 1000),
  ttlSeconds: number = TTL_SECONDS,
): Promise<string> {
```

e `.setExpirationTime(iat + ttlSeconds)`.

- [ ] **Step 5: Implementar entitlement** — `server/src/billing/entitlement.ts`:

```ts
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { accounts, subscriptions, teamMembers } from '../db/schema';
import type { SignInput } from '../auth/license-signer';

/**
 * Entitlement = max(assinatura pessoal, plano do time onde sou membro).
 * Licença derivada de TIME tem TTL curto (7d): membro removido perde o
 * acesso na renovação, limitando a janela offline.
 */

export const TTL_PERSONAL = 30 * 24 * 3600;
export const TTL_TEAM_MEMBER = 7 * 24 * 3600;

const RANK: Record<string, number> = { free: 0, pro: 1, team: 2 };

function liveStatus(
  status: string,
  graceUntil: Date | null,
  now: number,
): 'active' | 'past_due' | null {
  if (status === 'active' || status === 'trialing') return 'active';
  if (status === 'past_due' && graceUntil && graceUntil.getTime() > now) return 'past_due';
  return null; // canceled/expirado/grace vencida → não conta
}

export async function entitlementFor(
  db: Db,
  accountId: string,
  now: () => number = Date.now,
): Promise<{ input: SignInput; ttlSeconds: number }> {
  const t = now();
  const [acc] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
  const email = acc?.email ?? null;

  let best: { plan: string; status: 'active' | 'past_due'; renewsAt: string | null; graceUntil: string | null; fromTeam: boolean } | null = null;
  const consider = (sub: typeof subscriptions.$inferSelect, fromTeam: boolean) => {
    const st = liveStatus(sub.status, sub.graceUntil, t);
    if (!st) return;
    if (!best || RANK[sub.plan] > RANK[best.plan]) {
      best = {
        plan: sub.plan, status: st,
        renewsAt: sub.currentPeriodEnd?.toISOString() ?? null,
        graceUntil: sub.graceUntil?.toISOString() ?? null,
        fromTeam,
      };
    }
  };

  const personal = await db.select().from(subscriptions)
    .where(and(eq(subscriptions.ownerType, 'account'), eq(subscriptions.accountId, accountId)));
  personal.forEach((s) => consider(s, false));

  const memberships = await db.select().from(teamMembers)
    .where(eq(teamMembers.accountId, accountId));
  for (const m of memberships) {
    const teamSubs = await db.select().from(subscriptions)
      .where(and(eq(subscriptions.ownerType, 'team'), eq(subscriptions.teamId, m.teamId)));
    teamSubs.forEach((s) => consider(s, true));
  }

  if (!best) {
    return {
      input: { plan: 'free', email, status: 'none' },
      ttlSeconds: TTL_PERSONAL,
    };
  }
  return {
    input: {
      plan: best.plan as SignInput['plan'], email, status: best.status,
      renewsAt: best.renewsAt, graceUntil: best.graceUntil,
    },
    ttlSeconds: best.fromTeam ? TTL_TEAM_MEMBER : TTL_PERSONAL,
  };
}
```

- [ ] **Step 6:** `npx vitest run src/billing/entitlement.test.ts src/auth/license-signer.test.ts` → PASS; `npx tsc --noEmit` limpo.

- [ ] **Step 7: Commit** — `git add server/src/billing/entitlement.* server/src/auth/license-signer.* && git commit -m "feat(server): entitlement (pessoal vs time, grace) + licença com TTL variável"`
