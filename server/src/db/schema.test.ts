import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import * as schema from './schema';
import { CREATE_TABLES_SQL } from './schema';

describe('schema', () => {
  it('cria as tabelas e insere uma account', async () => {
    const client = new PGlite();
    const db = drizzle(client, { schema });
    await client.exec(CREATE_TABLES_SQL); // DDL literal p/ teste (migrations reais no deploy)
    await db.insert(schema.accounts).values({
      email: 'a@b.com',
      plan: 'free',
    });
    const rows = await db.select().from(schema.accounts);
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe('a@b.com');
    expect(rows[0].plan).toBe('free');
    // enum válido
    await expect(
      db.execute(sql`INSERT INTO accounts (email, plan) VALUES ('c@d.com','invalido')`),
    ).rejects.toBeTruthy();
  });

  it('schema REAL tem UNIQUE(provider, provider_user_id) em identities', () => {
    // A DDL de teste sempre teve a constraint; este teste garante que a
    // schema Drizzle (fonte das migrations de produção) também tem — sem
    // ela, dois primeiros logins concorrentes duplicariam a identidade.
    const cfg = getTableConfig(schema.identities);
    const unique = cfg.uniqueConstraints.find((u) => {
      const cols = u.columns.map((c) => c.name).sort();
      return cols.join(',') === 'provider,provider_user_id';
    });
    expect(unique).toBeTruthy();
  });

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
});
