// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PTY_CHANNELS } from '../shared/channels';
import { ORCH_CHANNELS } from '../shared/orch-channels';
import type { NexusApi, PtyDataEvent } from '../shared/types';
import { PTY_GAP_NOTICE } from './pty-gap-buffer';

type IpcHandler = (...args: unknown[]) => void;

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, Set<IpcHandler>>();
  const ipcRenderer = {
    on: vi.fn((channel: string, cb: IpcHandler) => {
      let set = handlers.get(channel);
      if (!set) {
        set = new Set();
        handlers.set(channel, set);
      }
      set.add(cb);
      return ipcRenderer;
    }),
    removeListener: vi.fn((channel: string, cb: IpcHandler) => {
      handlers.get(channel)?.delete(cb);
    }),
    send: vi.fn(),
    sendSync: vi.fn(() => true),
    invoke: vi.fn<(channel: string, payload?: unknown) => Promise<unknown>>(),
  };
  return {
    handlers,
    ipcRenderer,
    contextBridge: { exposeInMainWorld: vi.fn() },
    webUtils: { getPathForFile: vi.fn() },
  };
});

vi.mock('electron', () => electronMock);

function emitPtyData(payload: PtyDataEvent): void {
  electronMock.handlers
    .get(PTY_CHANNELS.data)
    ?.forEach((cb) => cb({}, payload));
}

function emitIpc(channel: string, payload: unknown): void {
  electronMock.handlers.get(channel)?.forEach((cb) => cb({}, payload));
}

function recoverInvokes(): Array<{ sessionId: string; afterSequence: number }> {
  return electronMock.ipcRenderer.invoke.mock.calls
    .filter(([channel]) => channel === PTY_CHANNELS.recover)
    .map(([, payload]) => payload as { sessionId: string; afterSequence: number });
}

function ackSends(): Array<{ sessionId: string; sequence: number }> {
  return electronMock.ipcRenderer.send.mock.calls
    .filter(([channel]) => channel === PTY_CHANNELS.acknowledge)
    .map(([, payload]) => payload as { sessionId: string; sequence: number });
}

async function loadPreloadApi(): Promise<NexusApi> {
  await import('./preload');
  const expose = electronMock.contextBridge.exposeInMainWorld;
  const call = expose.mock.calls.find(([name]) => name === 'nexus');
  if (!call) throw new Error('preload did not expose window.nexus');
  return call[1] as NexusApi;
}

