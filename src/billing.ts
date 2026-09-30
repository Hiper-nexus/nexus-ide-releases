import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppEnv } from './context.js';
import { billingConfigured, type Config } from './config.js';
import type { AccountRow } from './db/schema.js';
import { jsonBody, readBoundedBody } from './http.js';
import { licenseForAccount } from './licences.js';
import { requireCsrf, requireNativeAuth, requireWebAuth } from './middleware.js';
import { PRO_MONTHLY_PRICE, stripeFrom, type StripeEvent, type StripeLike, type StripePrice, type StripeSubscription } from './stripe.js';

export const GRACE_MS = 7 * 24 * 60 * 60 * 1000;
/** Stripe Checkout Sessions live at most 24 h, and so do idempotency keys. */
const CHECKOUT_WINDOW_MS = 23 * 60 * 60 * 1000;
const SNAPSHOT_ATTEMPTS = 3;
const webCheckoutSchema = z.strictObject({ plan: z.literal('pro'), attemptId: z.uuid() });
const nativeCheckoutSchema = z.object({ plan: z.literal('pro') });
type BillingContext = Context<AppEnv>;
export type StripeFactory = (config: Config) => StripeLike;

const requireBilling: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!billingConfigured(c.get('config'))) throw new HTTPException(503, { message: 'A contratação está temporariamente indisponível.' });
  await next();
};

/** Outbound Stripe calls made on behalf of a visitor fail as 502, never as a leaked SDK error. */
async function viaStripe<T>(call: () => Promise<T>): Promise<T> {
  try { return await call(); }
  catch { throw new HTTPException(502, { message: 'Stripe indisponível no momento. Tente novamente em instantes.' }); }
}

function isConfiguredProPrice(price: StripePrice, expectedId: string): boolean {
  return price.id === expectedId && price.active && price.currency.toLowerCase() === PRO_MONTHLY_PRICE.currency
    && price.unit_amount === PRO_MONTHLY_PRICE.unitAmount && price.type === 'recurring'
    && price.recurring?.interval === PRO_MONTHLY_PRICE.interval && price.recurring.interval_count === PRO_MONTHLY_PRICE.intervalCount;
}

async function customerFor(db: D1Database, stripe: StripeLike, account: AccountRow): Promise<string> {
  if (account.stripe_customer_id) return account.stripe_customer_id;
  // The idempotency key makes concurrent first checkouts converge on one Stripe customer.
  const created = await viaStripe(() => stripe.customers.create({ ...(account.email.includes('@') ? { email: account.email } : {}), metadata: { accountId: account.id } }, { idempotencyKey: `customer:${account.id}` }));
  await db.prepare('UPDATE accounts SET stripe_customer_id=?,updated_at=? WHERE id=? AND stripe_customer_id IS NULL').bind(created.id, Date.now(), account.id).run();
  return created.id;
}

/** Opens a checkout window for the account, or joins the one already open. Every attempt
 * inside a window shares one idempotency key, so Stripe replays a single session instead
 * of creating a second payable one for the same account. */
async function reserveCheckout(db: D1Database, accountId: string, at: number): Promise<{ generation: number; openUntil: number }> {
  await db.prepare('UPDATE accounts SET checkout_generation=checkout_generation+1,checkout_open_until=? WHERE id=? AND (checkout_open_until IS NULL OR checkout_open_until<=?)').bind(at + CHECKOUT_WINDOW_MS, accountId, at).run();
  const row = await db.prepare('SELECT checkout_generation AS generation,checkout_open_until AS openUntil FROM accounts WHERE id=?').bind(accountId).first<{ generation: number; openUntil: number | null }>();
  if (!row || row.openUntil === null) throw new HTTPException(409, { message: 'Não foi possível iniciar o checkout. Tente novamente.' });
  return { generation: row.generation, openUntil: row.openUntil };
}

