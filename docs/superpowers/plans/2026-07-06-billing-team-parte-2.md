# Billing + Team — Plano de Implementação (Parte 2/4: checkout, portal e webhook)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Pré-requisito:** Parte 1 concluída (env Stripe, schema, StripeLike/makeFakeStripe, applySubscriptionState, entitlementFor, signLicense com TTL).

**Goal:** Rotas `/v1/billing/checkout`, `/v1/billing/portal` e o webhook idempotente/tolerante a ordem.

**Architecture:** `buildBillingRouter(BillingDeps)` e `buildWebhookRouter(BillingDeps)` seguem o padrão de `buildAuthRouter`: deps injetadas, `asyncHandler` em toda rota async, envelope `{ok,data?,error?}`. Webhook usa raw body (montado ANTES do `express.json` no `createApp`).

**Tech Stack:** Express 4, Drizzle/pglite, supertest, fake Stripe da Parte 1.

## Global Constraints

- Iguais à Parte 1 (sem concorrentes; pt-BR; envelope; hash de códigos; atomicidade; reler arquivo antes de editar; `git add` por arquivo).
- Toda rota async envolvida em `ah()` (`asyncHandler` de `server/src/middleware/errors.ts`).

---

### Task 5: billing-routes — checkout + portal

**Files:**
- Create: `server/src/billing/billing-routes.ts`
- Create: `server/src/billing/test-helpers.ts` (setup compartilhado — NUNCA exportar de um `.test.ts`: importar um test file de outro re-registra os testes dele)
- Test: `server/src/billing/billing-routes.test.ts`
- Modify: `server/src/index.ts` (montar router; deps ganham `stripe`)

**Interfaces:**
- Consumes: `requireAuth(db)`, `ah`, `rateLimit`, `StripeLike`, schema, `Env` com campos Stripe.
- Produces: `buildBillingRouter(deps: BillingDeps): Router` com `interface BillingDeps { db: Db; env: Env; stripe: StripeLike; now?: () => number }`. Rotas: `POST /billing/checkout`, `POST /billing/portal`. `createApp(deps?: AuthDeps & { stripe?: StripeLike })` monta billing quando `stripe` presente.

- [ ] **Step 1: Teste falhando** — primeiro criar `server/src/billing/test-helpers.ts` (setup compartilhado pelas Partes 2–3; pglite + env fake + Ed25519 + `makeFakeStripe`; sessão via `issueTokens` — evita repetir o loop OAuth):

```ts
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { generateKeyPair, exportPKCS8, exportSPKI } from 'jose';
import * as schema from '../db/schema';
import { CREATE_TABLES_SQL } from '../db/schema';
import type { Db } from '../db/client';
import type { Env } from '../env';
import { issueTokens } from '../auth/session-service';
import { errorHandler } from '../middleware/errors';
import { makeFakeStripe } from './stripe-like';
import { buildBillingRouter } from './billing-routes';

/** Setup de teste do billing: banco pglite + env fake + app com o router. */
export async function setup(fake = makeFakeStripe()) {
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
  app.use('/v1', buildBillingRouter({ db, env, stripe: fake.stripe }));
  app.use(errorHandler);
  const [acc] = await db.insert(schema.accounts).values({ email: 'u@x.com' })
    .returning({ id: schema.accounts.id });
  const { session } = await issueTokens(db, acc.id);
  return { app, db, env, fake, accountId: acc.id, bearer: `Bearer ${session}` };
}
```

