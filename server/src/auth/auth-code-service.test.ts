import { describe, expect, it, onTestFinished } from 'vitest';
import crypto from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../db/schema';
import { CREATE_TABLES_SQL } from '../db/schema';
import type { Db } from '../db/client';
import { hashToken } from './tokens';
import { consumeAuthCode } from './auth-code-service';

async function makeTestDb(): Promise<Db> {
  const client = new PGlite();
  // PGlite sobe um PostgreSQL WASM por fixture. Sem fechar, cada teste do
  // arquivo deixa mais um runtime residente e a rodada inteira disputa
  // CPU/memória com os demais workers. Fechar ao fim do teste mantém
  // exatamente um vivo por vez.
  onTestFinished(async () => {
    await client.close();
  });
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

function challengeOf(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

async function seedWithChallenge(
  db: Db,
  code: string,
  challenge: string,
  expiresAt: Date,
): Promise<string> {
  const [a] = await db
    .insert(schema.accounts)
    .values({ email: 'pkce@y.com' })
    .returning({ id: schema.accounts.id });
  await db.insert(schema.authCodes).values({
    codeHash: hashToken(code),
    accountId: a.id,
    expiresAt,
    codeChallenge: challenge,
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

  it('PKCE fail-closed: code COM challenge não resgata sem verifier (anti-downgrade)', async () => {
    const db = await makeTestDb();
    const verifier = 'v'.repeat(43);
    const acc = await seedWithChallenge(
      db,
      'cpkce',
      challengeOf(verifier),
      new Date(Date.now() + 60_000),
    );
    // Omitir o verifier NÃO pode consumir um code emitido COM challenge —
    // esse é o downgrade trivial que o fail-closed bloqueia.
    expect(await consumeAuthCode(db, 'cpkce')).toBeNull();
    // Verifier errado também não casa.
    expect(await consumeAuthCode(db, 'cpkce', Date.now, 'w'.repeat(43))).toBeNull();
    // Verifier correto consome.
    expect(await consumeAuthCode(db, 'cpkce', Date.now, verifier)).toEqual({
      accountId: acc,
    });
  });

  it('PKCE: code SEM challenge resgata sem verifier (cliente legado em rolling deploy)', async () => {
    const db = await makeTestDb();
    const acc = await seed(db, 'clegacy', new Date(Date.now() + 60_000));
    expect(await consumeAuthCode(db, 'clegacy')).toEqual({ accountId: acc });
  });
});
