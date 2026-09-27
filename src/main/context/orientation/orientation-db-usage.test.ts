import { describe, expect, it } from 'vitest';
import {
  extractSqlDbUsageEdges,
  extractTsDbUsageEdges,
} from './orientation-db-usage';

describe('orientation-db-usage: TS/JS extractor', () => {
  it('detects supabase.from(...).select as a read of that table', () => {
    const edges = extractTsDbUsageEdges(
      'src/comanda/close-commanda.ts',
      `const { data } = await supabase.from('appointments').select('*');`,
    );
    expect(edges).toEqual([
      expect.objectContaining({
        toKind: 'table',
        toQualifiedName: 'public.appointments',
        relation: 'reads',
      }),
    ]);
  });

  it('detects supabase.from(...).insert/update/upsert/delete as writes', () => {
    const edges = extractTsDbUsageEdges(
      'src/comanda/close-commanda.ts',
      `await supabaseAdmin.from('commission_entries').insert({ amount: 10 });`,
    );
    expect(edges).toEqual([
      expect.objectContaining({
        toKind: 'table',
        toQualifiedName: 'public.commission_entries',
        relation: 'writes',
      }),
    ]);
  });

  it('detects supabase.rpc(...) as a call to a function', () => {
    const edges = extractTsDbUsageEdges(
      'src/comanda/close-commanda.ts',
      `await supabase.rpc('close_commanda_internal', { p_id: id });`,
    );
    expect(edges).toEqual([
      expect.objectContaining({
        toKind: 'function',
        toQualifiedName: 'public.close_commanda_internal',
        relation: 'calls',
      }),
    ]);
  });

  it('classifies prisma.<model>.<verb> calls as reads or writes', () => {
    const edges = extractTsDbUsageEdges(
      'src/commission/service.ts',
      `
        const rows = await prisma.commission.findMany({ where: { active: true } });
        await prisma.commission.update({ where: { id }, data: { amount } });
      `,
    );
    expect(edges).toEqual([
      expect.objectContaining({ toQualifiedName: 'public.commission', relation: 'reads' }),
      expect.objectContaining({ toQualifiedName: 'public.commission', relation: 'writes' }),
    ]);
  });

  it('detects raw SQL table references inside template literals only', () => {
    const edges = extractTsDbUsageEdges(
      'src/reports/report-bundle.ts',
      "const rows = await db.query(`SELECT * FROM commission_entries WHERE tenant_id = ${tenantId}`);\n" +
        "const label = 'not a query but has the word from in it';\n",
    );
    expect(edges).toEqual([
      expect.objectContaining({ toQualifiedName: 'public.commission_entries', relation: 'reads' }),
    ]);
  });
});

describe('orientation-db-usage: SQL body extractor', () => {
  const migration = `
    CREATE OR REPLACE FUNCTION public.close_commanda_internal(p_id uuid)
    RETURNS void
    LANGUAGE plpgsql
    AS $$
    BEGIN
      UPDATE public.appointments SET status = 'closed' WHERE id = p_id;
      INSERT INTO commission_entries (id, amount) VALUES (p_id, 10);
    END;
    $$;

    CREATE TRIGGER trg_close_commanda
    AFTER UPDATE ON public.appointments
    FOR EACH ROW
    EXECUTE FUNCTION public.close_commanda_internal();
  `;

  it('extracts function-body table reads/writes as edges from the function node', () => {
    const edges = extractSqlDbUsageEdges('supabase/migrations/x.sql', migration);
    expect(edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'db:function:public.close_commanda_internal',
          toQualifiedName: 'public.appointments',
          relation: 'writes',
        }),
        expect.objectContaining({
          from: 'db:function:public.close_commanda_internal',
          toQualifiedName: 'public.commission_entries',
          relation: 'writes',
        }),
      ]),
    );
  });

  it('extracts a trigger-on-table calls-function edge', () => {
    const edges = extractSqlDbUsageEdges('supabase/migrations/x.sql', migration);
    expect(edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'db:table:public.appointments',
          toKind: 'function',
          toQualifiedName: 'public.close_commanda_internal',
          relation: 'calls',
        }),
      ]),
    );
  });
});