Depois `server/src/billing/billing-routes.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import * as schema from '../db/schema';
import { setup } from './test-helpers';

describe('billing-routes', () => {
  it('checkout pro: cria customer + session e devolve a url', async () => {
    const { app, fake, bearer } = await setup();
    const r = await request(app).post('/v1/billing/checkout')
      .set('authorization', bearer).send({ plan: 'pro' });
    expect(r.status).toBe(200);
    expect(r.body.data.url).toBe('https://stripe.test/checkout');
    const params = fake.calls.checkoutCreate[0] as Record<string, unknown>;
    expect(params.mode).toBe('subscription');
  });

  it('checkout team cria o time (owner) ANTES de pagar, com quantity=seats', async () => {
    const { app, db, fake, bearer, accountId } = await setup();
    const r = await request(app).post('/v1/billing/checkout')
      .set('authorization', bearer).send({ plan: 'team', seats: 5, teamName: 'Squad' });
    expect(r.status).toBe(200);
    const teams = await db.select().from(schema.teams);
    expect(teams).toHaveLength(1);
    expect(teams[0].ownerAccountId).toBe(accountId);
    const members = await db.select().from(schema.teamMembers);
    expect(members[0].role).toBe('owner');
    const params = fake.calls.checkoutCreate[0] as { line_items: Array<{ quantity: number }> };
    expect(params.line_items[0].quantity).toBe(5);
  });

  it('guardas 409: team já em time; pro com assinatura pessoal ativa', async () => {
    const { app, db, bearer, accountId } = await setup();
    const [t] = await db.insert(schema.teams).values({ name: 'S', ownerAccountId: accountId })
      .returning({ id: schema.teams.id });
    await db.insert(schema.teamMembers).values({ teamId: t.id, accountId, role: 'owner' });
    const rTeam = await request(app).post('/v1/billing/checkout')
      .set('authorization', bearer).send({ plan: 'team', seats: 3, teamName: 'X' });
    expect(rTeam.status).toBe(409);
    await db.insert(schema.subscriptions).values({
      ownerType: 'account', accountId, stripeSubscriptionId: 'sub_p',
      stripeCustomerId: 'cus_p', plan: 'pro', status: 'active', seats: 1,
      currentPeriodEnd: new Date(Date.now() + 86_400_000),
    });
    const rPro = await request(app).post('/v1/billing/checkout')
      .set('authorization', bearer).send({ plan: 'pro' });
    expect(rPro.status).toBe(409);
  });

  it('portal devolve url; sem Bearer → 401', async () => {
    const { app, db, bearer, accountId } = await setup();
    const { eq } = await import('drizzle-orm');
    await db.update(schema.accounts).set({ stripeCustomerId: 'cus_1' })
      .where(eq(schema.accounts.id, accountId));
    const r = await request(app).post('/v1/billing/portal').set('authorization', bearer);
    expect(r.status).toBe(200);
    expect(r.body.data.url).toBe('https://stripe.test/portal');
    expect((await request(app).post('/v1/billing/portal')).status).toBe(401);
  });
});
```

- [ ] **Step 2:** `cd server && npx vitest run src/billing/billing-routes.test.ts` → FAIL (módulo não existe).

- [ ] **Step 3: Implementar** — `server/src/billing/billing-routes.ts`:

