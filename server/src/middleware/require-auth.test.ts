import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/client';
import { sessionAccount } from '../auth/session-service';
import { errorHandler } from './errors';
import { requireAuth } from './require-auth';

vi.mock('../auth/session-service', () => ({
  sessionAccount: vi.fn(),
}));

const mockedSessionAccount = vi.mocked(sessionAccount);

function protectedApp() {
  const app = express();
  app.get('/protected', requireAuth({} as Db), (req, res) => {
    res.json({ ok: true, accountId: req.accountId });
  });
  app.use(errorHandler);
  return app;
}

describe('requireAuth', () => {
  beforeEach(() => {
    mockedSessionAccount.mockReset();
  });

  it('forwards session lookup rejection to the Express 4 error handler', async () => {
    mockedSessionAccount.mockRejectedValue(new Error('database unavailable'));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const response = await request(protectedApp())
        .get('/protected')
        .set('authorization', 'Bearer opaque-session')
        .timeout({ response: 500, deadline: 1_000 });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ ok: false, error: 'erro interno' });
      expect(errorLog).toHaveBeenCalledOnce();
    } finally {
      errorLog.mockRestore();
    }
  });

  it('preserves unauthenticated and authenticated behavior', async () => {
    const missing = await request(protectedApp()).get('/protected');
    expect(missing.status).toBe(401);
    expect(mockedSessionAccount).not.toHaveBeenCalled();

    mockedSessionAccount.mockResolvedValue('account-1');
    const authenticated = await request(protectedApp())
      .get('/protected')
      .set('authorization', 'Bearer opaque-session');

    expect(authenticated.status).toBe(200);
    expect(authenticated.body).toEqual({ ok: true, accountId: 'account-1' });
  });
});
