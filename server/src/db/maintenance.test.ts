import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from './schema';
import { CREATE_TABLES_SQL } from './schema';
import type { Db } from './client';
import { cleanupExpired } from './maintenance';

async function makeTestDb(): Promise<Db> {
  const client = new PGlite();
  await client.exec(CREATE_TABLES_SQL);
  return drizzle(client, { schema }) as unknown as Db;
}

describe('cleanupExpired', () => {
  it('remove states/codes/sessões/refresh expirados e preserva os vivos', async () => {
    const db = await makeTestDb();
    const [a] = await db
      .insert(schema.accounts)
      .values({ email: 'x@y.com' })
      .returning({ id: schema.accounts.id });
    const past = new Date(Date.now() - 1000);
    const future = new Date(Date.now() + 60_000);
    await db.insert(schema.oauthStates).values([
      { state: 'morto', provider: 'github', codeVerifier: 'v', appState: 'n', expiresAt: past },
      { state: 'vivo', provider: 'github', codeVerifier: 'v', appState: 'n', expiresAt: future },
    ]);
    await db.insert(schema.authCodes).values([
      { codeHash: 'h-morto', accountId: a.id, expiresAt: past },
      { codeHash: 'h-vivo', accountId: a.id, expiresAt: future },
    ]);
    await db.insert(schema.sessions).values([
      { accountId: a.id, tokenHash: 's-morto', expiresAt: past },
      { accountId: a.id, tokenHash: 's-vivo', expiresAt: future },
    ]);
    await db.insert(schema.refreshTokens).values([
      { accountId: a.id, tokenHash: 'r-morto', expiresAt: past },
      { accountId: a.id, tokenHash: 'r-vivo', expiresAt: future },
    ]);

    await cleanupExpired(db);

    expect(await db.select().from(schema.oauthStates)).toHaveLength(1);
    expect(await db.select().from(schema.authCodes)).toHaveLength(1);
    expect(await db.select().from(schema.sessions)).toHaveLength(1);
    expect(await db.select().from(schema.refreshTokens)).toHaveLength(1);
  });
});