```ts
import { Router } from 'express';
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import type { Env } from '../env';
import { accounts, subscriptions, teamMembers, teams } from '../db/schema';
import type { StripeLike } from './stripe-like';
import { asyncHandler as ah } from '../middleware/errors';
import { rateLimit } from '../middleware/rate-limit';
import { requireAuth } from '../middleware/require-auth';

export interface BillingDeps {
  db: Db;
  env: Env;
  stripe: StripeLike;
  now?: () => number;
}

const LIVE = ['active', 'trialing', 'past_due'];
const MAX_SEATS = 100;

/** Acha/cria o Stripe customer da conta (cacheado em accounts.stripe_customer_id). */
async function customerFor(db: Db, stripe: StripeLike, accountId: string): Promise<string> {
  const [acc] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
  if (acc.stripeCustomerId) return acc.stripeCustomerId;
  const created = await stripe.customers.create({
    email: acc.email ?? undefined,
    metadata: { accountId },
  });
  await db.update(accounts).set({ stripeCustomerId: created.id })
    .where(eq(accounts.id, accountId));
  return created.id;
}

export function buildBillingRouter(deps: BillingDeps): Router {
  const { db, env, stripe } = deps;
  const r = Router();
  const limit = rateLimit({ windowMs: 60_000, max: 30 });

  r.post('/billing/checkout', limit, requireAuth(db), ah(async (req, res) => {
    const body = req.body as { plan?: string; seats?: number; teamName?: string };
    const plan = body.plan === 'team' ? 'team' : body.plan === 'pro' ? 'pro' : null;
    if (!plan) return res.status(400).json({ ok: false, error: 'plan inválido' });
    const accountId = req.accountId!;

    let teamId: string | null = null;
    let seats = 1;
    if (plan === 'team') {
      seats = Math.min(Math.max(Math.trunc(body.seats ?? 2), 2), MAX_SEATS);
      const name = String(body.teamName ?? '').trim().slice(0, 80);
      if (!name) return res.status(400).json({ ok: false, error: 'teamName obrigatório' });
      // 1 time por conta: quem já está num time não cria outro.
      const [member] = await db.select().from(teamMembers)
        .where(eq(teamMembers.accountId, accountId)).limit(1);
      if (member) {
        return res.status(409).json({ ok: false, error: 'você já está num time' });
      }
      // Time nasce AGORA (pendente até o webhook confirmar o pagamento).
      const created = await db.transaction(async (tx) => {
        const [t] = await tx.insert(teams).values({ name, ownerAccountId: accountId })
          .returning({ id: teams.id });
        await tx.insert(teamMembers).values({ teamId: t.id, accountId, role: 'owner' });
        return t;
      });
      teamId = created.id;
    } else {
      // Pro: assinatura pessoal viva → mudanças são no portal, não em novo checkout.
      const live = await db.select().from(subscriptions).where(and(
        eq(subscriptions.ownerType, 'account'),
        eq(subscriptions.accountId, accountId),
        inArray(subscriptions.status, LIVE),
      ));
      if (live.length > 0) {
        return res.status(409).json({ ok: false, error: 'assinatura ativa — use o portal' });
      }
    }

    const customer = await customerFor(db, stripe, accountId);
    const price = plan === 'team' ? env.STRIPE_PRICE_TEAM : env.STRIPE_PRICE_PRO;
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer,
      line_items: [{ price, quantity: seats }],
      success_url: `${env.PUBLIC_SITE_URL}/billing/success`,
      cancel_url: `${env.PUBLIC_SITE_URL}/billing/cancel`,
      // metadata na SUBSCRIPTION (não só na session): é ela que o webhook lê.
      subscription_data: { metadata: { accountId, teamId: teamId ?? '', plan } },
    });
    if (!session.url) return res.status(502).json({ ok: false, error: 'stripe sem url' });
    res.json({ ok: true, data: { url: session.url } });
  }));

  r.post('/billing/portal', limit, requireAuth(db), ah(async (req, res) => {
    const [acc] = await db.select().from(accounts)
      .where(eq(accounts.id, req.accountId!)).limit(1);
    if (!acc.stripeCustomerId) {
      return res.status(409).json({ ok: false, error: 'sem assinatura — assine primeiro' });
    }
    const session = await stripe.billingPortal.sessions.create({
      customer: acc.stripeCustomerId,
      return_url: `${env.PUBLIC_SITE_URL}/billing/success`,
    });
    res.json({ ok: true, data: { url: session.url } });
  }));

  return r;
}
```

- [ ] **Step 4: Montar no app** — em `server/src/index.ts` (RELER antes; sessões concorrentes):

```ts
import type { StripeLike } from './billing/stripe-like';
import { buildBillingRouter } from './billing/billing-routes';

export type AppDeps = AuthDeps & { stripe?: StripeLike };

export function createApp(deps?: AppDeps): Express {
  // ... mantém trust proxy, json, health, auth router ...
  if (deps?.stripe) {
    app.use('/v1', buildBillingRouter({ db: deps.db, env: deps.env, stripe: deps.stripe }));
  }
  // errorHandler continua por último
}
```

No boot real: `const Stripe = (await import('stripe')).default;` e `stripe: new Stripe(env.STRIPE_SECRET_KEY) as unknown as StripeLike`.

- [ ] **Step 5:** `npx vitest run src/billing/billing-routes.test.ts` → PASS; `npx tsc --noEmit` limpo; suíte inteira verde.

