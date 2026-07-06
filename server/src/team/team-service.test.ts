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
  const [account] = await db.insert(schema.accounts).values({ email })
    .returning({ id: schema.accounts.id });
  return account.id;
}

async function mkTeam(
  db: Db,
  owner: string,
  seats = 3,
  status = 'active',
): Promise<string> {
  const [team] = await db.insert(schema.teams)
    .values({ name: 'S', ownerAccountId: owner })
    .returning({ id: schema.teams.id });
  await db.insert(schema.teamMembers).values({ teamId: team.id, accountId: owner, role: 'owner' });
  await db.insert(schema.subscriptions).values({
    ownerType: 'team',
    teamId: team.id,
    stripeSubscriptionId: `sub_${team.id}`,
    stripeCustomerId: 'cus',
    plan: 'team',
    status,
    seats,
    currentPeriodEnd: new Date(Date.now() + 86_400_000),
  });
  return team.id;
}

describe('createInvite / joinTeam', () => {
  it('cria convite AB12-CD34, guarda so o hash; join entra com ou sem hifen', async () => {
    const db = await makeTestDb();
    const owner = await acc(db, 'o@x.com');
    const teamId = await mkTeam(db, owner);

    const inv = await createInvite(db, teamId, owner);

    expect(inv.code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    const rows = await db.select().from(schema.teamInvites);
    expect(rows[0].codeHash).not.toBe(inv.code);
    expect(rows[0].codeHash).not.toBe(inv.code.replace('-', ''));
    expect(rows[0].codePrefix).toBe(inv.code.slice(0, 4));
    const member = await acc(db, 'm@x.com');
    const result = await joinTeam(db, member, inv.code.toLowerCase());
    expect(result.ok).toBe(true);
  });

  it('guardas: expirado, revogado, maxUses, ja-em-time, assinatura morta, sem assento', async () => {
    const db = await makeTestDb();
    const owner = await acc(db, 'o2@x.com');
    const teamId = await mkTeam(db, owner, 2);
    const inv = await createInvite(db, teamId, owner);

    await db.update(schema.teamInvites).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await joinTeam(db, await acc(db, 'a@x.com'), inv.code)).ok).toBe(false);
    await db.update(schema.teamInvites).set({ expiresAt: new Date(Date.now() + 86_400_000) });

    await db.update(schema.teamInvites).set({ revokedAt: new Date() });
    expect((await joinTeam(db, await acc(db, 'b@x.com'), inv.code)).ok).toBe(false);
    await db.update(schema.teamInvites).set({ revokedAt: null });

    await db.update(schema.teamInvites).set({ usedCount: 10 });
    expect((await joinTeam(db, await acc(db, 'c@x.com'), inv.code)).ok).toBe(false);
    await db.update(schema.teamInvites).set({ usedCount: 0 });

    const member = await acc(db, 'm1@x.com');
    expect((await joinTeam(db, member, inv.code)).ok).toBe(true);
    const again = await joinTeam(db, member, inv.code);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toMatch(/já está/);

    const semVaga = await joinTeam(db, await acc(db, 'd@x.com'), inv.code);
    expect(semVaga.ok).toBe(false);
    if (!semVaga.ok) expect(semVaga.error).toMatch(/assento/);

    await db.update(schema.subscriptions).set({ status: 'canceled' })
      .where(eq(schema.subscriptions.teamId, teamId));
    await db.delete(schema.teamMembers).where(eq(schema.teamMembers.accountId, member));
    const morta = await joinTeam(db, await acc(db, 'e@x.com'), inv.code);
    expect(morta.ok).toBe(false);
    if (!morta.ok) expect(morta.error).toMatch(/ativa/);
  });

  it('corrida do ultimo assento: 2 joins simultaneos entram uma vez so', async () => {
    const db = await makeTestDb();
    const owner = await acc(db, 'o3@x.com');
    await mkTeam(db, owner, 2);
    const [team] = await db.select().from(schema.teams);
    const inv = await createInvite(db, team.id, owner);
    const [a, b] = await Promise.all([
      joinTeam(db, await acc(db, 'ra@x.com'), inv.code),
      joinTeam(db, await acc(db, 'rb@x.com'), inv.code),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });

  it('join concorrente da mesma conta nao estoura unique e entra uma vez so', async () => {
    const db = await makeTestDb();
    const owner = await acc(db, 'o4@x.com');
    const teamId = await mkTeam(db, owner, 3);
    const inv = await createInvite(db, teamId, owner);
    const member = await acc(db, 'same@x.com');

    const [a, b] = await Promise.all([
      joinTeam(db, member, inv.code),
      joinTeam(db, member, inv.code),
    ]);

    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const failed = [a, b].find((result) => !result.ok);
    expect(failed?.ok).toBe(false);
    if (failed && !failed.ok) expect(failed.error).toMatch(/já está/);
  });
});
