import type { Server } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import express, { type Express } from 'express';
import type { AuthDeps } from './auth/auth-routes';
import { buildAuthRouter } from './auth/auth-routes';
import type { StripeLike } from './billing/stripe-like';
import { buildBillingRouter } from './billing/billing-routes';
import { buildWebhookRouter } from './billing/webhook-routes';
import { buildLicenseRouter } from './billing/license-routes';
import { buildTeamRouter } from './team/team-routes';
import { buildWebPages } from './web/pages';
import { errorHandler } from './middleware/errors';
import { rateLimit } from './middleware/rate-limit';
import { buildCronRouter } from './cron/cron-routes';
import { buildSyncRouter } from './sync/sync-routes';
import { parseEnv } from './env';
import {
  databasePoolTimeoutsFrom,
  type DatabasePoolTimeouts,
  type Db,
} from './db/client';
import {
  assertReadinessWithin,
  assertDatabaseReady,
  registerHealthRoutes,
  runWithDeadline,
  type DatabaseReadinessClient,
  type ReadinessProbe,
} from './health';

/** Deps de auth + Stripe opcional (billing só monta quando presente). */
export type AppDeps = AuthDeps & { stripe?: StripeLike };

export interface AppOptions {
  readonly readinessProbe?: ReadinessProbe;
  readonly readinessTimeoutMs?: number;
}

interface ServerDatabasePool extends DatabaseReadinessClient {
  end(): Promise<void>;
}

export interface ServerBootDependencies {
  readonly connectDatabase: (
    connectionString: string,
    timeouts: DatabasePoolTimeouts,
  ) => {
    readonly db: Db;
    readonly pool: ServerDatabasePool;
  };
  readonly createStripe: (secretKey: string) => StripeLike;
  readonly cleanupExpired: (db: Db) => Promise<unknown>;
  readonly assertReady: (database: DatabaseReadinessClient) => Promise<void>;
  readonly listen: (app: Express, port: number) => Promise<Server>;
  readonly scheduleReaper: (reap: () => Promise<void>) => void;
}

/** Monta o app Express. Passe deps p/ montar as rotas /v1/auth e /v1/billing. */
export function createApp(deps?: AppDeps, options: AppOptions = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  // Um proxy/LB na frente (deploy padrão): sem isso o rate-limit veria o IP
  // do proxy para TODOS os usuários (bucket único = DoS global). Ajuste se a
  // topologia tiver mais saltos.
  app.set('trust proxy', 1);
  // Teto global generoso por IP (rotas sensíveis têm limiters próprios, mais
  // apertados). O webhook do Stripe fica FORA: retries legítimos chegam em
  // rajada e a rota já se protege por assinatura + idempotência.
  const globalLimiter = rateLimit({ windowMs: 60_000, max: 300 });
  app.use((req, res, next) => {
    if (req.path.startsWith('/v1/billing/webhook')) return next();
    globalLimiter(req, res, next);
  });
  if (deps?.stripe) {
    app.use('/v1/billing/webhook', express.raw({ type: '*/*', limit: '256kb' }));
  }
  app.use(express.json({ limit: '256kb' }));
  registerHealthRoutes(
    app,
    options.readinessProbe,
    options.readinessTimeoutMs,
  );
  if (deps) {
    app.use('/v1', buildAuthRouter(deps));
    app.use('/v1', buildLicenseRouter({ db: deps.db, env: deps.env, now: deps.now }));
    app.use('/v1', buildTeamRouter({ db: deps.db, env: deps.env, now: deps.now }));
    app.use('/v1', buildCronRouter({ db: deps.db, now: deps.now }));
    app.use('/v1', buildSyncRouter({ db: deps.db, now: deps.now }));
  }
  if (deps?.stripe) {
    app.use('/v1', buildBillingRouter({ db: deps.db, env: deps.env, stripe: deps.stripe }));
    app.use('/v1', buildWebhookRouter({ db: deps.db, env: deps.env, stripe: deps.stripe }));
  }
  app.use(buildWebPages());
  app.use(errorHandler); // rejeição async → 500 JSON (nunca request pendurada)
  return app;
}

