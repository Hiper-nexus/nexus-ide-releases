import { describe, expect, it, onTestFinished } from 'vitest';
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

async function setupTwo() {
  const client = new PGlite();
  // PGlite sobe um PostgreSQL WASM por fixture. Sem fechar, cada teste do
  // arquivo deixa mais um runtime residente e a rodada inteira disputa
  // CPU/memória com os demais workers. Fechar ao fim do teste mantém
  // exatamente um vivo por vez.
  onTestFinished(async () => {
    await client.close();
  });
  await client.exec(CREATE_TABLES_SQL);
  const db = drizzle(client, { schema }) as unknown as Db;
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const env = {
    LICENSE_PRIVATE_KEY: await exportPKCS8(privateKey),
    LICENSE_PUBLIC_KEY: await exportSPKI(publicKey),
    GITHUB_OAUTH_ID: 'g',
    GITHUB_OAUTH_SECRET: 'g',
    GOOGLE_OAUTH_ID: 'g',
    GOOGLE_OAUTH_SECRET: 'g',
    PUBLIC_BASE_URL: 'https://api.test',
    APP_DEEP_LINK_BASE: 'nexus://auth',
    DATABASE_URL: 'x',
    PORT: 8080,
    STRIPE_SECRET_KEY: 'sk',
    STRIPE_WEBHOOK_SECRET: 'whsec',
    STRIPE_PRICE_PRO: 'price_pro',
    STRIPE_PRICE_TEAM: 'price_team',
    PUBLIC_SITE_URL: 'https://nexuside.app',
  } as Env;
  const app = express();
  app.use(express.json());
  app.use('/v1', buildTeamRouter({ db, env }));
  app.use(errorHandler);
  const mk = async (email: string) => {
    const [account] = await db.insert(schema.accounts).values({ email })
      .returning({ id: schema.accounts.id });
    const { session } = await issueTokens(db, account.id);
    return { id: account.id, bearer: `Bearer ${session}` };
  };
  const owner = await mk('owner@x.com');
  const member = await mk('member@x.com');
  return {
    app,
    db,
    ownerId: owner.id,
    memberId: member.id,
    ownerBearer: owner.bearer,
    memberBearer: member.bearer,
  };
}

async function mkTeam(db: Db, owner: string, seats = 3, status = 'active'): Promise<string> {
  const [team] = await db.insert(schema.teams)
    .values({ name: 'S', ownerAccountId: owner })
    .returning({ id: schema.teams.id });
  await db.insert(schema.teamMembers).values({ teamId: team.id, accountId: owner, role: 'owner' });
  await db.insert(schema.subscriptions).values({
    ownerType: 'team',
    teamId: team.id,
    stripeSubscriptionId: `old_${team.id}`,
    stripeCustomerId: 'cus_old',
    plan: 'team',
    status: 'canceled',
    seats: 99,
    currentPeriodEnd: new Date(Date.now() - 86_400_000),
  });
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

describe('team-routes', () => {
  it('fluxo: owner cria convite, membro entra, GET /team mostra os dois', async () => {
    const { app, db, ownerBearer, memberBearer, ownerId } = await setupTwo();
    await mkTeam(db, ownerId, 3);

    const invite = await request(app).post('/v1/team/invites').set('authorization', ownerBearer);
    expect(invite.status).toBe(200);
    expect(invite.body.data.code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    expect(invite.body.data.url).toContain('/join/');
    const join = await request(app).post('/v1/team/join')
      .set('authorization', memberBearer)
      .send({ code: invite.body.data.code });
    expect(join.status).toBe(200);

    const team = await request(app).get('/v1/team').set('authorization', memberBearer);
    expect(team.status).toBe(200);
    expect(team.body.data.members).toHaveLength(2);
    expect(team.body.data.seats).toEqual({ used: 2, total: 3 });
  });

  it('member nao cria convite; owner nao sai; member sai', async () => {
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

  it('owner remove membro mas nao a si; convite revogado impede join', async () => {
    const { app, db, ownerBearer, memberBearer, ownerId, memberId } = await setupTwo();
    const teamId = await mkTeam(db, ownerId, 3);
    await db.insert(schema.teamMembers).values({ teamId, accountId: memberId, role: 'member' });

    expect((await request(app).delete(`/v1/team/members/${ownerId}`)
      .set('authorization', ownerBearer)).status).toBe(400);
    expect((await request(app).delete(`/v1/team/members/${memberId}`)
      .set('authorization', ownerBearer)).status).toBe(200);
    const invite = await request(app).post('/v1/team/invites').set('authorization', ownerBearer);
    const prefix = invite.body.data.codePrefix as string;
    expect((await request(app).delete(`/v1/team/invites/${prefix}`)
      .set('authorization', ownerBearer)).status).toBe(200);
    expect((await request(app).post('/v1/team/join')
      .set('authorization', memberBearer)
      .send({ code: invite.body.data.code })).status).toBe(409);
  });

  it('sem time retorna team null', async () => {
    const { app, memberBearer } = await setupTwo();
    const r = await request(app).get('/v1/team').set('authorization', memberBearer);
    expect(r.status).toBe(200);
    expect(r.body.data.team).toBeNull();
  });
});