async function checkout(c: BillingContext, stripe: StripeLike, now: () => number) {
  const config = c.get('config'), db = c.env.DB, accountId = c.get('session').account_id;
  if (config.MIGRATION_READY !== 'true') throw new HTTPException(503, { message: 'A contratação ainda não está aberta.' });
  const account = await db.prepare('SELECT * FROM accounts WHERE id=?').bind(accountId).first<AccountRow>();
  if (!account) throw new HTTPException(401, { message: 'Conta não disponível.' });
  if (account.suspended_at !== null) throw new HTTPException(403, { message: 'Conta suspensa. Fale com o suporte.' });
  // A live personal subscription is changed in the portal, never by a second checkout.
  const live = await db.prepare("SELECT id FROM subscriptions WHERE owner_type='account' AND account_id=? AND status IN('active','trialing','past_due') LIMIT 1").bind(accountId).first();
  if (live) throw new HTTPException(409, { message: 'Você já tem uma assinatura. Use o portal para gerenciá-la.' });
  // The Stripe Price is the monetary authority: a stale or foreign Price fails before any customer or charge exists.
  const price = await viaStripe(() => stripe.prices.retrieve(config.STRIPE_PRICE_PRO));
  if (!isConfiguredProPrice(price, config.STRIPE_PRICE_PRO)) {
    console.error('nexus-cloud-api: STRIPE_PRICE_PRO does not match the public Pro price');
    throw new HTTPException(503, { message: 'Plano Pro temporariamente indisponível. Tente novamente mais tarde.' });
  }
  const customer = await customerFor(db, stripe, account);
  const window = await reserveCheckout(db, accountId, now());
  const metadata = { accountId, plan: 'pro' };
  // Parameters must be identical across attempts, or Stripe rejects the idempotent replay.
  const session = await viaStripe(() => stripe.checkout.sessions.create({
    mode: 'subscription', customer, client_reference_id: accountId, line_items: [{ price: config.STRIPE_PRICE_PRO, quantity: 1 }],
    locale: 'pt-BR', billing_address_collection: 'auto', metadata, expires_at: Math.floor(window.openUntil / 1000),
    // The webhook reads the subscription, so the owner must be in its metadata too.
    subscription_data: { metadata },
    success_url: `${config.PUBLIC_SITE_URL}/conta/?checkout=success`, cancel_url: `${config.PUBLIC_SITE_URL}/conta/?checkout=cancel`,
  }, { idempotencyKey: `checkout:${accountId}:${window.generation}` }));
  if (!session.url) throw new HTTPException(502, { message: 'Stripe indisponível no momento. Tente novamente em instantes.' });
  return c.json({ ok: true, data: { url: session.url } });
}

async function portal(c: BillingContext, stripe: StripeLike) {
  const config = c.get('config');
  const row = await c.env.DB.prepare('SELECT stripe_customer_id AS id FROM accounts WHERE id=?').bind(c.get('session').account_id).first<{ id: string | null }>();
  if (!row?.id) throw new HTTPException(409, { message: 'Nenhuma assinatura encontrada para esta conta.' });
  const customer = row.id;
  const session = await viaStripe(() => stripe.billingPortal.sessions.create({ customer, return_url: `${config.PUBLIC_SITE_URL}/conta/` }));
  return c.json({ ok: true, data: { url: session.url } });
}

function stripeId(value: unknown): string | null {
  if (typeof value === 'string') return value;
  const id = typeof value === 'object' && value !== null ? (value as { id?: unknown }).id : null;
  return typeof id === 'string' ? id : null;
}

function subscriptionIdFrom(event: StripeEvent): string | null {
  const object = event.data.object as { id?: unknown; subscription?: unknown; parent?: { subscription_details?: { subscription?: unknown } | null } | null };
  if (event.type === 'checkout.session.completed') return stripeId(object.subscription);
  if (event.type.startsWith('customer.subscription.')) return stripeId(object.id);
  if (event.type.startsWith('invoice.')) return stripeId(object.subscription) ?? stripeId(object.parent?.subscription_details?.subscription);
  return null;
}

type SubscriptionOwner = { readonly plan: 'pro' | 'team'; readonly accountId: string | null; readonly teamId: string | null; readonly periodEnd: number };
type IgnoredReason = 'foreign-price' | 'missing-owner' | 'unknown-owner' | 'customer-mismatch' | 'missing-period';

