import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db/client';
import { asyncHandler as ah } from '../middleware/errors';
import { rateLimit } from '../middleware/rate-limit';
import { requireAuth } from '../middleware/require-auth';
import {
  leaseRequestSchema,
  leaseTokenRequestSchema,
  portableProjectIdSchema,
  portableScheduleIdSchema,
  publishScheduleSchema,
} from './cron-contract';
import {
  acquireCronLease,
  listCronSchedules,
  publishCronSchedule,
  releaseCronLease,
  renewCronLease,
} from './cron-service';

const pathSchema = z
  .object({
    projectId: portableProjectIdSchema,
    scheduleId: portableScheduleIdSchema.optional(),
  })
  .strict();

export function buildCronRouter(deps: { db: Db; now?: () => number }): Router {
  const router = Router();
  const limiter = rateLimit({ windowMs: 60_000, max: 180 });
  const service = { db: deps.db, now: deps.now };

  router.get(
    '/cron/projects/:projectId/schedules',
    limiter,
    requireAuth(deps.db),
    ah(async (req, res) => {
      const path = pathSchema.safeParse(req.params);
      if (!path.success) {
        return res.status(400).json({ ok: false, error: 'invalid-project' });
      }
      const schedules = await listCronSchedules(
        service,
        req.accountId!,
        path.data.projectId,
      );
      res.json({ ok: true, data: schedules });
    }),
  );

  router.put(
    '/cron/projects/:projectId/schedules/:scheduleId',
    limiter,
    requireAuth(deps.db),
    ah(async (req, res) => {
      const path = pathSchema.safeParse(req.params);
      const body = publishScheduleSchema.safeParse(req.body);
      if (!path.success || !path.data.scheduleId || !body.success) {
        return res.status(400).json({ ok: false, error: 'invalid-schedule' });
      }
      const result = await publishCronSchedule(service, {
        accountId: req.accountId!,
        projectId: path.data.projectId,
        scheduleId: path.data.scheduleId,
        expectedVersion: body.data.expectedVersion,
        definition: body.data.definition,
      });
      if (!result.ok) {
        return res.status(409).json({
          ok: false,
          error: 'version-conflict',
          conflict: {
            expectedVersion: result.expectedVersion,
            actualVersion: result.actualVersion,
            current: result.current,
          },
        });
      }
      res.status(result.created ? 201 : 200).json({
        ok: true,
        data: result.schedule,
      });
    }),
  );

  router.post(
    '/cron/leases/acquire',
    limiter,
    requireAuth(deps.db),
    ah(async (req, res) => {
      const body = leaseRequestSchema.safeParse(req.body);
      if (!body.success) {
        return res.status(400).json({ ok: false, error: 'invalid-lease' });
      }
      const result = await acquireCronLease(service, req.accountId!, body.data);
      res.status(result.acquired ? 200 : 409).json({ ok: result.acquired, data: result });
    }),
  );

  router.post(
    '/cron/leases/renew',
    limiter,
    requireAuth(deps.db),
    ah(async (req, res) => {
      const body = leaseTokenRequestSchema.safeParse(req.body);
      if (!body.success) {
        return res.status(400).json({ ok: false, error: 'invalid-lease' });
      }
      const result = await renewCronLease(service, req.accountId!, body.data);
      res.status(result.acquired ? 200 : 409).json({ ok: result.acquired, data: result });
    }),
  );

  router.post(
    '/cron/leases/release',
    limiter,
    requireAuth(deps.db),
    ah(async (req, res) => {
      const body = leaseTokenRequestSchema.safeParse(req.body);
      if (!body.success) {
        return res.status(400).json({ ok: false, error: 'invalid-lease' });
      }
      const released = await releaseCronLease(service, req.accountId!, body.data);
      res.status(released ? 200 : 409).json({
        ok: released,
        data: { released },
      });
    }),
  );

  return router;
}
