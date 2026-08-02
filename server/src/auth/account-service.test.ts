import { describe, expect, it, onTestFinished } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { CREATE_TABLES_SQL } from '../db/schema';
import type { Db } from '../db/client';
import type { OAuthProfile } from './oauth-providers';
import { findOrCreateAccount } from './account-service';

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

function prof(over: Partial<OAuthProfile> = {}): OAuthProfile {
  return {
    provider: 'github',
    providerUserId: 'gh-1',
    email: 'a@b.com',
    emailVerified: true,
    name: 'A',
    avatar: null,
    ...over,
  };
}

describe('findOrCreateAccount (matriz de merge)', () => {
  it('conta nova quando não há identity nem email casando', async () => {
    const db = await makeTestDb();
    const r = await findOrCreateAccount(db, prof());
    expect(r.merged).toBe(false);
    const accs = await db.select().from(schema.accounts);
    expect(accs).toHaveLength(1);
  });

  it('identity existente reusa a mesma conta', async () => {
    const db = await makeTestDb();
    const first = await findOrCreateAccount(db, prof());
    const again = await findOrCreateAccount(db, prof());
    expect(again.accountId).toBe(first.accountId);
    expect(again.merged).toBe(false);
  });

  it('MERGE: 2º provider com email verificado que casa vira a mesma conta', async () => {
    const db = await makeTestDb();
    const gh = await findOrCreateAccount(db, prof());
    const google = await findOrCreateAccount(
      db,
      prof({ provider: 'google', providerUserId: 'g-9', email: 'a@b.com', emailVerified: true }),
    );
    expect(google.accountId).toBe(gh.accountId);
    expect(google.merged).toBe(true);
    const ids = await db
      .select()
      .from(schema.identities)
      .where(eq(schema.identities.accountId, gh.accountId));
    expect(ids).toHaveLength(2);
  });

  it('NÃO faz merge quando o email do 2º não é verificado', async () => {
    const db = await makeTestDb();
    const gh = await findOrCreateAccount(db, prof());
    const google = await findOrCreateAccount(
      db,
      prof({ provider: 'google', providerUserId: 'g-9', email: 'a@b.com', emailVerified: false }),
    );
    expect(google.accountId).not.toBe(gh.accountId);
    expect(google.merged).toBe(false);
  });

  it('NÃO faz merge quando a conta existente tem email não verificado', async () => {
    const db = await makeTestDb();
    const first = await findOrCreateAccount(db, prof({ emailVerified: false }));
    const second = await findOrCreateAccount(
      db,
      prof({ provider: 'google', providerUserId: 'g-2', emailVerified: true }),
    );
    expect(second.accountId).not.toBe(first.accountId);
  });

  it('email verificado colidindo com conta NÃO-mesclável não quebra o login', async () => {
    const db = await makeTestDb();
    // Estado adversarial: conta segurando o email a@b.com SEM nenhuma
    // identity verificada (não-mesclável pela matriz anti-takeover).
    const [acc] = await db
      .insert(schema.accounts)
      .values({ email: 'a@b.com' })
      .returning({ id: schema.accounts.id });
    await db.insert(schema.identities).values({
      accountId: acc.id,
      provider: 'google',
      providerUserId: 'g-zumbi',
      email: 'a@b.com',
      emailVerified: false,
    });
    // Login verificado com o mesmo email: não pode 500 (violação de UNIQUE)
    // nem tomar a conta — cria conta isolada com email sintético.
    const r = await findOrCreateAccount(db, prof());
    expect(r.merged).toBe(false);
    expect(r.accountId).not.toBe(acc.id);
    const [created] = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, r.accountId));
    expect(created.email).toBe('github:gh-1');
  });

  it('primeiro login concorrente do MESMO subject não duplica conta', async () => {
    const db = await makeTestDb();
    // Dois callbacks simultâneos do mesmo usuário OAuth: a UNIQUE(provider,
    // provider_user_id) derruba o perdedor, que precisa re-resolver e
    // devolver a MESMA conta — nunca 500, nunca duplicata.
    const [a, b] = await Promise.all([
      findOrCreateAccount(db, prof()),
      findOrCreateAccount(db, prof()),
    ]);
    expect(a.accountId).toBe(b.accountId);
    expect(await db.select().from(schema.accounts)).toHaveLength(1);
    expect(await db.select().from(schema.identities)).toHaveLength(1);
  });
});
