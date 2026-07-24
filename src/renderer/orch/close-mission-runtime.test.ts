// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  close: vi.fn(),
  closeRuntime: vi.fn(),
  paneMissions: {} as Record<string, string>,
  panes: [] as Array<{ id: string; kind: string; missionId?: string }>,
}));

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
    getState: () => ({ paneMissions: harness.paneMissions }),
  },
}));
vi.mock('../lib/split-tree', () => ({
  listPanes: () => harness.panes,
}));

import { closeMissionRuntimeAndPanes } from './close-mission-runtime';

describe('closeMissionRuntimeAndPanes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    harness.panes = [
      { id: 'pane-a', kind: 'cli-agent', missionId: 'mission-a' },
      { id: 'pane-b', kind: 'cli-agent', missionId: 'mission-b' },
    ];
    harness.paneMissions = {};
    vi.stubGlobal('window', {
      nexus: { orch: { closeMissionRuntime: harness.closeRuntime } },
    });
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
});
