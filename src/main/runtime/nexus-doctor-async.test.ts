import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import { inspectNexusReadinessAsync } from './nexus-doctor-async';

const roots: string[] = [];

function fixture(): {
  readonly root: string;
  readonly scope: ProjectExecutionScope;
} {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-doctor-async-')),
  );
  roots.push(root);
  fs.mkdirSync(path.join(root, '.context', 'config'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.context', 'config', 'sensors.json'),
    JSON.stringify({
      schemaVersion: 1,
      sensors: [
        {
          id: 'typecheck',
          command: ['npm', 'run', 'typecheck'],
          timeoutMs: 60_000,
          network: false,
        },
        {
          id: 'unit',
          command: ['npm', 'test'],
          timeoutMs: 60_000,
          network: false,
        },
      ],
    }),
  );
  return {
    root,
    scope: {
      version: 1,
      installationId: 'install-async',
      projectId: 'project-async',
      checkoutId: 'checkout-async',
      rootRealPath: root,
      identitySource: 'provisional',
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('inspectNexusReadinessAsync', () => {
  it('does not occupy the main loop while Git diagnostics are pending', async () => {
    const { scope } = fixture();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = inspectNexusReadinessAsync({
      scope,
      platform: 'darwin',
      asyncGit: {
        run: async (_cwd, args) => {
          await gate;
          const command = args.join(' ');
          if (command.includes('--is-inside-work-tree')) {
            return { status: 0, stdout: 'true\n', stderr: '' };
          }
          if (command.includes('status --porcelain')) {
            return { status: 0, stdout: '', stderr: '' };
          }
          return { status: 1, stdout: '', stderr: '' };
        },
      },
      inspectContext: () => ({
        ready: true,
        blockers: [],
        warnings: [],
        sensorIds: ['typecheck', 'unit'],
      }),
      listProviders: () => [],
      multiPc: {
        leaseBackendConfigured: false,
        syncBackendConfigured: false,
        requireSharedExecution: false,
      },
      pathExecutable: () => true,
    });

    await expect(
      new Promise<string>((resolve) => setImmediate(() => resolve('free'))),
    ).resolves.toBe('free');
    release?.();
    const report = await pending;
    expect(report.checks.find((check) => check.check === 'git')).toMatchObject({
      ok: true,
      findings: [],
    });
  });
});
