import { lt, sql } from 'drizzle-orm';
import type { Db } from './client';
import {
  authCodes,
  cronLeases,
  oauthStates,
  refreshTokens,
  sessions,
  subscriptions,
  teams,
} from './schema';

export const PENDING_TEAM_TTL_MS = 24 * 3600 * 1000;

/**
 * Reaper: remove linhas efêmeras expiradas (states de 10min, codes de 60s,
 * sessões de 15min, refresh de 30d) e times pendentes antigos sem assinatura.
 * Sem isso as tabelas crescem para sempre. Roda no boot e a cada intervalo.
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
  await db.delete(cronLeases).where(lt(cronLeases.expiresAt, at));
  const pendingTeamCutoff = new Date(now() - PENDING_TEAM_TTL_MS);
  await db.delete(teams).where(sql`
    ${teams.createdAt} < ${pendingTeamCutoff}
    AND NOT EXISTS (
      SELECT 1 FROM ${subscriptions}
      WHERE ${subscriptions.teamId} = ${teams.id}
    )
  `);
}