/** Decides who a Stripe subscription belongs to. A subscription the product cannot own
 * is a terminal condition: retrying the event would never change the answer. */
async function subscriptionOwner(db: D1Database, sub: StripeSubscription, config: Config): Promise<SubscriptionOwner | { readonly ignored: IgnoredReason }> {
  const item = sub.items.data[0];
  const priceId = item?.price.id ?? '';
  const plan = priceId === config.STRIPE_PRICE_PRO ? 'pro' : config.STRIPE_PRICE_TEAM && priceId === config.STRIPE_PRICE_TEAM ? 'team' : null;
  if (!plan) return { ignored: 'foreign-price' };
  const periodEnd = item?.current_period_end ?? sub.current_period_end;
  if (typeof periodEnd !== 'number' || !Number.isFinite(periodEnd)) return { ignored: 'missing-period' };
  if (plan === 'team') {
    const teamId = sub.metadata.teamId || null;
    if (!teamId) return { ignored: 'missing-owner' };
    const team = await db.prepare('SELECT id FROM teams WHERE id=?').bind(teamId).first();
    return team ? { plan, accountId: null, teamId, periodEnd } : { ignored: 'unknown-owner' };
  }
  const accountId = sub.metadata.accountId || null;
  if (!accountId) return { ignored: 'missing-owner' };
  const account = await db.prepare('SELECT stripe_customer_id AS customer FROM accounts WHERE id=?').bind(accountId).first<{ customer: string | null }>();
  if (!account) return { ignored: 'unknown-owner' };
  // Checkout links the customer to the account before any session exists, so metadata alone
  // can never move a subscription paid by one customer onto another account.
  return account.customer === sub.customer ? { plan, accountId, teamId: null, periodEnd } : { ignored: 'customer-mismatch' };
}

/** Statements that mirror one Stripe subscription snapshot. Idempotent, and the only write
 * path into `subscriptions`. The snapshot was read between `startedAt` and `receivedAt`; it
 * only replaces a stored snapshot received before this read started, which proves it is not
 * older. Grace is anchored on the first past_due observation, so retries never extend it. */
function subscriptionStatements(db: D1Database, sub: StripeSubscription, owner: SubscriptionOwner, startedAt: number, receivedAt: number): D1PreparedStatement[] {
  const upsert = db.prepare(`INSERT INTO subscriptions(id,owner_type,account_id,team_id,stripe_subscription_id,stripe_customer_id,plan,status,seats,current_period_end,grace_until,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(stripe_subscription_id) DO UPDATE SET owner_type=excluded.owner_type,account_id=excluded.account_id,team_id=excluded.team_id,
      stripe_customer_id=excluded.stripe_customer_id,plan=excluded.plan,seats=excluded.seats,current_period_end=excluded.current_period_end,
      grace_until=CASE WHEN excluded.status<>'past_due' THEN NULL WHEN subscriptions.status='past_due' AND subscriptions.grace_until IS NOT NULL THEN subscriptions.grace_until ELSE excluded.grace_until END,
      status=excluded.status,updated_at=excluded.updated_at
    WHERE subscriptions.updated_at<=? RETURNING id`)
    .bind(crypto.randomUUID(), owner.teamId ? 'team' : 'account', owner.accountId, owner.teamId, sub.id, sub.customer, owner.plan, sub.status, sub.items.data[0]?.quantity ?? 1,
      owner.periodEnd * 1000, sub.status === 'past_due' ? receivedAt + GRACE_MS : null, receivedAt, receivedAt, startedAt);
  if (!owner.accountId) return [upsert];
  // Personal plan cache; the entitlement itself is always recomputed from `subscriptions`.
  // A subscription change also closes the checkout window, so a later checkout gets a new session.
  const cache = db.prepare(`UPDATE accounts SET updated_at=?1,checkout_open_until=NULL,plan=CASE WHEN EXISTS(SELECT 1 FROM subscriptions s WHERE s.owner_type='account' AND s.account_id=accounts.id
      AND ((s.status IN('active','trialing') AND s.current_period_end>?1) OR (s.status='past_due' AND s.grace_until>?1))) THEN 'pro' ELSE 'free' END WHERE id=?2`).bind(receivedAt, owner.accountId);
  return [upsert, cache];
}

