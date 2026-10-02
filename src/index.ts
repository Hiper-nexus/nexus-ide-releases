import { Hono, type MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from './context.js';
import { authConfigured, billingConfigured, configFrom } from './config.js';
import { createAuthRoutes } from './auth.js';
import { createBillingRoutes, type StripeFactory } from './billing.js';
import { adminRoutes } from './admin.js';
import { teamRoutes } from './teams.js';
import { cronRoutes } from './cron.js';
import { syncRoutes } from './sync.js';
import { noticeRoutes } from './email/routes.js';
import { createNoticeAdminRoutes } from './email/admin-routes.js';
import { sendDueNotices } from './email/dispatch.js';
import { bugReportRoutes } from './bugs/routes.js';
import { createBugAdminRoutes } from './bugs/admin-routes.js';
import { PRO_MONTHLY_PRICE } from './stripe.js';

const WEBHOOK_PATH = '/v1/billing/webhook';
const REDEEM_PATH = '/v1/license/redeem';
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
};

export interface AppDeps { readonly fetchFn?: typeof fetch; readonly stripeFor?: StripeFactory; readonly now?: () => number }

export function createApp(deps: AppDeps = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ ok: false, error: error.message }, error.status);
    console.error('nexus-cloud-api: unhandled error:', error instanceof Error ? error.message : 'unknown');
    return c.json({ ok: false, error: 'Erro interno. Tente novamente.' }, 500);
  });
  app.notFound(c => c.json({ ok: false, error: 'Rota não encontrada.' }, 404));
  app.use('*', async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      // As páginas de resultado do login trazem o próprio CSP (só estilo inline); o resto da API mantém o global.
      if (name === 'content-security-policy' && c.res.headers.has(name)) continue;
      c.res.headers.set(name, value);
    }
  });
  app.get('/health', c => c.json({ ok: true }));
  const rateLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
    // Stripe retries arrive in bursts and are already protected by signature and idempotency.
    if (c.req.path !== WEBHOOK_PATH) {
      // O código de licença é a única barreira do resgate: teto próprio e mais baixo. Sem o binding (deploy antigo) cai no geral.
      const limiter = /^\/v1\/(web\/)?auth\//.test(c.req.path) ? c.env.AUTH_RATE_LIMITER
        : c.req.path === REDEEM_PATH ? (c.env.REDEEM_RATE_LIMITER ?? c.env.API_RATE_LIMITER)
        : c.env.API_RATE_LIMITER;
      const { success } = await limiter.limit({ key: c.req.header('CF-Connecting-IP') ?? 'unknown' });
      if (!success) throw new HTTPException(429, { message: 'Muitas tentativas. Aguarde um momento antes de continuar.' });
    }
    await next();
  };
  app.get('/ready', rateLimit, async (c) => {
    try {
      await c.env.DB.prepare("SELECT value FROM system_metadata WHERE key='schema_version'").first();
      return c.json({ ok: true });
    } catch { return c.json({ ok: false, error: 'Banco de dados indisponível.' }, 503); }
  });
  app.use('/v1/*', async (c, next) => { c.set('config', configFrom(c.env)); await next(); });
  // Only the product site may read credentialed responses; the desktop app sends no Origin.
  app.use('/v1/*', cors({
    origin: (origin, c) => origin === new URL(c.get('config').PUBLIC_SITE_URL).origin ? origin : null,
    credentials: true, allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'], allowHeaders: ['Content-Type', 'X-CSRF-Token'], maxAge: 600,
  }));
  app.use('/v1/*', rateLimit);
  app.get('/v1/public/status', (c) => {
    const config = c.get('config');
    c.header('Cache-Control', 'public, max-age=60');
    return c.json({ ok: true, data: {
      ready: config.MIGRATION_READY === 'true',
      auth: { google: authConfigured(config, 'google'), github: authConfigured(config, 'github') },
      billing: { available: billingConfigured(config), amount: PRO_MONTHLY_PRICE.unitAmount, currency: PRO_MONTHLY_PRICE.currency, interval: PRO_MONTHLY_PRICE.interval },
      trial: { days: config.TRIAL_DAYS, maxAgents: config.TRIAL_MAX_AGENTS, cloudSync: config.TRIAL_CLOUD_SYNC === 'true' },
    } });
  });
  // O envio de teste e o painel de relatos de bug vêm ANTES de adminRoutes: respondem sozinhos (com as próprias guardas) e não herdam nem duplicam o middleware de /admin/*.
  app.route('/v1', createAuthRoutes(deps.fetchFn)).route('/v1', createBillingRoutes(deps.stripeFor, deps.now)).route('/v1', createNoticeAdminRoutes(deps.fetchFn)).route('/v1', bugReportRoutes).route('/v1', createBugAdminRoutes()).route('/v1', adminRoutes)
    .route('/v1', teamRoutes).route('/v1', cronRoutes).route('/v1', syncRoutes).route('/v1', noticeRoutes);
  return app;
}

const LEASE_RETENTION_MS = 60 * 60 * 1000;
/** Removes login state, tokens and cron leases that can no longer be used. */
export async function cleanupExpired(db: D1Database, now = Date.now()): Promise<void> {
  await db.batch([
    ...['oauth_states', 'auth_codes', 'sessions', 'refresh_tokens'].map(table => db.prepare(`DELETE FROM ${table} WHERE expires_at<?`).bind(now)),
    // An expired lease can be re-acquired by any peer, so keeping it only grows the table.
    db.prepare('DELETE FROM cron_leases WHERE expires_at<?').bind(now - LEASE_RETENTION_MS),
  ]);
}

/** Cron horário: a limpeza vem primeiro; os avisos por e-mail depois, e uma falha deles nunca desfaz nem esconde a limpeza. */
export async function runScheduled(env: CloudflareBindings, deps: { readonly now?: number; readonly fetchFn?: typeof fetch } = {}): Promise<void> {
  await cleanupExpired(env.DB, deps.now);
  try {
    await sendDueNotices(env, { ...(deps.now === undefined ? {} : { now: deps.now }), ...(deps.fetchFn === undefined ? {} : { fetchFn: deps.fetchFn }) });
  } catch (error) {
    console.error('nexus-cloud-api: avisos por e-mail falharam:', error instanceof Error ? error.message : 'unknown');
  }
}

const app = createApp();
export default {
  fetch: app.fetch,
  scheduled(_controller, env, context) { context.waitUntil(runScheduled(env)); },
} satisfies ExportedHandler<CloudflareBindings>;
