import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStorageHygienePolicyForTest } from './hygiene-policy';
import { StorageHygieneService, type StorageHygieneDeps } from './storage-hygiene-service';
import type { StorageTarget } from './storage-targets';
import { EMPTY_SWEEP } from './stale-sweep';

vi.mock('../observability/main-trace', () => ({ trace: vi.fn() }));

const GiB = 1024 ** 3;
let base: string;

function deps(overrides: Partial<StorageHygieneDeps> = {}): StorageHygieneDeps {
  return {
    roots: {
      userDataDir: path.join(base, 'userData'),
      logsDir: path.join(base, 'logs'),
      homeDir: path.join(base, 'home'),
      tempDir: path.join(base, 'tmp'),
    },
    liveSessionKeys: () => new Set(),
    livePartitionNames: () => new Set(),
    sampleDisk: async () => ({ freeBytes: 200 * GiB, totalBytes: 500 * GiB, sampledAt: 1 }),
    targets: [],
    ...overrides,
  };
}

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-hygiene-service-')));
  fs.mkdirSync(path.join(base, 'userData'), { recursive: true });
  resetStorageHygienePolicyForTest();
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(base, { recursive: true, force: true });
  resetStorageHygienePolicyForTest();
});

describe('StorageHygieneService', () => {
  it('limpeza manual usa no mínimo os prazos de disco apertado e grava o relatório', async () => {
    const seen: string[] = [];
    const worktrees = vi.fn(async (policy) => {
      seen.push(policy.pressure);
      return { trimmed: 2, removed: 3, retired: 1, kept: 4, scopes: 1, retiredWorktrees: [
        { branch: 'nexus/a/b', ref: 'refs/nexus-salvage/nexus/a/b/20261020T000000000Z', commit: 'c'.repeat(40) },
      ] };
    });
    const target: StorageTarget = {
      id: 'fake', label: 'Fake',
      run: async ({ policy }) => {
        seen.push(`target:${policy.pressure}`);
        return { removed: 5, freedBytes: 1024, kept: 0, errors: 0, deferred: 0 };
      },
    };
    const service = new StorageHygieneService(deps({ worktrees, targets: [target] }));
    const run = await service.runNow('manual');
    expect(seen).toEqual(['low', 'target:low']);
    expect(run).toMatchObject({ trigger: 'manual', pressure: 'low', freedBytes: 1024, diskFreeDeltaBytes: 0 });
    expect(run.steps.map((step) => step.id)).toEqual(['agent-worktrees', 'fake']);
    expect(run.steps[0]).toMatchObject({ removed: 3, kept: 4, detail: expect.stringContaining('1 aposentada') });
    // Aposentada some do disco: o relatório diz onde o trabalho ficou e como trazer.
    expect(run.steps[0]!.detail).toContain('nexus/a/b → refs/nexus-salvage/nexus/a/b/20261020T000000000Z');
    expect(run.steps[0]!.detail).toContain(`git cherry-pick ${'c'.repeat(12)}`);
    await service.idle();
    const persisted = JSON.parse(fs.readFileSync(path.join(base, 'userData', 'storage-hygiene.json'), 'utf8'));
    expect(persisted.lastRun.freedBytes).toBe(1024);
    expect(persisted.categories.length).toBeGreaterThan(0);
    // Uma instância nova lê o relatório gravado.
    const reloaded = await new StorageHygieneService(deps()).report();
    expect(reloaded.lastRun?.trigger).toBe('manual');
    service.dispose();
  });

  it('um passo que falha vira erro no relatório e os outros seguem', async () => {
    const boom: StorageTarget = { id: 'boom', label: 'Boom', run: async () => { throw new Error('EACCES'); } };
    const ok: StorageTarget = { id: 'ok', label: 'Ok', run: async () => ({ ...EMPTY_SWEEP, removed: 1 }) };
    const service = new StorageHygieneService(deps({
      targets: [boom, ok],
      worktrees: async () => { throw new Error('git travou'); },
    }));
    const run = await service.runNow('scheduled');
    expect(run.steps).toEqual([
      expect.objectContaining({ id: 'agent-worktrees', error: 'git travou' }),
      expect.objectContaining({ id: 'boom', error: 'EACCES' }),
      expect.objectContaining({ id: 'ok', removed: 1 }),
    ]);
    service.dispose();
  });

  it('rodada única: quem chama durante uma rodada recebe a mesma', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const target: StorageTarget = { id: 'slow', label: 'Slow', run: async () => { await gate; return EMPTY_SWEEP; } };
    const service = new StorageHygieneService(deps({ targets: [target] }));
    const first = service.runNow('scheduled');
    const second = service.runNow('manual');
    expect(second).toBe(first);
    expect((await service.report()).running).toBe(true);
    release();
    await first;
    expect((await service.report()).running).toBe(false);
    service.dispose();
  });

  it('disco crítico: limpa o cache HTTP e volta na cadência curta', async () => {
    const clearHttpCaches = vi.fn(async () => undefined);
    const service = new StorageHygieneService(deps({
      clearHttpCaches,
      sampleDisk: async () => ({ freeBytes: 2 * GiB, totalBytes: 500 * GiB, sampledAt: 1 }),
    }));
    const before = Date.now();
    const run = await service.runNow('scheduled');
    expect(run.pressure).toBe('critical');
    expect(clearHttpCaches).toHaveBeenCalledTimes(1);
    const report = await service.report();
    expect(report.pressure).toBe('critical');
    expect(report.nextRunAt! - before).toBeLessThanOrEqual(20 * 60_000 + 1_000);
    service.dispose();
  });

  it('com folga não esvazia o cache HTTP; start arma a primeira rodada adiada', async () => {
    vi.useFakeTimers();
    const clearHttpCaches = vi.fn(async () => undefined);
    const target: StorageTarget = { id: 't', label: 'T', run: vi.fn(async () => EMPTY_SWEEP) };
    const service = new StorageHygieneService(deps({ clearHttpCaches, targets: [target], firstRunDelayMs: 1_000 }));
    service.start();
    expect(target.run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    await service.idle();
    expect(target.run).toHaveBeenCalledTimes(1);
    expect(clearHttpCaches).not.toHaveBeenCalled();
    service.dispose();
  });
});
