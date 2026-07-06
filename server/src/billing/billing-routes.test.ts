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
