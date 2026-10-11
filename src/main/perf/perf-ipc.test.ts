import { beforeEach, describe, expect, it, vi } from 'vitest';

const physical = vi.hoisted(() => ({
  footprints: null as null | Array<{ sessionId: string; rootPid: number; processCount: number; rssBytes: number | null }>,
  systemMemory: null as null | { freeMB: number | null; swapUsedMB: number | null },
  machineSample: vi.fn(),
}));

vi.mock('electron', () => ({ app: undefined }));
vi.mock('../pty/pty-manager', () => ({
  countLiveAgentSessions: () => 1,
  getLiveSessionCount: () => physical.footprints?.length ?? 0,
  probePaneFootprints: () => Promise.resolve(physical.footprints),
}));
vi.mock('../browser/browser-manager', () => ({ getBrowserViewCount: () => 0 }));
vi.mock('../pty/warm-pool', () => ({ warmPool: { getMetrics: () => undefined } }));
vi.mock('../security/trusted-ipc', () => ({ handleTrusted: vi.fn(), onTrusted: vi.fn() }));
vi.mock('./pane-footprint-broadcast', () => ({ setPaneFootprintSubscription: vi.fn() }));
vi.mock('./machine-resources', () => ({
  machineResourceSampler: { sample: physical.machineSample },
}));
vi.mock('../orch/pane-admission', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../orch/pane-admission')>()),
  sampleSystemMemory: () => Promise.resolve(physical.systemMemory),
}));

import { collectPerfSnapshotDetailed } from './perf-ipc';

describe('perf:snapshot — recursos da máquina (F-1172)', () => {
  beforeEach(() => {
    physical.machineSample.mockReset();
  });

  it('inclui o resumo da máquina com a leitura do gate e o RSS somado dos panes', async () => {
    physical.footprints = [
      { sessionId: 'a', rootPid: 1, processCount: 2, rssBytes: 100 },
      { sessionId: 'b', rootPid: 2, processCount: 1, rssBytes: 50 },
    ];
    physical.systemMemory = { freeMB: 9000, swapUsedMB: 10 };
    const machine = { pressure: 'ok' };
    physical.machineSample.mockReturnValue(machine);

    const snapshot = await collectPerfSnapshotDetailed();

    expect(physical.machineSample).toHaveBeenCalledWith({
      memory: { freeMB: 9000, swapUsedMB: 10 },
      panesRssBytes: 150,
      paneCount: 2,
    });
    expect(snapshot.machine).toBe(machine);
  });

  it('host PTY mudo: panes sem leitura (null), não "0 MB"', async () => {
    physical.footprints = null;
    physical.systemMemory = null;
    physical.machineSample.mockReturnValue(null);

    const snapshot = await collectPerfSnapshotDetailed();

    expect(physical.machineSample).toHaveBeenCalledWith({ memory: null, panesRssBytes: null, paneCount: 0 });
    expect(snapshot.machine).toBeUndefined();
  });
});
