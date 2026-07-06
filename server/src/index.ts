import express, { type Express } from 'express';
import type { AuthDeps } from './auth/auth-routes';
import { buildAuthRouter } from './auth/auth-routes';

/** Monta o app Express. Passe deps p/ montar as rotas /v1/auth. */
export function createApp(deps?: AuthDeps): Express {
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.get('/health', (_req, res) => res.json({ ok: true }));
  if (deps) app.use('/v1', buildAuthRouter(deps));
  return app;
}

// Boot real só quando executado direto (não em teste/import).
if (process.argv[1] && process.argv[1].endsWith('index.js')) {
  const { parseEnv } = await import('./env');
  const { makeDb } = await import('./db/client');
  const env = parseEnv(process.env);
  const { db } = makeDb(env.DATABASE_URL);
  const app = createApp({ db, env, fetchFn: fetch });
  app.listen(env.PORT, () => console.log(`[server] :${env.PORT}`));
}
