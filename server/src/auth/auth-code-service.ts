import { and, eq, gt, isNull } from 'drizzle-orm';
import crypto from 'node:crypto';
import type { Db } from '../db/client';
import { authCodes } from '../db/schema';
import { hashToken } from './tokens';

/**
 * Consumo ATÔMICO do code de deep-link (anti-TOCTOU): marca usado SÓ se ainda
 * virgem e não-expirado, num único UPDATE condicional. Dois resgates
 * concorrentes: um recebe a conta, o outro recebe null.
 *
 * M11: when `codeChallenge` was stored at issue time, the caller MUST present
 * the matching `codeVerifier` — binds the deep-link code to the desktop client
 * that initiated the login, so a malicious app that merely intercepts the
 * custom-scheme callback cannot exchange it.
 */
export async function consumeAuthCode(
  db: Db,
  rawCode: string,
  now: () => number = Date.now,
  codeVerifier?: string,
): Promise<{ accountId: string } | null> {
  const at = new Date(now());
  const conditions = [
    eq(authCodes.codeHash, hashToken(rawCode)),
    isNull(authCodes.usedAt),
    gt(authCodes.expiresAt, at),
  ];
  // If a challenge was stored, the verifier must hash to it (S256).
  if (codeVerifier) {
    const derivedChallenge = crypto
      .createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');
    conditions.push(eq(authCodes.codeChallenge, derivedChallenge));
  }
  const [row] = await db
    .update(authCodes)
    .set({ usedAt: at })
    .where(and(...conditions))
    .returning({ accountId: authCodes.accountId });
  return row ?? null;
}
