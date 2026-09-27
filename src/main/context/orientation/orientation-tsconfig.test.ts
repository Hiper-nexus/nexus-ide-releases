import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectExecutionScope } from '../../../shared/types';
import {
  loadTsconfigAliases,
  resolveAliasCandidateBases,
} from './orientation-tsconfig';
import { ProjectOrientationService } from './orientation-service';

const roots: string[] = [];

function scopeFor(root: string): ProjectExecutionScope {
  return Object.freeze({
    version: 1,
    installationId: 'install-tsconfig',
    projectId: 'project-tsconfig',
    checkoutId: 'checkout-tsconfig',
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

describe('loadTsconfigAliases', () => {
  it('reads baseUrl + paths, tolerating JSONC comments', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-tsconfig-')));
    roots.push(root);
    write(
      root,
      'tsconfig.json',
      `{
        // comment
        "compilerOptions": {
          "baseUrl": ".",
          /* block comment */
          "paths": { "@/*": ["./src/*"] },
        },
      }`,
    );
    const aliases = loadTsconfigAliases(scopeFor(root));
    expect(aliases?.baseUrl).toBe('.');
    expect(aliases?.paths.get('@/*')).toEqual(['./src/*']);
  });

  it('follows a relative extends chain to inherit paths', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-tsconfig-extends-')));
    roots.push(root);
    write(root, 'tsconfig.base.json', JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } },
    }));
    write(root, 'tsconfig.json', JSON.stringify({ extends: './tsconfig.base.json' }));
    const aliases = loadTsconfigAliases(scopeFor(root));
    expect(aliases?.paths.get('@/*')).toEqual(['./src/*']);
  });

  it('accepts an extends array (TS 5), skipping package entries and applying relative ones in order', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-tsconfig-array-')));
    roots.push(root);
    write(root, 'tsconfig.a.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['./a/*'] } } }));
    write(root, 'tsconfig.b.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['./b/*'] } } }));
    write(root, 'tsconfig.json', JSON.stringify({
      extends: ['@tsconfig/node20/tsconfig.json', './tsconfig.a.json', './tsconfig.b.json'],
    }));
    const aliases = loadTsconfigAliases(scopeFor(root));
    expect(aliases && resolveAliasCandidateBases('@/x', aliases)).toEqual(['b/x']);
  });

  it('never throws on a non-object tsconfig', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-tsconfig-null-')));
    roots.push(root);
    write(root, 'tsconfig.json', 'null');
    expect(loadTsconfigAliases(scopeFor(root))).toBeNull();
    write(root, 'tsconfig.json', JSON.stringify({ extends: 42, compilerOptions: { paths: [] } }));
    expect(loadTsconfigAliases(scopeFor(root))).toBeNull();
  });

  it('resolves baseUrl relative to the inherited config that declares it', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-tsconfig-dir-')));
    roots.push(root);
    write(root, 'config/base.json', JSON.stringify({
      compilerOptions: { baseUrl: '..', paths: { '@/*': ['src/*'] } },
    }));
    write(root, 'tsconfig.json', JSON.stringify({ extends: './config/base.json' }));
    const aliases = loadTsconfigAliases(scopeFor(root));
    expect(aliases && resolveAliasCandidateBases('@/foo', aliases)).toEqual(['src/foo']);
  });

  it('resolves paths without baseUrl relative to the config that declares them', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-tsconfig-nobase-')));
    roots.push(root);
    write(root, 'config/paths.json', JSON.stringify({
      compilerOptions: { paths: { '@/*': ['../src/*'] } },
    }));
    write(root, 'tsconfig.json', JSON.stringify({ extends: './config/paths.json' }));
    const aliases = loadTsconfigAliases(scopeFor(root));
    expect(aliases && resolveAliasCandidateBases('@/foo', aliases)).toEqual(['src/foo']);
  });

  it('a tsconfig with an extends array does not fail the whole orientation map', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-tsconfig-map-')));
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-tsconfig-map-cache-'));
    roots.push(root, cacheRoot);
    write(root, 'package.json', JSON.stringify({ name: 'x' }));
    write(root, 'tsconfig.json', JSON.stringify({ extends: ['./a.json', './b.json'] }));
    write(root, 'src/a.ts', "import { b } from './b';\nexport const a = b;");
    write(root, 'src/b.ts', 'export const b = 1;');
    const service = new ProjectOrientationService({ cacheRoot, includeContextSummary: false });
    const map = await service.ensure(scopeFor(root), { reason: 'workspace-open' });
    expect(map.status).toBe('ready');
    expect(map.graph.edgeCount).toBe(1);
  });

  it('returns null when there is no tsconfig or no paths configured', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-tsconfig-none-')));
    roots.push(root);
    expect(loadTsconfigAliases(scopeFor(root))).toBeNull();
    write(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { strict: true } }));
    expect(loadTsconfigAliases(scopeFor(root))).toBeNull();
  });
});

describe('resolveAliasCandidateBases', () => {
  it('substitutes the wildcard into every target pattern, joined with baseUrl', () => {
    const bases = resolveAliasCandidateBases('@/foo/bar', {
      baseUrl: '.',
      paths: new Map([['@/*', ['./src/*']]]),
    });
    expect(bases).toEqual(['src/foo/bar']);
  });

  it('supports an exact (non-wildcard) alias', () => {
    const bases = resolveAliasCandidateBases('zod', {
      baseUrl: '.',
      paths: new Map([['zod', ['./node_modules/zod']]]),
    });
    expect(bases).toEqual(['node_modules/zod']);
  });

  it('does not match a specifier the prefix does not cover', () => {
    const bases = resolveAliasCandidateBases('other/thing', {
      baseUrl: '.',
      paths: new Map([['@/*', ['./src/*']]]),
    });
    expect(bases).toEqual([]);
  });
});
