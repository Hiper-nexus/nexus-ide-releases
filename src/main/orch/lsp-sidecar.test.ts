import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  __settleLspWorkerForTests,
  LSP_LIMITS,
  runScopedLspQuery,
} from './lsp-sidecar';
import { LSP_WORKER_SOURCE } from './lsp-worker-source';

let parentDir = '';
let root = '';
let scope: ProjectExecutionScope;

function writeProjectConfig(config: Record<string, unknown>): void {
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify(config));
}

function writeLspProjectConfig(config: Record<string, unknown>): void {
  fs.writeFileSync(path.join(root, 'tsconfig.lsp.json'), JSON.stringify(config));
}

function writeManyScripts(
  directory: string,
  extension: 'js' | 'ts',
): void {
  fs.mkdirSync(directory, { recursive: true });
  for (let index = 0; index <= LSP_LIMITS.maxProjectFiles; index += 1) {
    fs.writeFileSync(
      path.join(directory, `generated-${index}.${extension}`),
      `export const generated_${index} = ${index};\n`,
    );
  }
}

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

  it('F-1323: resolve a cadeia de extends do tsconfig (paths vêm da base)', async () => {
    fs.writeFileSync(
      path.join(root, 'tsconfig.base.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          baseUrl: '.',
          paths: { '@local/*': ['src/*'] },
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          target: 'ES2022',
        },
      }),
    );
    writeProjectConfig({
      extends: './tsconfig.base.json',
      include: ['src/**/*.ts'],
    });
    fs.writeFileSync(
      path.join(root, 'src', 'use.ts'),
      [
        "import { greet } from '@local/lib';",
        "export const message = greet('Nexus');",
        '',
      ].join('\n'),
    );

    const diagnostics = await runScopedLspQuery(scope, {
      kind: 'diagnostics',
      path: 'src/use.ts',
      maxResults: 20,
    });
    expect(diagnostics.items).toEqual([]);
    expect(diagnostics.budget.degraded).toBe(false);

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
  }, 15_000);

  it('F-1323: base de extends ilegível degrada o resultado em vez de falhar', async () => {
    writeProjectConfig({
      extends: './tsconfig.missing.json',
      include: ['src/**/*.ts'],
    });

    const result = await runScopedLspQuery(scope, {
      kind: 'symbols',
      path: 'src/lib.ts',
      maxResults: 10,
    });
    expect(result.budget.degraded).toBe(true);
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'greet', path: 'src/lib.ts' }),
      ]),
    );
  }, 15_000);

  it('F-1323: extends em cadeia e em lista herdam o aliás mais antigo', async () => {
    fs.writeFileSync(
      path.join(root, 'tsconfig.root.json'),
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { '@local/*': ['src/*'] },
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          target: 'ES2022',
        },
      }),
    );
    fs.writeFileSync(
      path.join(root, 'tsconfig.mid.json'),
      JSON.stringify({ extends: './tsconfig.root.json' }),
    );
    writeProjectConfig({
      extends: ['./tsconfig.mid.json'],
      include: ['src/**/*.ts'],
    });
    fs.writeFileSync(
      path.join(root, 'src', 'use.ts'),
      [
        "import { greet } from '@local/lib';",
        "export const message = greet('Nexus');",
        '',
      ].join('\n'),
    );

    const diagnostics = await runScopedLspQuery(scope, {
      kind: 'diagnostics',
      path: 'src/use.ts',
      maxResults: 20,
    });
    expect(diagnostics.items).toEqual([]);
    expect(diagnostics.budget.degraded).toBe(false);
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

  it('uses tsconfig allowJs and exclude semantics without weakening the project-file cap', async () => {
    const generated = path.join(root, 'src', 'generated-js');
    writeManyScripts(generated, 'js');
    writeProjectConfig({
      compilerOptions: { strict: true },
      include: ['src'],
    });

    await expect(
      runScopedLspQuery(scope, {
        kind: 'symbols',
        path: 'src/lib.ts',
        maxResults: 10,
      }),
    ).resolves.toMatchObject({ path: 'src/lib.ts' });

    writeProjectConfig({
      compilerOptions: { allowJs: true, strict: true },
      include: ['src'],
      exclude: ['src/generated-js'],
    });
    await expect(
      runScopedLspQuery(scope, {
        kind: 'symbols',
        path: 'src/lib.ts',
        maxResults: 10,
      }),
    ).resolves.toMatchObject({ path: 'src/lib.ts' });

    writeProjectConfig({
      compilerOptions: { allowJs: true, strict: true },
      include: ['src'],
    });
    await expect(
      runScopedLspQuery(scope, {
        kind: 'symbols',
        path: 'src/lib.ts',
        maxResults: 10,
      }),
    ).rejects.toThrow(/project-file limit exceeded/i);
  }, 15_000);

  it('uses an explicit bounded LSP config without weakening the repository typecheck config', async () => {
    const generated = path.join(root, 'src', 'generated-ts');
    writeManyScripts(generated, 'ts');
    writeProjectConfig({
      compilerOptions: { strict: true },
      include: ['src'],
    });
    writeLspProjectConfig({
      compilerOptions: { strict: true },
      include: ['src'],
      exclude: ['src/generated-ts'],
    });

    await expect(
      runScopedLspQuery(scope, {
        kind: 'symbols',
        path: 'src/lib.ts',
        maxResults: 10,
      }),
    ).resolves.toMatchObject({
      path: 'src/lib.ts',
      items: expect.arrayContaining([
        expect.objectContaining({ name: 'greet', path: 'src/lib.ts' }),
      ]),
    });
  }, 15_000);

  it('anchors includes at the config root and never indexes a sibling tree', async () => {
    const outsideRoot = path.join(parentDir, 'src');
    writeManyScripts(outsideRoot, 'ts');
    writeProjectConfig({
      compilerOptions: { strict: true },
      include: ['src', '../src', path.join(outsideRoot, '**/*.ts')],
    });

    await expect(
      runScopedLspQuery(scope, {
        kind: 'symbols',
        path: 'src/lib.ts',
        maxResults: 10,
      }),
    ).resolves.toMatchObject({
      path: 'src/lib.ts',
      items: expect.arrayContaining([
        expect.objectContaining({ name: 'greet', path: 'src/lib.ts' }),
      ]),
    });
  }, 15_000);

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

  it('F-1252: definition/diagnostics degradam para truncated em vez de estourar o teto de bytes', async () => {
    // O fecho de imports do alvo não cabe no teto de bytes: a resposta do
    // arquivo perguntado continua exata (o alvo carrega primeiro e o import da
    // linha 1 traz lib.ts antes dos fillers) e o resultado vem marcado
    // truncated em vez de falhar a consulta inteira. A lib .d.ts do TypeScript
    // é conteúdo fixo do bundle do app e não consome o teto.
    const fillerImports: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      fs.writeFileSync(
        path.join(root, 'src', `filler-${index}.ts`),
        `export const filler_${index} = '${'x'.repeat(4096)}';\n`,
      );
      fillerImports.push(`import './filler-${index}';`);
    }
    fs.writeFileSync(
      path.join(root, 'src', 'use.ts'),
      [
        "import { greet } from './lib';",
        ...fillerImports,
        "export const message = greet('Nexus');",
        'export const bad: string = 42;',
        '',
      ].join('\n'),
    );
    const typescriptPath = createRequire(import.meta.url).resolve('typescript');
    const tightLimits = { ...LSP_LIMITS, maxTotalBytes: 32 * 1024 };
    const runWorker = (query: Record<string, unknown>) =>
      __settleLspWorkerForTests(
        new Worker(LSP_WORKER_SOURCE, {
          eval: true,
          workerData: {
            rootRealPath: root,
            typescriptPath,
            query,
            limits: tightLimits,
          },
        }),
        LSP_LIMITS.parentTimeoutMs,
      );

    const definitions = await runWorker({
      kind: 'definition',
      path: 'src/use.ts',
      line: 1,
      column: 10,
      maxResults: 10,
    });
    expect(definitions.truncated).toBe(true);
    expect(definitions.budget.degraded).toBe(true);
    expect(definitions.items).toEqual([
      expect.objectContaining({ path: 'src/lib.ts', line: 1 }),
    ]);

    const diagnostics = await runWorker({
      kind: 'diagnostics',
      path: 'src/use.ts',
      maxResults: 20,
    });
    expect(diagnostics.truncated).toBe(true);
    expect(diagnostics.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'src/use.ts', code: 2322 }),
      ]),
    );
  }, 15_000);

  it('F-1183: diagnostics leem a lib do TypeScript servida pelo app.asar', async () => {
    const typescriptPath = createRequire(import.meta.url).resolve('typescript');
    // Como o Electron faz com arquivo de asar: o fd aponta para uma cópia
    // temporária, então o fstat nunca tem o dev/ino do caminho da lib.
    const asarLikeLib = `
const asarFs = module.require('node:fs');
const asarLib = ${JSON.stringify(fs.realpathSync(path.dirname(typescriptPath)))};
const asarCopies = ${JSON.stringify(parentDir)};
const realOpenSync = asarFs.openSync;
let asarCopy = 0;
asarFs.openSync = (file, ...rest) => {
  if (typeof file !== 'string' || !file.startsWith(asarLib)) return realOpenSync(file, ...rest);
  const copy = module.require('node:path').join(asarCopies, 'asar-copy-' + (asarCopy += 1));
  asarFs.copyFileSync(file, copy);
  return realOpenSync(copy, ...rest);
};
`;
    const worker = new Worker(
      LSP_WORKER_SOURCE.replace("'use strict';\n", `'use strict';\n${asarLikeLib}`),
      {
        eval: true,
        workerData: {
          rootRealPath: root,
          typescriptPath,
          query: { kind: 'diagnostics', path: 'src/lib.ts', maxResults: 20 },
          limits: LSP_LIMITS,
        },
      },
    );

    const diagnostics = await __settleLspWorkerForTests(worker, LSP_LIMITS.parentTimeoutMs);

    expect(diagnostics.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'src/lib.ts', code: 2322, line: 4 }),
      ]),
    );
  }, 15_000);
});
