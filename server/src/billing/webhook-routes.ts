import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { stripeEvents } from '../db/schema';
import { asyncHandler as ah } from '../middleware/errors';
import type { BillingDeps } from './billing-routes';
import { applySubscriptionState } from './subscription-service';
import type { StripeEvent } from './stripe-like';

function subscriptionIdFrom(event: StripeEvent): string | null {
  const object = event.data.object as { id?: unknown; subscription?: unknown };
  if (event.type === 'checkout.session.completed') {
    return typeof object.subscription === 'string' ? object.subscription : null;
  }
  if (event.type.startsWith('customer.subscription.')) {
    return typeof object.id === 'string' ? object.id : null;
  }
  if (event.type.startsWith('invoice.')) {
    return typeof object.subscription === 'string' ? object.subscription : null;
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

    const subId = subscriptionIdFrom(event);
    if (subId) {
      const current = await stripe.subscriptions.retrieve(subId);
      await applySubscriptionState(
        db,
        current,
        { pricePro: env.STRIPE_PRICE_PRO, priceTeam: env.STRIPE_PRICE_TEAM },
        now,
      );
    }
    await db.update(stripeEvents)
      .set({ processedAt: new Date(now?.() ?? Date.now()) })
      .where(eq(stripeEvents.eventId, event.id));
    res.json({ ok: true });
  }));

  return r;
}
