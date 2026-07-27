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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

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
          command: ['npm', 'test'],
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
      expect.objectContaining({ command: ['npm', 'test'] }),
      root,
      expect.objectContaining({ projectId: 'project-a' }),
      expect.any(Object),
    );
    expect(evidence).toMatchObject({
      id: 'evidence-a',
      producer: 'nexus',
      projectId: 'project-a',
      checkoutId: 'checkout-a',
      missionId: 'mission-a',
      sensorId: 'unit',
      ...gitState,
      command: ['npm', 'test'],
      exitCode: 0,
    });
    expect(evidence.sensorConfigHash).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.stdoutHash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(evidence)).toBe(true);
  });

  it('does not mint evidence after authority is revoked during process execution', async () => {
    const root = tempRoot();
    const processResult = deferred<SensorProcessResult>();
    const runProcess = vi.fn(() => processResult.promise);
    const makeId = vi.fn(() => 'evidence-a');
    const broker = new SensorBroker(
      [{ id: 'unit', command: ['npm', 'test'], network: false }],
      {
        inspectGit: async () => gitState,
        runProcess,
        makeId,
      },
    );
    const controller = new AbortController();
    const running = broker.run(
      {
        scope: scope(root),
        missionId: 'mission-a',
        sensorId: 'unit',
        baseSha: gitState.baseSha,
        contractHash: 'c'.repeat(64),
        contextHash: 'e'.repeat(64),
      },
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(runProcess).toHaveBeenCalledOnce());
    controller.abort();
    processResult.resolve({
      exitCode: 0,
      stdout: 'passed',
      stderr: '',
      timedOut: false,
      truncated: false,
    });

    await expect(running).rejects.toThrow(/authority_revoked/i);
    expect(makeId).not.toHaveBeenCalled();
    expect(runProcess).toHaveBeenCalledWith(
      expect.any(Object),
      root,
      expect.objectContaining({ projectId: 'project-a' }),
      expect.objectContaining({ signal: controller.signal }),
    );
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
