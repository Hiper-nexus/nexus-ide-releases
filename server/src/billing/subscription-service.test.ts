import { describe, expect, it, onTestFinished } from 'vitest';
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
  // PGlite sobe um PostgreSQL WASM por fixture. Sem fechar, cada teste do
  // arquivo deixa mais um runtime residente e a rodada inteira disputa
  // CPU/memória com os demais workers. Fechar ao fim do teste mantém
  // exatamente um vivo por vez.
  onTestFinished(async () => {
    await client.close();
  });
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

  it('lê current_period_end do item no shape atual da API Dahlia', async () => {
    const db = await makeTestDb();
    const acc = await anAccount(db);
    const periodEnd = Math.floor(Date.now() / 1000) + 172_800;
    await applySubscriptionState(db, sub(acc, {
      current_period_end: undefined,
      items: {
        data: [{
          quantity: 1,
          price: { id: 'price_pro' },
          current_period_end: periodEnd,
        }],
      },
    }), PRICES);

    const [row] = await db.select().from(schema.subscriptions);
    expect(row.currentPeriodEnd?.getTime()).toBe(periodEnd * 1000);
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

  it('grace é ancorada: reaplicar past_due depois NÃO estende graceUntil', async () => {
    const db = await makeTestDb();
    const acc = await anAccount(db);
    const t0 = Date.now();
    await applySubscriptionState(db, sub(acc), PRICES, () => t0);
    await applySubscriptionState(db, sub(acc, { status: 'past_due' }), PRICES, () => t0);
    const [first] = await db.select().from(schema.subscriptions);
    const firstGrace = first.graceUntil!.getTime();

    const t1 = t0 + 3 * 24 * 3600 * 1000; // +3 dias, mesmo estado reaplicado
    await applySubscriptionState(db, sub(acc, { status: 'past_due' }), PRICES, () => t1);
    const [second] = await db.select().from(schema.subscriptions);

    expect(second.graceUntil!.getTime()).toBe(firstGrace);
  });

  it('past_due com grace vencida rebaixa o cache pra free', async () => {
    const db = await makeTestDb();
    const acc = await anAccount(db);
    const t0 = Date.now();
    await applySubscriptionState(db, sub(acc), PRICES, () => t0);
    await applySubscriptionState(db, sub(acc, { status: 'past_due' }), PRICES, () => t0);
    const [afterFirst] = await db.select().from(schema.subscriptions);
    const firstGrace = afterFirst.graceUntil!.getTime();

    const t1 = t0 + 8 * 24 * 3600 * 1000; // +8 dias, além dos 7d de graça
    await applySubscriptionState(db, sub(acc, { status: 'past_due' }), PRICES, () => t1);

    const [row] = await db.select().from(schema.subscriptions);
    expect(row.graceUntil!.getTime()).toBe(firstGrace); // não re-estende
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

  it('recusa preço desconhecido em vez de conceder Pro por padrão', async () => {
    const db = await makeTestDb();
    const acc = await anAccount(db);

    await expect(applySubscriptionState(db, sub(acc, {
      items: { data: [{ quantity: 1, price: { id: 'price_outro' } }] },
    }), PRICES)).rejects.toThrow(/price não autorizado/i);

    expect(await db.select().from(schema.subscriptions)).toHaveLength(0);
    const [account] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, acc));
    expect(account.plan).toBe('free');
  });
});
