import { describe, expect, it } from 'vitest';
import { normalizeOrientationChangedPath } from './orientation-path-policy';

describe('orientation changed-path policy', () => {
  it('keeps project files and rejects generated, dependency, worktree and unsafe paths', () => {
    expect(normalizeOrientationChangedPath('src/domain/order.ts')).toBe(
      'src/domain/order.ts',
    );
    expect(normalizeOrientationChangedPath('./src\\domain\\order.ts')).toBe(
      'src/domain/order.ts',
    );

    for (const excluded of [
      '.dev-user-data/cache/generated.ts',
      '.worktrees/task/generated.ts',
      '.nexus-memory/mem-generated.ts',
      'worktrees/task/generated.ts',
      'node_modules/pkg/index.ts',
      'packages/app/node_modules/pkg/index.ts',
      'dist/index.js',
      'packages/app/dist/index.js',
      'build/index.js',
      'out/index.js',
      '.claude/worktrees/task/index.ts',
      '../outside.ts',
      '/absolute.ts',
      'src/.env',
      'src/key.pem',
    ]) {
      expect(
        normalizeOrientationChangedPath(excluded),
        `${excluded} leaked into incremental orientation`,
      ).toBeNull();
    }
  });
});
