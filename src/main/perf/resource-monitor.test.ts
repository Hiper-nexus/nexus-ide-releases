import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { limitsForMachine } from '../orch/pane-admission';
import {
  isSystemUnderMemoryPressure,
  ResourceSampleWindow,
  sampleSystemResources,
} from './resource-monitor';

const MiB = 1024 * 1024;

describe('resource monitor (T3 first cut)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('samples system and process numbers', () => {
    const sample = sampleSystemResources({ freeMB: 4096, swapUsedMB: 0 }, { now: () => 1_000 });
    expect(sample.sampledAt).toBe(1_000);
    expect(sample.totalMemBytes).toBeGreaterThan(0);
    expect(sample.usedMemRatio).not.toBeNull();
    expect(sample.usedMemRatio!).toBeGreaterThanOrEqual(0);
    expect(sample.usedMemRatio!).toBeLessThanOrEqual(1);
    expect(sample.cpuCount).toBeGreaterThan(0);
    expect(sample.process.rssBytes).toBeGreaterThan(0);
    expect(sample.uptimeSec).toBeGreaterThan(0);
  });

  it('a memória disponível vem da amostra do gate, nunca do os.freemem()', () => {
    // No macOS o os.freemem() conta só páginas livres (sem cache recuperável)
    // e acusaria pressão numa máquina saudável. O monitor não pode lê-lo.
    const freemem = vi.spyOn(os, 'freemem').mockReturnValue(64 * MiB);
    const total = 16 * 1024 * MiB;
    const sample = sampleSystemResources(
      { freeMB: 8 * 1024, swapUsedMB: 2048 },
      { totalMemBytes: total },
    );
    expect(freemem).not.toHaveBeenCalled();
    expect(sample.freeMemBytes).toBe(8 * 1024 * MiB);
    expect(sample.usedMemRatio).toBeCloseTo(0.5, 5);
    expect(sample.swapUsedBytes).toBe(2048 * MiB);
  });

  it('sem amostra do gate a memória fica desconhecida (null), não inventada', () => {
    const missing = sampleSystemResources(null, { totalMemBytes: 8 * 1024 * MiB });
    expect(missing.freeMemBytes).toBeNull();
    expect(missing.usedMemRatio).toBeNull();
    const blind = sampleSystemResources({ freeMB: null, swapUsedMB: null });
    expect(blind.freeMemBytes).toBeNull();
    expect(blind.swapUsedBytes).toBeNull();
  });

  it('o veredito de pressão usa os mesmos limiares do gate de admissão', () => {
    const total = 24 * 1024 * MiB;
    const limits = limitsForMachine(24 * 1024); // minFreeMB = 15 % de 24 GB = 3686
    const at = (freeMB: number | null, swapUsedMB: number | null = 0) =>
      sampleSystemResources({ freeMB, swapUsedMB }, { totalMemBytes: total });
    expect(isSystemUnderMemoryPressure(at(limits.minFreeMB + 1), limits)).toBe(false);
    expect(isSystemUnderMemoryPressure(at(limits.minFreeMB - 1), limits)).toBe(true);
    // Swap alto não é pressão enquanto a máquina não armou o gate dela.
    expect(isSystemUnderMemoryPressure(at(12 * 1024, 16 * 1024), limits)).toBe(false);
    expect(
      isSystemUnderMemoryPressure(at(12 * 1024, 16 * 1024), { ...limits, maxSwapUsedMB: 1024 }),
    ).toBe(true);
    // Gate cego nunca inventa pressão.
    expect(isSystemUnderMemoryPressure(at(null, null), limits)).toBe(false);
  });

  it('window keeps peak and average without unbounded growth', () => {
    const window = new ResourceSampleWindow(3);
    const sample = sampleSystemResources({ freeMB: 1024, swapUsedMB: 0 });
    window.push({ ...sample, sampledAt: 1, usedMemRatio: 0.2, loadAvg1: 1 });
    window.push({ ...sample, sampledAt: 2, usedMemRatio: 0.8, loadAvg1: 3 });
    window.push({ ...sample, sampledAt: 3, usedMemRatio: 0.4, loadAvg1: 2 });
    window.push({ ...sample, sampledAt: 4, usedMemRatio: 0.1, loadAvg1: 0 });
    expect(window.size).toBe(3);
    // Janela = últimos 3: 0.8, 0.4, 0.1 (o 0.2 saiu).
    expect(window.peakUsedMemRatio()).toBe(0.8);
    expect(window.averageLoad1()).toBeCloseTo((3 + 2 + 0) / 3, 5);
    expect(window.latest()?.usedMemRatio).toBe(0.1);
    expect(window.spanMs()).toBe(2);
  });

  it('pico ignora amostras sem memória e é null quando nenhuma tem', () => {
    const window = new ResourceSampleWindow(5);
    expect(window.peakUsedMemRatio()).toBeNull();
    const sample = sampleSystemResources(null);
    window.push(sample);
    expect(window.peakUsedMemRatio()).toBeNull();
    window.push({ ...sample, usedMemRatio: 0.3 });
    window.push({ ...sample, usedMemRatio: null });
    expect(window.peakUsedMemRatio()).toBe(0.3);
  });
});
