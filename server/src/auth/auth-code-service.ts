import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Db } from '../db/client';
import { authCodes } from '../db/schema';
import { hashToken } from './tokens';

/**
 * Consumo ATÔMICO do code de deep-link (anti-TOCTOU): marca usado SÓ se ainda
 * virgem e não-expirado, num único UPDATE condicional. Dois resgates
 * concorrentes: um recebe a conta, o outro recebe null.
 */
export async function consumeAuthCode(
  db: Db,
  rawCode: string,
  now: () => number = Date.now,
): Promise<{ accountId: string } | null> {
  const at = new Date(now());
  const [row] = await db
    .update(authCodes)
    .set({ usedAt: at })
    .where(
      and(
        eq(authCodes.codeHash, hashToken(rawCode)),
        isNull(authCodes.usedAt),
        gt(authCodes.expiresAt, at),
      ),
    )
    .returning({ accountId: authCodes.accountId });
  return row ?? null;
}
