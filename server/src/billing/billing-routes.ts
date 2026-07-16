import { Router } from 'express';
import { and, eq, inArray } from 'drizzle-orm';
import { PRO_MONTHLY_PRICE } from '../../../shared/pricing';
import type { Db } from '../db/client';
import type { Env } from '../env';
import { accounts, subscriptions } from '../db/schema';
import type { StripeLike, StripePrice } from './stripe-like';
import { asyncHandler as ah } from '../middleware/errors';
import { rateLimit } from '../middleware/rate-limit';
import { requireAuth } from '../middleware/require-auth';

export interface BillingDeps {
  db: Db;
  env: Env;
  stripe: StripeLike;
  now?: () => number;
}

const LIVE = ['active', 'trialing', 'past_due'];

/** Acha/cria o Stripe customer da conta (cacheado em accounts.stripe_customer_id). */
async function customerFor(db: Db, stripe: StripeLike, accountId: string): Promise<string> {
  const [acc] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
  if (acc.stripeCustomerId) return acc.stripeCustomerId;
  const created = await stripe.customers.create({
    email: acc.email ?? undefined,
    metadata: { accountId },
  });
  await db.update(accounts).set({ stripeCustomerId: created.id })
    .where(eq(accounts.id, accountId));
  return created.id;
}

function isConfiguredProPrice(price: StripePrice, expectedId: string): boolean {
  return price.id === expectedId
    && price.active
    && price.currency.toLowerCase() === PRO_MONTHLY_PRICE.currency
    && price.unit_amount === PRO_MONTHLY_PRICE.unitAmount
    && price.type === 'recurring'
    && price.recurring?.interval === PRO_MONTHLY_PRICE.interval
    && price.recurring.interval_count === PRO_MONTHLY_PRICE.intervalCount;
}

export function buildBillingRouter(deps: BillingDeps): Router {
  const { db, env, stripe } = deps;
  const r = Router();
  const limit = rateLimit({ windowMs: 60_000, max: 30 });

  r.post('/billing/checkout', limit, requireAuth(db), ah(async (req, res) => {
    const body = req.body as { plan?: unknown };
    if (body.plan !== 'pro') {
      return res.status(400).json({ ok: false, error: 'plano inválido' });
    }
    const accountId = req.accountId!;

    // Pro: assinatura pessoal viva → mudanças são no portal, não em novo checkout.
    const live = await db.select().from(subscriptions).where(and(
      eq(subscriptions.ownerType, 'account'),
      eq(subscriptions.accountId, accountId),
      inArray(subscriptions.status, LIVE),
    ));
    if (live.length > 0) {
      return res.status(409).json({ ok: false, error: 'assinatura ativa — use o portal' });
    }

    // Price do Stripe é a autoridade monetária. Uma configuração antiga em
    // USD ou com valor/período incorreto falha antes de criar customer/cobrança.
    let configuredPrice: StripePrice;
    try {
      configuredPrice = await stripe.prices.retrieve(env.STRIPE_PRICE_PRO);
    } catch {
      return res.status(502).json({
        ok: false,
        error: 'Stripe indisponível no momento. Tente novamente em instantes.',
      });
    }
    if (!isConfiguredProPrice(configuredPrice, env.STRIPE_PRICE_PRO)) {
      console.error('[billing] STRIPE_PRICE_PRO não corresponde a BRL 59,99/mês');
      return res.status(503).json({
        ok: false,
        error: 'Plano Pro temporariamente indisponível. Tente novamente mais tarde.',
      });
    }

    const customer = await customerFor(db, stripe, accountId);
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer,
      client_reference_id: accountId,
      line_items: [{ price: env.STRIPE_PRICE_PRO, quantity: 1 }],
      locale: 'pt-BR',
      billing_address_collection: 'auto',
      success_url: `${env.PUBLIC_SITE_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.PUBLIC_SITE_URL}/billing/cancel`,
      metadata: { accountId, plan: 'pro' },
      // Metadata na SUBSCRIPTION (não só na session): é ela que o webhook lê.
      subscription_data: { metadata: { accountId, plan: 'pro' } },
    });
    if (!session.url) return res.status(502).json({ ok: false, error: 'stripe sem url' });
    res.json({ ok: true, data: { url: session.url } });
  }));

  r.post('/billing/portal', limit, requireAuth(db), ah(async (req, res) => {
    const [acc] = await db.select().from(accounts)
      .where(eq(accounts.id, req.accountId!)).limit(1);
    if (!acc.stripeCustomerId) {
      return res.status(409).json({ ok: false, error: 'sem assinatura — assine primeiro' });
    }
    const session = await stripe.billingPortal.sessions.create({
      customer: acc.stripeCustomerId,
      return_url: `${env.PUBLIC_SITE_URL}/billing/success`,
    });
    res.json({ ok: true, data: { url: session.url } });
  }));

  return r;
}
