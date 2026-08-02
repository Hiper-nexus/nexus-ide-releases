import { describe, expect, it, onTestFinished } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../db/schema';
import { CREATE_TABLES_SQL } from '../db/schema';
import type { Db } from '../db/client';
import {
  issueTokens,
  rotateRefresh,
  sessionAccount,
} from './session-service';

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
async function anAccount(db: Db): Promise<string> {
  const [a] = await db
    .insert(schema.accounts)
    .values({ email: 'x@y.com' })
    .returning({ id: schema.accounts.id });
  return a.id;
}

describe('session-service', () => {
  it('emite session+refresh e a session autentica a conta', async () => {
    const db = await makeTestDb();
    const acc = await anAccount(db);
    const { session, refresh } = await issueTokens(db, acc);
    expect(session).not.toBe(refresh);
    expect(await sessionAccount(db, session)).toBe(acc);
    expect(await sessionAccount(db, 'invalido')).toBeNull();
  });

  it('rotação feliz: refresh novo funciona, o antigo não', async () => {
    const db = await makeTestDb();
    const acc = await anAccount(db);
    const first = await issueTokens(db, acc);
    const rotated = await rotateRefresh(db, first.refresh);
    expect('refresh' in rotated).toBe(true);
    if (!('refresh' in rotated)) throw new Error('esperava rotação');
    const reuse = await rotateRefresh(db, first.refresh);
    expect('reuseDetected' in reuse).toBe(true);
  });

  it('reuso revoga a cadeia: o refresh novo também morre', async () => {
    const db = await makeTestDb();
    const acc = await anAccount(db);
    const first = await issueTokens(db, acc);
    const rotated = await rotateRefresh(db, first.refresh);
    if (!('refresh' in rotated)) throw new Error('esperava rotação');
    await rotateRefresh(db, first.refresh); // dispara reuso → revoga tudo
    const afterRevoke = await rotateRefresh(db, rotated.refresh);
    expect('reuseDetected' in afterRevoke).toBe(true);
  });

  it('refresh inexistente = reuseDetected (trata como comprometido)', async () => {
    const db = await makeTestDb();
    const r = await rotateRefresh(db, 'nunca-existiu');
    expect('reuseDetected' in r).toBe(true);
  });

  it('rotação concorrente: só UMA das duas vence (consumo atômico)', async () => {
    const db = await makeTestDb();
    const acc = await anAccount(db);
    const first = await issueTokens(db, acc);
    // Duas rotações simultâneas do MESMO refresh — o TOCTOU clássico. O
    // consumo atômico garante exatamente 1 sucesso; a perdedora cai no
    // caminho de reuso (que revoga a cadeia — fail closed).
    const [a, b] = await Promise.all([
      rotateRefresh(db, first.refresh),
      rotateRefresh(db, first.refresh),
    ]);
    const wins = [a, b].filter((r) => 'refresh' in r).length;
    const reuses = [a, b].filter((r) => 'reuseDetected' in r).length;
    expect(wins).toBe(1);
    expect(reuses).toBe(1);
  });
});
