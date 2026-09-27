import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectExecutionScope } from '../../../shared/types';
import { computeBlastRadius } from './orientation-blast-radius';
import { ProjectOrientationService } from './orientation-service';

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
        'db:function:public.close_commanda_internal',
        'db:table:public.appointments',
        'db:table:public.commission_entries',
        'src/commission/commission-service.ts',
        'src/commission/commission-service.test.ts',
      ]),
    );
    expect(radius.tests).toContain('src/commission/commission-service.test.ts');
  });
});