- [ ] **Step 6: Commit** — `git add server/src/billing/billing-routes.ts server/src/billing/test-helpers.ts server/src/billing/billing-routes.test.ts server/src/index.ts && git commit -m "feat(server): checkout (pro/team+assentos) e portal com guardas 409"`

---

### Task 6: webhook — idempotente + tolerante a ordem

**Files:**
- Create: `server/src/billing/webhook-routes.ts`
- Test: `server/src/billing/webhook-routes.test.ts`
- Modify: `server/src/index.ts` (raw body ANTES do json + montar)

**Interfaces:**
- Consumes: `BillingDeps` (Task 5), `applySubscriptionState` (Task 3), `stripeEvents` schema, `makeFakeStripe`.
- Produces: `buildWebhookRouter(deps: BillingDeps): Router` com `POST /billing/webhook`.

- [ ] **Step 1: Teste falhando** — `server/src/billing/webhook-routes.test.ts`. Reusar o `setup` de `./test-helpers` só para db/env/conta, montando um app próprio com raw body:

```ts
import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import * as schema from '../db/schema';
import { errorHandler } from '../middleware/errors';
import { makeFakeStripe, type StripeEvent, type StripeSubscription } from './stripe-like';
import { buildWebhookRouter } from './webhook-routes';
import { setup } from './test-helpers';

function appFor(deps: Parameters<typeof buildWebhookRouter>[0]) {
  const app = express();
  app.use('/v1/billing/webhook', express.raw({ type: '*/*' }));
  app.use(express.json());
  app.use('/v1', buildWebhookRouter(deps));
  app.use(errorHandler);
  return app;
}
const EVT: StripeEvent = {
  id: 'evt_1', type: 'customer.subscription.updated',
  data: { object: { id: 'sub_1' } },
};
function subState(accountId: string, status = 'active'): StripeSubscription {
  return {
    id: 'sub_1', customer: 'cus_1', status,
    items: { data: [{ quantity: 1, price: { id: 'price_pro' } }] },
    current_period_end: Math.floor(Date.now() / 1000) + 86_400,
    metadata: { accountId, plan: 'pro' },
  };
}

describe('webhook', () => {
  it('assinatura inválida → 400 e nada gravado', async () => {
    const { db, env } = await setup();
    const fake = makeFakeStripe({ event: new Error('bad sig') });
    const app = appFor({ db, env, stripe: fake.stripe });
    const r = await request(app).post('/v1/billing/webhook')
      .set('stripe-signature', 'x').send('{}');
    expect(r.status).toBe(400);
    expect(await db.select().from(schema.stripeEvents)).toHaveLength(0);
  });

  it('aplica o estado ATUAL da API (não o payload) e é idempotente', async () => {
    const { db, env, accountId } = await setup();
    const fake = makeFakeStripe({ event: EVT, subscription: subState(accountId) });
    const app = appFor({ db, env, stripe: fake.stripe });
    expect((await request(app).post('/v1/billing/webhook')
      .set('stripe-signature', 's').send('{}')).status).toBe(200);
    // 2ª entrega do MESMO event.id: 200 sem reprocessar
    expect((await request(app).post('/v1/billing/webhook')
      .set('stripe-signature', 's').send('{}')).status).toBe(200);
    expect(fake.calls.retrieve).toHaveLength(1); // só a 1ª buscou a API
    const subs = await db.select().from(schema.subscriptions);
    expect(subs).toHaveLength(1);
    expect(subs[0].status).toBe('active');
  });

  it('evento "velho" chegando depois ainda resulta no estado ATUAL', async () => {
    const { db, env, accountId } = await setup();
    // A API já diz canceled; o evento que chega é um updated antigo.
    const fake = makeFakeStripe({
      event: { ...EVT, id: 'evt_old' }, subscription: subState(accountId, 'canceled'),
    });
    const app = appFor({ db, env, stripe: fake.stripe });
    await request(app).post('/v1/billing/webhook').set('stripe-signature', 's').send('{}');
    const [sub] = await db.select().from(schema.subscriptions);
    expect(sub.status).toBe('canceled'); // ordem irrelevante por construção
  });

  it('evento sem subscription (ex.: charge.succeeded) → 200 e ignora', async () => {
    const { db, env } = await setup();
    const fake = makeFakeStripe({
      event: { id: 'evt_x', type: 'charge.succeeded', data: { object: {} } },
    });
    const app = appFor({ db, env, stripe: fake.stripe });
    expect((await request(app).post('/v1/billing/webhook')
      .set('stripe-signature', 's').send('{}')).status).toBe(200);
  });
});
```

