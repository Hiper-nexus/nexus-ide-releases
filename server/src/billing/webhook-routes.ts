import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { stripeEvents } from '../db/schema';
import { asyncHandler as ah } from '../middleware/errors';
import type { BillingDeps } from './billing-routes';
import { applySubscriptionState } from './subscription-service';
import type { StripeEvent } from './stripe-like';

function stripeId(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === 'string' ? id : null;
}

function subscriptionIdFrom(event: StripeEvent): string | null {
  const object = event.data.object as {
    id?: unknown;
    subscription?: unknown;
    parent?: {
      subscription_details?: { subscription?: unknown } | null;
    } | null;
  };
  if (event.type === 'checkout.session.completed') {
    return stripeId(object.subscription);
  }
  if (event.type.startsWith('customer.subscription.')) {
    return stripeId(object.id);
  }
  if (event.type.startsWith('invoice.')) {
    return stripeId(object.subscription)
      ?? stripeId(object.parent?.subscription_details?.subscription);
  }
  return null;
}

export function buildWebhookRouter(deps: BillingDeps): Router {
  const { db, env, stripe, now } = deps;
  const r = Router();

  r.post('/billing/webhook', ah(async (req, res) => {
    const sig = String(req.headers['stripe-signature'] ?? '');
    let event: StripeEvent;
    try {
      event = stripe.webhooks.constructEvent(
        req.body as Buffer,
        sig,
        env.STRIPE_WEBHOOK_SECRET,
      );
    } catch {
      return res.status(400).json({ ok: false, error: 'assinatura inválida' });
    }

    const inserted = await db.insert(stripeEvents)
      .values({
        eventId: event.id,
        type: event.type,
        payload: event as unknown as Record<string, unknown>,
      })
      .onConflictDoNothing()
      .returning({ eventId: stripeEvents.eventId });
    if (inserted.length === 0) {
      const [existing] = await db.select({ processedAt: stripeEvents.processedAt })
        .from(stripeEvents)
        .where(eq(stripeEvents.eventId, event.id))
        .limit(1);
      if (existing?.processedAt) return res.json({ ok: true });
    }

    // Processamento + processedAt na MESMA transação: se applySubscriptionState
    // falhar, o evento fica sem processedAt e o Stripe retenta (o insert acima
    // já garantiu a idempotência). A chamada à API do Stripe fica FORA da
    // transação — nunca segurar conexão de banco esperando rede.
    try {
      const subId = subscriptionIdFrom(event);
      const current = subId ? await stripe.subscriptions.retrieve(subId) : null;
      await db.transaction(async (tx) => {
        if (current) {
          await applySubscriptionState(
            tx as unknown as typeof db,
            current,
            { pricePro: env.STRIPE_PRICE_PRO, priceTeam: env.STRIPE_PRICE_TEAM },
            now,
          );
        }
        await tx.update(stripeEvents)
          .set({ processedAt: new Date(now?.() ?? Date.now()) })
          .where(eq(stripeEvents.eventId, event.id));
      });
    } catch (err) {
      console.error(
        `[billing] webhook ${event.id} (${event.type}) falhou ao processar — Stripe vai retentar:`,
        err,
      );
      throw err; // errorHandler → 500 → retry do Stripe
    }
    res.json({ ok: true });
  }));

  return r;
}
