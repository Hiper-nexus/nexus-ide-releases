import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createDevEnvironment,
  runDevNativeLifecycle,
} from './dev-runtime.mjs';

describe('createDevEnvironment', () => {
  it('isolates development data from the installed application by default', () => {
    const repoRoot = path.resolve('/workspace/nexus-ide');

    const env = createDevEnvironment({ HOME: '/Users/test' }, repoRoot);

    expect(env.NEXUS_USER_DATA_DIR).toBe(
      path.join(repoRoot, '.dev-user-data'),
    );
  });

  it('keeps an explicit absolute userData override', () => {
    const env = createDevEnvironment(
      { NEXUS_USER_DATA_DIR: '/tmp/nexus-custom' },
      '/workspace/nexus-ide',
    );

    expect(env.NEXUS_USER_DATA_DIR).toBe('/tmp/nexus-custom');
  });

  it('normalizes an explicit relative userData override against the repo', () => {
    const env = createDevEnvironment(
      { NEXUS_USER_DATA_DIR: '.local/dev-data' },
      '/workspace/nexus-ide',
    );

    expect(env.NEXUS_USER_DATA_DIR).toBe(
      path.resolve('/workspace/nexus-ide/.local/dev-data'),
    );
  });
});

describe('runDevNativeLifecycle', () => {
  it('rebuilds for Electron before Forge and restores the Node ABI afterward', async () => {
    const calls = [];

    const result = await runDevNativeLifecycle({
      rebuildElectron: async () => calls.push('electron'),
      startForge: async () => {
        calls.push('forge');
        return { code: 0, signal: null };
      },
      rebuildNode: async () => calls.push('node'),
    });

    expect(calls).toEqual(['electron', 'forge', 'node']);
    expect(result).toEqual({ code: 0, signal: null });
  });

  it('restores the Node ABI when Forge exits unsuccessfully', async () => {
    const calls = [];

    const result = await runDevNativeLifecycle({
      rebuildElectron: async () => calls.push('electron'),
      startForge: async () => {
        calls.push('forge');
        return { code: 7, signal: null };
      },
      rebuildNode: async () => calls.push('node'),
    });

    expect(calls).toEqual(['electron', 'forge', 'node']);
    expect(result).toEqual({ code: 7, signal: null });
  });

  it('restores the Node ABI before returning a Forge signal', async () => {
    const calls = [];

    const result = await runDevNativeLifecycle({
      rebuildElectron: async () => calls.push('electron'),
      startForge: async () => {
        calls.push('forge');
        return { code: 1, signal: 'SIGINT' };
      },
      rebuildNode: async () => calls.push('node'),
    });

    expect(calls).toEqual(['electron', 'forge', 'node']);
    expect(result).toEqual({ code: 1, signal: 'SIGINT' });
  });

  it('restores the Node ABI even when the Electron rebuild fails', async () => {
    const rebuildError = new Error('electron rebuild failed');
    const rebuildNode = vi.fn(async () => undefined);

    await expect(
      runDevNativeLifecycle({
        rebuildElectron: async () => {
          throw rebuildError;
        },
        startForge: vi.fn(),
        rebuildNode,
      }),
    ).rejects.toBe(rebuildError);

    expect(rebuildNode).toHaveBeenCalledOnce();
  });

  it('does not hide the primary failure when restoring Node also fails', async () => {
    const primaryError = new Error('electron rebuild failed');
    const restoreError = new Error('node restore failed');
    const onRestoreError = vi.fn();

    await expect(
      runDevNativeLifecycle({
        rebuildElectron: async () => {
          throw primaryError;
        },
        startForge: vi.fn(),
        rebuildNode: async () => {
          throw restoreError;
        },
        onRestoreError,
      }),
    ).rejects.toBe(primaryError);

    expect(onRestoreError).toHaveBeenCalledExactlyOnceWith(restoreError);
  });

  it('fails a clean dev session when the Node ABI cannot be restored', async () => {
    const restoreError = new Error('node restore failed');

    await expect(
      runDevNativeLifecycle({
        rebuildElectron: async () => undefined,
        startForge: async () => ({ code: 0, signal: null }),
        rebuildNode: async () => {
          throw restoreError;
        },
      }),
    ).rejects.toBe(restoreError);
  });
});
