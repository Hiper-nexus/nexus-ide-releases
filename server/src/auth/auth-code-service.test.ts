import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../db/schema';
import { CREATE_TABLES_SQL } from '../db/schema';
import type { Db } from '../db/client';
import { hashToken } from './tokens';
import { consumeAuthCode } from './auth-code-service';

async function makeTestDb(): Promise<Db> {
  const client = new PGlite();
  await client.exec(CREATE_TABLES_SQL);
  return drizzle(client, { schema }) as unknown as Db;
}

async function seed(db: Db, code: string, expiresAt: Date): Promise<string> {
  const [a] = await db
    .insert(schema.accounts)
    .values({ email: 'x@y.com' })
    .returning({ id: schema.accounts.id });
  await db.insert(schema.authCodes).values({
    codeHash: hashToken(code),
    accountId: a.id,
    expiresAt,
  });
  return a.id;
}

describe('consumeAuthCode', () => {
  it('code válido consome uma vez e retorna a conta', async () => {
    const db = await makeTestDb();
    const acc = await seed(db, 'c1', new Date(Date.now() + 60_000));
    expect(await consumeAuthCode(db, 'c1')).toEqual({ accountId: acc });
    expect(await consumeAuthCode(db, 'c1')).toBeNull(); // single-use
  });

  it('expirado ou inexistente → null', async () => {
    const db = await makeTestDb();
    await seed(db, 'velho', new Date(Date.now() - 1000));
    expect(await consumeAuthCode(db, 'velho')).toBeNull();
    expect(await consumeAuthCode(db, 'nunca-existiu')).toBeNull();
  });

  it('consumo concorrente: exatamente um vence (anti-TOCTOU)', async () => {
    const db = await makeTestDb();
    await seed(db, 'corrida', new Date(Date.now() + 60_000));
    const results = await Promise.all([
      consumeAuthCode(db, 'corrida'),
      consumeAuthCode(db, 'corrida'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
