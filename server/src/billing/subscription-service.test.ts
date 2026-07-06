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
