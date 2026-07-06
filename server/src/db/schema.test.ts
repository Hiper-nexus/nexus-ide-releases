import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import * as schema from './schema';
import { CREATE_TABLES_SQL } from './schema';

describe('schema', () => {
  it('cria as tabelas e insere uma account', async () => {
    const client = new PGlite();
    const db = drizzle(client, { schema });
    await client.exec(CREATE_TABLES_SQL); // DDL literal p/ teste (migrations reais no deploy)
    await db.insert(schema.accounts).values({
      email: 'a@b.com',
      plan: 'free',
    });
    const rows = await db.select().from(schema.accounts);
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe('a@b.com');
    expect(rows[0].plan).toBe('free');
    // enum válido
    await expect(
      db.execute(sql`INSERT INTO accounts (email, plan) VALUES ('c@d.com','invalido')`),
    ).rejects.toBeTruthy();
  });
});
