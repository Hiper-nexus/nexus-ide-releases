import { describe, expect, it } from 'vitest';
import { buildDbGraphFromFiles, type DbGraphInputFile } from './orientation-db-graph';
import { extractSchemaEntitiesFromSql } from './orientation-schema';
import { extractSqlDbUsageEdges, extractTsDbUsageEdges } from './orientation-db-usage';
import { DEFAULT_ORIENTATION_LIMITS } from './orientation-types';

const MIGRATION = `
  CREATE TABLE public.appointments (id uuid primary key);
  ALTER TABLE public.appointments ENABLE ROW LEVEL SECURITY;
  CREATE TABLE commission_entries (id uuid primary key, amount numeric);

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

const COMANDA_TS = `
  export async function closeCommanda(id: string) {
    await supabase.rpc('close_commanda_internal', { p_id: id });
  }
`;

function fileFor(relativePath: string, content: string, kind: 'sql' | 'ts'): DbGraphInputFile {
  if (kind === 'sql') {
    return {
      relativePath,
      schemaFacts: extractSchemaEntitiesFromSql(relativePath, content),
      usageEdges: extractSqlDbUsageEdges(relativePath, content),
    };
  }
  return {
    relativePath,
    schemaFacts: [],
    usageEdges: extractTsDbUsageEdges(relativePath, content),
  };
}

describe('orientation-db-graph: buildDbGraphFromFiles', () => {
  it('connects a comanda file to the commission table/test through table and function nodes', () => {
    const files = [
      fileFor('supabase/migrations/20260101000000_init.sql', MIGRATION, 'sql'),
      fileFor('src/comanda/close-commanda.ts', COMANDA_TS, 'ts'),
    ];
    const result = buildDbGraphFromFiles(files, DEFAULT_ORIENTATION_LIMITS);

    const appointmentsNode = 'db:table:public.appointments';
    const commissionNode = 'db:table:public.commission_entries';
    const functionNode = 'db:function:public.close_commanda_internal';

    // src -> function (rpc call)
    expect(result.adjacency.get('src/comanda/close-commanda.ts')).toEqual(
      new Set([functionNode]),
    );
    // function -> appointments (writes) and function -> commission_entries (writes)
    expect(result.adjacency.get(functionNode)).toEqual(
      new Set([appointmentsNode, commissionNode]),
    );
    // trigger: appointments -> function (calls)
    expect(result.adjacency.get(appointmentsNode)).toEqual(new Set([functionNode]));

    const appointments = result.dbEntities.find((e) => e.nodeId === appointmentsNode);
    expect(appointments?.rlsEnabled).toBe(true);
    expect(appointments?.definedIn).toEqual(['supabase/migrations/20260101000000_init.sql']);

    const commission = result.dbEntities.find((e) => e.nodeId === commissionNode);
    expect(commission).toBeTruthy();

    const fn = result.dbEntities.find((e) => e.nodeId === functionNode);
    expect(fn?.kind).toBe('function');
  });

  it('surfaces a usage-only table (referenced in code, no migration found) with an empty definedIn', () => {
    const files = [
      fileFor(
        'src/reports/report.ts',
        `await supabase.from('orphan_table').select('*');`,
        'ts',
      ),
    ];
    const result = buildDbGraphFromFiles(files, DEFAULT_ORIENTATION_LIMITS);
    const orphan = result.dbEntities.find((e) => e.qualifiedName === 'public.orphan_table');
    expect(orphan?.definedIn).toEqual([]);
  });
});
