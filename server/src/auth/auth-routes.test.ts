import { describe, expect, it, onTestFinished, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { generateKeyPair, exportPKCS8, exportSPKI } from 'jose';
import * as schema from '../db/schema';
import { CREATE_TABLES_SQL } from '../db/schema';
import type { Db } from '../db/client';
import type { Env } from '../env';
import { buildAuthRouter } from './auth-routes';
import { errorHandler } from '../middleware/errors';

async function setup() {
  const client = new PGlite();
  // Cada PGlite sobe um PostgreSQL WASM próprio e este arquivo chama setup()
  // uma vez por teste: sem fechar, os 8 ficam residentes até o fim do arquivo
  // e disputam CPU/memória com os outros workers da rodada — pressão que
  // aparece como falha "impossível" no último teste. Fechar ao fim do teste
  // mantém exatamente um vivo por vez (mesma disciplina de cron-service.test).
  onTestFinished(async () => {
    await client.close();
  });
  await client.exec(CREATE_TABLES_SQL);
  const db = drizzle(client, { schema }) as unknown as Db;
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const env = {
    LICENSE_PRIVATE_KEY: await exportPKCS8(privateKey),
    LICENSE_PUBLIC_KEY: await exportSPKI(publicKey),
    GITHUB_OAUTH_ID: 'gid', GITHUB_OAUTH_SECRET: 'gsec',
    GOOGLE_OAUTH_ID: 'ggid', GOOGLE_OAUTH_SECRET: 'ggsec',
    PUBLIC_BASE_URL: 'https://api.test', APP_DEEP_LINK_BASE: 'nexus://auth',
    DATABASE_URL: 'x', PORT: 8080,
  } as Env;
  const fetchFn = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 't' }), { headers: { 'content-type': 'application/json' } }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: 1, login: 'u', name: 'U', avatar_url: 'a' })))
    .mockResolvedValueOnce(new Response(JSON.stringify([{ email: 'u@x.com', primary: true, verified: true }])));
  const app = express();
  app.use(express.json());
  app.use('/v1', buildAuthRouter({ db, env, fetchFn: fetchFn as unknown as typeof fetch }));
  app.use(errorHandler); // espelha createApp: rejeição async → 500 JSON
  return { app, db, fetchFn };
}

/** Extrai o code do redirect nexus://auth/<code>?state=... */
function deepLinkCode(location: string): string {
  return new URL(location).pathname.replace(/^\/+/, '');
}

