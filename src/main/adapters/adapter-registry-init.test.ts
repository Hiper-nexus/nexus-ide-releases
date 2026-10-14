import fs from 'node:fs';
import { afterAll, describe, expect, it, vi } from 'vitest';

const deps = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeFs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeOs = require('node:os') as typeof import('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require('node:path') as typeof import('node:path');
  return {
    home: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'adapter-registry-init-')),
    warm: vi.fn(async () => 0),
  };
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const homedir = () => deps.home;
  return { ...actual, homedir, default: { ...actual, homedir } };
});
vi.mock('../path-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../path-resolver')>()),
  warmCliBinaryVersions: deps.warm,
}));

import { closeAdapterRegistry, initAdapterRegistry } from './adapter-registry';
import { getPostBootIdleQueueStatus } from '../observability/post-boot-idle-queue';

afterAll(() => {
  fs.rmSync(deps.home, { recursive: true, force: true });
});

describe('initAdapterRegistry (C4)', () => {
  it('starts the CLI version probes at init, without waiting for the post-boot idle queue', async () => {
    initAdapterRegistry();
    try {
      // Probes run in child processes; restored Codex panes need the version
      // (--dangerously-bypass-hook-trust) before their 2 s spawn wait expires.
      expect(getPostBootIdleQueueStatus().bootCompleted).toBe(false);
      expect(deps.warm).toHaveBeenCalledWith({
        alsoSingle: expect.arrayContaining(['codex']),
      });
    } finally {
      await closeAdapterRegistry();
    }
  });
});
