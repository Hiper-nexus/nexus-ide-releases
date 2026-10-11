import { beforeEach, describe, expect, it } from 'vitest';
import type { MachineResources } from '../../shared/machine-resources';
import {
  receiveMachineResources,
  receivePaneFootprintBroadcast,
  usePaneFootprintStore,
} from './pane-footprint-store';

function machine(overrides: Partial<MachineResources> = {}): MachineResources {
  return {
    sampledAt: 1000,
    memory: {
      totalBytes: 16 * 1024 ** 3,
      availableBytes: 8 * 1024 ** 3,
      usedRatio: 0.5,
      peakUsedRatio: 0.6,
      swapUsedBytes: 0,
      minFreeBytes: 2.4 * 1024 ** 3,
    },
    cpu: { cores: 8, loadAvg1: 2, averageLoad1: 1.5 },
    nexus: { appBytes: 400 * 1024 ** 2, panesBytes: 1024 ** 3, paneCount: 2 },
    pressure: 'ok',
    admissionEnabled: true,
    window: { samples: 3, spanMs: 60_000 },
    ...overrides,
  };
}

describe('pane-footprint-store', () => {
  beforeEach(() => {
    usePaneFootprintStore.setState({
      capturedAt: null,
      generation: 0,
      sequence: 0,
      bySessionId: {},
      systemMemory: null,
      machine: null,
    });
  });

  it('replaces the snapshot with the latest broadcast', () => {
    receivePaneFootprintBroadcast({
      generation: 1,
      sequence: 1,
      capturedAt: 1000,
      bySessionId: { s1: { rssBytes: 512 * 1024 * 1024, processCount: 3 } },
      systemMemory: { freeMB: 2048, swapUsedMB: 0 },
    });

    expect(usePaneFootprintStore.getState()).toEqual({
      capturedAt: 1000,
      generation: 1,
      sequence: 1,
      bySessionId: { s1: { rssBytes: 512 * 1024 * 1024, processCount: 3 } },
      systemMemory: { freeMB: 2048, swapUsedMB: 0 },
      machine: null,
    });
  });

  it('a later broadcast fully replaces (not merges) the previous one', () => {
    receivePaneFootprintBroadcast({
      generation: 1,
      sequence: 1,
      capturedAt: 1000,
      bySessionId: { s1: { rssBytes: 1, processCount: 1 } },
      systemMemory: null,
    });
    receivePaneFootprintBroadcast({
      generation: 1,
      sequence: 2,
      capturedAt: 2000,
      bySessionId: { s2: { rssBytes: 2, processCount: 2 } },
      systemMemory: null,
    });

    expect(usePaneFootprintStore.getState().bySessionId).toEqual({
      s2: { rssBytes: 2, processCount: 2 },
    });
  });

  it('na mesma geração, sequência repetida ou antiga é descartada', () => {
    receivePaneFootprintBroadcast({
      generation: 1,
      sequence: 2,
      capturedAt: 2000,
      bySessionId: { s1: { rssBytes: 2, processCount: 2 } },
      systemMemory: null,
    });
    receivePaneFootprintBroadcast({
      generation: 1,
      sequence: 1,
      capturedAt: 1000,
      bySessionId: { s1: { rssBytes: 1, processCount: 1 } },
      systemMemory: null,
    });

    expect(usePaneFootprintStore.getState().capturedAt).toBe(2000);
  });

  it('geração nova do coletor recomeça a série mesmo com sequência menor', () => {
    receivePaneFootprintBroadcast({
      generation: 1,
      sequence: 5,
      capturedAt: 1000,
      bySessionId: { s1: { rssBytes: 1, processCount: 1 } },
      systemMemory: null,
    });
    receivePaneFootprintBroadcast({
      generation: 2,
      sequence: 1,
      capturedAt: 2000,
      bySessionId: { s1: { rssBytes: 9, processCount: 4 } },
      systemMemory: null,
    });

    expect(usePaneFootprintStore.getState()).toMatchObject({
      generation: 2,
      sequence: 1,
      bySessionId: { s1: { rssBytes: 9, processCount: 4 } },
    });
  });

  it('amostra de geração anterior chegando depois da nova é descartada, mesmo com sequência maior', () => {
    receivePaneFootprintBroadcast({
      generation: 2,
      sequence: 1,
      capturedAt: 2000,
      bySessionId: { s1: { rssBytes: 9, processCount: 4 } },
      systemMemory: null,
    });
    receivePaneFootprintBroadcast({
      generation: 1,
      sequence: 7,
      capturedAt: 1500,
      bySessionId: { s1: { rssBytes: 1, processCount: 1 } },
      systemMemory: null,
    });

    expect(usePaneFootprintStore.getState()).toMatchObject({
      generation: 2,
      sequence: 1,
      capturedAt: 2000,
      bySessionId: { s1: { rssBytes: 9, processCount: 4 } },
    });
  });

  it('F-1172: guarda o resumo da máquina validado; fora do contrato vira null', () => {
    receivePaneFootprintBroadcast({
      generation: 1,
      sequence: 1,
      capturedAt: 1000,
      bySessionId: {},
      systemMemory: null,
      machine: machine({ pressure: 'pressure' }),
    });
    expect(usePaneFootprintStore.getState().machine?.pressure).toBe('pressure');

    receivePaneFootprintBroadcast({
      generation: 1,
      sequence: 2,
      capturedAt: 2000,
      bySessionId: {},
      systemMemory: null,
      machine: { pressure: 'talvez' } as unknown as MachineResources,
    });
    expect(usePaneFootprintStore.getState().machine).toBeNull();
  });

  it('F-1172: snapshot só substitui o resumo quando é mais novo', () => {
    receiveMachineResources(machine({ sampledAt: 5000, pressure: 'pressure' }));
    receiveMachineResources(machine({ sampledAt: 4000, pressure: 'ok' }));
    expect(usePaneFootprintStore.getState().machine?.pressure).toBe('pressure');
    receiveMachineResources(machine({ sampledAt: 6000, pressure: 'ok' }));
    expect(usePaneFootprintStore.getState().machine?.pressure).toBe('ok');
    receiveMachineResources(undefined);
    expect(usePaneFootprintStore.getState().machine?.pressure).toBe('ok');
  });
});
