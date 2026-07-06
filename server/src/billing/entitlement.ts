import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { accounts, subscriptions, teamMembers } from '../db/schema';
import type { SignInput } from '../auth/license-signer';

/**
 * Direito = max(assinatura pessoal, plano do time onde sou membro).
 * Licença derivada de TIME tem TTL curto (7d): membro removido perde o
 * acesso na renovação, limitando a janela offline.
 */

export const TTL_PERSONAL = 30 * 24 * 3600;
export const TTL_TEAM_MEMBER = 7 * 24 * 3600;

const RANK: Record<string, number> = { free: 0, pro: 1, team: 2 };

function liveStatus(
  status: string,
  graceUntil: Date | null,
  now: number,
): 'active' | 'past_due' | null {
  if (status === 'active' || status === 'trialing') return 'active';
  if (status === 'past_due' && graceUntil && graceUntil.getTime() > now) return 'past_due';
  return null; // canceled/expirado/grace vencida → não conta
}

export async function entitlementFor(
  db: Db,
  accountId: string,
  now: () => number = Date.now,
): Promise<{ input: SignInput; ttlSeconds: number }> {
  const t = now();
  const [acc] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
  const email = acc?.email ?? null;

  type BestSub = { plan: string; status: 'active' | 'past_due'; renewsAt: string | null; graceUntil: string | null; fromTeam: boolean };
  let best: BestSub | null = null;

  const consider = (sub: typeof subscriptions.$inferSelect, fromTeam: boolean) => {
    const st = liveStatus(sub.status, sub.graceUntil, t);
    if (!st) return;
    // Tie-break por RANK: empate (=) mantém quem veio primeiro. Como pessoal é
    // considerado antes de times, empate favorece a assinatura pessoal (TTL 30d, intencional).
    if (!best || RANK[sub.plan] > RANK[best.plan]) {
      best = {
        plan: sub.plan, status: st,
        renewsAt: sub.currentPeriodEnd?.toISOString() ?? null,
        graceUntil: sub.graceUntil?.toISOString() ?? null,
        fromTeam,
      };
    }
  };

  const personal = await db.select().from(subscriptions)
    .where(and(eq(subscriptions.ownerType, 'account'), eq(subscriptions.accountId, accountId)));
  personal.forEach((s) => consider(s, false));

  const memberships = await db.select().from(teamMembers)
    .where(eq(teamMembers.accountId, accountId));
  for (const m of memberships) {
    const teamSubs = await db.select().from(subscriptions)
      .where(and(eq(subscriptions.ownerType, 'team'), eq(subscriptions.teamId, m.teamId)));
    teamSubs.forEach((s) => consider(s, true));
  }

  if (!best) {
    return {
      input: { plan: 'free', email, status: 'none' },
      ttlSeconds: TTL_PERSONAL,
    };
  }

  const bestSub: BestSub = best;
  return {
    input: {
      plan: bestSub.plan as SignInput['plan'], email, status: bestSub.status,
      renewsAt: bestSub.renewsAt, graceUntil: bestSub.graceUntil,
    },
    ttlSeconds: bestSub.fromTeam ? TTL_TEAM_MEMBER : TTL_PERSONAL,
  };
}
