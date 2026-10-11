import { describe, expect, it } from 'vitest';
import { limitsForMachine } from '../orch/pane-admission';
import { createMachineResourceSampler } from './machine-resources';

const MiB = 1024 * 1024;
const TOTAL = 24 * 1024 * MiB;

function harness(overrides: Partial<Parameters<typeof createMachineResourceSampler>[0]> = {}) {
  let clock = 1_000_000;
  const sampler = createMachineResourceSampler({
    now: () => clock,
    totalMemBytes: () => TOTAL,
    readLimits: () => limitsForMachine(24 * 1024),
    appMemoryBytes: () => 400 * MiB,
    ...overrides,
  });
  return {
    sampler,
    advance(ms: number) {
      clock += ms;
    },
  };
}

describe('machine resources sampler (F-1172)', () => {
  it('monta o resumo com a memória do gate, panes e o próprio Nexus', () => {
    const { sampler } = harness();
    const result = sampler.sample({
      memory: { freeMB: 12 * 1024, swapUsedMB: 512 },
      panesRssBytes: 3 * 1024 * MiB,
      paneCount: 2,
    });
    expect(result).not.toBeNull();
    expect(result!.memory.totalBytes).toBe(TOTAL);
    expect(result!.memory.availableBytes).toBe(12 * 1024 * MiB);
    expect(result!.memory.usedRatio).toBeCloseTo(0.5, 5);
    expect(result!.memory.minFreeBytes).toBe(limitsForMachine(24 * 1024).minFreeMB * MiB);
    expect(result!.nexus).toEqual({ appBytes: 400 * MiB, panesBytes: 3 * 1024 * MiB, paneCount: 2 });
    expect(result!.pressure).toBe('ok');
    expect(result!.admissionEnabled).toBe(true);
    expect(result!.cpu.cores).toBeGreaterThan(0);
  });

  it('pressão segue o limiar do gate; sem leitura é "unknown", não "ok"', () => {
    const { sampler, advance } = harness();
    const minFree = limitsForMachine(24 * 1024).minFreeMB;
    expect(sampler.sample({ memory: { freeMB: minFree - 1, swapUsedMB: 0 }, panesRssBytes: null, paneCount: 0 })!.pressure).toBe('pressure');
    advance(30_000);
    expect(sampler.sample({ memory: null, panesRssBytes: null, paneCount: 0 })!.pressure).toBe('unknown');
    advance(30_000);
    expect(sampler.sample({ memory: { freeMB: null, swapUsedMB: null }, panesRssBytes: null, paneCount: 0 })!.pressure).toBe('unknown');
  });

  it('o pico vem da janela e amostras muito próximas não a inundam', () => {
    const { sampler, advance } = harness();
    sampler.sample({ memory: { freeMB: 4 * 1024, swapUsedMB: 0 }, panesRssBytes: null, paneCount: 0 });
    advance(30_000);
    const later = sampler.sample({ memory: { freeMB: 20 * 1024, swapUsedMB: 0 }, panesRssBytes: null, paneCount: 0 })!;
    expect(later.memory.usedRatio).toBeCloseTo(4 / 24, 5);
    expect(later.memory.peakUsedRatio).toBeCloseTo(20 / 24, 5);
    expect(later.window.samples).toBe(2);
    expect(later.window.spanMs).toBe(30_000);
    // Snapshot pedido 1 s depois: valor atual sai, mas a janela não ganha amostra.
    advance(1_000);
    const burst = sampler.sample({ memory: { freeMB: 21 * 1024, swapUsedMB: 0 }, panesRssBytes: null, paneCount: 0 })!;
    expect(burst.memory.usedRatio).toBeCloseTo(3 / 24, 5);
    expect(burst.window.samples).toBe(2);
  });

  it('pico considera a leitura atual mesmo quando ela ainda não entrou na janela', () => {
    const { sampler, advance } = harness();
    sampler.sample({ memory: { freeMB: 20 * 1024, swapUsedMB: 0 }, panesRssBytes: null, paneCount: 0 });
    advance(1_000);
    const spike = sampler.sample({ memory: { freeMB: 2 * 1024, swapUsedMB: 0 }, panesRssBytes: null, paneCount: 0 })!;
    expect(spike.memory.peakUsedRatio).toBeCloseTo(22 / 24, 5);
  });

  it('defeito na telemetria do app não derruba a amostra', () => {
    const { sampler } = harness({
      appMemoryBytes: () => {
        throw new Error('metrics indisponível');
      },
    });
    const result = sampler.sample({ memory: { freeMB: 8 * 1024, swapUsedMB: 0 }, panesRssBytes: null, paneCount: 0 });
    expect(result?.nexus.appBytes).toBeNull();
  });

  it('Windows não expõe load average: CPU fica sem leitura em vez de 0 falso', () => {
    const { sampler } = harness({ platform: 'win32' });
    const result = sampler.sample({ memory: { freeMB: 8 * 1024, swapUsedMB: null }, panesRssBytes: null, paneCount: 0 })!;
    expect(result.cpu.loadAvg1).toBeNull();
    expect(result.cpu.averageLoad1).toBeNull();
  });

  it('guard desligado é informado ao operador', () => {
    const { sampler } = harness({ readLimits: () => ({ ...limitsForMachine(24 * 1024), enabled: false }) });
    expect(sampler.sample({ memory: null, panesRssBytes: null, paneCount: 0 })!.admissionEnabled).toBe(false);
  });
});
