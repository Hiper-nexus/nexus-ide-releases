import { beforeEach, describe, expect, it } from 'vitest';
import {
  receivePaneFootprintBroadcast,
  usePaneFootprintStore,
} from './pane-footprint-store';

describe('pane-footprint-store', () => {
  beforeEach(() => {
    usePaneFootprintStore.setState({
      capturedAt: null,
      generation: 0,
      sequence: 0,
      bySessionId: {},
      systemMemory: null,
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
});
