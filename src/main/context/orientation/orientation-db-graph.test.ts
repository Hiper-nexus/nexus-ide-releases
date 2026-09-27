import { describe, expect, it } from 'vitest';
import { buildDbGraphFromFiles, type DbGraphInputFile } from './orientation-db-graph';
import {
  extractSchemaEntitiesFromDrizzle,
  extractSchemaEntitiesFromPrisma,
  extractSchemaEntitiesFromSql,
} from './orientation-schema';
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

describe('orientation-db-graph: ORM name resolution and RLS history', () => {
  it('resolves prisma.<model> through @@map to the mapped table', () => {
    const result = buildDbGraphFromFiles(
      [
        {
          relativePath: 'prisma/schema.prisma',
          schemaFacts: extractSchemaEntitiesFromPrisma(
            'prisma/schema.prisma',
            'model Commission {\n  id String @id\n  @@map("commission_entries")\n}\n',
          ),
          usageEdges: [],
        },
        fileFor('src/commission.ts', 'await prisma.commission.findMany();', 'ts'),
      ],
      DEFAULT_ORIENTATION_LIMITS,
    );
    expect(result.adjacency.get('src/commission.ts')).toEqual(
      new Set(['db:table:public.commission_entries']),
    );
    expect(result.dbEntities.map((e) => e.qualifiedName)).toEqual(['public.commission_entries']);
  });

  it('resolves drizzle table variables to the pgTable in the same or the imported file', () => {
    const schema = "export const commissionEntries = pgTable('commission_entries', {});";
    const result = buildDbGraphFromFiles(
      [
        {
          relativePath: 'src/db/schema.ts',
          schemaFacts: extractSchemaEntitiesFromDrizzle('src/db/schema.ts', schema),
          usageEdges: extractTsDbUsageEdges('src/db/schema.ts', schema),
        },
        fileFor(
          'src/report.ts',
          "import { commissionEntries } from './db/schema';\n" +
            'const rows = await db.select().from(commissionEntries);\n' +
            'await db.insert(commissionEntries).values(row);\n' +
            'const copy = Array.from(items);\n',
          'ts',
        ),
      ],
      DEFAULT_ORIENTATION_LIMITS,
    );
    expect(result.adjacency.get('src/report.ts')).toEqual(
      new Set(['db:table:public.commission_entries']),
    );
    expect(result.dbEntities.map((e) => e.nodeId)).toEqual(['db:table:public.commission_entries']);
  });

  it('drops a drizzle variable bound to pgTable in more than one other file (ambiguous)', () => {
    const def = (name: string) => ({
      relativePath: name,
      schemaFacts: extractSchemaEntitiesFromDrizzle(name, `const users = pgTable('${name.includes('a') ? 'a_users' : 'b_users'}', {});`),
      usageEdges: [],
    });
    const result = buildDbGraphFromFiles(
      [def('src/a.ts'), def('src/b.ts'), fileFor('src/c.ts', 'db.select().from(users);', 'ts')],
      DEFAULT_ORIENTATION_LIMITS,
    );
    expect(result.adjacency.get('src/c.ts')).toBeUndefined();
  });

  it('applies the latest migration RLS toggle (enable then disable => false)', () => {
    const result = buildDbGraphFromFiles(
      [
        fileFor(
          'supabase/migrations/20260102000000_off.sql',
          'ALTER TABLE users DISABLE ROW LEVEL SECURITY;',
          'sql',
        ),
        fileFor(
          'supabase/migrations/20260101000000_on.sql',
          'CREATE TABLE users (id int); ALTER TABLE users ENABLE ROW LEVEL SECURITY;',
          'sql',
        ),
      ],
      DEFAULT_ORIENTATION_LIMITS,
    );
    expect(result.dbEntities.find((e) => e.qualifiedName === 'public.users')?.rlsEnabled).toBe(
      false,
    );
  });
});
