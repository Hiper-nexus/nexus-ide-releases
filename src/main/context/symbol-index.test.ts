import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import { buildProjectSymbolIndex } from './symbol-index';

const roots: string[] = [];

function fixture(): { root: string; scope: ProjectExecutionScope } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-symbols-')));
  roots.push(root);
  return {
    root,
    scope: {
      version: 1, installationId: 'install-a', projectId: 'project-a',
      checkoutId: 'checkout-a', rootRealPath: root, identitySource: 'manifest',
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('project symbol index', () => {
  it('skips nested Claude worktrees but indexes their source when opened directly', () => {
    const { root, scope } = fixture();
    const nested = path.join(root, '.claude', 'worktrees', 'writer');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(root, 'app.ts'), 'class CurrentProject {}');
    fs.writeFileSync(path.join(root, '.claude', 'hook.ts'), 'function localHook() {}');
    fs.writeFileSync(path.join(nested, 'app.ts'), 'class OtherCheckout {}');

    const result = buildProjectSymbolIndex(scope);
    expect(result.filesScanned).toBe(2);
    expect(result.symbols.has('CurrentProject')).toBe(true);
    expect(result.symbols.has('localHook')).toBe(true);
    expect(result.symbols.has('OtherCheckout')).toBe(false);
    expect(buildProjectSymbolIndex({ ...scope, rootRealPath: nested }).symbols.has('OtherCheckout')).toBe(true);
  });

  it('derives real declarations without indexing dependencies', () => {
    const { root, scope } = fixture();
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src/domain.ts'),
      'export interface InvoicePolicy {}\nexport function settleInvoice() {}\n');
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.writeFileSync(path.join(root, 'node_modules/ignored.ts'), 'class NotOurSymbol {}');
    fs.mkdirSync(path.join(root, '.nexus-memory'));
    fs.writeFileSync(
      path.join(root, '.nexus-memory/generated.ts'),
      'class MemoryProjectionMustNotBeIndexed {}',
    );

    const result = buildProjectSymbolIndex(scope);
    expect(result.symbols.has('InvoicePolicy')).toBe(true);
    expect(result.symbols.has('settleInvoice')).toBe(true);
    expect(result.symbols.has('NotOurSymbol')).toBe(false);
    expect(result.symbols.has('MemoryProjectionMustNotBeIndexed')).toBe(false);
  });

  it('does not follow source-tree symlinks', () => {
    const { root, scope } = fixture();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-symbols-outside-'));
    roots.push(outside);
    fs.writeFileSync(path.join(outside, 'secret.ts'), 'class LeakedSymbol {}');
    fs.symlinkSync(outside, path.join(root, 'linked'));

    expect(buildProjectSymbolIndex(scope).symbols.has('LeakedSymbol')).toBe(false);
  });
});
