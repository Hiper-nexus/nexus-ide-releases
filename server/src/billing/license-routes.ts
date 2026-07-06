import { Router } from 'express';
import type { Db } from '../db/client';
import type { Env } from '../env';
import { signLicense } from '../auth/license-signer';
import { asyncHandler as ah } from '../middleware/errors';
import { rateLimit } from '../middleware/rate-limit';
import { requireAuth } from '../middleware/require-auth';
import { entitlementFor } from './entitlement';

export function buildLicenseRouter(deps: { db: Db; env: Env; now?: () => number }): Router {
  const { db, env } = deps;
  const now = deps.now ?? Date.now;
  const r = Router();

  r.get('/license', rateLimit({ windowMs: 60_000, max: 60 }), requireAuth(db),
    ah(async (req, res) => {
      const { input, ttlSeconds } = await entitlementFor(db, req.accountId!, now);
      const licenca = await signLicense(
        input,
        env.LICENSE_PRIVATE_KEY,
        () => Math.floor(now() / 1000),
        ttlSeconds,
      );
      res.json({ ok: true, data: { licenca } });
    }));

  return r;
}
