import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { PERF_CHANNELS } from '../../shared/channels';
import type { SessionFootprint } from '../pty/pane-footprint';
import type { SystemMemorySample } from '../orch/pane-admission';

const physical = vi.hoisted(() => ({
  liveSessionCount: 0,
  footprints: null as readonly SessionFootprint[] | null,
  systemMemory: null as SystemMemorySample | null,
  /** Quando definido, o próximo probe fica pendente até o teste resolver. */
  hold: null as null | { resolve: (value: readonly SessionFootprint[] | null) => void },
  probe: vi.fn(),
}));

vi.mock('../pty/pty-manager', () => ({
  getLiveSessionCount: () => physical.liveSessionCount,
  getSessionState: () => 'idle',
  probePaneFootprints: physical.probe,
}));
vi.mock('../orch/pane-admission', () => ({
  getCachedSystemMemory: () => physical.systemMemory,
}));

type FakeRenderer = WebContents & { send: ReturnType<typeof vi.fn>; destroy(): void };

function renderer(): FakeRenderer {
  const emitter = new EventEmitter();
  let destroyed = false;
  return Object.assign(emitter, {
    isDestroyed: () => destroyed,
    isCrashed: () => false,
    send: vi.fn(),
    destroy: () => {
      destroyed = true;
      emitter.emit('destroyed');
    },
  }) as unknown as FakeRenderer;
}

/** Drena as cadeias de promessa do tick (probe → checkpoint → send). */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await vi.advanceTimersByTimeAsync(0);
}

function sentPayloads(wc: FakeRenderer): Array<{ generation: number; sequence: number }> {
  return wc.send.mock.calls
    .filter(([channel]) => channel === PERF_CHANNELS.paneFootprints)
    .map(([, payload]) => payload as { generation: number; sequence: number });
}

describe('pane-footprint-broadcast (QLT-11: coleta só com assinante)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    physical.liveSessionCount = 1;
    physical.footprints = [
      { sessionId: 's1', rootPid: 111, processCount: 3, rssBytes: 512 * 1024 * 1024 },
    ];
    physical.systemMemory = { freeMB: 2048, swapUsedMB: 0 };
    physical.hold = null;
    physical.probe.mockReset();
    physical.probe.mockImplementation(() => {
      if (!physical.hold) return Promise.resolve(physical.footprints);
      return new Promise((resolve) => {
        physical.hold = { resolve };
      });
    });
  });

  afterEach(async () => {
    const mod = await import('./pane-footprint-broadcast');
    await mod.stopPaneFootprintBroadcast();
    vi.useRealTimers();
    vi.resetModules();
  });

  it('sem assinante não roda `ps` periódico, mesmo com sessão viva', async () => {
    const mod = await import('./pane-footprint-broadcast');
    mod.startPaneFootprintBroadcast();

    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(physical.probe).not.toHaveBeenCalled();
  });

  it('assinar dispara uma amostra imediata e só o assinante recebe', async () => {
    const mod = await import('./pane-footprint-broadcast');
    mod.startPaneFootprintBroadcast();
    const watcher = renderer();

    mod.setPaneFootprintSubscription(watcher, true);
    await settle();

    expect(physical.probe).toHaveBeenCalledTimes(1);
    expect(watcher.send).toHaveBeenCalledWith(PERF_CHANNELS.paneFootprints, {
      generation: 1,
      sequence: 1,
      capturedAt: expect.any(Number),
      bySessionId: { s1: { rssBytes: 512 * 1024 * 1024, processCount: 3 } },
      systemMemory: { freeMB: 2048, swapUsedMB: 0 },
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(physical.probe).toHaveBeenCalledTimes(2);
    expect(sentPayloads(watcher).map((p) => p.sequence)).toEqual([1, 2]);
  });

  it('assinatura antes do start fica guardada e a amostra sai no start', async () => {
    const mod = await import('./pane-footprint-broadcast');
    const watcher = renderer();
    mod.setPaneFootprintSubscription(watcher, true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(physical.probe).not.toHaveBeenCalled();

    mod.startPaneFootprintBroadcast();
    await settle();
    expect(physical.probe).toHaveBeenCalledTimes(1);
    expect(sentPayloads(watcher)).toHaveLength(1);
  });

  it('desassinar o último cancela o timer', async () => {
    const mod = await import('./pane-footprint-broadcast');
    mod.startPaneFootprintBroadcast();
    const a = renderer();
    const b = renderer();
    mod.setPaneFootprintSubscription(a, true);
    mod.setPaneFootprintSubscription(b, true);
    await settle();
    const afterSubscribe = physical.probe.mock.calls.length;

    mod.setPaneFootprintSubscription(a, false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(physical.probe.mock.calls.length).toBe(afterSubscribe + 1);
    expect(sentPayloads(a)).toHaveLength(sentPayloads(b).length - 1);

    mod.setPaneFootprintSubscription(b, false);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(physical.probe.mock.calls.length).toBe(afterSubscribe + 1);
  });

  it('renderer destruído deixa de ser assinante', async () => {
    const mod = await import('./pane-footprint-broadcast');
    mod.startPaneFootprintBroadcast();
    const watcher = renderer();
    mod.setPaneFootprintSubscription(watcher, true);
    await settle();

    watcher.destroy();
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(physical.probe).toHaveBeenCalledTimes(1);
  });

  it('reinício do coletor abre geração nova e descarta a amostra da anterior', async () => {
    const mod = await import('./pane-footprint-broadcast');
    mod.startPaneFootprintBroadcast();
    const watcher = renderer();
    physical.hold = { resolve: () => undefined };

    mod.setPaneFootprintSubscription(watcher, true); // geração 1, probe pendente
    await settle();
    const pending = physical.hold;
    physical.hold = null;
    mod.setPaneFootprintSubscription(watcher, false);
    mod.setPaneFootprintSubscription(watcher, true); // geração 2

    pending.resolve(physical.footprints);
    await settle();

    // A amostra presa da geração 1 não vaza para a série nova; a geração 2
    // recomeça a sequência em 1 (comparar sequência entre gerações é o erro).
    expect(sentPayloads(watcher).map((p) => [p.generation, p.sequence])).toEqual([[2, 1]]);
  });

  it('sem sessão viva não chama o probe nem emite', async () => {
    const mod = await import('./pane-footprint-broadcast');
    mod.startPaneFootprintBroadcast();
    physical.liveSessionCount = 0;
    const watcher = renderer();

    mod.setPaneFootprintSubscription(watcher, true);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(physical.probe).not.toHaveBeenCalled();
    expect(watcher.send).not.toHaveBeenCalled();
  });

  it('sessão viva mas host PTY mudo (probe null) não emite', async () => {
    const mod = await import('./pane-footprint-broadcast');
    mod.startPaneFootprintBroadcast();
    physical.footprints = null;
    const watcher = renderer();

    mod.setPaneFootprintSubscription(watcher, true);
    await settle();

    expect(physical.probe).toHaveBeenCalledTimes(1);
    expect(watcher.send).not.toHaveBeenCalled();
  });

  it('stop desliga a coleta mesmo com assinante', async () => {
    const mod = await import('./pane-footprint-broadcast');
    mod.startPaneFootprintBroadcast();
    mod.startPaneFootprintBroadcast(); // idempotente
    const watcher = renderer();
    mod.setPaneFootprintSubscription(watcher, true);
    await settle();

    await mod.stopPaneFootprintBroadcast();
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(physical.probe).toHaveBeenCalledTimes(1);
  });
});
