import { lt } from 'drizzle-orm';
import type { Db } from './client';
import { authCodes, oauthStates, refreshTokens, sessions } from './schema';

/**
 * Reaper: remove linhas efêmeras expiradas (states de 10min, codes de 60s,
 * sessões de 15min, refresh de 30d). Sem isso as tabelas crescem para
 * sempre. Roda no boot e a cada intervalo (ver index.ts).
 */
export async function cleanupExpired(
  db: Db,
  now: () => number = Date.now,
): Promise<void> {
  const at = new Date(now());
  await db.delete(oauthStates).where(lt(oauthStates.expiresAt, at));
  await db.delete(authCodes).where(lt(authCodes.expiresAt, at));
  await db.delete(sessions).where(lt(sessions.expiresAt, at));
  await db.delete(refreshTokens).where(lt(refreshTokens.expiresAt, at));
}
