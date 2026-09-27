/**
 * Portão + code map REAIS (orientation: walker, schema, uso de banco, grafo):
 * nada de blast radius simulado. Só o runner é dublê — a fronteira aqui é a
 * descoberta dos testes pelo grafo, não a execução deles.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProcessGitRunner } from '../runtime/git-command';
import { testProjectScope } from '../orch/__tests__/scope-fixture';
import {
  __resetProjectOrientationServiceForTests,
  configureProjectOrientationService,
} from '../context/orientation/orientation-service';
import {
  __resetRegressionGateForTests,
  runRegressionGate,
  type RegressionExec,
} from './regression-gate';

const roots: string[] = [];
afterEach(() => {
  __resetRegressionGateForTests();
  __resetProjectOrientationServiceForTests();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

/** Runner dublê: aprova tudo o que foi pedido e registra os pedidos. */
function recordingRunner() {
  const requested: string[] = [];
  const exec = vi.fn<RegressionExec>(async (_file, args, options) => {
    const outFile = args.find((arg) => arg.startsWith('--outputFile='))!.slice('--outputFile='.length);
    const files = args.filter((arg) => /\.test\.ts$/u.test(arg));
    requested.push(...files);
    fs.writeFileSync(outFile, JSON.stringify({
      testResults: files.map((file) => ({
        name: path.join(options.cwd, file),
        status: 'passed',
        assertionResults: [{ status: 'passed', fullName: 'ok' }],
      })),
    }));
    return { exitCode: 0, timedOut: false, stdout: '', stderr: '' };
  });
  return { exec, requested };
}

describe('portão + code map: comanda → banco → comissão', () => {
  it('mudança na comanda roda o teste da comissão, ligada só pelo banco (sem import em comum)', async () => {
    const root = tempDir('nexus-gate-db-');
    const write = (file: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), content);
    };
    write('package.json', JSON.stringify({ name: 'barbearia', devDependencies: { vitest: '*' } }));
    write('.gitignore', 'node_modules\n');
    write('node_modules/.bin/vitest', '#!/bin/sh\n');
    write(
      'supabase/migrations/20260905121000_close_commanda.sql',
      `
        CREATE TABLE public.appointments (id uuid primary key);
        CREATE TABLE public.commission_entries (id uuid primary key, amount numeric);
        CREATE OR REPLACE FUNCTION public.close_commanda_internal(p_id uuid)
        RETURNS void LANGUAGE plpgsql AS $$
        BEGIN
          UPDATE public.appointments SET status = 'closed' WHERE id = p_id;
          INSERT INTO commission_entries (id, amount) VALUES (p_id, 10);
        END;
        $$;
      `,
    );
    write(
      'src/comanda/close-commanda.ts',
      "export async function closeCommanda(id: string) {\n  await supabase.rpc('close_commanda_internal', { p_id: id });\n}\n",
    );
    write(
      'src/commission/commission-service.ts',
      "export async function listCommissions() {\n  return supabase.from('commission_entries').select('*');\n}\n",
    );
    // Nome que não casa com o módulo: só o grafo de imports o acha.
    write(
      'src/commission/commission-report.test.ts',
      "import { listCommissions } from './commission-service';\ntest('lista', async () => { await listCommissions(); });\n",
    );
    const git = new ProcessGitRunner();
    git.run(root, ['init', '-q']);
    git.run(root, ['add', '-A']);
    git.run(root, ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'fixture']);
    configureProjectOrientationService({ cacheRoot: tempDir('nexus-gate-db-cache-'), includeContextSummary: false });
    // O diff: a comanda muda o valor que a função grava na comissão.
    write(
      'src/comanda/close-commanda.ts',
      "export async function closeCommanda(id: string) {\n  await supabase.rpc('close_commanda_internal', { p_id: id, fee: 2 });\n}\n",
    );
    const { exec, requested } = recordingRunner();

    const result = await runRegressionGate({ scope: testProjectScope({ rootRealPath: root }) }, { exec });

    expect(requested).toContain('src/commission/commission-report.test.ts');
    expect(result.testsRun).toContain('src/commission/commission-report.test.ts');
    expect(result.status).toBe('passed');
  }, 60_000);
});
