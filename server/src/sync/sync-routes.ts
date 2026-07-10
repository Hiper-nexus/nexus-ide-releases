import { Router } from 'express';
import { z } from 'zod';
import {
  SYNC_PORTABLE_ID_PATTERN,
  SyncContractQuotaError,
  SyncContractValidationError,
} from '../../../shared/sync-contract';
import type { Db } from '../db/client';
import { asyncHandler as ah } from '../middleware/errors';
import { rateLimit } from '../middleware/rate-limit';
import { requireAuth } from '../middleware/require-auth';
import {
  compareAndSwapSyncProject,
  readSyncProject,
  type SyncLimits,
} from './sync-service';

const pathSchema = z
  .object({
    projectId: z.string().min(1).max(128).regex(SYNC_PORTABLE_ID_PATTERN),
  })
  .strict();
const casBodySchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    entities: z.array(z.unknown()).max(1_000),
  })
  .strict();

function invalidSyncState(res: Parameters<Parameters<typeof ah>[0]>[1]) {
  return res.status(400).json({ ok: false, error: 'invalid-sync-state' });
}

export function buildSyncRouter(deps: {
  readonly db: Db;
  readonly now?: () => number;
  readonly limits?: SyncLimits;
}): Router {
  const router = Router();
  const limiter = rateLimit({ windowMs: 60_000, max: 120 });
  const service = { db: deps.db, now: deps.now, limits: deps.limits };
  router.use((_req, res, next) => {
    res.set('cache-control', 'no-store');
    next();
  });

  router.get(
    '/sync/projects/:projectId',
    limiter,
    requireAuth(deps.db),
    ah(async (req, res) => {
      const path = pathSchema.safeParse(req.params);
      if (!path.success) return invalidSyncState(res);
      const state = await readSyncProject(
        service,
        req.accountId!,
        path.data.projectId,
      );
      res.json({
        ok: true,
        data: {
          projectId: path.data.projectId,
          ...state,
          serverTime: (deps.now ?? Date.now)(),
        },
      });
    }),
  );

  router.put(
    '/sync/projects/:projectId',
    limiter,
    requireAuth(deps.db),
    ah(async (req, res) => {
      const path = pathSchema.safeParse(req.params);
      const body = casBodySchema.safeParse(req.body);
      if (!path.success || !body.success) return invalidSyncState(res);

      try {
        const result = await compareAndSwapSyncProject(service, {
          accountId: req.accountId!,
          projectId: path.data.projectId,
          expectedRevision: body.data.expectedRevision,
          entities: body.data.entities,
        });
        if (result.ok) {
          return res.json({
            ok: true,
            data: {
              revision: result.revision,
              serverTime: result.serverTime,
            },
          });
        }
        if (result.reason === 'projects-per-account') {
          return res.status(413).json({
            ok: false,
            error: 'quota-exceeded',
            quota: {
              name: result.reason,
              limit: result.limit,
              actual: result.actual,
            },
          });
        }
        return res.status(409).json({
          ok: false,
          error: result.reason,
          conflict: {
            expectedRevision: result.expectedRevision,
            actualRevision: result.actualRevision,
            conflictingEntityIds: result.conflictingEntityIds,
            serverTime: result.serverTime,
          },
        });
      } catch (error) {
        if (error instanceof SyncContractQuotaError) {
          return res.status(413).json({
            ok: false,
            error: 'quota-exceeded',
            quota: {
              name: error.quota,
              limit: error.limit,
              actual: error.actual,
            },
          });
        }
        if (error instanceof SyncContractValidationError) {
          return invalidSyncState(res);
        }
        throw error;
      }
    }),
  );

  return router;
}
