import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import * as schema from '../db/schema';
import { createApp } from '../index';
import { errorHandler } from '../middleware/errors';
import {
  makeFakeStripe,
  type StripeEvent,
  type StripeLike,
  type StripeSubscription,
} from './stripe-like';
import { buildWebhookRouter } from './webhook-routes';
import { setup } from './test-helpers';

function appFor(deps: Parameters<typeof buildWebhookRouter>[0]) {
  const app = express();
  app.use('/v1/billing/webhook', express.raw({ type: '*/*', limit: '256kb' }));
  app.use(express.json());
  app.use('/v1', buildWebhookRouter(deps));
  app.use(errorHandler);
  return app;
}

const EVT: StripeEvent = {
  id: 'evt_1',
  type: 'customer.subscription.updated',
  data: { object: { id: 'sub_1' } },
};

function subState(accountId: string, status = 'active'): StripeSubscription {
  return {
    id: 'sub_1',
    customer: 'cus_1',
    status,
    items: { data: [{ quantity: 1, price: { id: 'price_pro' } }] },
    current_period_end: Math.floor(Date.now() / 1000) + 86_400,
    metadata: { accountId, plan: 'pro' },
  };
}

describe('webhook', () => {
  it('assinatura invalida retorna 400 e nao grava evento', async () => {
    const { db, env } = await setup();
    const fake = makeFakeStripe({ event: new Error('bad sig') });
    const app = appFor({ db, env, stripe: fake.stripe });

    const r = await request(app).post('/v1/billing/webhook')
      .set('stripe-signature', 'x')
      .send('{}');

    expect(r.status).toBe(400);
    expect(await db.select().from(schema.stripeEvents)).toHaveLength(0);
  });

  it('aplica o estado atual da API e nao reprocessa evento ja processado', async () => {
    const { db, env, accountId } = await setup();
    const fake = makeFakeStripe({ event: EVT, subscription: subState(accountId) });
    const app = appFor({ db, env, stripe: fake.stripe });

    const first = await request(app).post('/v1/billing/webhook')
      .set('stripe-signature', 's')
      .send('{}');
    const second = await request(app).post('/v1/billing/webhook')
      .set('stripe-signature', 's')
      .send('{}');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(fake.calls.retrieve).toHaveLength(1);
    const subs = await db.select().from(schema.subscriptions);
    expect(subs).toHaveLength(1);
    expect(subs[0].status).toBe('active');
  });

  it('evento velho chegando depois ainda resulta no estado atual', async () => {
    const { db, env, accountId } = await setup();
    const fake = makeFakeStripe({
      event: { ...EVT, id: 'evt_old' },
      subscription: subState(accountId, 'canceled'),
    });
    const app = appFor({ db, env, stripe: fake.stripe });

    const r = await request(app).post('/v1/billing/webhook')
      .set('stripe-signature', 's')
      .send('{}');

    expect(r.status).toBe(200);
    const [sub] = await db.select().from(schema.subscriptions);
    expect(sub.status).toBe('canceled');
  });

  it('checkout.session.completed usa object.subscription para buscar a assinatura', async () => {
    const { db, env, accountId } = await setup();
    const fake = makeFakeStripe({
      event: {
        id: 'evt_checkout',
        type: 'checkout.session.completed',
        data: { object: { subscription: 'sub_1' } },
      },
      subscription: subState(accountId),
    });
    const app = appFor({ db, env, stripe: fake.stripe });

    const r = await request(app).post('/v1/billing/webhook')
      .set('stripe-signature', 's')
      .send('{}');

    expect(r.status).toBe(200);
    expect(fake.calls.retrieve).toEqual(['sub_1']);
  });

  it('invoice.paid aceita o shape parent.subscription_details da API Dahlia', async () => {
    const { db, env, accountId } = await setup();
    const fake = makeFakeStripe({
      event: {
        id: 'evt_invoice_dahlia',
        type: 'invoice.paid',
        data: {
          object: {
            parent: {
              type: 'subscription_details',
              subscription_details: { subscription: 'sub_1' },
            },
          },
        },
      },
      subscription: subState(accountId),
    });
    const app = appFor({ db, env, stripe: fake.stripe });

    const r = await request(app).post('/v1/billing/webhook')
      .set('stripe-signature', 's')
      .send('{}');

    expect(r.status).toBe(200);
    expect(fake.calls.retrieve).toEqual(['sub_1']);
  });

  it('evento sem subscription retorna 200 e marca como processado', async () => {
    const { db, env } = await setup();
    const fake = makeFakeStripe({
      event: { id: 'evt_x', type: 'charge.succeeded', data: { object: {} } },
    });
    const app = appFor({ db, env, stripe: fake.stripe });

    const r = await request(app).post('/v1/billing/webhook')
      .set('stripe-signature', 's')
      .send('{}');

    expect(r.status).toBe(200);
    const [event] = await db.select().from(schema.stripeEvents);
    expect(event.processedAt).toBeInstanceOf(Date);
  });

  it('createApp monta raw body antes do json para o webhook', async () => {
    const { db, env, accountId } = await setup();
    const event = { ...EVT, id: 'evt_app' };
    const programmed = makeFakeStripe({ event, subscription: subState(accountId) });
    const stripe: StripeLike = {
      ...programmed.stripe,
      webhooks: {
        constructEvent: (body, sig, secret) => {
          expect(Buffer.isBuffer(body)).toBe(true);
          expect(sig).toBe('s');
          expect(secret).toBe(env.STRIPE_WEBHOOK_SECRET);
          return event;
        },
      },
    };
    const app = createApp({ db, env, fetchFn: fetch, stripe });

    const r = await request(app).post('/v1/billing/webhook')
      .set('stripe-signature', 's')
      .send('{}');

    expect(r.status).toBe(200);
    expect(programmed.calls.retrieve).toEqual(['sub_1']);
  });
});
