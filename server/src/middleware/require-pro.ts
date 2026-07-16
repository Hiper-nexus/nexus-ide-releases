import type { RequestHandler } from 'express';
import { entitlementFor } from '../billing/entitlement';
import type { Db } from '../db/client';
import { asyncHandler } from './errors';

/** Protege recursos de nuvem sem afetar o núcleo local do plano Free. */
export function requirePro(
  db: Db,
  now: () => number = Date.now,
): RequestHandler {
  return asyncHandler(async (req, res, next) => {
    if (!req.accountId) {
      res.status(401).json({ ok: false, error: 'não autenticado' });
      return;
    }
    const entitlement = await entitlementFor(db, req.accountId, now);
    if (entitlement.input.plan === 'free') {
      res.status(403).json({
        ok: false,
        error: 'pro-required',
        message: 'A sincronização em nuvem faz parte do plano Pro.',
      });
      return;
    }
    next();
  });
}
