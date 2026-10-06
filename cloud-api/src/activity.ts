import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppEnv } from './context.js';
import { adminEmails, LIVE } from './classified.js';
import { jsonBody } from './http.js';
import {
  requireAccess,
  requireAdmin,
  requireNativeAuth,
  requireWebAuth,
} from './middleware.js';

const DAY_MS = 86_400_000;
const activitySchema = z.strictObject({
  agentStarted: z.boolean(),
  agentWorking: z.boolean(),
  missionCompleted: z.boolean(),
});
/** Brazil's reporting day uses the agreed UTC-3 boundary. */
function brazilDay(now: number): string {
  return new Date(now - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
export async function purgeActivityDays(
  db: D1Database,
  now: number,
): Promise<void> {
  await db
    .prepare('DELETE FROM account_activity_days WHERE day<?')
    .bind(brazilDay(now - 89 * DAY_MS))
    .run();
}

export function createActivityRoutes(
  clock: () => number = Date.now,
): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.post('/activity', requireNativeAuth, requireAccess, async (c) => {
    const accountId = c.get('session').account_id;
    // Existing distributed limiter bounds each account, even across IPs and sessions.
    if (
      !(await c.env.API_RATE_LIMITER.limit({ key: `activity:${accountId}` }))
        .success
    ) {
      throw new HTTPException(429, {
        message: 'Muitas tentativas. Aguarde um momento antes de continuar.',
      });
    }
    const flags = await jsonBody(c.req.raw, activitySchema, 256);
    const now = clock(),
      day = brazilDay(now);
    const used =
      flags.agentStarted || flags.agentWorking || flags.missionCompleted;
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO account_activity(account_id,first_app_seen_at,last_app_seen_at,first_agent_at,first_mission_at,first_usage_day)
        VALUES(?1,?2,?2,?3,?4,?5) ON CONFLICT(account_id) DO UPDATE SET
        last_app_seen_at=max(account_activity.last_app_seen_at,excluded.last_app_seen_at),
        first_agent_at=COALESCE(account_activity.first_agent_at,excluded.first_agent_at),
        first_mission_at=COALESCE(account_activity.first_mission_at,excluded.first_mission_at),
        returned_at=CASE WHEN account_activity.first_usage_day IS NOT NULL AND excluded.first_usage_day IS NOT NULL
          AND account_activity.first_usage_day<>excluded.first_usage_day THEN COALESCE(account_activity.returned_at,?2) ELSE account_activity.returned_at END,
        first_usage_day=COALESCE(account_activity.first_usage_day,excluded.first_usage_day)`,
      ).bind(
        accountId,
        now,
        flags.agentStarted ? now : null,
        flags.missionCompleted ? now : null,
        used ? day : null,
      ),
      ...(used
        ? [
            c.env.DB.prepare(
              'INSERT INTO account_activity_days(account_id,day) VALUES(?,?) ON CONFLICT DO NOTHING',
            ).bind(accountId, day),
          ]
        : []),
    ]);
    c.header('Cache-Control', 'no-store');
    return c.json({ ok: true, data: {} });
  });
  routes.get('/admin/activity', requireWebAuth, requireAdmin, async (c) => {
    const now = clock();
    // Authorized administrators and current courtesy-only access are not customer activation.
    // EXISTS keeps account counts distinct even for team subscriptions or multiple identities.
    const row = await c.env.DB.prepare(
      `WITH subscription_accounts AS (
      SELECT s.account_id,s.stripe_subscription_id,s.status,s.current_period_end,s.grace_until
        FROM subscriptions s WHERE s.owner_type='account'
      UNION ALL
      SELECT m.account_id,s.stripe_subscription_id,s.status,s.current_period_end,s.grace_until
        FROM subscriptions s JOIN team_members m ON m.team_id=s.team_id WHERE s.owner_type='team'
    ), real_paid AS (
      SELECT DISTINCT s.account_id FROM subscription_accounts s
        WHERE s.stripe_subscription_id GLOB 'sub_*' AND s.status='active' AND s.current_period_end>?1
    ), current_courtesy AS (
      SELECT DISTINCT s.account_id FROM subscription_accounts s
        WHERE s.stripe_subscription_id GLOB 'codegrant:*' AND ${LIVE}
    ), eligible AS (
      SELECT a.id FROM accounts a WHERE NOT (a.role='admin' AND EXISTS(
        SELECT 1 FROM identities i WHERE i.account_id=a.id AND i.email_verified=1
          AND lower(i.email) IN (SELECT value FROM json_each(?2))))
      AND (a.id IN (SELECT account_id FROM real_paid) OR a.id NOT IN (SELECT account_id FROM current_courtesy))
    ), tracked AS (SELECT t.* FROM account_activity t JOIN eligible e ON e.id=t.account_id)
    SELECT
      (SELECT count(*) FROM tracked WHERE last_app_seen_at>=?1-300000 AND last_app_seen_at<=?1) AS onlineNow,
      (SELECT count(*) FROM eligible e WHERE EXISTS(SELECT 1 FROM account_activity_days d WHERE d.account_id=e.id AND d.day=?3)) AS usedToday,
      (SELECT count(*) FROM eligible e WHERE EXISTS(SELECT 1 FROM account_activity_days d WHERE d.account_id=e.id AND d.day>=?4 AND d.day<=?3)) AS used7d,
      (SELECT count(*) FROM tracked WHERE first_agent_at IS NOT NULL) AS startedAgents,
      (SELECT count(*) FROM tracked WHERE first_mission_at IS NOT NULL) AS completedMission,
      (SELECT count(*) FROM tracked WHERE returned_at IS NOT NULL) AS returned,
      (SELECT count(*) FROM eligible e WHERE e.id IN (SELECT account_id FROM real_paid)) AS paidAccounts,
      (SELECT count(*) FROM tracked) AS trackedAccounts,
      (SELECT min(first_app_seen_at) FROM tracked) AS measuringSince`,
    )
      .bind(
        now,
        adminEmails(c.get('config')),
        brazilDay(now),
        brazilDay(now - 6 * DAY_MS),
      )
      .first<{
        onlineNow: number;
        usedToday: number;
        used7d: number;
        startedAgents: number;
        completedMission: number;
        returned: number;
        paidAccounts: number;
        trackedAccounts: number;
        measuringSince: number | null;
      }>();
    c.header('Cache-Control', 'no-store');
    return c.json({
      ok: true,
      data: {
        ...row!,
        measuringSince:
          row!.measuringSince === null
            ? null
            : new Date(row!.measuringSince).toISOString(),
      },
    });
  });
  return routes;
}