/** Flush queued microtasks (recover .then chains). */
async function flushMicrotasks(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

describe('preload PTY delivery', () => {
  beforeEach(() => {
    vi.resetModules();
    electronMock.handlers.clear();
    electronMock.ipcRenderer.on.mockClear();
    electronMock.ipcRenderer.send.mockClear();
    electronMock.ipcRenderer.invoke.mockReset();
    electronMock.ipcRenderer.invoke.mockResolvedValue([]);
    electronMock.contextBridge.exposeInMainWorld.mockClear();
  });

  it('delivers ordered chunks byte-for-byte with acks and no recover', async () => {
    const api = await loadPreloadApi();
    const received: string[] = [];
    api.pty.onData('s1', (data) => received.push(data));

    emitPtyData({ sessionId: 's1', sequence: 1, data: 'a' });
    emitPtyData({ sessionId: 's1', sequence: 2, data: 'b' });
    emitPtyData({ sessionId: 's1', sequence: 3, data: 'c' });

    expect(received).toEqual(['a', 'b', 'c']);
    expect(ackSends()).toEqual([
      { sessionId: 's1', sequence: 1 },
      { sessionId: 's1', sequence: 2 },
      { sessionId: 's1', sequence: 3 },
    ]);
    expect(recoverInvokes()).toEqual([]);
  });

  it('single-flights the recover pull while a gap is outstanding', async () => {
    const api = await loadPreloadApi();
    const received: string[] = [];
    api.pty.onData('s1', (data) => received.push(data));

    let resolveRecover!: (events: PtyDataEvent[]) => void;
    electronMock.ipcRenderer.invoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRecover = resolve as (events: PtyDataEvent[]) => void;
        }),
    );

    emitPtyData({ sessionId: 's1', sequence: 1, data: 'a' });
    // Hole at 2: each out-of-order chunk asks for a recover, but only one
    // invoke may be in flight — no amplification.
    emitPtyData({ sessionId: 's1', sequence: 3, data: 'c' });
    emitPtyData({ sessionId: 's1', sequence: 4, data: 'd' });
    emitPtyData({ sessionId: 's1', sequence: 5, data: 'e' });
    expect(recoverInvokes()).toEqual([{ sessionId: 's1', afterSequence: 1 }]);
    expect(received).toEqual(['a']);

    resolveRecover([
      { sessionId: 's1', sequence: 2, data: 'b' },
      { sessionId: 's1', sequence: 3, data: 'c' },
    ]);
    await flushMicrotasks();

    // Recover response + buffered successors flush in contiguous order.
    expect(received).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(ackSends().map((a) => a.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(recoverInvokes()).toHaveLength(1);
  });

  it('accepts an unrecoverable hole when recover starts past the high-water', async () => {
    const api = await loadPreloadApi();
    const received: string[] = [];
    api.pty.onData('s1', (data) => received.push(data));

    let resolveRecover!: (events: PtyDataEvent[]) => void;
    electronMock.ipcRenderer.invoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRecover = resolve as (events: PtyDataEvent[]) => void;
        }),
    );

    emitPtyData({ sessionId: 's1', sequence: 1, data: 'a' });
    emitPtyData({ sessionId: 's1', sequence: 3, data: 'c' });
    expect(recoverInvokes()).toHaveLength(1);

    // Main evicted 2..99 from its replay window: the hole can never heal.
    resolveRecover([{ sessionId: 's1', sequence: 100, data: 'resumed' }]);
    await flushMicrotasks();

    // One notice marks the skip; buffered 3 stays behind its own hole; the
    // recover payload delivers from 100.
    expect(received).toEqual(['a', PTY_GAP_NOTICE, 'resumed']);
    expect(ackSends().map((a) => a.sequence)).toEqual([1, 100]);

    // Delivery continues normally — no further recover storm.
    emitPtyData({ sessionId: 's1', sequence: 101, data: 'next' });
    expect(received).toEqual(['a', PTY_GAP_NOTICE, 'resumed', 'next']);
    expect(recoverInvokes()).toHaveLength(1);
  });

  it('heals from the cap and keeps delivering instead of buffering forever', async () => {
    const api = await loadPreloadApi();
    const received: string[] = [];
    api.pty.onData('s1', (data) => received.push(data));
    electronMock.ipcRenderer.invoke.mockResolvedValue([]);

    emitPtyData({ sessionId: 's1', sequence: 1, data: 'a' });
    // Overflow the chunk-count cap (2048) with a persistent hole at 2.
    for (let i = 0; i < 2100; i += 1) {
      emitPtyData({ sessionId: 's1', sequence: 3 + i, data: 'x' });
    }
    // The cap fired exactly once: one notice, then the contiguous run from
    // the oldest buffered chunk, and the high-water resumed at 2102.
    expect(received.filter((d) => d === PTY_GAP_NOTICE)).toHaveLength(1);
    expect(received[0]).toBe('a');
    expect(received[received.length - 1]).toBe('x');
    const lastAck = ackSends().at(-1);
    expect(lastAck).toEqual({ sessionId: 's1', sequence: 2102 });

    emitPtyData({ sessionId: 's1', sequence: 2103, data: 'after' });
    expect(received[received.length - 1]).toBe('after');
  });
});

