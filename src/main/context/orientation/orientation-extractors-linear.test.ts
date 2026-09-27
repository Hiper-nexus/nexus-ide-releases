import { describe, expect, it } from 'vitest';
import { extractOrientationImportSpecifiers } from './orientation-import-graph';
import { extractSqlDbUsageEdges, extractTsDbUsageEdges } from './orientation-db-usage';
import {
  extractSchemaEntitiesFromDrizzle,
  extractSchemaEntitiesFromPrisma,
  extractSchemaEntitiesFromSql,
} from './orientation-schema';

// Every extractor runs synchronously on the Main process while indexing, so a
// super-linear scanner freezes the app. Each case below is adversarial input
// that made the previous regexes backtrack (exponential or polynomial); with
// linear scanners they finish in a few milliseconds.
const BUDGET_MS = 1_000;

function timed(run: () => unknown): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

describe('orientation extractors: linear worst case', () => {
  it('template scan: quoted backtick followed by many interpolations (was exponential)', () => {
    const small = `const a = "\`${'${x}'.repeat(24)}";`;
    const large = `const a = "\`${'${x}'.repeat(40_000)}";`;
    expect(timed(() => extractTsDbUsageEdges('src/a.ts', small))).toBeLessThan(BUDGET_MS);
    expect(timed(() => extractTsDbUsageEdges('src/a.ts', large))).toBeLessThan(BUDGET_MS);
  });

  it('import scan: many `import` words without from/quotes (was quadratic)', () => {
    const content = 'import '.repeat(40_000);
    expect(timed(() => extractOrientationImportSpecifiers(content))).toBeLessThan(BUDGET_MS);
  });

  it('SQL trigger/function scan: unterminated clauses (was polynomial)', () => {
    const trigger = `CREATE TRIGGER t BEFORE INSERT ${'ON x '.repeat(20_000)}`.repeat(4);
    const fn = 'CREATE FUNCTION f() RETURNS void AS $a$ select 1 '.repeat(4_000);
    for (const content of [trigger, fn]) {
      expect(
        timed(() => {
          extractSqlDbUsageEdges('m.sql', content);
          extractSchemaEntitiesFromSql('m.sql', content);
        }),
      ).toBeLessThan(BUDGET_MS);
    }
  });

  it('prisma scan: unclosed model with a long whitespace run (was quadratic)', () => {
    const content = `model A {${'\n'.repeat(200_000)}`.repeat(2);
    expect(timed(() => extractSchemaEntitiesFromPrisma('schema.prisma', content))).toBeLessThan(
      BUDGET_MS,
    );
  });

  it('drizzle scan: many bindings and calls', () => {
    const content = 'const a = pgTable(\'t\', {}); db.select().from(a); '.repeat(20_000);
    expect(
      timed(() => {
        extractSchemaEntitiesFromDrizzle('s.ts', content);
        extractTsDbUsageEdges('s.ts', content);
      }),
    ).toBeLessThan(BUDGET_MS);
  });
});

describe('orientation extractors: lexical correctness', () => {
  it('keeps a multi-line import whose comment contains an apostrophe', () => {
    const content = "import {\n  Foo, // Don't remove this type\n  Bar,\n} from './foo';\n";
    expect(extractOrientationImportSpecifiers(content)).toEqual(['./foo']);
  });

  it('ignores import-looking text inside comments and strings', () => {
    const content =
      "// import x from './commented';\nconst s = \"import y from './quoted'\";\nimport z from './real';\n";
    expect(extractOrientationImportSpecifiers(content)).toEqual(['./real']);
  });

  it('reads "schema"."table" in SQL templates and function bodies as schema.table', () => {
    const ts = extractTsDbUsageEdges('src/a.ts', 'q(`SELECT * FROM "public"."users"`);');
    expect(ts.map((e) => e.toQualifiedName)).toEqual(['public.users']);
    const sql = extractSqlDbUsageEdges(
      'm.sql',
      'CREATE FUNCTION f() RETURNS void AS $$ BEGIN DELETE FROM "auth"."sessions"; END $$;',
    );
    expect(sql).toEqual([
      expect.objectContaining({ toQualifiedName: 'auth.sessions', relation: 'writes' }),
    ]);
  });

  it('does not read a backtick inside a quoted string as a SQL template', () => {
    const edges = extractTsDbUsageEdges('src/a.ts', 'const s = "use `FROM users` here";');
    expect(edges).toEqual([]);
  });

  it('does not take SET in ON CONFLICT DO UPDATE SET as a table', () => {
    const edges = extractTsDbUsageEdges(
      'src/a.ts',
      'q(`INSERT INTO items (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET id = 1`);',
    );
    expect(edges.map((e) => e.toQualifiedName)).toEqual(['public.items']);
  });
});

describe('orientation extractors: PostgreSQL identifier case folding', () => {
  it('folds unquoted identifiers and preserves quoted ones in definitions', () => {
    const facts = extractSchemaEntitiesFromSql(
      'm.sql',
      'CREATE TABLE Public.Appointments (id int); CREATE TABLE "Users" (id int); CREATE FUNCTION Public.Close_It() RETURNS void AS $$ $$;',
    );
    expect(facts.map((f) => f.qualifiedName).sort()).toEqual([
      'public.Users',
      'public.appointments',
      'public.close_it',
    ]);
  });

  it('applies the same folding to usages, so definition and use meet', () => {
    const edges = extractTsDbUsageEdges(
      'src/a.ts',
      'q(`select * from Appointments join "Users" on true`);',
    );
    expect(edges.map((e) => e.toQualifiedName)).toEqual(['public.appointments', 'public.Users']);
    const trigger = extractSqlDbUsageEdges(
      'm.sql',
      'CREATE TRIGGER t AFTER UPDATE ON Public.Appointments FOR EACH ROW EXECUTE FUNCTION Public.Close_It();',
    );
    expect(trigger).toEqual([
      expect.objectContaining({
        from: 'db:table:public.appointments',
        toQualifiedName: 'public.close_it',
      }),
    ]);
  });
});

describe('orientation extractors: RLS state', () => {
  it('keeps the last explicit toggle inside one file', () => {
    const facts = extractSchemaEntitiesFromSql(
      'm.sql',
      'ALTER TABLE users ENABLE ROW LEVEL SECURITY; ALTER TABLE users DISABLE ROW LEVEL SECURITY;',
    );
    expect(facts).toEqual([expect.objectContaining({ qualifiedName: 'public.users', rlsEnabled: false })]);
  });

  it('ignores toggles inside comments', () => {
    const facts = extractSchemaEntitiesFromSql(
      'm.sql',
      'CREATE TABLE users (id int); -- ALTER TABLE users ENABLE ROW LEVEL SECURITY;',
    );
    expect(facts[0].rlsEnabled).toBeUndefined();
  });
});