describe('auth-routes', () => {
  it('loop completo: authorize → callback → exchange → me', async () => {
    const { app } = await setup();
    const auth = await request(app).get('/v1/auth/github?app_state=nonce-local-1');
    expect(auth.status).toBe(302);
    const loc = new URL(auth.headers.location);
    const state = loc.searchParams.get('state')!;
    expect(state).toBeTruthy();
    const cb = await request(app).get(`/v1/auth/github/callback?code=abc&state=${state}`);
    expect(cb.status).toBe(302);
    // O deep link devolve o app_state — é o binding que o desktop valida
    // contra o login pendente (anti login-CSRF/fixation).
    const back = new URL(cb.headers.location);
    expect(back.searchParams.get('state')).toBe('nonce-local-1');
    const code = deepLinkCode(cb.headers.location);
    expect(code).toBeTruthy();
    const ex = await request(app).post('/v1/auth/exchange').send({ code });
    expect(ex.status).toBe(200);
    expect(ex.body.data.session).toBeTruthy();
    expect(ex.body.data.refresh).toBeTruthy();
    expect(ex.body.data.licenca).toBeTruthy();
    const me = await request(app).get('/v1/me').set('authorization', `Bearer ${ex.body.data.session}`);
    expect(me.status).toBe(200);
    expect(me.body.data.plan).toBe('free');
    expect(me.body.data.email).toBe('u@x.com');
    const ex2 = await request(app).post('/v1/auth/exchange').send({ code });
    expect(ex2.status).toBe(400);
  });

  it('authorize sem app_state → 400 (binding local é obrigatório)', async () => {
    const { app } = await setup();
    expect((await request(app).get('/v1/auth/github')).status).toBe(400);
    expect((await request(app).get('/v1/auth/github?app_state=tem espaço')).status).toBe(400);
  });

  it('exchange concorrente do mesmo code: exatamente um vence', async () => {
    const { app } = await setup();
    const auth = await request(app).get('/v1/auth/github?app_state=n1');
    const state = new URL(auth.headers.location).searchParams.get('state')!;
    const cb = await request(app).get(`/v1/auth/github/callback?code=abc&state=${state}`);
    const code = deepLinkCode(cb.headers.location);
    // Duplo resgate simultâneo do deep-link code (TOCTOU): o consumo
    // atômico garante 1×200 + 1×400, nunca dois pares de sessão.
    const [a, b] = await Promise.all([
      request(app).post('/v1/auth/exchange').send({ code }),
      request(app).post('/v1/auth/exchange').send({ code }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 400]);
  });

  it('callback com state inválido → 400', async () => {
    const { app } = await setup();
    const r = await request(app).get('/v1/auth/github/callback?code=x&state=naoexiste');
    expect(r.status).toBe(400);
  });

  it('rejeição async vira 500 JSON (não pendura a request)', async () => {
    const { app, fetchFn } = await setup();
    // Provider fora do ar durante o callback: sem asyncHandler, a promise
    // rejeitada em Express 4 nunca responde e a request fica pendurada.
    fetchFn.mockReset().mockRejectedValue(new Error('provider caiu'));
    const auth = await request(app).get('/v1/auth/github?app_state=n2');
    const state = new URL(auth.headers.location).searchParams.get('state')!;
    const r = await request(app)
      .get(`/v1/auth/github/callback?code=abc&state=${state}`)
      .timeout({ deadline: 5000 });
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ ok: false, error: 'erro interno' });
  });

  it('link NÃO apaga conta de origem com billing ativo', async () => {
    const { app, db } = await setup();
    // Loga o usuário A (github)
    const auth = await request(app).get('/v1/auth/github?app_state=n4');
    const state = new URL(auth.headers.location).searchParams.get('state')!;
    const cb = await request(app).get(`/v1/auth/github/callback?code=abc&state=${state}`);
    const code = deepLinkCode(cb.headers.location);
    const ex = await request(app).post('/v1/auth/exchange').send({ code });
    // Status antes do deref: sem isto um 500 e um 400 falham igual
    // ("Cannot read properties of undefined") e a próxima quebra não se
    // distingue numa rodada só.
    expect(ex.status).toBe(200);
    const session = ex.body.data.session as string;
    // Conta de origem com plano pago + um code válido apontando pra ela
    const [paid] = await db.insert(schema.accounts)
      .values({ email: 'pago@x.com', plan: 'pro', stripeCustomerId: 'cus_1' })
      .returning({ id: schema.accounts.id });
    const { hashToken } = await import('./tokens');
    await db.insert(schema.authCodes).values({
      codeHash: hashToken('code-pago'), accountId: paid.id,
      expiresAt: new Date(Date.now() + 60_000),
    });
    // Merge destrutivo bloqueado: apagaria billing pago silenciosamente.
    const link = await request(app).post('/v1/auth/link')
      .set('authorization', `Bearer ${session}`).send({ code: 'code-pago' });
    expect(link.status).toBe(409);
    const still = await db.select().from(schema.accounts)
      .where((await import('drizzle-orm')).eq(schema.accounts.id, paid.id));
    expect(still).toHaveLength(1);
  });

  it('DELETE /me apaga a conta (LGPD)', async () => {
    const { app, db } = await setup();
    const auth = await request(app).get('/v1/auth/github?app_state=n3');
    const state = new URL(auth.headers.location).searchParams.get('state')!;
    const cb = await request(app).get(`/v1/auth/github/callback?code=abc&state=${state}`);
    const code = deepLinkCode(cb.headers.location);
    const ex = await request(app).post('/v1/auth/exchange').send({ code });
    expect(ex.status).toBe(200);
    const del = await request(app).delete('/v1/me').set('authorization', `Bearer ${ex.body.data.session}`);
    expect(del.status).toBe(200);
    expect(await db.select().from(schema.accounts)).toHaveLength(0);
  });

  it('DELETE /me de owner com assinatura de time ativa retorna 409; cancelada apaga', async () => {
    const { app, db } = await setup();
    const auth = await request(app).get('/v1/auth/github?app_state=n5');
    const state = new URL(auth.headers.location).searchParams.get('state')!;
    const cb = await request(app).get(`/v1/auth/github/callback?code=abc&state=${state}`);
    const code = deepLinkCode(cb.headers.location);
    const ex = await request(app).post('/v1/auth/exchange').send({ code });
    expect(ex.status).toBe(200);
    const bearer = `Bearer ${ex.body.data.session}`;
    const accountId = (await db.select().from(schema.accounts))[0].id;
    const [team] = await db.insert(schema.teams)
      .values({ name: 'S', ownerAccountId: accountId })
      .returning({ id: schema.teams.id });
    await db.insert(schema.teamMembers)
      .values({ teamId: team.id, accountId, role: 'owner' });
    await db.insert(schema.subscriptions).values({
      ownerType: 'team',
      teamId: team.id,
      stripeSubscriptionId: 's0',
      stripeCustomerId: 'c0',
      plan: 'team',
      status: 'canceled',
      seats: 99,
      currentPeriodEnd: new Date(Date.now() - 86_400_000),
    });
    await db.insert(schema.subscriptions).values({
      ownerType: 'team',
      teamId: team.id,
      stripeSubscriptionId: 's1',
      stripeCustomerId: 'c1',
      plan: 'team',
      status: 'active',
      seats: 3,
      currentPeriodEnd: new Date(Date.now() + 86_400_000),
    });

    expect((await request(app).delete('/v1/me').set('authorization', bearer)).status).toBe(409);
    const { eq } = await import('drizzle-orm');
    await db.update(schema.subscriptions).set({ status: 'canceled' })
      .where(eq(schema.subscriptions.teamId, team.id));
    expect((await request(app).delete('/v1/me').set('authorization', bearer)).status).toBe(200);
  });
});
