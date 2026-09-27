import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectExecutionScope } from '../../../shared/types';
import {
  loadTsconfigAliases,
  resolveAliasCandidateBases,
} from './orientation-tsconfig';

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
