// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { ProjectExecutionScope } from '../../../shared/types';
import { DEFAULT_ORIENTATION_LIMITS, type OrientationLimits } from './orientation-types';
import { walkOrientationTree, walkOrientationTreeAsync } from './orientation-walker';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

function scopeFor(root: string): ProjectExecutionScope {
  return Object.freeze({ version: 1, installationId: 'i', projectId: 'p', checkoutId: 'c', rootRealPath: root, identitySource: 'provisional' as const });
}

function write(root: string, relative: string, content: string): void {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

/** As duas implementações do walker têm de concordar. */
async function walkBoth(root: string, limits: OrientationLimits) {
  const scope = scopeFor(root);
  return {
    sync: walkOrientationTree(scope, limits),
    async: await walkOrientationTreeAsync(scope, limits),
  };
}

it('não gasta o orçamento de bytes com arquivos que nunca lê', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-walk-')));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'assets'));
  fs.mkdirSync(path.join(root, 'src/main'), { recursive: true });
  fs.writeFileSync(path.join(root, 'assets/shot.png'), Buffer.alloc(4096));
  fs.writeFileSync(path.join(root, 'src/main/updater.ts'), 'export const x = 1;\n');
  const scope = Object.freeze({ version: 1, installationId: 'i', projectId: 'p', checkoutId: 'c', rootRealPath: root, identitySource: 'provisional' as const });
  const walk = await walkOrientationTreeAsync(scope, { ...DEFAULT_ORIENTATION_LIMITS, maxTotalBytes: 1024 });
  expect(walk.truncated).toBe(false);
  expect(walk.files.map((f) => f.relativePath)).toContain('src/main/updater.ts');
});

it('F-1322: worktree antiga em .harvest não consome o orçamento nem trunca o mapa', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-walk-harvest-')));
  roots.push(root);
  write(root, 'src/current.ts', 'export const current = 1;\n');
  write(root, '.harvest/old/.git', 'gitdir: /nonexistent\n');
  for (let i = 0; i < 8; i += 1) {
    write(root, `.harvest/old/src/foreign-${i}.ts`, `export const foreign${i} = 0;\n`);
  }

  for (const walk of Object.values(await walkBoth(root, { ...DEFAULT_ORIENTATION_LIMITS, maxFiles: 3 }))) {
    expect(walk.truncated).toBe(false);
    expect(walk.files.map((f) => f.relativePath)).toEqual(['src/current.ts']);
  }
});

it('F-1322: qualquer filho que seja raiz de outro checkout git é fronteira', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-walk-nested-')));
  roots.push(root);
  write(root, 'src/current.ts', 'export const current = 1;\n');
  // Nome fora do SKIP_DIRECTORIES: só a regra genérica de `.git` segura.
  fs.mkdirSync(path.join(root, 'legacy-checkout/.git'), { recursive: true });
  write(root, 'legacy-checkout/src/old.ts', 'export const old = 0;\n');

  for (const walk of Object.values(await walkBoth(root, { ...DEFAULT_ORIENTATION_LIMITS, maxFiles: 3 }))) {
    expect(walk.truncated).toBe(false);
    expect(walk.files.map((f) => f.relativePath)).toEqual(['src/current.ts']);
  }
});
