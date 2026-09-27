import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectExecutionScope } from '../../../shared/types';
import { computeBlastRadius, expandOwnershipWithBlastRadius } from './orientation-blast-radius';
import { orientationCurrentPath } from './orientation-cache';
import { extractSqlDbUsageEdges } from './orientation-db-usage';
import { ProjectOrientationService } from './orientation-service';
import {
  orientationStructuralIndexPath,
  readOrientationStructuralIndex,
} from './orientation-structural-index-cache';

const roots: string[] = [];

function scopeFor(root: string): ProjectExecutionScope {
  return Object.freeze({
    version: 1,
    installationId: 'install-db-graph',
    projectId: 'project-db-graph',
    checkoutId: 'checkout-db-graph',
    rootRealPath: root,
    identitySource: 'provisional' as const,
  });
}

function write(root: string, relative: string, content: string): void {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('code map <-> banco: comanda alcanca comissao e seu teste', () => {
  it('crosses table/function edges from a comanda file to the commission table and its test', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-db-graph-')));
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-db-graph-cache-'));
    roots.push(root, cacheRoot);

    write(root, 'package.json', JSON.stringify({ name: 'barbearia', scripts: { test: 'vitest' } }));
    write(
      root,
      'supabase/migrations/20260905121000_close_commanda.sql',
      `
        CREATE TABLE public.appointments (id uuid primary key);
        ALTER TABLE public.appointments ENABLE ROW LEVEL SECURITY;
        CREATE TABLE public.commission_entries (id uuid primary key, amount numeric);

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
      `,
    );
    write(
      root,
      'src/comanda/close-commanda.ts',
      `
        export async function closeCommanda(id: string) {
          await supabase.rpc('close_commanda_internal', { p_id: id });
        }
      `,
    );
    write(
      root,
      'src/commission/commission-service.ts',
      `
        export async function listCommissions() {
          return supabase.from('commission_entries').select('*');
        }
      `,
    );
    write(
      root,
      'src/commission/commission-service.test.ts',
      `
        import { listCommissions } from './commission-service';
        test('lists commissions', async () => { await listCommissions(); });
      `,
    );

    const service = new ProjectOrientationService({ cacheRoot, includeContextSummary: false });
    const map = await service.ensure(scopeFor(root), { reason: 'workspace-open' });

    expect(map.graph.dbEntities?.some((e) => e.qualifiedName === 'public.appointments')).toBe(true);
    expect(map.graph.dbEntities?.some((e) => e.qualifiedName === 'public.commission_entries')).toBe(true);
    const appointments = map.graph.dbEntities?.find((e) => e.qualifiedName === 'public.appointments');
    expect(appointments?.rlsEnabled).toBe(true);

    const radius = computeBlastRadius(map, {
      seedFiles: ['src/comanda/close-commanda.ts'],
      depth: 4,
    });

    expect(radius.files).toEqual(
      expect.arrayContaining([
        'src/comanda/close-commanda.ts',
        'src/commission/commission-service.ts',
        'src/commission/commission-service.test.ts',
      ]),
    );
    expect(radius.dbEntities).toEqual(
      expect.arrayContaining([
        'db:function:public.close_commanda_internal',
        'db:table:public.appointments',
        'db:table:public.commission_entries',
      ]),
    );
    expect(radius.tests).toContain('src/commission/commission-service.test.ts');
  });
});

describe('code map <-> banco: grafo sem imports, seed de migration e reservas', () => {
  async function buildMap(withImport = false) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-db-only-')));
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-db-only-cache-'));
    roots.push(root, cacheRoot);
    write(root, 'package.json', JSON.stringify({ name: 'db-only' }));
    write(root, 'supabase/migrations/20260101000000_users.sql', 'CREATE TABLE users (id uuid);');
    // No file imports another one: every link goes through the users table.
    write(root, 'src/billing/invoices.ts', "export const listInvoices = () => supabase.from('users').select('*');");
    write(root, 'src/profile/profile.ts', "export const saveProfile = () => supabase.from('users').update({});");
    write(root, 'src/audit/audit.ts', "export const writeAudit = () => supabase.from('audit_log').insert({});");
    write(root, 'src/profile/profile.test.ts', "afterEach(() => supabase.from('users').delete());");
    if (withImport) {
      write(root, 'src/billing/money.ts', 'export const cents = 100;');
      write(root, 'src/billing/totals.ts', "import { cents } from './money';\nexport const t = cents;");
    }
    const service = new ProjectOrientationService({ cacheRoot, includeContextSummary: false });
    return service.ensure(scopeFor(root), { reason: 'workspace-open' });
  }

  it('walks a graph made only of db edges (no import edge at all)', async () => {
    const map = await buildMap();
    expect(map.graph.edgeCount).toBe(0);
    const radius = computeBlastRadius(map, { seedFiles: ['src/billing/invoices.ts'], depth: 2 });
    expect(radius.files).toEqual([
      'src/billing/invoices.ts',
      'src/profile/profile.test.ts',
      'src/profile/profile.ts',
    ]);
    expect(radius.dbEntities).toEqual(['db:table:public.users']);
    expect(radius.tests).toEqual(['src/profile/profile.test.ts']);
  });

  it('seeding the migration reaches the code and tests that use what it defines', async () => {
    const map = await buildMap();
    const radius = computeBlastRadius(map, {
      seedFiles: ['supabase/migrations/20260101000000_users.sql'],
      depth: 1,
    });
    expect(radius.files).toEqual(
      expect.arrayContaining(['src/billing/invoices.ts', 'src/profile/profile.ts']),
    );
    expect(radius.tests).toContain('src/profile/profile.test.ts');
  });

  it('keeps db nodes out of domains and never turns a shared table into an ownership claim', async () => {
    // One unrelated import edge makes the graph walkable, as in real projects.
    const map = await buildMap(true);
    expect(map.graph.edgeCount).toBe(1);
    const radius = computeBlastRadius(map, { seedFiles: ['src/billing/invoices.ts'], depth: 1 });
    expect(radius.files).toEqual(['src/billing/invoices.ts']);
    expect(radius.domains).toEqual(['billing']);

    const owned = expandOwnershipWithBlastRadius(
      { files: ['src/billing/invoices.ts'], symbols: [], domains: ['billing'] },
      map,
    );
    const other = expandOwnershipWithBlastRadius(
      { files: ['src/profile/profile.ts'], symbols: [], domains: ['profile'] },
      map,
    );
    expect(owned.files).toEqual(['src/billing/invoices.ts']);
    expect(owned.domains).toEqual(['billing']);
    expect(other.files.filter((f) => owned.files.includes(f))).toEqual([]);
    expect(other.domains.filter((d) => owned.domains.includes(d))).toEqual([]);
  });

  it('goal text seeds schema-defined tables, never usage-only names', async () => {
    const map = await buildMap();
    expect(computeBlastRadius(map, { goal: 'fix users sync', depth: 1 }).dbEntities).toEqual([
      'db:table:public.users',
    ]);
    // depth 0: only what the goal itself seeds (the audit.ts symbol hub may
    // still pull the file in, but the usage-only table is not a seed).
    expect(computeBlastRadius(map, { goal: 'rotate audit_log', depth: 0 }).dbEntities).toEqual([]);
  });
});

