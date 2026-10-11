// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PERF_CHANNELS, PTY_CHANNELS } from '../shared/channels';
import { ORCH_CHANNELS } from '../shared/orch-channels';
import { FILES_CHANNELS } from '../shared/files-types';
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

  it('exposes only typed status and write operations for Clef configuration', async () => {
    const api = await loadPreloadApi();
    electronMock.ipcRenderer.invoke.mockResolvedValue({ ok: true });
    expect(await api.decisionModels.setKey({ token: 'synthetic-token' })).toEqual({ ok: true });
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith('decisionModels:setKey', { token: 'synthetic-token' });
    expect(api.decisionModels).not.toHaveProperty('getKey');
  });

  it('F-1167: calibração e painel da missão saem com payload fixo (o renderer não escolhe casos nem modelos)', async () => {
    const api = await loadPreloadApi();
    electronMock.ipcRenderer.invoke.mockResolvedValue({ ok: true });
    await api.decisionModels.calibrationPlan();
    expect(electronMock.ipcRenderer.invoke).toHaveBeenLastCalledWith('decisionModels:calibrationPlan');
    await (api.decisionModels.calibrate as (...args: unknown[]) => Promise<unknown>)({ cases: [], models: ['luna'] });
    expect(electronMock.ipcRenderer.invoke).toHaveBeenLastCalledWith('decisionModels:calibrate', { confirm: true });
    await (api.decisionModels.cancelCalibration as (...args: unknown[]) => Promise<unknown>)({ confirm: true });
    expect(electronMock.ipcRenderer.invoke).toHaveBeenLastCalledWith('decisionModels:calibrate', { cancel: true });
    await api.decisionModels.missionPanel('mission-a');
    expect(electronMock.ipcRenderer.invoke).toHaveBeenLastCalledWith('decisionModels:missionPanel', { missionId: 'mission-a' });
  });

  it('exposes Main-owned logout over billing:logout', async () => {
    const api = await loadPreloadApi();
    electronMock.ipcRenderer.invoke.mockResolvedValue({ ok: true });
    expect(await api.billing.logout()).toEqual({ ok: true });
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith('billing:logout');
  });

  it('pinga o main por app:heartbeat sem carga nenhuma (F-764 C.7)', async () => {
    const api = await loadPreloadApi();
    electronMock.ipcRenderer.invoke.mockResolvedValue({ at: 42 });
    expect(await api.app.heartbeat()).toEqual({ at: 42 });
    expect(electronMock.ipcRenderer.invoke.mock.calls).toContainEqual(['app:heartbeat']);
  });

  it('exposes bug report preview/submit over their own channels and nothing that reads the session', async () => {
    const api = await loadPreloadApi();
    electronMock.ipcRenderer.invoke.mockResolvedValue({ ok: true });
    const request = {
      title: 'O terminal trava ao colar',
      description: 'Ao colar um texto longo o pane congela por alguns segundos.',
      category: 'terminal' as const,
      impact: 'annoying' as const,
      includeDiagnostics: false,
    };
    await api.bugReport.preview(request);
    await api.bugReport.submit(request);
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith('bugReport:preview', request);
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith('bugReport:submit', request);
    expect(Object.keys(api.bugReport).sort()).toEqual(['onOpenRequest', 'preview', 'submit']);
  });

  it('exposes the Marketplace recommendations over their own channel, refresh as a strict boolean (F-757)', async () => {
    const api = await loadPreloadApi();
    const answer = { ok: true, areas: [], recommendations: [] };
    electronMock.ipcRenderer.invoke.mockResolvedValue(answer);
    expect(await api.orch.recommendCatalog(true)).toEqual(answer);
    expect(electronMock.ipcRenderer.invoke).toHaveBeenLastCalledWith('orch:catalog.recommend', { refresh: true });
    await api.orch.recommendCatalog();
    expect(electronMock.ipcRenderer.invoke).toHaveBeenLastCalledWith('orch:catalog.recommend', { refresh: false });
  });

  it('exposes the voice mission tie-break over its own channel and passes the request through untouched', async () => {
    const api = await loadPreloadApi();
    const answer = { decision: 'picked', index: 1, confidence: 0.9 };
    electronMock.ipcRenderer.invoke.mockResolvedValue(answer);
    const request = {
      spoken: 'site da loja',
      candidates: [
        { title: 'Site da loja', state: 'running' },
        { title: 'Site da loja v2', state: 'completed' },
      ],
    };
    expect(await api.jev.missionPick(request)).toEqual(answer);
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith('jev:missionPick', request);
  });

  it('exposes the account choice receipt as a read-only lookup over its own channel', async () => {
    const api = await loadPreloadApi();
    const receipt = { adapterId: 'claude', source: 'native', account: null, headroom: null, alternatives: [], decidedAt: 1 };
    electronMock.ipcRenderer.invoke.mockResolvedValue(receipt);
    expect(await api.accountChoice.get('sess-1')).toEqual(receipt);
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith('accountChoice:get', { sessionId: 'sess-1' });
    // Só leitura: nada que grave, esqueça ou escute o recibo.
    expect(Object.keys(api.accountChoice)).toEqual(['get']);
  });

  it('forwards only the session id to the account choice channel, never extra caller data', async () => {
    const api = await loadPreloadApi();
    electronMock.ipcRenderer.invoke.mockResolvedValue(null);
    const loose = api.accountChoice.get as (...args: unknown[]) => Promise<unknown>;
    await loose('sess-2', { accountId: 'acct-1', sessionId: 'sess-1' });
    const payloads = electronMock.ipcRenderer.invoke.mock.calls
      .filter(([channel]) => channel === 'accountChoice:get')
      .map(([, payload]) => payload);
    expect(payloads).toEqual([{ sessionId: 'sess-2' }]);
  });

  it('forwards the menu open request without IPC event data and supports unsubscribe', async () => {
    const api = await loadPreloadApi();
    const listener = vi.fn();
    const off = api.bugReport.onOpenRequest(listener);
    emitIpc('bugReport:open', { token: 'must-not-forward' });
    expect(listener).toHaveBeenCalledWith();
    off();
    emitIpc('bugReport:open', {});
    expect(listener).toHaveBeenCalledOnce();
  });

  it('exposes billing changes without IPC event data and supports unsubscribe', async () => {
    const api = await loadPreloadApi();
    const listener = vi.fn();
    const off = api.billing.onChanged(listener);
    emitIpc('billing:changed', { token: 'must-not-forward' });
    expect(listener).toHaveBeenCalledWith();
    off();
    emitIpc('billing:changed', {});
    expect(listener).toHaveBeenCalledOnce();
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

  it('replay of an adopted session delivers the retained window inside the pull, before any live chunk (DSK-01)', async () => {
    const api = await loadPreloadApi();
    const received: string[] = [];
    api.pty.onData('s-adopted', (data) => received.push(data));
    electronMock.ipcRenderer.invoke.mockResolvedValue([
      { sessionId: 's-adopted', sequence: 1, data: 'old ' },
      { sessionId: 's-adopted', sequence: 2, data: 'frame' },
    ]);

    await api.pty.replay('s-adopted');

    // Delivered before replay() settles: the renderer sanitizes exactly that
    // window. Dropping it left the old frame to the 15 s recover, raw.
    expect(received).toEqual(['old ', 'frame']);
    expect(recoverInvokes()).toEqual([{ sessionId: 's-adopted', afterSequence: 0 }]);
    expect(ackSends().map((ack) => ack.sequence)).toEqual([1, 2]);

    // Live output continues contiguously after the replayed window.
    emitPtyData({ sessionId: 's-adopted', sequence: 3, data: 'live' });
    expect(received).toEqual(['old ', 'frame', 'live']);
    expect(recoverInvokes()).toHaveLength(1);
  });

  it('marks only what the replay pull delivered; a live push during a slow replay stays unmarked (DSK-01)', async () => {
    const api = await loadPreloadApi();
    const received: Array<[string, unknown]> = [];
    api.pty.onData('s-adopted', (data, meta) => received.push([data, meta]));
    let resolveReplay!: (events: PtyDataEvent[]) => void;
    electronMock.ipcRenderer.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveReplay = resolve as (events: PtyDataEvent[]) => void;
        }),
    );

    const replaying = api.pty.replay('s-adopted');
    // The adopted TUI answers the adoption SIGWINCH while the pull is slow:
    // its chunk is pushed live, and main's window also returns it.
    emitPtyData({ sessionId: 's-adopted', sequence: 3, data: 'live\x1b[6n' });
    resolveReplay([
      { sessionId: 's-adopted', sequence: 1, data: 'old ' },
      { sessionId: 's-adopted', sequence: 2, data: 'frame' },
      { sessionId: 's-adopted', sequence: 3, data: 'live\x1b[6n' },
    ]);
    await replaying;

    // Only retained output written again is marked; the renderer sanitizes
    // that and nothing else, so the live query still gets its answer.
    expect(received).toEqual([
      ['old ', { replayed: true }],
      ['frame', { replayed: true }],
      ['live\x1b[6n', undefined],
    ]);
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
      'answerDirect',
      'command',
      'list',
      'listForWorkspace',
      'onChanged',
      'prepare',
      'routeIntent',
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

  it('um listener que lança NÃO cala os demais (entrega isolada)', async () => {
    const api = await loadPreloadApi();
    const failing = vi.fn(() => {
      throw new Error('subscriber quebrado');
    });
    const healthy = vi.fn();
    api.orch.onMissionsChanged(failing);
    api.orch.onMissionsChanged(healthy);

    expect(() =>
      emitIpc(ORCH_CHANNELS.missionsChanged, [{ id: 'm' }]),
    ).not.toThrow();
    expect(healthy).toHaveBeenCalledWith([{ id: 'm' }]);
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

  it('pty.resize encaminha o assert opcional para o Main (F-216)', async () => {
    const api = await loadPreloadApi();
    api.pty.resize('s1', 120, 40);
    api.pty.resize('s1', 120, 40, { assert: true });
    const sends = electronMock.ipcRenderer.send.mock.calls
      .filter(([channel]) => channel === PTY_CHANNELS.resize)
      .map(([, payload]) => payload);
    expect(sends).toEqual([
      { sessionId: 's1', cols: 120, rows: 40 },
      { sessionId: 's1', cols: 120, rows: 40, assert: true },
    ]);
  });
});



describe('files.clipboardFileUris (F-582)', () => {
  beforeEach(() => {
    vi.resetModules();
    electronMock.handlers.clear();
    electronMock.ipcRenderer.on.mockClear();
    electronMock.ipcRenderer.send.mockClear();
    electronMock.ipcRenderer.invoke.mockReset();
    electronMock.ipcRenderer.invoke.mockResolvedValue([]);
    electronMock.contextBridge.exposeInMainWorld.mockClear();
  });

  it('invokes the main pasteboard channel with no payload', async () => {
    const api = await loadPreloadApi();
    electronMock.ipcRenderer.invoke.mockResolvedValueOnce({
      uris: ['file:///Users/ana/foto.jpg'],
    });

    const result = await api.files.clipboardFileUris();

    expect(
      electronMock.ipcRenderer.invoke.mock.calls,
    ).toContainEqual([FILES_CHANNELS.clipboardFileUris]);
    expect(result).toEqual({ uris: ['file:///Users/ana/foto.jpg'] });
  });

  it('convertHeicToJpeg sends only the bytes to the Main converter', async () => {
    const api = await loadPreloadApi();
    const bytes = new Uint8Array([1, 2, 3]);
    electronMock.ipcRenderer.invoke.mockResolvedValueOnce({
      ok: false,
      reason: 'unsupported',
      error: 'HEIC não suportado neste sistema.',
    });

    const result = await api.files.convertHeicToJpeg(bytes);

    expect(electronMock.ipcRenderer.invoke.mock.calls).toContainEqual([
      FILES_CHANNELS.convertHeicToJpeg,
      { bytes },
    ]);
    expect(result).toEqual({
      ok: false,
      reason: 'unsupported',
      error: 'HEIC não suportado neste sistema.',
    });
  });
});

describe('perf.onPaneFootprints (QLT-11: o main só mede com assinante)', () => {
  beforeEach(() => {
    vi.resetModules();
    electronMock.handlers.clear();
    electronMock.ipcRenderer.send.mockClear();
    electronMock.contextBridge.exposeInMainWorld.mockClear();
  });

  function watchSends(): unknown[] {
    return electronMock.ipcRenderer.send.mock.calls
      .filter(([channel]) => channel === PERF_CHANNELS.paneFootprintsWatch)
      .map(([, active]) => active);
  }

  it('assina no primeiro ouvinte e desassina só quando o último sai', async () => {
    const api = await loadPreloadApi();
    const a = vi.fn();
    const b = vi.fn();

    const offA = api.perf.onPaneFootprints(a);
    const offB = api.perf.onPaneFootprints(b);
    expect(watchSends()).toEqual([true]);

    emitIpc(PERF_CHANNELS.paneFootprints, { generation: 1, sequence: 1 });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    offA();
    offA(); // idempotente: não desassina o renderer por engano
    expect(watchSends()).toEqual([true]);
    offB();
    expect(watchSends()).toEqual([true, false]);
  });
});
