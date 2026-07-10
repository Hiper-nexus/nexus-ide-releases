import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from './schema';
import { CREATE_TABLES_SQL } from './schema';
import type { Db } from './client';
import { PENDING_TEAM_TTL_MS, cleanupExpired } from './maintenance';

async function makeTestDb(): Promise<Db> {
  const client = new PGlite();
  await client.exec(CREATE_TABLES_SQL);
  return drizzle(client, { schema }) as unknown as Db;
}

describe('cleanupExpired', () => {
  it('remove states/codes/sessões/refresh expirados e preserva os vivos', async () => {
    const db = await makeTestDb();
    const [a] = await db
      .insert(schema.accounts)
      .values({ email: 'x@y.com' })
      .returning({ id: schema.accounts.id });
    const past = new Date(Date.now() - 1000);
    const future = new Date(Date.now() + 60_000);
    await db.insert(schema.oauthStates).values([
      { state: 'morto', provider: 'github', codeVerifier: 'v', appState: 'n', expiresAt: past },
      { state: 'vivo', provider: 'github', codeVerifier: 'v', appState: 'n', expiresAt: future },
    ]);
    await db.insert(schema.authCodes).values([
      { codeHash: 'h-morto', accountId: a.id, expiresAt: past },
      { codeHash: 'h-vivo', accountId: a.id, expiresAt: future },
    ]);
    await db.insert(schema.sessions).values([
      { accountId: a.id, tokenHash: 's-morto', expiresAt: past },
      { accountId: a.id, tokenHash: 's-vivo', expiresAt: future },
    ]);
    await db.insert(schema.refreshTokens).values([
      { accountId: a.id, tokenHash: 'r-morto', expiresAt: past },
      { accountId: a.id, tokenHash: 'r-vivo', expiresAt: future },
    ]);
    await db.insert(schema.cronLeases).values([
      {
        accountId: a.id,
        projectId: '31781d36-3f22-41b8-ad9d-8690c85d3343',
        scheduleId: '2a21a665-d7fd-45d5-b81f-41f433c665ad',
        occurrenceAt: 1,
        tokenHash: 'lease-dead',
        version: 1,
        expiresAt: past,
      },
      {
        accountId: a.id,
        projectId: '31781d36-3f22-41b8-ad9d-8690c85d3343',
        scheduleId: '2a21a665-d7fd-45d5-b81f-41f433c665ad',
        occurrenceAt: 2,
        tokenHash: 'lease-live',
        version: 1,
        expiresAt: future,
      },
    ]);

    await cleanupExpired(db);

    expect(await db.select().from(schema.oauthStates)).toHaveLength(1);
    expect(await db.select().from(schema.authCodes)).toHaveLength(1);
    expect(await db.select().from(schema.sessions)).toHaveLength(1);
    expect(await db.select().from(schema.refreshTokens)).toHaveLength(1);
    expect(await db.select().from(schema.cronLeases)).toHaveLength(1);
  });

  it('remove times pendentes antigos sem assinatura e preserva times com subscription', async () => {
    const db = await makeTestDb();
    const now = Date.now();
    const old = new Date(now - PENDING_TEAM_TTL_MS - 1_000);
    const [owner] = await db.insert(schema.accounts).values({ email: 'owner@x.com' })
      .returning({ id: schema.accounts.id });
    const [oldPending] = await db.insert(schema.teams)
      .values({ name: 'old', ownerAccountId: owner.id, createdAt: old })
      .returning({ id: schema.teams.id });
    await db.insert(schema.teamMembers)
      .values({ teamId: oldPending.id, accountId: owner.id, role: 'owner' });
    const [kept] = await db.insert(schema.teams)
      .values({ name: 'paid', ownerAccountId: owner.id, createdAt: old })
      .returning({ id: schema.teams.id });
    await db.insert(schema.subscriptions).values({
      ownerType: 'team',
      teamId: kept.id,
      stripeSubscriptionId: 'sub_kept',
      stripeCustomerId: 'cus_kept',
      plan: 'team',
      status: 'canceled',
      seats: 3,
      currentPeriodEnd: old,
    });

    await cleanupExpired(db, () => now);

    const teams = await db.select().from(schema.teams);
    expect(teams.map((team) => team.id)).toEqual([kept.id]);
    expect(await db.select().from(schema.teamMembers)).toHaveLength(0);
  });
});
