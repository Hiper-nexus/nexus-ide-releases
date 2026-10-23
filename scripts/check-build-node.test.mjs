import { describe, expect, it } from 'vitest';

import { validateBuildNodeVersion } from './check-build-node.mjs';

describe('release Node version contract', () => {
  it('accepts Node 22.23.4+ within the pinned major', () => {
    expect(validateBuildNodeVersion('22.23.4')).toBe(true);
    expect(validateBuildNodeVersion('v22.23.4')).toBe(true);
    expect(validateBuildNodeVersion('22.24.0')).toBe(true);
  });

  it.each(['20.19.0', '22.11.0', '22.12.0', '22.23.3', '23.0.0', 'invalid'])(
    'rejects unsupported runtime %s',
    (version) => {
      expect(validateBuildNodeVersion(version)).toBe(false);
    },
  );
});

describe('release node_modules layout contract', () => {
  it('flags a symlinked node_modules and accepts a real directory', async () => {
    const { mkdtempSync, mkdirSync, symlinkSync, rmSync } = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { isNodeModulesSymlink } = await import('./check-build-node.mjs');

    const root = mkdtempSync(path.join(os.tmpdir(), 'check-build-node-'));
    try {
      const realTree = path.join(root, 'real');
      mkdirSync(path.join(realTree, 'node_modules'), { recursive: true });
      expect(isNodeModulesSymlink(realTree)).toBe(false);

      const linkedTree = path.join(root, 'linked');
      mkdirSync(linkedTree, { recursive: true });
      symlinkSync(
        path.join(realTree, 'node_modules'),
        path.join(linkedTree, 'node_modules'),
      );
      expect(isNodeModulesSymlink(linkedTree)).toBe(true);

      expect(isNodeModulesSymlink(path.join(root, 'missing'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
