import { z } from 'zod';
import { DEFAULT_DATABASE_POOL_TIMEOUTS } from './db/client';
import {
  DEFAULT_DATABASE_READINESS_TIMEOUT_MS,
  DEFAULT_SERVER_CLEANUP_TIMEOUT_MS,
} from './health';

const MIN_DATABASE_TIMEOUT_MS = 100;
const MAX_DATABASE_TIMEOUT_MS = 60_000;

function databaseTimeout(defaultValue: number) {
  return z.coerce
    .number()
    .int()
    .min(MIN_DATABASE_TIMEOUT_MS)
    .max(MAX_DATABASE_TIMEOUT_MS)
    .default(defaultValue);
}

/**
 * Env validado no boot — falta de qualquer segredo derruba o processo cedo,
 * com mensagem clara, em vez de falhar no primeiro request.
 */
const schema = z.object({
  DATABASE_URL: z.string().min(1),
  DATABASE_CONNECTION_TIMEOUT_MS: databaseTimeout(
    DEFAULT_DATABASE_POOL_TIMEOUTS.connectionTimeoutMs,
  ),
  DATABASE_QUERY_TIMEOUT_MS: databaseTimeout(
    DEFAULT_DATABASE_POOL_TIMEOUTS.queryTimeoutMs,
  ),
  DATABASE_STATEMENT_TIMEOUT_MS: databaseTimeout(
    DEFAULT_DATABASE_POOL_TIMEOUTS.statementTimeoutMs,
  ),
  DATABASE_READINESS_TIMEOUT_MS: databaseTimeout(
    DEFAULT_DATABASE_READINESS_TIMEOUT_MS,
  ),
  SERVER_CLEANUP_TIMEOUT_MS: databaseTimeout(
    DEFAULT_SERVER_CLEANUP_TIMEOUT_MS,
  ),
  LICENSE_PRIVATE_KEY: z.string().includes('PRIVATE KEY'),
  LICENSE_PUBLIC_KEY: z.string().includes('PUBLIC KEY'),
  GITHUB_OAUTH_ID: z.string().min(1),
  GITHUB_OAUTH_SECRET: z.string().min(1),
  GOOGLE_OAUTH_ID: z.string().min(1),
  GOOGLE_OAUTH_SECRET: z.string().min(1),
  PUBLIC_BASE_URL: z.string().url(),
  APP_DEEP_LINK_BASE: z.string().min(1),
  STRIPE_SECRET_KEY: z.string().min(1),
  STRIPE_WEBHOOK_SECRET: z.string().min(1),
  STRIPE_PRICE_PRO: z.string().min(1),
  STRIPE_PRICE_TEAM: z.string().min(1),
  PUBLIC_SITE_URL: z.string().url(),
  PORT: z.coerce.number().int().positive().default(8080),
});

export type Env = z.infer<typeof schema>;

export function parseEnv(raw: Record<string, string | undefined>): Env {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const missing = result.error.issues
      .map((i) => i.path.join('.'))
      .join(', ');
    throw new Error(`env inválido/faltando: ${missing}`);
  }
  return result.data;
}
