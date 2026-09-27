import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProcessGitRunner } from '../runtime/git-command';
import { testProjectScope } from '../orch/__tests__/scope-fixture';

vi.mock('../context/orientation/orientation-service', () => ({
  tryGetProjectOrientationService: () => ({ ensure: async () => ({ graph: {} }) }),
}));
vi.mock('../context/orientation/orientation-blast-radius', () => ({
  // Forma real do BlastRadiusResult do code map (rodada 4b): `files` só com
  // caminhos reais; os nós de banco vêm à parte em `dbEntities`. A descoberta
  // pelo grafo real está em regression-gate-db-consumers.test.ts.
  computeBlastRadius: vi.fn(() => ({
    files: ['src/orders.ts', 'tests/db/orders.test.ts'],
    dbEntities: ['db:table:public.orders', 'db:function:fechar_comanda'],
    symbols: [],
    domains: [],
    hubs: [],
    tests: ['tests/db/orders.test.ts', 42],
    mapHash: 'h',
    source: 'orientation',
  })),
}));

import {
  __resetRegressionGateForTests,
  orientationBlastRadiusExtension,
  runRegressionGate,
  type RegressionExec,
} from './regression-gate';

const roots: string[] = [];
afterEach(() => {
  __resetRegressionGateForTests();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('blast radius estendido (contrato do codemap-banco)', () => {
  it('usa tests e as entidades de banco (dbEntities) do blast radius', async () => {
    const radius = await orientationBlastRadiusExtension({
      scope: testProjectScope(),
      changedFiles: ['src/orders.ts'],
    });
    expect(radius).toEqual({
      tests: ['tests/db/orders.test.ts'],
      dbEntities: ['public.orders', 'orders', 'fechar_comanda'],
      dbConsumers: [],
    });
  });

  it('teste de banco que não importa o módulo entra no portão pelo blast radius', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-regression-br-')));
    roots.push(root);
    const git = new ProcessGitRunner();
    const run = (...args: string[]) => git.run(root, args);
    const write = (file: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), content);
    };
    run('init', '-q');
    write('src/orders.ts', 'export const total = 1;\n');
    write('tests/db/orders.test.ts', "it('fecha comanda', () => {});\n");
    write('package.json', JSON.stringify({ devDependencies: { jest: '^29' } }));
    write('node_modules/.bin/jest', '#!/bin/sh\n');
    write('.gitignore', 'node_modules\n');
    run('add', '-A');
    run('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'fixture');
    write('src/orders.ts', 'export const total = 2;\n');
    const exec = vi.fn<RegressionExec>(async (_file, args, options) => {
      const outFile = args.find((arg) => arg.startsWith('--outputFile='))!.slice('--outputFile='.length);
      fs.writeFileSync(outFile, JSON.stringify({
        testResults: [{
          name: path.join(options.cwd, 'tests/db/orders.test.ts'),
          status: 'passed',
          assertionResults: [{ status: 'passed', fullName: 'fecha comanda' }],
        }],
      }));
      return { exitCode: 0, timedOut: false, stdout: '', stderr: '' };
    });

    const result = await runRegressionGate(
      { scope: testProjectScope({ rootRealPath: root }) },
      { exec },
    );

    expect(result.runner).toBe('jest');
    expect(result.testsRun).toEqual(['tests/db/orders.test.ts']);
    expect(exec.mock.calls[0]![1]).toContain('--runTestsByPath');
  });
});
