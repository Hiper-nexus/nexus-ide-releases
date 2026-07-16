import crypto from 'node:crypto';
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { hashToken } from '../auth/tokens';
import type { Db } from '../db/client';
import { subscriptions, teamInvites, teamMembers, teams } from '../db/schema';

const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
// 12 base32 chars ≈ 60 bits (L14): a distributed guesser can no longer
// meaningfully grind the keyspace over the 7-day TTL. `normalizeCode` strips the
// grouping dashes, so validation (DB lookup on the hash) is format-agnostic and
// codes issued before this change keep working.
const CODE_LENGTH = 12;
const CODE_GROUP_SIZE = 4;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function inviteCode(): string {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  const chars = Array.from(bytes, (byte) => BASE32[byte % BASE32.length]).join('');
  return chars.match(/.{1,4}/g)!.join('-');
}

function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z2-7]/g, '');
}

function isLiveTeamSubscription(
  sub: typeof subscriptions.$inferSelect,
  now: number,
): boolean {
  if (sub.status === 'active' || sub.status === 'trialing') return true;
  return sub.status === 'past_due' && sub.graceUntil !== null && sub.graceUntil.getTime() > now;
}

export async function createInvite(
  db: Db,
  teamId: string,
  createdBy: string,
  now: () => number = Date.now,
): Promise<{ code: string; codePrefix: string; expiresAt: Date }> {
  const code = inviteCode();
  const codePrefix = code.slice(0, CODE_GROUP_SIZE);
  const expiresAt = new Date(now() + INVITE_TTL_MS);
  await db.insert(teamInvites).values({
    codeHash: hashToken(normalizeCode(code)),
    codePrefix,
    teamId,
    createdBy,
    expiresAt,
  });
  return { code, codePrefix, expiresAt };
}

export async function joinTeam(
  db: Db,
  accountId: string,
  rawCode: string,
  now: () => number = Date.now,
): Promise<{ ok: true; teamId: string; name: string } | { ok: false; error: string }> {
  const at = new Date(now());
  const [existing] = await db.select({ teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(eq(teamMembers.accountId, accountId))
    .limit(1);
  if (existing) return { ok: false, error: 'você já está num time' };

  return db.transaction(async (tx) => {
    const [invite] = await tx.update(teamInvites)
      .set({ usedCount: sql`${teamInvites.usedCount} + 1` })
      .where(and(
        eq(teamInvites.codeHash, hashToken(normalizeCode(rawCode))),
        isNull(teamInvites.revokedAt),
        gt(teamInvites.expiresAt, at),
        lt(teamInvites.usedCount, teamInvites.maxUses),
      ))
      .returning({ teamId: teamInvites.teamId });
    if (!invite) return { ok: false as const, error: 'convite inválido ou esgotado' };

    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${invite.teamId}))`);

    const teamSubs = await tx.select().from(subscriptions).where(and(
      eq(subscriptions.ownerType, 'team'),
      eq(subscriptions.teamId, invite.teamId),
    ));
    const liveSub = teamSubs.find((sub) => isLiveTeamSubscription(sub, now()));
    if (!liveSub) return { ok: false as const, error: 'assinatura do time não está ativa' };

    const members = await tx.select({ accountId: teamMembers.accountId })
      .from(teamMembers)
      .where(eq(teamMembers.teamId, invite.teamId));
    if (members.length >= liveSub.seats) {
      return { ok: false as const, error: 'sem assento livre — peça ao dono' };
    }

    const inserted = await tx.insert(teamMembers)
      .values({ teamId: invite.teamId, accountId, role: 'member' })
      .onConflictDoNothing()
      .returning({ accountId: teamMembers.accountId });
    if (inserted.length === 0) return { ok: false as const, error: 'você já está num time' };

    const [team] = await tx.select({ name: teams.name })
      .from(teams)
      .where(eq(teams.id, invite.teamId))
      .limit(1);
    return { ok: true as const, teamId: invite.teamId, name: team.name };
  });
}