describe('canonical mission preload bridge', () => {
  beforeEach(() => {
    vi.resetModules();
    electronMock.handlers.clear();
    electronMock.ipcRenderer.on.mockClear();
    electronMock.ipcRenderer.removeListener.mockClear();
    electronMock.ipcRenderer.send.mockClear();
    electronMock.ipcRenderer.invoke.mockReset();
    electronMock.ipcRenderer.invoke.mockResolvedValue([]);
    electronMock.contextBridge.exposeInMainWorld.mockClear();
  });

  it('exposes exactly the canonical mission methods with no mutation authority', async () => {
    const api = await loadPreloadApi();

    expect(Object.keys(api.mission).sort()).toEqual([
      'command',
      'list',
      'listForWorkspace',
      'onChanged',
      'prepare',
      'snapshot',
      'start',
    ]);
    expect('update' in api.mission).toBe(false);
    expect('patch' in api.mission).toBe(false);
    expect('complete' in api.mission).toBe(false);
    expect('block' in api.mission).toBe(false);
  });

  it('invokes every canonical channel with its exact payload shape', async () => {
    const api = await loadPreloadApi();
    const prepare = {
      objective: 'Ship the bridge',
      contextPaths: ['src/main/orch/orch-ipc.ts'],
      roster: [
        {
          id: 'orchestrator',
          agentName: 'Maestro',
          category: 'orchestrator' as const,
          cli: 'codex',
        },
      ],
    };
    const start = {
      missionId: 'mission-1',
      reviewSha256: 'a'.repeat(64),
    };
    const command = {
      kind: 'resume' as const,
      missionId: 'mission-1',
    };

    await api.mission.prepare(prepare);
    await api.mission.start(start);
    await api.mission.command(command);
    await api.mission.snapshot('mission-1');
    await api.mission.list();

    expect(electronMock.ipcRenderer.invoke.mock.calls).toEqual([
      [ORCH_CHANNELS.missionPrepare, prepare],
      [ORCH_CHANNELS.missionStart, start],
      [ORCH_CHANNELS.missionCommand, command],
      [ORCH_CHANNELS.missionSnapshot, 'mission-1'],
      [ORCH_CHANNELS.missionList],
    ]);
  });

  it('stops changed delivery after an idempotent double unsubscribe', async () => {
    const api = await loadPreloadApi();
    const listener = vi.fn();
    const unsubscribe = api.mission.onChanged(listener);
    const summaries = [
      {
        id: 'mission-1',
        title: 'Canonical mission',
        state: 'running' as const,
        progress: { completed: 0, total: 1 },
        needsAttention: false,
        updatedAt: 2,
      },
    ];

    emitIpc(ORCH_CHANNELS.missionChanged, summaries);
    expect(listener).toHaveBeenCalledWith(summaries);

    unsubscribe();
    unsubscribe();
    emitIpc(ORCH_CHANNELS.missionChanged, []);
    expect(listener).toHaveBeenCalledOnce();
  });

  it('keeps canonical summaries isolated from the legacy raw mission listener', async () => {
    const api = await loadPreloadApi();
    const canonical = vi.fn();
    const legacy = vi.fn();
    api.mission.onChanged(canonical);
    api.orch.onMissionsChanged(legacy);
    const rawMissions = [{ id: 'legacy', status: 'running' }];
    const summaries = [
      {
        id: 'canonical',
        title: 'Canonical',
        state: 'running',
        progress: { completed: 0, total: 0 },
        needsAttention: false,
        updatedAt: 1,
      },
    ];

    emitIpc(ORCH_CHANNELS.missionsChanged, rawMissions);
    expect(legacy).toHaveBeenCalledWith(rawMissions);
    expect(canonical).not.toHaveBeenCalled();

    emitIpc(ORCH_CHANNELS.missionChanged, summaries);
    expect(canonical).toHaveBeenCalledWith(summaries);
    expect(legacy).toHaveBeenCalledOnce();
  });
});


