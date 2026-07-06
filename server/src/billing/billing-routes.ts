import { Router } from 'express';
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import type { Env } from '../env';
import { accounts, subscriptions, teamMembers, teams } from '../db/schema';
import type { StripeLike } from './stripe-like';
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
const MAX_SEATS = 100;

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

function isUniqueViolation(err: unknown): boolean {
  const layers = [err, (err as { cause?: unknown })?.cause];
  return layers.some((layer) => {
    const code = (layer as { code?: string })?.code;
    const msg = layer instanceof Error ? layer.message : String(layer ?? '');
    return code === '23505' || /duplicate key|unique constraint/i.test(msg);
  });
}

async function hasLiveTeamSubscription(db: Db, teamId: string): Promise<boolean> {
  const [live] = await db.select({ id: subscriptions.id })
    .from(subscriptions)
    .where(and(
      eq(subscriptions.ownerType, 'team'),
      eq(subscriptions.teamId, teamId),
      inArray(subscriptions.status, LIVE),
    ))
    .limit(1);
  return Boolean(live);
}

export function buildBillingRouter(deps: BillingDeps): Router {
  const { db, env, stripe } = deps;
  const r = Router();
  const limit = rateLimit({ windowMs: 60_000, max: 30 });

  r.post('/billing/checkout', limit, requireAuth(db), ah(async (req, res) => {
    const body = req.body as { plan?: string; seats?: number; teamName?: string };
    const plan = body.plan === 'team' ? 'team' : body.plan === 'pro' ? 'pro' : null;
    if (!plan) return res.status(400).json({ ok: false, error: 'plan inválido' });
    const accountId = req.accountId!;

    let teamId: string | null = null;
    let seats = 1;
    if (plan === 'team') {
      seats = Math.min(Math.max(Math.trunc(body.seats ?? 2), 2), MAX_SEATS);
      const name = String(body.teamName ?? '').trim().slice(0, 80);
      if (!name) return res.status(400).json({ ok: false, error: 'teamName obrigatório' });
      const [member] = await db.select({
        teamId: teamMembers.teamId,
        role: teamMembers.role,
        ownerAccountId: teams.ownerAccountId,
      })
        .from(teamMembers)
        .innerJoin(teams, eq(teams.id, teamMembers.teamId))
        .where(eq(teamMembers.accountId, accountId))
        .limit(1);
      if (member) {
        if (member.role !== 'owner' || member.ownerAccountId !== accountId) {
          return res.status(409).json({ ok: false, error: 'você já está num time' });
        }
        if (await hasLiveTeamSubscription(db, member.teamId)) {
          return res.status(409).json({ ok: false, error: 'assinatura ativa — use o portal' });
        }
        await db.update(teams).set({ name }).where(eq(teams.id, member.teamId));
        teamId = member.teamId;
      } else {
        try {
          const created = await db.transaction(async (tx) => {
            const [t] = await tx.insert(teams).values({ name, ownerAccountId: accountId })
              .returning({ id: teams.id });
            await tx.insert(teamMembers).values({ teamId: t.id, accountId, role: 'owner' });
            return t;
          });
          teamId = created.id;
        } catch (err) {
          if (isUniqueViolation(err)) {
            return res.status(409).json({ ok: false, error: 'você já está num time' });
          }
          throw err;
        }
      }
    } else {
      // Pro: assinatura pessoal viva → mudanças são no portal, não em novo checkout.
      const live = await db.select().from(subscriptions).where(and(
        eq(subscriptions.ownerType, 'account'),
        eq(subscriptions.accountId, accountId),
        inArray(subscriptions.status, LIVE),
      ));
      if (live.length > 0) {
        return res.status(409).json({ ok: false, error: 'assinatura ativa — use o portal' });
      }
    }

    const customer = await customerFor(db, stripe, accountId);
    const price = plan === 'team' ? env.STRIPE_PRICE_TEAM : env.STRIPE_PRICE_PRO;
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer,
      line_items: [{ price, quantity: seats }],
      success_url: `${env.PUBLIC_SITE_URL}/billing/success`,
      cancel_url: `${env.PUBLIC_SITE_URL}/billing/cancel`,
      // metadata na SUBSCRIPTION (não só na session): é ela que o webhook lê.
      subscription_data: { metadata: { accountId, teamId: teamId ?? '', plan } },
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
