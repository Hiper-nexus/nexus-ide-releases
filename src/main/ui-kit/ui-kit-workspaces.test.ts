import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listUiKitWorkspaces, resolveUiKitWorkspace } from './ui-kit-workspaces';

let root = '';
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ui-kit-ws-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function pkgAt(rel: string, value: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.join(root, rel), { recursive: true });
  fs.writeFileSync(path.join(root, rel, 'package.json'), JSON.stringify(value));
}

describe('listUiKitWorkspaces', () => {
  it('reads npm/yarn workspaces and keeps only real packages', () => {
    pkgAt('.', { workspaces: ['apps/*', 'packages/ui'] });
    pkgAt('apps/web');
    pkgAt('apps/admin');
    fs.mkdirSync(path.join(root, 'apps/notes'), { recursive: true }); // no package.json
    pkgAt('packages/ui');

    expect(listUiKitWorkspaces(root)).toEqual(['apps/admin', 'apps/web', 'packages/ui']);
  });

  it('reads pnpm-workspace.yaml, with exclusions', () => {
    pkgAt('.');
    fs.writeFileSync(
      path.join(root, 'pnpm-workspace.yaml'),
      "packages:\n  - 'apps/*'\n  - \"!apps/legacy\"\n# comment\ncatalog:\n  react: ^19\n",
    );
    pkgAt('apps/web');
    pkgAt('apps/legacy');

    expect(listUiKitWorkspaces(root)).toEqual(['apps/web']);
  });

  it('never offers a path that leaves the project', () => {
    pkgAt('.', { workspaces: ['../outside', '/etc', 'apps/*'] });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ui-kit-ws-out-'));
    try {
      fs.writeFileSync(path.join(outside, 'package.json'), '{}');
      fs.mkdirSync(path.join(root, 'apps'), { recursive: true });
      fs.symlinkSync(outside, path.join(root, 'apps', 'escape'), 'dir');

      expect(listUiKitWorkspaces(root)).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('resolveUiKitWorkspace', () => {
  it('runs at the root when none is named', () => {
    expect(resolveUiKitWorkspace(root, undefined)).toBe(root);
  });

  it('runs in a declared package', () => {
    pkgAt('.', { workspaces: ['apps/*'] });
    pkgAt('apps/web');

    expect(resolveUiKitWorkspace(root, 'apps/web')).toBe(path.join(root, 'apps/web'));
  });

  it('refuses anything not on the list, naming the list', () => {
    pkgAt('.', { workspaces: ['apps/*'] });
    pkgAt('apps/web');

    expect(() => resolveUiKitWorkspace(root, 'src')).toThrow(/declares apps\/web/);
    expect(() => resolveUiKitWorkspace(root, '../x')).toThrow(/unknown workspace/);
  });
});
