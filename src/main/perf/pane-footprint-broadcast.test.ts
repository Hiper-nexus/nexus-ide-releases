import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { PERF_CHANNELS } from '../../shared/channels';
import type { SessionFootprint } from '../pty/pane-footprint';
import type { SystemMemorySample } from '../orch/pane-admission';

const physical = vi.hoisted(() => ({
  renderers: [] as WebContents[],
  liveSessionCount: 0,
  footprints: null as readonly SessionFootprint[] | null,
  systemMemory: null as SystemMemorySample | null,
}));

vi.mock('electron', () => ({
  webContents: { getAllWebContents: () => physical.renderers },
}));
vi.mock('../pty/pty-manager', () => ({
  getLiveSessionCount: () => physical.liveSessionCount,
  probePaneFootprints: () => Promise.resolve(physical.footprints),
}));
vi.mock('../orch/pane-admission', () => ({
  getCachedSystemMemory: () => physical.systemMemory,
}));

function renderer(): WebContents & { send: ReturnType<typeof vi.fn> } {
  return {
    isDestroyed: () => false,
    isCrashed: () => false,
    send: vi.fn(),
  } as unknown as WebContents & { send: ReturnType<typeof vi.fn> };
}

describe('pane-footprint-broadcast', () => {
  beforeEach(() => {
    physical.renderers = [];
    physical.liveSessionCount = 0;
    physical.footprints = null;
    physical.systemMemory = null;
  });

  afterEach(async () => {
    const mod = await import('./pane-footprint-broadcast');
    mod.stopPaneFootprintBroadcast();
    vi.resetModules();
  });

  it('sem sessões vivas não chama o probe nem emite', async () => {
    const mod = await import('./pane-footprint-broadcast');
    const wc = renderer();
    physical.renderers = [wc];
    physical.liveSessionCount = 0;

    await mod.runPaneFootprintBroadcastTickForTests();

    expect(wc.send).not.toHaveBeenCalled();
  });

  it('com sessão viva, mede o footprint e emite para todos os renderers', async () => {
    const mod = await import('./pane-footprint-broadcast');
    const wcA = renderer();
    const wcB = renderer();
    physical.renderers = [wcA, wcB];
    physical.liveSessionCount = 1;
    physical.footprints = [
      { sessionId: 's1', rootPid: 111, processCount: 3, rssBytes: 512 * 1024 * 1024 },
    ];
    physical.systemMemory = { freeMB: 2048, swapUsedMB: 0 };

    await mod.runPaneFootprintBroadcastTickForTests();

    const expected = {
      capturedAt: expect.any(Number),
      bySessionId: { s1: { rssBytes: 512 * 1024 * 1024, processCount: 3 } },
      systemMemory: { freeMB: 2048, swapUsedMB: 0 },
    };
    expect(wcA.send).toHaveBeenCalledWith(PERF_CHANNELS.paneFootprints, expected);
    expect(wcB.send).toHaveBeenCalledWith(PERF_CHANNELS.paneFootprints, expected);
  });

  it('sessão viva mas host PTY mudo (probe null) não emite', async () => {
    const mod = await import('./pane-footprint-broadcast');
    const wc = renderer();
    physical.renderers = [wc];
    physical.liveSessionCount = 1;
    physical.footprints = null;

    await mod.runPaneFootprintBroadcastTickForTests();

    expect(wc.send).not.toHaveBeenCalled();
  });

  it('nunca manda para um renderer destruído', async () => {
    const mod = await import('./pane-footprint-broadcast');
    const dead = renderer();
    dead.isDestroyed = () => true;
    physical.renderers = [dead];
    physical.liveSessionCount = 1;
    physical.footprints = [];
    physical.systemMemory = null;

    await mod.runPaneFootprintBroadcastTickForTests();

    expect(dead.send).not.toHaveBeenCalled();
  });

  it('start/stop ligam e desligam o timer sem duplicar', async () => {
    vi.useFakeTimers();
    try {
      const mod = await import('./pane-footprint-broadcast');
      physical.liveSessionCount = 1;
      physical.footprints = [];
      mod.startPaneFootprintBroadcast();
      mod.startPaneFootprintBroadcast(); // idempotente: não duplica o timer
      const wc = renderer();
      physical.renderers = [wc];

      await vi.advanceTimersByTimeAsync(30_000);
      expect(wc.send).toHaveBeenCalledTimes(1);

      mod.stopPaneFootprintBroadcast();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(wc.send).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
