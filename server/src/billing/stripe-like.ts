/**
 * Subconjunto ESTRUTURAL do SDK do Stripe que o backend usa — sempre injetado
 * (nunca `new Stripe()` dentro de service/rota; só no boot). Testes usam
 * makeFakeStripe(). O SDK real satisfaz este shape por tipagem estrutural.
 */

export interface StripeSubscription {
  id: string;
  customer: string;
  status: string; // active | trialing | past_due | canceled | ...
  items: { data: Array<{ quantity?: number; price: { id: string } }> };
  current_period_end: number; // epoch segundos
  metadata: Record<string, string>;
}

export interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

export interface StripeLike {
  customers: {
    create(p: { email?: string; metadata?: Record<string, string> }): Promise<{ id: string }>;
  };
  checkout: {
    sessions: {
      create(p: Record<string, unknown>): Promise<{ url: string | null }>;
    };
  };
  billingPortal: {
    sessions: {
      create(p: { customer: string; return_url: string }): Promise<{ url: string }>;
    };
  };
  subscriptions: {
    retrieve(id: string): Promise<StripeSubscription>;
  };
  webhooks: {
    constructEvent(body: Buffer | string, sig: string, secret: string): StripeEvent;
  };
}

/** Fake p/ testes: grava chamadas e responde o que o teste programar. */
export function makeFakeStripe(over: Partial<{
  subscription: StripeSubscription;
  checkoutUrl: string;
  portalUrl: string;
  event: StripeEvent | Error;
}> = {}) {
  const calls: Record<string, unknown[]> = {
    customersCreate: [], checkoutCreate: [], portalCreate: [], retrieve: [],
  };
  const stripe: StripeLike = {
    customers: {
      create: async (p) => { calls.customersCreate.push(p); return { id: 'cus_fake' }; },
    },
    checkout: {
      sessions: {
        create: async (p) => { calls.checkoutCreate.push(p); return { url: over.checkoutUrl ?? 'https://stripe.test/checkout' }; },
      },
    },
    billingPortal: {
      sessions: {
        create: async (p) => { calls.portalCreate.push(p); return { url: over.portalUrl ?? 'https://stripe.test/portal' }; },
      },
    },
    subscriptions: {
      retrieve: async (id) => {
        calls.retrieve.push(id);
        if (!over.subscription) throw new Error('fake: sem subscription programada');
        return over.subscription;
      },
    },
    webhooks: {
      constructEvent: () => {
        if (over.event instanceof Error) throw over.event;
        if (!over.event) throw new Error('fake: sem event programado');
        return over.event;
      },
    },
  };
  return { stripe, calls };
}
