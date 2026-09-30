import Stripe from 'stripe';
import type { Config } from './config.js';

/** Public commercial contract. Monetary values are always in cents. */
export const PRO_MONTHLY_PRICE = Object.freeze({ currency: 'brl', unitAmount: 5_999, interval: 'month', intervalCount: 1 } as const);

/** Structural subset of the Stripe SDK used by the API, so routes and tests
 * never depend on the network. The real client is only built in stripeFrom. */
export interface StripeSubscription {
  id: string;
  customer: string;
  status: string;
  items: { data: Array<{ quantity?: number; price: { id: string }; current_period_end?: number }> };
  /** Stripe API versions before Dahlia expose the period on the subscription. */
  current_period_end?: number;
  metadata: Record<string, string>;
}
export interface StripeEvent { id: string; type: string; data: { object: Record<string, unknown> } }
export interface StripePrice { id: string; active: boolean; currency: string; unit_amount: number | null; type: string; recurring: { interval: string; interval_count: number } | null }
export interface StripeLike {
  customers: { create(params: { email?: string; metadata: Record<string, string> }, options: { idempotencyKey: string }): Promise<{ id: string }> };
  checkout: { sessions: { create(params: Record<string, unknown>, options?: { idempotencyKey: string }): Promise<{ url: string | null }> } };
  billingPortal: { sessions: { create(params: { customer: string; return_url: string }): Promise<{ url: string }> } };
  subscriptions: { retrieve(id: string): Promise<StripeSubscription> };
  prices: { retrieve(id: string): Promise<StripePrice> };
  webhooks: { constructEventAsync(body: string, signature: string, secret: string): Promise<StripeEvent> };
}

export function stripeFrom(config: Config): StripeLike {
  const stripe = new Stripe(config.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });
  const provider = Stripe.createSubtleCryptoProvider();
  // Workers have no synchronous crypto, so signatures are verified through SubtleCrypto.
  const webhooks: StripeLike['webhooks'] = {
    constructEventAsync: async (body, signature, secret) => await stripe.webhooks.constructEventAsync(body, signature, secret, undefined, provider) as unknown as StripeEvent,
  };
  return { customers: stripe.customers, checkout: stripe.checkout, billingPortal: stripe.billingPortal, subscriptions: stripe.subscriptions, prices: stripe.prices, webhooks } as unknown as StripeLike;
}
