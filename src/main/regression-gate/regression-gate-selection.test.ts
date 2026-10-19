import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import { ProcessGitRunner } from '../runtime/git-command';
import {
  __resetImportFactMemoryForTests,
  __resetRegressionGateForTests,
  computeImpactedTests,
  externalDependencyReads,
  getImportFactStats,
} from './regression-gate';
import { summarizeRegressionGate } from './regression-gate-handoff';
import { configureImportStoreDir } from './regression-gate-import-store';
import { extractRemovedLiterals } from './regression-gate-selection';

const dirs: string[] = [];
const git = new ProcessGitRunner();

afterEach(() => {
  configureImportStoreDir(undefined);
  __resetRegressionGateForTests();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

function write(root: string, file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
}

function commitAll(root: string, message = 'fixture'): void {
  git.run(root, ['add', '-A']);
  git.run(root, ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', message]);
}

function repo(files: Record<string, string>) {
  const root = tempDir('nexus-gate-selection-');
  git.run(root, ['init', '-q']);
  for (const [file, content] of Object.entries(files)) write(root, file, content);
  commitAll(root);
  const scope: ProjectExecutionScope = {
    version: 1,
    installationId: 'install-a',
    projectId: 'project-a',
    checkoutId: 'checkout-a',
    rootRealPath: root,
    identitySource: 'manifest',
  };
  return { root, scope };
}

describe('cache persistido do mapa de imports', () => {
  it('o 2º handoff não remapeia: processo novo lê o disco e só revalida por hash quando o mtime muda', async () => {
    const storeDir = tempDir('nexus-gate-store-');
    configureImportStoreDir(storeDir);
    const { root, scope } = repo({
      'src/a.ts': 'export const a = 1;\n',
      'src/a.test.ts': "import { a } from './a';\n",
      'src/b.ts': "import { a } from './a';\nexport const b = a;\n",
      'src/b.test.ts': "import { b } from './b';\n",
    });

    const first = await computeImpactedTests(scope, ['src/a.ts']);
    expect(getImportFactStats().parsed).toBeGreaterThan(0);
    expect(fs.readdirSync(storeDir).some((name) => name.endsWith('.json'))).toBe(true);

    // Processo novo: memória vazia, disco intacto.
    __resetImportFactMemoryForTests();
    const second = await computeImpactedTests(scope, ['src/a.ts']);
    expect(getImportFactStats().parsed).toBe(0);
    expect(getImportFactStats().hits).toBeGreaterThan(0);
    expect(second.tests).toEqual(first.tests);

    // Só o mtime muda (mesmo conteúdo): o hash evita reanalisar.
    const bumped = new Date(Date.now() + 5_000);
    fs.utimesSync(path.join(root, 'src/b.ts'), bumped, bumped);
    __resetImportFactMemoryForTests();
    const third = await computeImpactedTests(scope, ['src/a.ts']);
    expect(getImportFactStats().parsed).toBe(0);
    expect(getImportFactStats().revalidated).toBe(1);
    expect(third.tests).toEqual(first.tests);

    // Conteúdo diferente com o mtime novo: reanalisa e não serve grafo velho.
    write(root, 'src/b.ts', 'export const b = 2;\n');
    const later = new Date(Date.now() + 10_000);
    fs.utimesSync(path.join(root, 'src/b.ts'), later, later);
    const fourth = await computeImpactedTests(scope, ['src/a.ts']);
    expect(getImportFactStats().parsed).toBe(1);
    expect(fourth.tests).not.toContain('src/b.test.ts');
  });
});

describe('seleção por prioridade', () => {
  it('extractRemovedLiterals traz só literais removidos/alterados, fora de imports e de testes', () => {
    const diff = [
      'diff --git a/src/x.ts b/src/x.ts',
      '--- a/src/x.ts',
      '+++ b/src/x.ts',
      '@@ -1,4 +1,4 @@',
      "-import { y } from './muito-longo-caminho';",
      "-export const msg = 'mensagem antiga do sistema';",
      "-export const keep = 'texto que continua igual';",
      "+export const msg = 'mensagem nova do sistema';",
      "+export const keep = 'texto que continua igual';",
      'diff --git a/src/x.test.ts b/src/x.test.ts',
      '--- a/src/x.test.ts',
      '+++ b/src/x.test.ts',
      "-it('nome antigo do teste', () => {});",
    ].join('\n');
    expect(extractRemovedLiterals(diff)).toEqual(['mensagem antiga do sistema']);
  });

  it('inclui o .test irmão (distância 0) e o teste que contém o literal removido (entre 1 e 2)', async () => {
    const { root, scope } = repo({
      'src/x.ts': "export const msg = 'mensagem antiga do sistema';\n",
      'src/x.test.ts': "import { msg } from './x';\n",
      'src/z.test.ts': "it('mensagem antiga do sistema', () => {});\n",
      'src/w.test.ts': "it('nada a ver', () => {});\n",
    });
    write(root, 'src/x.ts', "export const msg = 'mensagem nova do sistema';\n");

    const impacted = await computeImpactedTests(scope, ['src/x.ts'], [], [], false, undefined, undefined, {
      git,
      baseSha: null,
    });

    expect(impacted.tests).toContain('src/x.test.ts');
    expect(impacted.tests).toContain('src/z.test.ts');
    expect(impacted.tests).not.toContain('src/w.test.ts');
    expect(impacted.distances.get('src/x.test.ts')).toBe(0);
    expect(impacted.distances.get('src/z.test.ts')).toBeGreaterThan(1);
    expect(impacted.distances.get('src/z.test.ts')).toBeLessThan(2);
  });

  it('mapa estourado: roda o .test irmão e os testes achados por git grep do basename importado', async () => {
    const { root, scope } = repo({
      'src/lib.ts': 'export const lib = 1;\n',
      'src/lib.test.ts': "import { lib } from './lib';\n",
      'src/user.test.ts': "import { lib } from './lib';\n",
      'src/other.test.ts': "import { o } from './other';\n",
    });
    write(root, 'src/lib.ts', 'export const lib = 2;\n');
    const expired = { deadline: 0, now: () => 1 };

    const without = await computeImpactedTests(scope, ['src/lib.ts'], [], [], false, undefined, expired);
    expect(without.mapDeadlineHit).toBe(true);
    expect(without.tests).toEqual(['src/lib.test.ts']);

    const withGrep = await computeImpactedTests(scope, ['src/lib.ts'], [], [], false, undefined, expired, {
      git,
      baseSha: null,
    });
    expect(withGrep.mapDeadlineHit).toBe(true);
    expect(withGrep.tests).toEqual(expect.arrayContaining(['src/lib.test.ts', 'src/user.test.ts']));
    expect(withGrep.tests).not.toContain('src/other.test.ts');
    expect(withGrep.distances.get('src/user.test.ts')).toBe(1);
  });
});

describe('node_modules em symlink', () => {
  function sameRepoWorktrees() {
    const main = repo({ 'package.json': '{}\n', '.gitignore': 'node_modules\n' });
    write(main.root, 'node_modules/.bin/vitest', '#!/bin/sh\n');
    const worktree = path.join(tempDir('nexus-gate-wt-'), 'wt');
    git.run(main.root, ['worktree', 'add', '-q', '-b', 'gate-wt-test', worktree]);
    return { main, worktree: fs.realpathSync(worktree) };
  }

  it('aceita o node_modules de outra worktree do MESMO repositório', () => {
    const { main, worktree } = sameRepoWorktrees();
    fs.symlinkSync(path.join(main.root, 'node_modules'), path.join(worktree, 'node_modules'));

    const result = externalDependencyReads(worktree, worktree, undefined);

    expect(result.rejected).toBeNull();
    expect(result.reads).toEqual([fs.realpathSync(path.join(main.root, 'node_modules'))]);
  });

  it('recusa node_modules fora do repositório e de outro repositório', () => {
    const { worktree } = sameRepoWorktrees();
    const outside = tempDir('nexus-gate-outside-');
    fs.mkdirSync(path.join(outside, 'node_modules'));
    fs.symlinkSync(path.join(outside, 'node_modules'), path.join(worktree, 'node_modules'));
    expect(externalDependencyReads(worktree, worktree, undefined)).toEqual({ reads: [], rejected: 'node_modules' });

    fs.rmSync(path.join(worktree, 'node_modules'));
    const other = repo({ 'package.json': '{}\n' });
    fs.mkdirSync(path.join(other.root, 'node_modules'));
    fs.symlinkSync(path.join(other.root, 'node_modules'), path.join(worktree, 'node_modules'));
    expect(externalDependencyReads(worktree, worktree, undefined)).toEqual({ reads: [], rejected: 'node_modules' });
  });
});

describe('summary do artefato', () => {
  it('conta afetados, rodados, passaram, falharam e não rodaram', () => {
    const summary = summarizeRegressionGate({
      testsRun: ['a.test.ts', 'b.test.ts', 'c.test.ts'],
      testsNotRun: ['d.test.ts', 'e.test.ts'],
      failures: [{ file: 'b.test.ts', message: 'x' }],
    } as unknown as Parameters<typeof summarizeRegressionGate>[0]);
    expect(summary).toEqual({ affected: 5, run: 3, passed: 2, failed: 1, notRun: 2 });
  });
});
