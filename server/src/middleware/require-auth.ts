import type { RequestHandler } from 'express';
import type { Db } from '../db/client';
import { sessionAccount } from '../auth/session-service';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      accountId?: string;
    }
  }
}

export function requireAuth(db: Db): RequestHandler {
  return async (req, res, next) => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
    const accountId = token ? await sessionAccount(db, token) : null;
    if (!accountId) {
      res.status(401).json({ ok: false, error: 'não autenticado' });
      return;
    }
    req.accountId = accountId;
    next();
  };
}