/** Applies the CURRENT subscription from the Stripe API. Returns the reason when the
 * subscription can never be applied. A write that loses to a fresher concurrent one is
 * retried with a new read, never forced. */
async function applySubscription(db: D1Database, stripe: StripeLike, subscriptionId: string, config: Config, now: () => number): Promise<IgnoredReason | null> {
  for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt++) {
    const startedAt = now();
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    const receivedAt = now();
    const owner = await subscriptionOwner(db, sub, config);
    if ('ignored' in owner) return owner.ignored;
    const [written] = await db.batch<{ id: string }>(subscriptionStatements(db, sub, owner, startedAt, receivedAt));
    if (written.results.length) return null;
  }
  throw new Error('Stripe subscription snapshot kept losing to newer writes');
}

export function createBillingRoutes(stripeFor: StripeFactory = stripeFrom, now: () => number = Date.now): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
  routes.post('/web/checkout', requireWebAuth, requireCsrf, requireBilling, async (c) => {
    // attemptId is validated for the site contract; one session per account is enforced server-side.
    await jsonBody(c.req.raw, webCheckoutSchema);
    return checkout(c, stripeFor(c.get('config')), now);
  });
  routes.post('/web/portal', requireWebAuth, requireCsrf, requireBilling, c => portal(c, stripeFor(c.get('config'))));
  routes.post('/billing/checkout', requireNativeAuth, requireBilling, async (c) => {
    await jsonBody(c.req.raw, nativeCheckoutSchema);
    return checkout(c, stripeFor(c.get('config')), now);
  });
  routes.post('/billing/portal', requireNativeAuth, requireBilling, c => portal(c, stripeFor(c.get('config'))));
  routes.get('/license', requireNativeAuth, async c => c.json({ ok: true, data: { licenca: await licenseForAccount(c.env.DB, c.get('session').account_id, c.get('config')) } }));
  routes.post('/billing/webhook', requireBilling, async (c) => {
    const config = c.get('config'), db = c.env.DB;
    const signature = c.req.header('stripe-signature');
    if (!signature) throw new HTTPException(400, { message: 'Assinatura inválida.' });
    const body = await readBoundedBody(c.req.raw);
    const stripe = stripeFor(config);
    let event: StripeEvent;
    try { event = await stripe.webhooks.constructEventAsync(body, signature, config.STRIPE_WEBHOOK_SECRET); }
    catch { throw new HTTPException(400, { message: 'Assinatura inválida.' }); }
    const subscriptionId = subscriptionIdFrom(event);
    // Only the routing facts are stored; the event body carries customer data the API never needs again.
    await db.prepare('INSERT OR IGNORE INTO stripe_events(event_id,type,payload,created_at) VALUES(?,?,?,?)').bind(event.id, event.type, JSON.stringify({ subscription: subscriptionId }), now()).run();
    const seen = await db.prepare('SELECT processed_at FROM stripe_events WHERE event_id=?').bind(event.id).first<{ processed_at: number | null }>();
    if (seen?.processed_at) return c.json({ ok: true });
    // State comes from the Stripe API, never from the event payload. A failure here leaves
    // processed_at empty and Stripe retries; a terminal condition is recorded and acknowledged,
    // because retrying it would only fail again until Stripe disables the endpoint.
    const ignored = subscriptionId ? await applySubscription(db, stripe, subscriptionId, config, now) : null;
    if (ignored) console.error('nexus-cloud-api: Stripe subscription ignored:', ignored);
    await db.prepare('UPDATE stripe_events SET processed_at=?,payload=? WHERE event_id=?').bind(now(), JSON.stringify({ subscription: subscriptionId, ...(ignored ? { ignored } : {}) }), event.id).run();
    return c.json({ ok: true });
  });
  return routes;
}
