import { beforeEach, describe, expect, it } from 'vitest';
import {
  receivePaneFootprintBroadcast,
  usePaneFootprintStore,
} from './pane-footprint-store';

describe('pane-footprint-store', () => {
  beforeEach(() => {
    usePaneFootprintStore.setState({
      capturedAt: null,
      bySessionId: {},
      systemMemory: null,
    });
  });

  it('replaces the snapshot with the latest broadcast', () => {
    receivePaneFootprintBroadcast({
      capturedAt: 1000,
      bySessionId: { s1: { rssBytes: 512 * 1024 * 1024, processCount: 3 } },
      systemMemory: { freeMB: 2048, swapUsedMB: 0 },
    });

    expect(usePaneFootprintStore.getState()).toEqual({
      capturedAt: 1000,
      bySessionId: { s1: { rssBytes: 512 * 1024 * 1024, processCount: 3 } },
      systemMemory: { freeMB: 2048, swapUsedMB: 0 },
    });
  });

  it('a later broadcast fully replaces (not merges) the previous one', () => {
    receivePaneFootprintBroadcast({
      capturedAt: 1000,
      bySessionId: { s1: { rssBytes: 1, processCount: 1 } },
      systemMemory: null,
    });
    receivePaneFootprintBroadcast({
      capturedAt: 2000,
      bySessionId: { s2: { rssBytes: 2, processCount: 2 } },
      systemMemory: null,
    });

    expect(usePaneFootprintStore.getState().bySessionId).toEqual({
      s2: { rssBytes: 2, processCount: 2 },
    });
  });
});
