import { describe, expect, it } from 'vitest';
import { DISK_PRESSURE_THRESHOLDS, diskPressureOf, sampleDiskSpace } from './disk-space';
import {
  currentStorageHygienePolicy,
  recordDiskSample,
  resetStorageHygienePolicyForTest,
  storageHygienePolicyFor,
  tighterPressure,
} from './hygiene-policy';

const GiB = 1024 ** 3;

describe('folga do disco', () => {
  it('crítico só pelo absoluto; apertado pelo absoluto ou pela fração', () => {
    // Disco grande: 40 GB livres de 1 TB (4%) encurtam prazos, mas não é emergência.
    expect(diskPressureOf({ freeBytes: 40 * GiB, totalBytes: 1000 * GiB })).toBe('low');
    // Notebook de 128 GB com 18 GB livres: 14% de folga, mas abaixo de 20 GB absolutos.
    expect(diskPressureOf({ freeBytes: 18 * GiB, totalBytes: 128 * GiB })).toBe('low');
    expect(diskPressureOf({ freeBytes: 4 * GiB, totalBytes: 128 * GiB })).toBe('critical');
    expect(diskPressureOf({ freeBytes: 4 * GiB, totalBytes: 4000 * GiB })).toBe('critical');
    expect(diskPressureOf({ freeBytes: 147 * GiB, totalBytes: 460 * GiB })).toBe('ok');
    expect(DISK_PRESSURE_THRESHOLDS.criticalFreeBytes).toBeLessThan(DISK_PRESSURE_THRESHOLDS.lowFreeBytes);
  });

  it('sem leitura (ou leitura absurda) não aperta nada', () => {
    expect(diskPressureOf(null)).toBe('ok');
    expect(diskPressureOf({ freeBytes: 0, totalBytes: 0 })).toBe('ok');
    expect(diskPressureOf({ freeBytes: Number.NaN, totalBytes: 10 })).toBe('ok');
  });

  it('statfs vira bytes (inclusive bigint) e falha vira null', async () => {
    const sample = await sampleDiskSpace('/x', {
      statfs: async () => ({ bavail: 10n, blocks: 40n, bsize: 4096n }),
      now: () => 7,
    });
    expect(sample).toEqual({ freeBytes: 40960, totalBytes: 163840, sampledAt: 7 });
    await expect(sampleDiskSpace('/x', { statfs: async () => { throw new Error('EACCES'); } })).resolves.toBeNull();
    // Volume real do teste: sempre há leitura.
    expect((await sampleDiskSpace(process.cwd()))?.totalBytes).toBeGreaterThan(0);
  });
});

describe('política de retenção', () => {
  const durations = [
    'paneWorktreeTrimAfterMs', 'paneWorktreeMinIdleMs', 'paneWorktreeRetireAfterMs',
    'browserPartitionMaxIdleMs', 'orientationMaxIdleMs', 'providerSnapshotMaxIdleMs',
    'sessionArtifactMaxIdleMs', 'droppedFilesMaxIdleMs', 'missionScratchMaxIdleMs', 'briefMaxIdleMs', 'tempMaxIdleMs',
    'runtimeSchemaBackupsKept', 'cadenceMs',
  ] as const;

  it('cada nível só encolhe prazos (nunca afrouxa com o disco apertado)', () => {
    const [ok, low, critical] = (['ok', 'low', 'critical'] as const).map(storageHygienePolicyFor);
    for (const key of durations) {
      expect(low[key], key).toBeLessThanOrEqual(ok[key]);
      expect(critical[key], key).toBeLessThanOrEqual(low[key]);
    }
  });

  it('aposentadoria vem depois da coleta da limpa, que vem depois da poda', () => {
    for (const pressure of ['ok', 'low', 'critical'] as const) {
      const policy = storageHygienePolicyFor(pressure);
      expect(policy.paneWorktreeTrimAfterMs).toBeLessThan(policy.paneWorktreeMinIdleMs);
      expect(policy.paneWorktreeMinIdleMs).toBeLessThan(policy.paneWorktreeRetireAfterMs);
      expect(policy.runtimeSchemaBackupsKept).toBeGreaterThanOrEqual(1);
    }
  });

  it('a política vigente segue a última leitura do volume', () => {
    resetStorageHygienePolicyForTest();
    expect(currentStorageHygienePolicy().pressure).toBe('ok');
    recordDiskSample({ freeBytes: 2 * GiB, totalBytes: 256 * GiB, sampledAt: 1 });
    expect(currentStorageHygienePolicy().pressure).toBe('critical');
    // Leitura que falhou não apaga a anterior.
    recordDiskSample(null);
    expect(currentStorageHygienePolicy().pressure).toBe('critical');
    resetStorageHygienePolicyForTest();
    expect(tighterPressure('ok', 'low')).toBe('low');
    expect(tighterPressure('critical', 'low')).toBe('critical');
  });
});
