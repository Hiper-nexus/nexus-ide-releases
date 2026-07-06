import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { accounts, subscriptions } from '../db/schema';
import type { StripeSubscription } from './stripe-like';

/**
 * Aplica o estado ATUAL de uma assinatura (vindo da API do Stripe — nunca do
 * payload de um evento) no espelho local. Idempotente: reaplicar o mesmo
 * estado não muda nada. É o ÚNICO caminho de escrita em `subscriptions`.
 */

export const GRACE_MS = 7 * 24 * 3600 * 1000;
export type PriceMap = { pricePro: string; priceTeam: string };

export async function applySubscriptionState(
  db: Db,
  sub: StripeSubscription,
  prices: PriceMap,
  now: () => number = Date.now,
): Promise<void> {
  const priceId = sub.items.data[0]?.price.id ?? '';
  const plan = priceId === prices.priceTeam || sub.metadata.plan === 'team' ? 'team' : 'pro';
  const teamId = sub.metadata.teamId || null;
  const accountId = sub.metadata.accountId || null;

  // Ancora a graça na primeira observação de past_due: se a linha já estava
  // past_due com graceUntil setado, REUSA esse valor (retries do Stripe não
  // empurram a graça pra sempre). Só computa now()+GRACE_MS quando o status
  // anterior não era past_due. Sair de past_due zera a graça.
  const [existing] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.stripeSubscriptionId, sub.id))
    .limit(1);
  let graceUntil: Date | null = null;
  if (sub.status === 'past_due') {
    graceUntil = existing?.status === 'past_due' && existing.graceUntil
      ? existing.graceUntil
      : new Date(now() + GRACE_MS);
  }
  const values = {
    ownerType: (teamId ? 'team' : 'account') as 'team' | 'account',
    accountId: teamId ? null : accountId,
    teamId,
    stripeSubscriptionId: sub.id,
    stripeCustomerId: sub.customer,
    plan: plan as 'pro' | 'team',
    status: sub.status,
    seats: sub.items.data[0]?.quantity ?? 1,
    currentPeriodEnd: new Date(sub.current_period_end * 1000),
    graceUntil,
    updatedAt: new Date(now()),
  };
  await db
    .insert(subscriptions)
    .values(values)
    .onConflictDoUpdate({ target: subscriptions.stripeSubscriptionId, set: values });

  // Cache do plano PESSOAL (time não mexe em accounts.plan — o entitlement
  // de membro é calculado na licença). past_due só mantém o plano enquanto a
  // graça (ancorada acima) não venceu; graça vencida rebaixa para 'free'.
  if (!teamId && accountId) {
    const inGrace = sub.status === 'past_due' && graceUntil !== null && graceUntil.getTime() > now();
    const isPaidNow = sub.status === 'active' || sub.status === 'trialing';
    const effective = isPaidNow || inGrace ? plan : 'free';
    await db.update(accounts).set({ plan: effective as 'free' | 'pro' | 'team' })
      .where(eq(accounts.id, accountId));
  }
}
