import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import { buildScopedExecPlan, createScopedSandboxHome } from '../runtime/process-sandbox';
import { SensorBroker, type SensorProcessResult } from './sensor-broker';

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-sensor-')));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function scope(root: string): ProjectExecutionScope {
  return Object.freeze({
    version: 1,
    installationId: 'install-a',
    projectId: 'project-a',
    checkoutId: 'checkout-a',
    rootRealPath: root,
    identitySource: 'manifest',
  });
}

const gitState = {
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  diffHash: 'd'.repeat(64),
};

describe('SensorBroker', () => {
  it('runs an immutable declarative argv and emits Nexus-bound evidence', async () => {
    const root = tempRoot();
    const runProcess = vi.fn(async (): Promise<SensorProcessResult> => ({
      exitCode: 0,
      stdout: '9 tests passed\n',
      stderr: '',
      timedOut: false,
      truncated: false,
    }));
    const broker = new SensorBroker(
      [
        {
          id: 'unit',
          command: ['npm', 'test', '--', '--run'],
          timeoutMs: 30_000,
          network: false,
        },
      ],
      {
        inspectGit: async () => gitState,
        runProcess,
        now: () => 1_700_000_000_000,
        makeId: () => 'evidence-a',
      },
    );

    const evidence = await broker.run({
      scope: scope(root),
      missionId: 'mission-a',
      sensorId: 'unit',
      baseSha: gitState.baseSha,
      contractHash: 'c'.repeat(64),
      contextHash: 'e'.repeat(64),
    });

    expect(runProcess).toHaveBeenCalledWith(
      expect.objectContaining({ command: ['npm', 'test', '--', '--run'] }),
      root,
      expect.objectContaining({ projectId: 'project-a' }),
    );
    expect(evidence).toMatchObject({
      id: 'evidence-a',
      producer: 'nexus',
      projectId: 'project-a',
      checkoutId: 'checkout-a',
      missionId: 'mission-a',
      sensorId: 'unit',
      ...gitState,
      command: ['npm', 'test', '--', '--run'],
      exitCode: 0,
    });
    expect(evidence.sensorConfigHash).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.stdoutHash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(evidence)).toBe(true);
  });

  it('rejects unknown sensors, base substitutions and execution roots outside scope', async () => {
    const root = tempRoot();
    const outside = tempRoot();
    const broker = new SensorBroker(
      [{ id: 'unit', command: ['npm', 'test'], network: false }],
      {
        inspectGit: async () => gitState,
        runProcess: async () => ({
          exitCode: 0,
          stdout: '',
          stderr: '',
          timedOut: false,
          truncated: false,
        }),
      },
    );
    const input = {
      scope: scope(root),
      missionId: 'mission-a',
      sensorId: 'unit',
      baseSha: gitState.baseSha,
      contractHash: 'c'.repeat(64),
      contextHash: 'e'.repeat(64),
    };

    await expect(broker.run({ ...input, sensorId: 'fabricated' })).rejects.toThrow(
      /unknown sensor/i,
    );
    await expect(broker.run({ ...input, baseSha: 'f'.repeat(40) })).rejects.toThrow(
      /base sha/i,
    );
    await expect(broker.run({ ...input, cwd: outside })).rejects.toThrow(/escapes/i);
  });

  it('does not expose a result-registration API to agents', () => {
    const broker = new SensorBroker([], {
      inspectGit: async () => gitState,
      runProcess: async () => ({
        exitCode: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
        truncated: false,
      }),
    });
    expect('registerResult' in broker).toBe(false);
    expect('setDefinitions' in broker).toBe(false);
  });
});

describe('declarative process sandbox plan', () => {
  it.runIf(process.platform === 'darwin')('passes argv directly without a shell', () => {
    const root = tempRoot();
    const sandbox = createScopedSandboxHome({ projectId: 'p', checkoutId: 'c' });
    roots.push(sandbox.dir);
    const plan = buildScopedExecPlan({
      platform: 'darwin',
      executable: '/usr/bin/printf',
      args: ['%s', '$(touch should-not-run)'],
      cwd: root,
      rootRealPath: root,
      sandboxDir: sandbox.dir,
      env: { PATH: '/usr/bin:/bin' },
    });

    expect(plan.args.slice(-3)).toEqual([
      '/usr/bin/printf',
      '%s',
      '$(touch should-not-run)',
    ]);
    expect(plan.args).not.toContain('/bin/sh');
    expect(plan.args).not.toContain('-c');
  });
});
