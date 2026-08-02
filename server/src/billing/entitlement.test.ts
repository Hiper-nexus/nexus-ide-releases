import { describe, expect, it, onTestFinished } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../db/schema';
import { CREATE_TABLES_SQL } from '../db/schema';
import type { Db } from '../db/client';
import { entitlementFor, TTL_PERSONAL, TTL_TEAM_MEMBER } from './entitlement';

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

  it('empate pessoal vs time: vence o pessoal (TTL 30d)', async () => {
    const db = await makeTestDb();
    const owner = await acc(db, 'tie-own@x.com');
    const member = await acc(db, 'tie-mem@x.com');

    // Subscription pessoal com plan 'team' (mesmo rank que time)
    await db.insert(schema.subscriptions).values({
      ownerType: 'account', accountId: member, stripeSubscriptionId: 'sub_pers',
      stripeCustomerId: 'cus_pers', plan: 'team', status: 'active', seats: 1,
      currentPeriodEnd: new Date(Date.now() + 86_400_000),
    });

    // Time também com plan 'team'
    await teamWith(db, owner, member, 'active');

    const r = await entitlementFor(db, member);
    expect(r.input.plan).toBe('team');
    // Pessoal vence empate → TTL_PERSONAL, não TTL_TEAM_MEMBER
    expect(r.ttlSeconds).toBe(TTL_PERSONAL);
  });
});
