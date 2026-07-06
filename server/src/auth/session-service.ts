import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Db } from '../db/client';
import { refreshTokens, sessions } from '../db/schema';
import { hashToken, newToken } from './tokens';

/**
 * Emissão e rotação de tokens. Session curto (15min), refresh longo (30d) com
 * ROTAÇÃO: cada uso emite um par novo e marca o antigo usado; um refresh já
 * usado que reaparece = roubo → revoga TODA a cadeia da conta.
 */

const SESSION_TTL_MS = 15 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 3600 * 1000;

async function issue(
  db: Db,
  accountId: string,
  now: number,
  rotatedFrom: string | null,
): Promise<{ session: string; refresh: string }> {
  const session = newToken();
  const refresh = newToken();
  await db.insert(sessions).values({
    accountId,
    tokenHash: hashToken(session),
    expiresAt: new Date(now + SESSION_TTL_MS),
  });
  await db.insert(refreshTokens).values({
    accountId,
    tokenHash: hashToken(refresh),
    rotatedFrom,
    expiresAt: new Date(now + REFRESH_TTL_MS),
  });
  return { session, refresh };
}

export async function issueTokens(
  db: Db,
  accountId: string,
  now: () => number = Date.now,
): Promise<{ session: string; refresh: string }> {
  return issue(db, accountId, now(), null);
}

export async function revokeAll(db: Db, accountId: string): Promise<void> {
  const at = new Date();
  await db
    .update(refreshTokens)
    .set({ revokedAt: at })
    .where(and(eq(refreshTokens.accountId, accountId), isNull(refreshTokens.revokedAt)));
  await db
    .update(sessions)
    .set({ revokedAt: at })
    .where(and(eq(sessions.accountId, accountId), isNull(sessions.revokedAt)));
}

export async function rotateRefresh(
  db: Db,
  refreshRaw: string,
  now: () => number = Date.now,
): Promise<{ session: string; refresh: string } | { reuseDetected: true }> {
  const hash = hashToken(refreshRaw);
  const [row] = await db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, hash))
    .limit(1);

  // inexistente OU já usado OU revogado OU expirado → comprometido
  if (!row || row.usedAt || row.revokedAt || row.expiresAt.getTime() < now()) {
    if (row) await revokeAll(db, row.accountId);
    return { reuseDetected: true };
  }
  await db
    .update(refreshTokens)
    .set({ usedAt: new Date(now()) })
    .where(eq(refreshTokens.id, row.id));
  return issue(db, row.accountId, now(), row.id);
}

export async function sessionAccount(
  db: Db,
  sessionRaw: string,
  now: () => number = Date.now,
): Promise<string | null> {
  const [row] = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.tokenHash, hashToken(sessionRaw)),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, new Date(now())),
      ),
    )
    .limit(1);
  return row?.accountId ?? null;
}
