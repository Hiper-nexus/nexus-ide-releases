import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  __settleLspWorkerForTests,
  runScopedLspQuery,
} from './lsp-sidecar';

let parentDir = '';
let root = '';
let scope: ProjectExecutionScope;

beforeEach(() => {
  parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-lsp-'));
  root = path.join(parentDir, 'project');
  fs.mkdirSync(root, { recursive: true });
  root = fs.realpathSync(root);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'src', 'lib.ts'),
    [
      'export function greet(name: string) {',
      '  return `hello ${name}`;',
      '}',
      'export const broken: string = 42;',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(root, 'src', 'use.ts'),
    [
      "import { greet } from './lib';",
      "export const message = greet('Nexus');",
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        target: 'ES2022',
      },
      include: ['src/**/*.ts'],
    }),
  );
  scope = Object.freeze({
    version: 1,
    installationId: 'install-lsp',
    projectId: 'project-lsp',
    checkoutId: 'checkout-lsp',
    rootRealPath: root,
    identitySource: 'provisional',
  });
});

afterEach(() => {
  fs.rmSync(parentDir, { recursive: true, force: true });
});

describe('runScopedLspQuery', () => {
  it('returns bounded TypeScript symbols, definitions, references and diagnostics', async () => {
    const symbols = await runScopedLspQuery(scope, {
      kind: 'symbols',
      path: 'src/lib.ts',
      maxResults: 20,
    });
    expect(symbols.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'greet', path: 'src/lib.ts' }),
        expect.objectContaining({ name: 'broken', path: 'src/lib.ts' }),
      ]),
    );

    const definitions = await runScopedLspQuery(scope, {
      kind: 'definition',
      path: 'src/use.ts',
      line: 1,
      column: 10,
      maxResults: 10,
    });
    expect(definitions.items).toEqual([
      expect.objectContaining({ path: 'src/lib.ts', line: 1 }),
    ]);

    const references = await runScopedLspQuery(scope, {
      kind: 'references',
      path: 'src/use.ts',
      line: 1,
      column: 10,
      maxResults: 10,
    });
    expect(references.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'src/lib.ts', line: 1 }),
        expect.objectContaining({ path: 'src/use.ts', line: 1 }),
        expect.objectContaining({ path: 'src/use.ts', line: 2 }),
      ]),
    );

    const diagnostics = await runScopedLspQuery(scope, {
      kind: 'diagnostics',
      path: 'src/lib.ts',
      maxResults: 20,
    });
    expect(diagnostics.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'src/lib.ts',
          code: 2322,
          severity: 'error',
          line: 4,
        }),
      ]),
    );
  }, 15_000);

  it('never resolves a definition outside the bound execution scope', async () => {
    fs.writeFileSync(
      path.join(parentDir, 'outside.ts'),
      'export const outside = 1;\n',
    );
    fs.writeFileSync(
      path.join(root, 'src', 'escape.ts'),
      [
        "import { outside } from '../../outside';",
        'export const leaked = outside;',
        '',
      ].join('\n'),
    );

    const result = await runScopedLspQuery(scope, {
      kind: 'definition',
      path: 'src/escape.ts',
      line: 1,
      column: 10,
      maxResults: 10,
    });
    expect(result.items.every((item) => item.path === 'src/escape.ts')).toBe(true);
    expect(result.items).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: expect.stringContaining('outside') }),
      ]),
    );
  });

  it('terminates a worker that exceeds its hard wall-clock budget', async () => {
    class HungWorker extends EventEmitter {
      terminated = false;

      async terminate(): Promise<number> {
        this.terminated = true;
        return 1;
      }
    }
    const worker = new HungWorker();

    await expect(
      __settleLspWorkerForTests(worker, 5),
    ).rejects.toThrow(/time limit/i);
    expect(worker.terminated).toBe(true);
  });

  it('allows only one active worker per execution scope', async () => {
    const first = runScopedLspQuery(scope, {
      kind: 'symbols',
      path: 'src/lib.ts',
      maxResults: 10,
    });
    await expect(
      runScopedLspQuery(scope, {
        kind: 'diagnostics',
        path: 'src/lib.ts',
        maxResults: 10,
      }),
    ).rejects.toThrow(/already active/i);
    await expect(first).resolves.toMatchObject({ path: 'src/lib.ts' });
  });

  it('honors the repository tsconfig include set instead of globally indexing every tree', async () => {
    const repositoryRoot = fs.realpathSync(process.cwd());
    const repositoryScope: ProjectExecutionScope = Object.freeze({
      ...scope,
      projectId: 'project-lsp-self-host',
      checkoutId: 'checkout-lsp-self-host',
      rootRealPath: repositoryRoot,
    });

    const result = await runScopedLspQuery(repositoryScope, {
      kind: 'symbols',
      path: 'src/main/orch/tools-lsp.ts',
      maxResults: 20,
    });
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'buildLspTools' }),
      ]),
    );
    expect(result.budget.directoriesRead).toBeLessThanOrEqual(2_000);
  }, 10_000);
});
