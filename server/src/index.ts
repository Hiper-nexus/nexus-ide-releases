import express, { type Express } from 'express';
import type { AuthDeps } from './auth/auth-routes';
import { buildAuthRouter } from './auth/auth-routes';
import type { StripeLike } from './billing/stripe-like';
import { buildBillingRouter } from './billing/billing-routes';
import { errorHandler } from './middleware/errors';

/** Deps de auth + Stripe opcional (billing só monta quando presente). */
export type AppDeps = AuthDeps & { stripe?: StripeLike };

/** Monta o app Express. Passe deps p/ montar as rotas /v1/auth e /v1/billing. */
export function createApp(deps?: AppDeps): Express {
  const app = express();
  // Um proxy/LB na frente (deploy padrão): sem isso o rate-limit veria o IP
  // do proxy para TODOS os usuários (bucket único = DoS global). Ajuste se a
  // topologia tiver mais saltos.
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '256kb' }));
  app.get('/health', (_req, res) => res.json({ ok: true }));
  if (deps) app.use('/v1', buildAuthRouter(deps));
  if (deps?.stripe) {
    app.use('/v1', buildBillingRouter({ db: deps.db, env: deps.env, stripe: deps.stripe }));
  }
  app.use(errorHandler); // rejeição async → 500 JSON (nunca request pendurada)
  return app;
}

// Boot real só quando executado direto (não em teste/import).
if (process.argv[1] && process.argv[1].endsWith('index.js')) {
  const { parseEnv } = await import('./env');
  const { makeDb } = await import('./db/client');
  const { cleanupExpired } = await import('./db/maintenance');
  const env = parseEnv(process.env);
  const { db } = makeDb(env.DATABASE_URL);
  // Stripe real só aqui no boot — nunca instanciado dentro de service/rota.
  const Stripe = (await import('stripe')).default;
  const stripe = new Stripe(env.STRIPE_SECRET_KEY) as unknown as StripeLike;
  const app = createApp({ db, env, fetchFn: fetch, stripe });
  // Reaper de linhas efêmeras expiradas (states/codes/sessões/refresh).
  const REAP_EVERY_MS = 15 * 60 * 1000;
  const reap = () =>
    cleanupExpired(db).catch((err) => console.error('[server] reaper:', err));
  void reap();
  setInterval(reap, REAP_EVERY_MS).unref();
  app.listen(env.PORT, () => console.log(`[server] :${env.PORT}`));
}