- [ ] **Step 2:** `npx vitest run src/billing/webhook-routes.test.ts` → FAIL.

- [ ] **Step 3: Implementar** — `server/src/billing/webhook-routes.ts`:

```ts
import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { stripeEvents } from '../db/schema';
import type { BillingDeps } from './billing-routes';
import type { StripeEvent } from './stripe-like';
import { applySubscriptionState } from './subscription-service';
import { asyncHandler as ah } from '../middleware/errors';

/**
 * O endpoint mais crítico do billing: perder/duplicar um evento = plano
 * errado. Estratégia: (1) assinatura Stripe valida a origem; (2) event.id é
 * idempotente (INSERT ... ON CONFLICT DO NOTHING); (3) NUNCA aplica o payload
 * do evento — busca o estado ATUAL da subscription na API e aplica. Ordem de
 * chegada vira irrelevante por construção (rev#5 da arquitetura).
 */

function subscriptionIdFrom(event: StripeEvent): string | null {
  const o = event.data.object as { id?: unknown; subscription?: unknown };
  if (event.type === 'checkout.session.completed') {
    return typeof o.subscription === 'string' ? o.subscription : null;
  }
  if (event.type.startsWith('customer.subscription.')) {
    return typeof o.id === 'string' ? o.id : null;
  }
  if (event.type.startsWith('invoice.')) {
    return typeof o.subscription === 'string' ? o.subscription : null;
  }
  return null;
}

export function buildWebhookRouter(deps: BillingDeps): Router {
  const { db, env, stripe } = deps;
  const r = Router();

  r.post('/billing/webhook', ah(async (req, res) => {
    const sig = String(req.headers['stripe-signature'] ?? '');
    let event: StripeEvent;
    try {
      event = stripe.webhooks.constructEvent(
        req.body as Buffer, sig, env.STRIPE_WEBHOOK_SECRET,
      );
    } catch {
      return res.status(400).json({ ok: false, error: 'assinatura inválida' });
    }

    // Idempotência: só a PRIMEIRA entrega deste event.id processa.
    const inserted = await db.insert(stripeEvents)
      .values({ eventId: event.id, type: event.type, payload: event as unknown })
      .onConflictDoNothing()
      .returning({ eventId: stripeEvents.eventId });
    if (inserted.length === 0) return res.json({ ok: true }); // duplicado

    const subId = subscriptionIdFrom(event);
    if (subId) {
      // Estado ATUAL da API — nunca o payload (tolerância a ordem).
      const current = await stripe.subscriptions.retrieve(subId);
      await applySubscriptionState(db, current, {
        pricePro: env.STRIPE_PRICE_PRO, priceTeam: env.STRIPE_PRICE_TEAM,
      });
    }
    await db.update(stripeEvents).set({ processedAt: new Date() })
      .where(eq(stripeEvents.eventId, event.id));
    res.json({ ok: true });
  }));

  return r;
}
```

- [ ] **Step 4: Montar** — em `server/src/index.ts`, ANTES de `app.use(express.json(...))`:

```ts
app.use('/v1/billing/webhook', express.raw({ type: '*/*' }));
```

e junto do billing router: `app.use('/v1', buildWebhookRouter({ db: deps.db, env: deps.env, stripe: deps.stripe }));`

- [ ] **Step 5:** testes PASS; suíte inteira verde; `npx tsc --noEmit` limpo.

- [ ] **Step 6: Commit** — `git add server/src/billing/webhook-routes.ts server/src/billing/webhook-routes.test.ts server/src/index.ts && git commit -m "feat(server): webhook Stripe idempotente que aplica o estado atual da API"`
