import { generateKeyPairSync } from 'node:crypto';
import { SqliteD1 } from './sqlite-d1.js';
import { issueTokens, type Tokens } from '../../src/sessions.js';
import type { StripeEvent, StripeLike, StripePrice, StripeSubscription } from '../../src/stripe.js';

export const SITE = 'https://nexuside.app';
export const API = 'https://api.nexuside.app';
export const ADMIN_EMAIL = 'admin@example.test';
export const PRICE_PRO = 'price_pro_fixture';
const keys = generateKeyPairSync('ed25519');
export const LICENSE_PUBLIC_KEY = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const DAY_MS = 24 * 60 * 60 * 1000;

/** Worker bindings with every secret configured; pass overrides to unset one. */
export function environment(db: SqliteD1, overrides: Record<string, unknown> = {}): CloudflareBindings {
  const allow = { limit: async () => ({ success: true }) };
  return {
    DB: db, AUTH_RATE_LIMITER: allow, API_RATE_LIMITER: allow, REDEEM_RATE_LIMITER: allow,
    PUBLIC_BASE_URL: API, PUBLIC_SITE_URL: SITE, APP_DEEP_LINK_BASE: 'nexus://auth', SHOT_DEEP_LINK_BASE: 'nexus-shot://auth/callback', APP_MODE: 'staging', MIGRATION_READY: 'true',
    ADMIN_EMAILS: ADMIN_EMAIL, GOOGLE_OAUTH_ID: 'google-id', GOOGLE_OAUTH_SECRET: 'fixture', GITHUB_OAUTH_ID: '', GITHUB_OAUTH_SECRET: '',
    LICENSE_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), LICENSE_PUBLIC_KEY,
    STRIPE_SECRET_KEY: 'fixture-key', STRIPE_WEBHOOK_SECRET: 'fixture-webhook', STRIPE_PRICE_PRO: PRICE_PRO, STRIPE_PRICE_TEAM: '',
    ...overrides,
  } as unknown as CloudflareBindings;
}

export interface SeedOptions {
  readonly trialDays?: number | null;
  readonly suspended?: boolean;
  readonly admin?: boolean;
  readonly verified?: boolean;
  readonly email?: string;
  /** Email reported by the provider when it differs from the account email. */
  readonly identityEmail?: string;
  /** Stripe customer already linked to the account (set by a previous checkout). */
  readonly customer?: string;
}

/** Inserts an account (15-day trial by default) with one provider identity. */
export async function seedAccount(db: SqliteD1, id: string, options: SeedOptions = {}): Promise<void> {
  const now = Date.now();
  const email = options.email ?? (options.admin ? ADMIN_EMAIL : `${id}@example.test`);
  const trialDays = options.trialDays === undefined ? 15 : options.trialDays;
  const start = trialDays === null ? null : trialDays < 0 ? now + trialDays * DAY_MS - DAY_MS : now;
  await db.batch([
    db.prepare('INSERT INTO accounts(id,email,name,role,trial_started_at,trial_expires_at,suspended_at,suspension_reason,stripe_customer_id) VALUES(?,?,?,?,?,?,?,?,?)')
      .bind(id, email, `Name ${id}`, options.admin ? 'admin' : 'user', start, trialDays === null ? null : now + trialDays * DAY_MS, options.suspended ? now : null, options.suspended ? 'fixture' : null, options.customer ?? null),
    db.prepare('INSERT INTO identities(id,account_id,provider,provider_user_id,email,email_verified) VALUES(?,?,?,?,?,?)')
      .bind(`identity-${id}`, id, 'google', `subject-${id}`, options.identityEmail ?? email, options.verified === false ? 0 : 1),
  ]);
}

export async function seedSubscription(db: SqliteD1, accountId: string, values: { status?: string; periodEnd?: number; graceUntil?: number | null } = {}): Promise<void> {
  await db.prepare("INSERT INTO subscriptions(id,owner_type,account_id,stripe_subscription_id,stripe_customer_id,plan,status,current_period_end,grace_until) VALUES(?,'account',?,?,?,'pro',?,?,?)")
    .bind(`row-${accountId}`, accountId, `sub_${accountId}`, `cus_${accountId}`, values.status ?? 'active', values.periodEnd ?? Date.now() + 30 * DAY_MS, values.graceUntil ?? null).run();
}

export function webHeaders(tokens: Tokens, extra: Record<string, string> = {}): Record<string, string> {
  return { Origin: SITE, Cookie: `__Host-nexus_session=${tokens.session}; __Host-nexus_csrf=${tokens.csrf}`, 'X-CSRF-Token': tokens.csrf!, 'Content-Type': 'application/json', ...extra };
}

export async function webLogin(db: SqliteD1, accountId: string): Promise<Record<string, string>> {
  return webHeaders(await issueTokens(db, accountId, 'web'));
}

export async function nativeLogin(db: SqliteD1, accountId: string): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${(await issueTokens(db, accountId, 'desktop')).session}`, 'Content-Type': 'application/json' };
}

export function subscription(accountId: string, values: Partial<StripeSubscription> = {}): StripeSubscription {
  return {
    id: `sub_${accountId}`, customer: `cus_${accountId}`, status: 'active', metadata: { accountId, plan: 'pro' },
    items: { data: [{ quantity: 1, price: { id: PRICE_PRO }, current_period_end: Math.floor((Date.now() + 30 * DAY_MS) / 1000) }] },
    ...values,
  };
}

export interface FakeStripe {
  readonly stripe: StripeLike;
  readonly calls: { customers: unknown[][]; checkouts: unknown[][]; portals: unknown[][]; retrieved: string[]; prices: string[] };
  /** One-shot answers for the next subscription reads, used to interleave concurrent deliveries. */
  readonly retrievals: Array<() => Promise<StripeSubscription>>;
  subscription: StripeSubscription | Error | null;
  event: StripeEvent | Error | null;
  price: StripePrice | Error | null;
}

/** Records calls and answers what the test programmed; never reaches the network. */
export function fakeStripe(): FakeStripe {
  const fake: FakeStripe = {
    calls: { customers: [], checkouts: [], portals: [], retrieved: [], prices: [] },
    retrievals: [], subscription: null, event: null, price: null,
    stripe: {
      customers: { create: async (...args) => { fake.calls.customers.push(args); return { id: 'cus_created' }; } },
      checkout: { sessions: { create: async (...args) => { fake.calls.checkouts.push(args); return { url: 'https://checkout.stripe.com/c/pay/fixture' }; } } },
      billingPortal: { sessions: { create: async (...args) => { fake.calls.portals.push(args); return { url: 'https://billing.stripe.com/p/session/fixture' }; } } },
      subscriptions: {
        retrieve: async (id) => {
          fake.calls.retrieved.push(id);
          const queued = fake.retrievals.shift();
          if (queued) return queued();
          if (fake.subscription instanceof Error) throw fake.subscription;
          if (!fake.subscription) throw new Error('fake: no subscription programmed');
          return fake.subscription;
        },
      },
      prices: {
        retrieve: async (id) => {
          fake.calls.prices.push(id);
          if (fake.price instanceof Error) throw fake.price;
          return fake.price ?? { id, active: true, currency: 'brl', unit_amount: 5999, type: 'recurring', recurring: { interval: 'month', interval_count: 1 } };
        },
      },
      webhooks: {
        constructEventAsync: async () => {
          if (fake.event instanceof Error) throw fake.event;
          if (!fake.event) throw new Error('fake: no event programmed');
          return fake.event;
        },
      },
    },
  };
  return fake;
}