export function isMainModule(moduleUrl: string, argvPath?: string): boolean {
  if (!argvPath) return false;
  return moduleUrl === pathToFileURL(resolve(argvPath)).href;
}

export function sanitizeRuntimeEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  const { GITHUB_PERSONAL_ACCESS_TOKEN: _removed, ...sanitized } = environment;
  return { ...sanitized };
}

export async function startServer(
  rawEnvironment: Readonly<Record<string, string | undefined>>,
  dependencies: ServerBootDependencies,
): Promise<Server> {
  const env = parseEnv(sanitizeRuntimeEnvironment(rawEnvironment));
  const { db, pool } = dependencies.connectDatabase(
    env.DATABASE_URL,
    databasePoolTimeoutsFrom(env),
  );
  const readinessProbe = () => dependencies.assertReady(pool);
  let server: Server | undefined;

  try {
    await assertReadinessWithin(
      readinessProbe,
      env.DATABASE_READINESS_TIMEOUT_MS,
    );
    const stripe = dependencies.createStripe(env.STRIPE_SECRET_KEY);
    const app = createApp(
      { db, env, fetchFn: fetch, stripe },
      {
        readinessProbe,
        readinessTimeoutMs: env.DATABASE_READINESS_TIMEOUT_MS,
      },
    );
    server = await dependencies.listen(app, env.PORT);
    const reap = async (): Promise<void> => {
      try {
        await dependencies.cleanupExpired(db);
      } catch {
        console.error('[server] maintenance failed');
      }
    };
    dependencies.scheduleReaper(reap);
    return server;
  } catch (error) {
    if (server) {
      await runWithDeadline(
        'server shutdown',
        env.SERVER_CLEANUP_TIMEOUT_MS,
        () => new Promise<void>((fulfill) => {
          server?.close(() => fulfill());
        }),
      ).catch(() => undefined);
    }
    await runWithDeadline(
      'database shutdown',
      env.SERVER_CLEANUP_TIMEOUT_MS,
      () => pool.end(),
    ).catch(() => undefined);
    throw error;
  }
}

const REAP_EVERY_MS = 15 * 60 * 1000;

async function loadProductionDependencies(): Promise<ServerBootDependencies> {
  const [{ makeDb }, { cleanupExpired }, stripeModule] = await Promise.all([
    import('./db/client'),
    import('./db/maintenance'),
    import('stripe'),
  ]);
  return {
    connectDatabase: (connectionString, timeouts) => {
      const connection = makeDb(connectionString, timeouts);
      return {
        db: connection.db,
        pool: connection.pool as unknown as ServerDatabasePool,
      };
    },
    createStripe: (secretKey) =>
      new stripeModule.default(secretKey) as unknown as StripeLike,
    cleanupExpired,
    assertReady: assertDatabaseReady,
    listen: (app, port) => new Promise((fulfill, reject) => {
      const server = app.listen(port);
      const onError = (error: Error): void => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off('error', onError);
        fulfill(server);
      };
      server.once('error', onError);
      server.once('listening', onListening);
    }),
    scheduleReaper: (reap) => {
      void reap();
      setInterval(() => void reap(), REAP_EVERY_MS).unref();
    },
  };
}

async function runProductionServer(): Promise<void> {
  const runtimeEnvironment = sanitizeRuntimeEnvironment(process.env);
  delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  const dependencies = await loadProductionDependencies();
  const server = await startServer(runtimeEnvironment, dependencies);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 'unknown';
  console.log(`[server] :${port}`);
}

// Works for `tsx src/index.ts` and for `node dist/index.js`.
if (isMainModule(import.meta.url, process.argv[1])) {
  try {
    await runProductionServer();
  } catch {
    console.error('[server] startup failed: verify environment, database, and migrations');
    process.exitCode = 1;
  }
}
