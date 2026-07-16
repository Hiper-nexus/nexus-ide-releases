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
    expect(params.locale).toBe('pt-BR');
    expect(params).toMatchObject({
      line_items: [{ price: 'price_pro', quantity: 1 }],
      subscription_data: { metadata: { accountId: expect.any(String), plan: 'pro' } },
    });
  });

  it('recusa novos checkouts Team porque Pro é o único plano pago', async () => {
    const { app, fake, bearer } = await setup();
    const r = await request(app).post('/v1/billing/checkout')
      .set('authorization', bearer).send({ plan: 'team', seats: 5, teamName: 'Squad' });

    expect(r.status).toBe(400);
    expect(r.body.error).toBe('plano inválido');
    expect(fake.calls.checkoutCreate).toHaveLength(0);
  });

  it('recusa checkout quando o Price configurado não é BRL 59,99 mensal', async () => {
    const { makeFakeStripe } = await import('./stripe-like');
    const invalidPrice = makeFakeStripe({
      price: {
        id: 'price_pro', active: true, currency: 'usd', unit_amount: 5999,
        type: 'recurring', recurring: { interval: 'month', interval_count: 1 },
      },
    });
    const { app, bearer } = await setup(invalidPrice);
    const r = await request(app).post('/v1/billing/checkout')
      .set('authorization', bearer).send({ plan: 'pro' });

    expect(r.status).toBe(503);
    expect(r.body.error).toContain('temporariamente indisponível');
    expect(invalidPrice.calls.customersCreate).toHaveLength(0);
    expect(invalidPrice.calls.checkoutCreate).toHaveLength(0);
  });

  it('guarda 409: Pro com assinatura pessoal ativa usa o portal', async () => {
    const { app, db, bearer, accountId } = await setup();
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