describe('code map <-> banco: caches gravados por versoes anteriores', () => {
  function fixture() {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-db-cache-')));
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-db-cache-root-'));
    roots.push(root, cacheRoot);
    write(root, 'package.json', JSON.stringify({ name: 'db-cache' }));
    write(root, 'supabase/migrations/20260101000000_users.sql', 'CREATE TABLE users (id uuid);');
    write(root, 'src/users.ts', "export const listUsers = () => supabase.from('users').select('*');");
    return { root, cacheRoot, scope: scopeFor(root) };
  }

  it('rebuilds a map cached by the previous extractors even when HEAD did not move', async () => {
    const { cacheRoot, scope } = fixture();
    await new ProjectOrientationService({ cacheRoot, includeContextSummary: false })
      .ensure(scope, { reason: 'workspace-open' });
    // Rewrite current.json as the previous release left it: no extractor
    // generation and no db graph.
    const file = orientationCurrentPath(cacheRoot, scope);
    const old = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete old.extractorVersion;
    delete old.graph.dbEntities;
    delete old.graph.dbEdgeCount;
    fs.writeFileSync(file, JSON.stringify(old));

    const upgraded = await new ProjectOrientationService({ cacheRoot, includeContextSummary: false })
      .ensure(scope, { reason: 'workspace-open' });
    expect(upgraded.graph.dbEntities?.map((e) => e.nodeId)).toEqual(['db:table:public.users']);
  });

  it('migration grande (dump do Supabase) é cortada no writer: o índice persistido continua legível', async () => {
    const { root, cacheRoot, scope } = fixture();
    const functions = Array.from({ length: 1_500 }, (_, i) => `
CREATE OR REPLACE FUNCTION public.f${i}() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.t${i} SET x = 1;
  UPDATE public.t${i} SET x = 2;
  INSERT INTO public.u${i} (id) VALUES (1);
  PERFORM 1 FROM public.v${i};
END;
$$;`).join('\n');
    write(root, 'supabase/migrations/20260102000000_remote_schema.sql', functions);
    const raw = extractSqlDbUsageEdges('supabase/migrations/20260102000000_remote_schema.sql', functions);
    expect(raw.length).toBeGreaterThan(4_096);

    await new ProjectOrientationService({ cacheRoot, includeContextSummary: false })
      .ensure(scope, { reason: 'workspace-open' });

    const index = readOrientationStructuralIndex(cacheRoot, scope);
    expect(index).not.toBeNull();
    const dump = index!.files.find((f) => f.relativePath.endsWith('_remote_schema.sql'))!;
    expect(dump.dbUsageEdges).toHaveLength(4_096);
    const keys = dump.dbUsageEdges.map((edge) => JSON.stringify(edge));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('round-trips db facts through the structural index and rejects an index without them', async () => {
    const { cacheRoot, scope } = fixture();
    await new ProjectOrientationService({ cacheRoot, includeContextSummary: false })
      .ensure(scope, { reason: 'workspace-open' });
    const index = readOrientationStructuralIndex(cacheRoot, scope);
    const users = index?.files.find((f) => f.relativePath === 'src/users.ts');
    expect(users?.dbUsageEdges).toEqual([
      expect.objectContaining({ toQualifiedName: 'public.users', relation: 'reads' }),
    ]);
    const migration = index?.files.find((f) => f.relativePath.endsWith('_users.sql'));
    expect(migration?.dbSchemaFacts.map((f) => f.qualifiedName)).toEqual(['public.users']);

    const file = orientationStructuralIndexPath(cacheRoot, scope);
    const old = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const entry of old.files) {
      delete entry.dbSchemaFacts;
      delete entry.dbUsageEdges;
    }
    fs.writeFileSync(file, JSON.stringify(old));
    expect(readOrientationStructuralIndex(cacheRoot, scope)).toBeNull();
  });
});
