// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  setPanes: vi.fn(),
  focus: vi.fn(),
  hide: vi.fn(),
  bindPaneMission: vi.fn(),
  markPersistedAuthorityOnSpawn: vi.fn(),
  waitForSession: vi.fn(),
  paneMissions: {} as Record<string, string>,
  layoutPanes: [] as Array<Record<string, unknown>>,
}));

vi.mock('../state/layout-store', () => ({
  useLayoutStore: {
    getState: () => ({
      root: { kind: 'leaf', pane: harness.layoutPanes[0] },
      setPanes: harness.setPanes,
      focus: harness.focus,
    }),
  },
}));

vi.mock('../state/orch-store', () => ({
  useOrchStore: {
    getState: () => ({
      paneMissions: harness.paneMissions,
      bindPaneMission: harness.bindPaneMission,
    }),
  },
}));

vi.mock('../state/home-store', () => ({
  useHomeStore: { getState: () => ({ hide: harness.hide }) },
}));

vi.mock('../lib/split-tree', () => ({
  createPane: vi.fn(() => ({ id: 'generated', kind: 'cli-agent' })),
  listPanes: () => harness.layoutPanes,
}));

vi.mock('../terminal/terminal-host', () => ({
  markPersistedAuthorityOnSpawn: harness.markPersistedAuthorityOnSpawn,
  waitForSession: harness.waitForSession,
}));

import { presentMainOwnedMissionPane } from './mission-pane-presentation';

const sealed = {
  paneId: 'pane-new',
  sessionId: 'session-new',
  adapterId: 'claude',
  model: 'claude-sonnet-5',
  cwd: '/workspace/a',
  title: 'Execução + QA · orq',
  agentName: 'Maestro',
  role: 'orchestrator' as const,
};

describe('presentMainOwnedMissionPane', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    harness.paneMissions = {
      'pane-old': 'mission-a',
      'pane-other': 'mission-other',
    };
    harness.layoutPanes = [
      {
        id: 'pane-old',
        kind: 'cli-agent',
        missionId: 'mission-a',
        role: 'orchestrator',
      },
      {
        id: 'pane-other',
        kind: 'cli-agent',
        missionId: 'mission-other',
        role: 'orchestrator',
      },
    ];
    harness.waitForSession.mockResolvedValue('session-new');
  });

  it('replaces stale copies of the same mission and verifies exact adoption', async () => {
    const result = await presentMainOwnedMissionPane(
      'mission-a',
      sealed,
      {},
      { waitForSession: harness.waitForSession },
    );

    expect(result).toMatchObject({ ok: true, pane: { id: 'pane-new' } });
    expect(harness.markPersistedAuthorityOnSpawn).toHaveBeenCalledWith(
      'pane-new',
    );
    expect(harness.bindPaneMission).toHaveBeenCalledWith(
      'pane-new',
      'mission-a',
    );
    expect(harness.setPanes).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'pane-other' }),
      expect.objectContaining({
        id: 'pane-new',
        missionId: 'mission-a',
        role: 'orchestrator',
      }),
    ]);
    expect(harness.waitForSession).toHaveBeenCalledWith('pane-new', 20_000);
    expect(harness.focus).toHaveBeenCalledWith('pane-new');
    expect(harness.hide).toHaveBeenCalledOnce();
  });

  it('removes explicitly displaced conflicts and placeholder-only layouts', async () => {
    harness.layoutPanes = [
      { id: 'shell-1', kind: 'shell' },
      { id: 'pane-conflict', kind: 'cli-agent', missionId: 'mission-old' },
    ];
    harness.paneMissions = { 'pane-conflict': 'mission-old' };

    await presentMainOwnedMissionPane(
      'mission-a',
      sealed,
      { removePaneIds: new Set(['pane-conflict']) },
      { waitForSession: harness.waitForSession },
    );

    expect(harness.setPanes).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'pane-new' }),
    ]);
  });

  it('fails when renderer adopts no session or a different physical session', async () => {
    harness.waitForSession.mockResolvedValueOnce(null);
    const missing = await presentMainOwnedMissionPane(
      'mission-a',
      sealed,
      {},
      { waitForSession: harness.waitForSession },
    );
    expect(missing).toMatchObject({
      ok: false,
      error: expect.stringMatching(/não adotou/i),
    });

    harness.waitForSession.mockResolvedValueOnce('session-other');
    const divergent = await presentMainOwnedMissionPane(
      'mission-a',
      sealed,
      {},
      { waitForSession: harness.waitForSession },
    );
    expect(divergent).toMatchObject({
      ok: false,
      error: expect.stringMatching(/sessão diferente/i),
    });
  });
});
