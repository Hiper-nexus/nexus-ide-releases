// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  workspace: { path: '/project' },
  close: vi.fn(),
  closeRuntime: vi.fn(),
  pruneMissionBindings: vi.fn(),
  paneMissions: {} as Record<string, string>,
  panes: [] as Array<{ id: string; kind: string; missionId?: string }>,
}));

vi.mock('../state/workspace-store', () => ({ useWorkspaceStore: { getState: () => ({ current: harness.workspace }) } }));

vi.mock('../state/layout-store', () => ({
  useLayoutStore: {
    getState: () => ({
      root: { kind: 'leaf', pane: harness.panes[0] },
      close: harness.close,
    }),
  },
}));
vi.mock('../state/orch-store', () => ({
  useOrchStore: {
    getState: () => ({
      paneMissions: harness.paneMissions,
      pruneMissionBindings: harness.pruneMissionBindings,
    }),
  },
}));
vi.mock('../lib/split-tree', () => ({
  listPanes: () => harness.panes,
}));

import { closeMissionRuntimeAndPanes } from './close-mission-runtime';

describe('closeMissionRuntimeAndPanes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    harness.workspace = { path: '/project' };
    harness.panes = [
      { id: 'pane-a', kind: 'cli-agent', missionId: 'mission-a' },
      { id: 'pane-b', kind: 'cli-agent', missionId: 'mission-b' },
    ];
    harness.close.mockImplementation((paneId: string) => {
      harness.panes = harness.panes.filter((pane) => pane.id !== paneId);
    });
    harness.paneMissions = {};
    vi.stubGlobal('window', {
      nexus: { orch: { closeMissionRuntime: harness.closeRuntime } },
    });
  });

  it('does not sweep another workspace after an asynchronous shutdown', async () => {
    let finish!: (value: { ok: boolean; terminatedSessionIds: string[] }) => void;
    harness.closeRuntime.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const pending = closeMissionRuntimeAndPanes('mission-a');
    harness.workspace = { path: '/other' };
    finish({ ok: true, terminatedSessionIds: ['pty-a'] });
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(harness.close).not.toHaveBeenCalled();
  });

  it('does not sweep a new project when physical proof arrives after timeout', async () => {
    vi.useFakeTimers();
    try {
      let finish!: (value: { ok: boolean; terminatedSessionIds: string[] }) => void;
      harness.closeRuntime.mockReturnValue(new Promise(resolve => { finish = resolve; }));
      const pending = closeMissionRuntimeAndPanes('mission-a');
      await vi.advanceTimersByTimeAsync(15_000);
      await pending;
      harness.workspace = { path: '/other' };
      finish({ ok: true, terminatedSessionIds: ['pty-a'] });
      await Promise.resolve();
      expect(harness.close).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('closes only this mission panes after main proves physical shutdown', async () => {
    harness.closeRuntime.mockResolvedValue({
      ok: true,
      mission: { id: 'mission-a' },
      terminatedSessionIds: ['pty-a'],
    });

    await closeMissionRuntimeAndPanes('mission-a', 'test-close');

    expect(harness.closeRuntime).toHaveBeenCalledWith('mission-a');
    expect(harness.close).toHaveBeenCalledOnce();
    expect(harness.close).toHaveBeenCalledWith('pane-a', 'test-close');
  });

  it('does not mutate the grid when close is cancelled or physical proof fails', async () => {
    harness.closeRuntime.mockResolvedValue({
      ok: false,
      cancelled: true,
      terminatedSessionIds: [],
    });
    await closeMissionRuntimeAndPanes('mission-a');
    expect(harness.close).not.toHaveBeenCalled();

    harness.closeRuntime.mockResolvedValue({
      ok: false,
      terminatedSessionIds: [],
      error: 'physical exit proof unavailable',
    });
    await closeMissionRuntimeAndPanes('mission-a');
    expect(harness.close).not.toHaveBeenCalled();
  });

  it('converte rejeição da autoridade em resultado, sem promessa pendurada', async () => {
    harness.closeRuntime.mockRejectedValue(
      new Error('mission runtime changed while confirmation was open'),
    );

    await expect(
      closeMissionRuntimeAndPanes('mission-a'),
    ).resolves.toEqual({
      ok: false,
      terminatedSessionIds: [],
      error: 'mission runtime changed while confirmation was open',
    });
    expect(harness.close).not.toHaveBeenCalled();
  });

  it('releases the UI when physical proof continues in the background', async () => {
    vi.useFakeTimers();
    let resolveClose:
      | ((result: {
          ok: true;
          terminatedSessionIds: string[];
        }) => void)
      | undefined;
    harness.closeRuntime.mockReturnValue(
      new Promise((resolve) => {
        resolveClose = resolve;
      }),
    );

    const resultPromise = closeMissionRuntimeAndPanes('mission-a');
    await vi.advanceTimersByTimeAsync(15_000);

    await expect(resultPromise).resolves.toMatchObject({
      ok: false,
      terminatedSessionIds: [],
      error: expect.stringMatching(/continua comprovando.*segundo plano/i),
    });
    expect(harness.close).not.toHaveBeenCalled();

    resolveClose?.({
      ok: true,
      terminatedSessionIds: ['pty-a'],
    });
    await Promise.resolve();
    expect(harness.close).toHaveBeenCalledWith(
      'pane-a',
      'mission-runtime-close',
    );
    vi.useRealTimers();
  });

  it('sweeps orphan renderer panes when the mission row is already gone', async () => {
    harness.closeRuntime.mockResolvedValue({
      ok: false,
      terminatedSessionIds: [],
      error: 'Missão não encontrada.',
    });

    await expect(
      closeMissionRuntimeAndPanes('mission-a', 'orphan-sweep'),
    ).resolves.toEqual({
      ok: true,
      terminatedSessionIds: [],
    });
    expect(harness.close).toHaveBeenCalledOnce();
    expect(harness.close).toHaveBeenCalledWith('pane-a', 'orphan-sweep');
    expect(harness.pruneMissionBindings).toHaveBeenCalledWith(
      new Set(['pane-b']),
    );
  });

  it('normalizes a legacy thrown mission-not-found into one idempotent local sweep', async () => {
    harness.closeRuntime.mockRejectedValue(
      new Error(
        "Error invoking remote method 'orch:missions.closeRuntime': Error: mission not found",
      ),
    );

    await expect(
      closeMissionRuntimeAndPanes('mission-a', 'legacy-orphan-sweep'),
    ).resolves.toEqual({
      ok: true,
      terminatedSessionIds: [],
    });
    expect(harness.close).toHaveBeenCalledOnce();
    expect(harness.close).toHaveBeenCalledWith(
      'pane-a',
      'legacy-orphan-sweep',
    );
    expect(harness.pruneMissionBindings).toHaveBeenCalledWith(
      new Set(['pane-b']),
    );
  });

  it('sweeps orphan panes for an already-done mission with no closable runtime', async () => {
    harness.closeRuntime.mockResolvedValue({
      ok: false,
      mission: { id: 'mission-a', status: 'done' },
      terminatedSessionIds: [],
      error: 'Missão concluída não possui execução encerrável.',
    });

    await expect(
      closeMissionRuntimeAndPanes('mission-a', 'done-sweep'),
    ).resolves.toMatchObject({
      ok: true,
      mission: { id: 'mission-a' },
      terminatedSessionIds: [],
    });
    expect(harness.close).toHaveBeenCalledWith('pane-a', 'done-sweep');
  });
});
