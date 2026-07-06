import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { generateKeyPair, exportPKCS8, exportSPKI } from 'jose';
import * as schema from '../db/schema';
import { CREATE_TABLES_SQL } from '../db/schema';
import type { Db } from '../db/client';
import type { Env } from '../env';
import { issueTokens } from '../auth/session-service';
import { errorHandler } from '../middleware/errors';
import { makeFakeStripe } from './stripe-like';
import { buildBillingRouter } from './billing-routes';

/** Setup de teste do billing: banco pglite + env fake + app com o router. */
export async function setup(fake = makeFakeStripe()) {
  const client = new PGlite();
  await client.exec(CREATE_TABLES_SQL);
  const db = drizzle(client, { schema }) as unknown as Db;
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const env = {
    LICENSE_PRIVATE_KEY: await exportPKCS8(privateKey),
    LICENSE_PUBLIC_KEY: await exportSPKI(publicKey),
    GITHUB_OAUTH_ID: 'g', GITHUB_OAUTH_SECRET: 'g', GOOGLE_OAUTH_ID: 'g', GOOGLE_OAUTH_SECRET: 'g',
    PUBLIC_BASE_URL: 'https://api.test', APP_DEEP_LINK_BASE: 'nexus://auth',
    DATABASE_URL: 'x', PORT: 8080,
    STRIPE_SECRET_KEY: 'sk', STRIPE_WEBHOOK_SECRET: 'whsec',
    STRIPE_PRICE_PRO: 'price_pro', STRIPE_PRICE_TEAM: 'price_team',
    PUBLIC_SITE_URL: 'https://nexuside.app',
  } as Env;
  const app = express();
  app.use(express.json());
  app.use('/v1', buildBillingRouter({ db, env, stripe: fake.stripe }));
  app.use(errorHandler);
  const [acc] = await db.insert(schema.accounts).values({ email: 'u@x.com' })
    .returning({ id: schema.accounts.id });
  const { session } = await issueTokens(db, acc.id);
  return { app, db, env, fake, accountId: acc.id, bearer: `Bearer ${session}` };
}
