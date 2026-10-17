import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppEnv } from './context.js';
import { adminEmails, CLASSIFIED, LIVE } from './classified.js';
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
  missionRunning: z.boolean().optional(),
  missionsStarted: z.number().int().min(0).max(50).optional(),
  missionsCompleted: z.number().int().min(0).max(50).optional(),
  deliveryId: z.string().min(1).max(96).regex(/^[A-Za-z0-9:_-]+$/).optional(),
});
const DELIVERY_RANGE = /^([A-Za-z0-9_-]{1,64}):(\d{1,9})-(\d{1,9}):(\d{1,9})-(\d{1,9})$/;
// Effective increments of a delivery: inside the same stream only what lies beyond the last applied sequence counts.
// Each stream lives in delivery_streams JSON as {"<stream>":{"s","c","t","w","r"}}: counter watermarks plus its last live flags.
// stream matches [A-Za-z0-9:_-], so it is safe in a quoted JSON path.
const STREAM_KEY = `COALESCE(?12,'__default')`;
const STREAM_PATH = `'$."' || ${STREAM_KEY} || '"'`;
const prev = (field: string) => `COALESCE(json_extract(account_activity.delivery_streams,${STREAM_PATH} || '.${field}'),0)`;
const PREV_S = prev('s'), PREV_C = prev('c'), PREV_T = prev('t'), PREV_W = prev('w'), PREV_R = prev('r');
const EFF_STARTED = `CASE WHEN ?12 IS NOT NULL THEN max(0,?14-max(?13,${PREV_S})) ELSE ?7 END`;
const EFF_COMPLETED = `CASE WHEN ?12 IS NOT NULL THEN max(0,?16-max(?15,${PREV_C})) ELSE ?8 END`;
// Evict only the single oldest stream (by $.t) past 32 KB (~650 streams): active watermarks are never wiped.
const BOUNDED_STREAMS = `CASE WHEN length(account_activity.delivery_streams)>32768 THEN json_remove(account_activity.delivery_streams,'$."' || (SELECT key FROM json_each(account_activity.delivery_streams) ORDER BY COALESCE(json_extract(value,'$.t'),0) ASC LIMIT 1) || '"') ELSE account_activity.delivery_streams END`;
const NEXT_STREAMS = `json_set(${BOUNDED_STREAMS},${STREAM_PATH},json_object('s',CASE WHEN ?12 IS NULL THEN 0 ELSE max(${PREV_S},?14) END,'c',CASE WHEN ?12 IS NULL THEN 0 ELSE max(${PREV_C},?16) END,'t',max(${PREV_T},?2),'w',CASE WHEN ?2>=${PREV_T} THEN ?9 ELSE ${PREV_W} END,'r',CASE WHEN ?2>=${PREV_T} THEN ?10 ELSE ${PREV_R} END))`;
const MAX_SEEN = `max(account_activity.last_app_seen_at,excluded.last_app_seen_at)`;
// An account is live while ANY stream seen in the last 5 minutes reports the flag: an idle device never clears another's work.
const live = (flag: string) => `CASE WHEN EXISTS(SELECT 1 FROM json_each(${NEXT_STREAMS}) WHERE json_extract(value,'$.t')>=${MAX_SEEN}-300000 AND json_extract(value,'$.${flag}')=1) THEN 1 ELSE 0 END`;
const LIVE_WORKING = live('w'), LIVE_RUNNING = live('r');
/** Brazil's reporting day uses the agreed UTC-3 boundary. */
export function brazilDay(now: number): string {
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
    const flags = await jsonBody(c.req.raw, activitySchema, 384);
    const now = clock(),
      day = brazilDay(now);
    const running = flags.missionRunning === true;
    const completedInc =
      flags.missionsCompleted ?? (flags.missionCompleted ? 1 : 0);
    const startedInc = flags.missionsStarted ?? (flags.missionCompleted ? 1 : 0);
    // Only a completion is the "completed a mission" milestone (first_mission_at, completedMission);
    // a mission that merely started or is running still counts as mission activity.
    const completedSignal = flags.missionCompleted || completedInc > 0;
    const hasMissionSignal = completedSignal || running || startedInc > 0;
    // deliveryId: `stream:startedFrom-startedTo:completedFrom-completedTo`, or an opaque idempotency key; absent = not idempotent.
    let stream: string | null = null,
      sFrom = 0,
      sTo = startedInc,
      cFrom = 0,
      cTo = completedInc;
    if (flags.deliveryId !== undefined) {
      const m = DELIVERY_RANGE.exec(flags.deliveryId);
      if (m) {
        [stream, sFrom, sTo, cFrom, cTo] = [m[1], Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
        if (sTo - sFrom !== startedInc || cTo - cFrom !== completedInc) {
          return c.json({ error: 'invalid_request' }, 400);
        }
      } else stream = flags.deliveryId;
    }
    const used =
      flags.agentStarted || flags.agentWorking || hasMissionSignal;
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO account_activity(account_id,first_app_seen_at,last_app_seen_at,first_agent_at,first_mission_at,first_usage_day,
          last_active_at,last_mission_at,missions_started_count,missions_completed_count,last_agent_working,last_mission_running,
          delivery_streams)
        VALUES(?1,?2,?2,?3,?4,?5,?6,?11,?7,?8,?9,?10,
          json_object(${STREAM_KEY}, json_object('s',CASE WHEN ?12 IS NULL THEN 0 ELSE ?14 END,'c',CASE WHEN ?12 IS NULL THEN 0 ELSE ?16 END,'t',?2,'w',?9,'r',?10))) ON CONFLICT(account_id) DO UPDATE SET
        last_app_seen_at=max(account_activity.last_app_seen_at,excluded.last_app_seen_at),
        first_agent_at=COALESCE(account_activity.first_agent_at,excluded.first_agent_at),
        first_mission_at=COALESCE(account_activity.first_mission_at,excluded.first_mission_at),
        last_mission_at=CASE WHEN excluded.last_mission_at IS NOT NULL AND (${EFF_STARTED}>0 OR ${EFF_COMPLETED}>0 OR ?10=1)
          AND excluded.last_mission_at>=COALESCE(account_activity.last_mission_at,0) THEN excluded.last_mission_at ELSE account_activity.last_mission_at END,
        last_active_at=CASE WHEN excluded.last_active_at>0 AND excluded.last_active_at>=COALESCE(account_activity.last_active_at,0)
          THEN excluded.last_active_at ELSE account_activity.last_active_at END,
        missions_started_count=account_activity.missions_started_count+${EFF_STARTED},
        missions_completed_count=account_activity.missions_completed_count+${EFF_COMPLETED},
        delivery_streams=${NEXT_STREAMS},
        last_agent_working=${LIVE_WORKING},
        last_mission_running=${LIVE_RUNNING},
        returned_at=CASE WHEN account_activity.first_usage_day IS NOT NULL AND excluded.first_usage_day IS NOT NULL
          AND account_activity.first_usage_day<>excluded.first_usage_day THEN COALESCE(account_activity.returned_at,?2) ELSE account_activity.returned_at END,
        first_usage_day=COALESCE(account_activity.first_usage_day,excluded.first_usage_day)`,
      ).bind(
        accountId,
        now,
        flags.agentStarted ? now : null,
        completedSignal ? now : null,
        used ? day : null,
        used ? now : null,
        startedInc,
        completedInc,
        flags.agentWorking ? 1 : 0,
        running ? 1 : 0,
        hasMissionSignal ? now : null,
        stream,
        sFrom,
        sTo,
        cFrom,
        cTo,
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
      (SELECT COALESCE(sum(missions_completed_count),0) FROM tracked) AS missionsTotalCompleted,
      (SELECT count(*) FROM tracked WHERE last_app_seen_at>=?1-300000 AND last_app_seen_at<=?1 AND last_mission_running=1) AS missionsRunningNow,
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
        missionsTotalCompleted: number;
        missionsRunningNow: number;
        measuringSince: number | null;
      }>();
    // Trial funnel: only accounts whose classified situation is a running, unsuspended trial.
    const trialFunnel = await c.env.DB.prepare(
      `${CLASSIFIED} SELECT count(*) AS totalTrial,
        count(CASE WHEN c.last_seen_at IS NOT NULL THEN 1 END) AS loggedIn,
        count(t.first_app_seen_at) AS openedApp,
        count(CASE WHEN t.first_agent_at IS NOT NULL OR t.last_active_at IS NOT NULL THEN 1 END) AS usedSystem,
        count(CASE WHEN t.first_mission_at IS NOT NULL OR t.missions_started_count>0 OR t.missions_completed_count>0 THEN 1 END) AS ranMissions,
        count(CASE WHEN EXISTS(SELECT 1 FROM account_activity_days d WHERE d.account_id=c.id AND d.day=?3) THEN 1 END) AS activeToday,
        count(CASE WHEN EXISTS(SELECT 1 FROM account_activity_days d WHERE d.account_id=c.id AND d.day>=?4 AND d.day<=?3) THEN 1 END) AS active7d,
        count(CASE WHEN t.last_app_seen_at>=?1-300000 AND t.last_app_seen_at<=?1 THEN 1 END) AS onlineNow
      FROM classified c LEFT JOIN account_activity t ON t.account_id=c.id WHERE c.situation='trial'`,
    )
      .bind(
        now,
        adminEmails(c.get('config')),
        brazilDay(now),
        brazilDay(now - 6 * DAY_MS),
      )
      .first();
    c.header('Cache-Control', 'no-store');
    return c.json({
      ok: true,
      data: {
        ...row!,
        trialFunnel,
        measuringSince:
          row!.measuringSince === null
            ? null
            : new Date(row!.measuringSince).toISOString(),
      },
    });
  });
  return routes;
}
