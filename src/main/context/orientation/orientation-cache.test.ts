// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { ProjectExecutionScope } from '../../../shared/types';
import {
  orientationCacheDirectory,
  orientationCurrentPath,
} from './orientation-cache';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function scopeFor(root: string): ProjectExecutionScope {
  return Object.freeze({
    version: 1,
    installationId: 'install-cache',
    projectId: 'project-cache',
    checkoutId: 'checkout-cache',
    rootRealPath: root,
    identitySource: 'provisional' as const,
  });
}

it('F-1321: raízes físicas distintas com os mesmos ids não compartilham o cache', () => {
  const cacheRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-orient-cache-key-')),
  );
  roots.push(cacheRoot);
  const coordination = scopeFor('/coordination/root');
  const execution = scopeFor('/execution/worktree');

  expect(coordination.projectId).toBe(execution.projectId);
  expect(coordination.checkoutId).toBe(execution.checkoutId);
  expect(orientationCacheDirectory(cacheRoot, coordination)).not.toBe(
    orientationCacheDirectory(cacheRoot, execution),
  );
  expect(orientationCurrentPath(cacheRoot, coordination)).not.toBe(
    orientationCurrentPath(cacheRoot, execution),
  );
  expect(orientationCacheDirectory(cacheRoot, coordination)).toContain(
    cacheRoot,
  );
});
