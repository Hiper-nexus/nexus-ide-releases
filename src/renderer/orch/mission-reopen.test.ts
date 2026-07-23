import { beforeEach, describe, expect, it, vi } from 'vitest';

const focus = vi.fn();
const setPanes = vi.fn();
const bindPaneMission = vi.fn();
const killLiveAgents = vi.fn();
const killConflictingOrchestrators = vi.fn(
  (_id?: string) => [] as string[],
);
const listMissionPanes = vi.fn();
const terminalMocks = vi.hoisted(() => ({
  waitForSession: vi.fn(
    async (paneId: string): Promise<string | null> => `session-${paneId}`,
  ),
  getPaneSessionId: vi.fn((paneId: string) => `session-${paneId}`),
}));

let layoutPanes: Array<{
  id: string;
  kind: string;
  role?: string;
  adapterId?: string;
}> = [{ id: 'live-1', kind: 'cli-agent', role: 'orchestrator', adapterId: 'codex' }];

let paneMissions: Record<string, string> = { 'live-1': 'mission-live' };

vi.mock('../state/layout-store', () => ({
  useLayoutStore: {
    getState: () => ({
      root: { type: 'leaf', pane: layoutPanes[0] },
      focus,
      setPanes,
    }),
  },
}));

vi.mock('../state/orch-store', () => ({
  useOrchStore: {
    getState: () => ({
      paneMissions,
      bindPaneMission,
    }),
  },
}));

vi.mock('../lib/split-tree', () => ({
  listPanes: () => layoutPanes,
  createPane: vi.fn(() => ({ id: 'new-id', kind: 'cli-agent' })),
}));

vi.mock('../state/active-workspace', () => ({
  getActiveWorkspacePath: () => '/tmp/ws',
}));

vi.mock('../terminal/terminal-host', () => ({
  markResumeOnSpawn: vi.fn(),
  waitForSession: terminalMocks.waitForSession,
  getPaneSessionId: terminalMocks.getPaneSessionId,
}));

vi.mock('./mission-launcher', async () => {
  const actual = await vi.importActual<typeof import('./mission-auth-conflict')>(
    './mission-auth-conflict',
  );
  return {
    killLiveAgents: () => killLiveAgents(),
    killConflictingOrchestrators: (id: string | undefined) =>
      killConflictingOrchestrators(id),
    conflictingOrchestratorPanes: (id: string | undefined) =>
      actual.conflictingOrchestratorPanes(id),
    hardReopenWouldKillAgents: (id: string | undefined) =>
      actual.hardReopenWouldKillAgents(id),
  };
});

import { reopenMission } from './mission-reopen';

describe('reopenMission soft / multi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    layoutPanes = [
      { id: 'live-1', kind: 'cli-agent', role: 'orchestrator', adapterId: 'codex' },
    ];
    paneMissions = { 'live-1': 'mission-live' };
    killConflictingOrchestrators.mockReturnValue([]);
    terminalMocks.waitForSession.mockImplementation(
      async (paneId: string) => `session-${paneId}`,
    );
    terminalMocks.getPaneSessionId.mockImplementation(
      (paneId: string) => `session-${paneId}`,
    );
    vi.stubGlobal('window', {
      nexus: {
        orch: {
          listMissionPanes,
          rebindMissionOrchestrator: vi.fn(async () => ({ ok: true })),
        },
        pty: { kill: vi.fn() },
      },
    });
  });

  it('reports hard reopen would displace existing layout', async () => {
    const { hardReopenWouldDisplaceLayout } = await import('./mission-reopen');
    expect(hardReopenWouldDisplaceLayout('other-mission')).toBe(true);
    expect(hardReopenWouldDisplaceLayout('mission-live')).toBe(false);
  });

  it('soft-focuses when the mission already has live panes', async () => {
    const result = await reopenMission({
      id: 'mission-live',
      title: 'Live',
      description: '',
      status: 'running',
      milestones: [],
      learnings: '',
      createdAt: 1,
      updatedAt: 2,
    });
    expect(result).toMatchObject({
      ok: true,
      panes: 1,
      soft: true,
      sessionIds: ['session-live-1'],
      ackId: expect.stringMatching(/^mission-reopen:/),
      ackedAt: expect.any(Number),
    });
    expect(focus).toHaveBeenCalledWith('live-1');
    expect(killLiveAgents).not.toHaveBeenCalled();
    expect(listMissionPanes).not.toHaveBeenCalled();
  });

  it('merges without kill when reopening another mission without Claude conflict', async () => {
    listMissionPanes.mockResolvedValueOnce([
      {
        id: 'spec-1',
        missionId: 'mission-b',
        adapterId: 'gemini',
        title: 'orch-b',
        role: 'orchestrator',
        paneId: 'orch-b',
        createdAt: 1,
      },
    ]);
    const result = await reopenMission({
      id: 'mission-b',
      title: 'B',
      description: '',
      status: 'running',
      milestones: [],
      learnings: '',
      createdAt: 1,
      updatedAt: 2,
    });
    expect(result.ok).toBe(true);
    expect(result.soft).toBe(false);
    expect(result.multi).toBe(true);
    expect(killLiveAgents).not.toHaveBeenCalled();
    expect(setPanes).toHaveBeenCalled();
    const merged = setPanes.mock.calls[0]![0] as Array<{ id: string }>;
    expect(merged.map((p) => p.id)).toContain('live-1');
    expect(merged.map((p) => p.id)).toContain('orch-b');
    expect(result).toMatchObject({
      sessionIds: ['session-orch-b'],
      ackId: expect.stringMatching(/^mission-reopen:/),
      ackedAt: expect.any(Number),
    });
    expect(window.nexus.orch.rebindMissionOrchestrator).toHaveBeenCalledWith(
      'mission-b',
      'session-orch-b',
    );
  });

  it('fails closed before changing layout on a forced hard reopen', async () => {
    listMissionPanes.mockResolvedValueOnce([
      {
        id: 'spec-hard',
        missionId: 'mission-hard',
        adapterId: 'gemini',
        title: 'orch-hard',
        role: 'orchestrator',
        paneId: 'orch-hard',
        createdAt: 1,
      },
    ]);

    const result = await reopenMission(
      {
        id: 'mission-hard',
        title: 'Hard',
        description: '',
        status: 'running',
        milestones: [],
        learnings: '',
        createdAt: 1,
        updatedAt: 2,
      },
      { forceHard: true },
    );

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/saída|encerramento físico/i),
    });
    expect(setPanes).not.toHaveBeenCalled();
    expect(killLiveAgents).not.toHaveBeenCalled();
  });

  it('fails closed on exclusive-auth conflict without renderer-side kill', async () => {
    layoutPanes = [
      {
        id: 'claude-live',
        kind: 'cli-agent',
        role: 'orchestrator',
        adapterId: 'claude',
      },
    ];
    paneMissions = { 'claude-live': 'mission-live' };
    listMissionPanes.mockResolvedValueOnce([
      {
        id: 'spec-conflict',
        missionId: 'mission-conflict',
        adapterId: 'claude',
        title: 'orch-conflict',
        role: 'orchestrator',
        paneId: 'orch-conflict',
        createdAt: 1,
      },
    ]);

    const result = await reopenMission({
      id: 'mission-conflict',
      title: 'Conflict',
      description: '',
      status: 'running',
      milestones: [],
      learnings: '',
      createdAt: 1,
      updatedAt: 2,
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/credencial exclusiva|saída/i),
    });
    expect(setPanes).not.toHaveBeenCalled();
    expect(killConflictingOrchestrators).not.toHaveBeenCalled();
  });

  it('does not claim restore success before every pane and rebind are acknowledged', async () => {
    listMissionPanes.mockResolvedValueOnce([
      {
        id: 'spec-orch',
        missionId: 'mission-b',
        adapterId: 'gemini',
        title: 'orch-b',
        role: 'orchestrator',
        paneId: 'orch-b',
        createdAt: 1,
      },
      {
        id: 'spec-worker',
        missionId: 'mission-b',
        adapterId: 'codex',
        title: 'worker-b',
        role: 'worker',
        paneId: 'worker-b',
        createdAt: 1,
      },
    ]);
    terminalMocks.waitForSession.mockImplementation(async (paneId: string) =>
      paneId === 'worker-b' ? null : `session-${paneId}`,
    );
    const result = await reopenMission({
      id: 'mission-b',
      title: 'B',
      description: '',
      status: 'running',
      milestones: [],
      learnings: '',
      createdAt: 1,
      updatedAt: 2,
    });
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toMatch(/worker-b.*não confirmou/i);
    expect(window.nexus.orch.rebindMissionOrchestrator).not.toHaveBeenCalled();
  });

  it('returns intentShell for armed agentic missions without panes', async () => {
    listMissionPanes.mockResolvedValueOnce([]);
    const result = await reopenMission({
      id: 'mission-armed',
      title: 'preciso de melhorias',
      description: 'preciso de melhorias no nexus',
      status: 'pending',
      intentState: 'awaiting_goal',
      squadId: 'navalha',
      milestones: [],
      learnings: '',
      createdAt: 1,
      updatedAt: 2,
    });
    expect(result).toEqual({ ok: true, panes: 0, intentShell: true });
    expect(setPanes).not.toHaveBeenCalled();
  });

  it('rejects legacy forceHard instead of killing from the renderer', async () => {
    listMissionPanes.mockResolvedValueOnce([
      {
        id: 'spec-1',
        missionId: 'mission-live',
        adapterId: 'claude',
        title: 'orch',
        role: 'orchestrator',
        paneId: 'orch-1',
        createdAt: 1,
      },
    ]);
    const result = await reopenMission(
      {
        id: 'mission-live',
        title: 'Live',
        description: '',
        status: 'running',
        milestones: [],
        learnings: '',
        createdAt: 1,
        updatedAt: 2,
      },
      { forceHard: true },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/encerramento físico|saída/i);
    expect(killLiveAgents).not.toHaveBeenCalled();
    expect(setPanes).not.toHaveBeenCalled();
  });

  it('rejects a Claude conflict instead of killing only its visible pane', async () => {
    layoutPanes = [
      {
        id: 'claude-orch',
        kind: 'cli-agent',
        role: 'orchestrator',
        adapterId: 'claude',
      },
      { id: 'worker-x', kind: 'cli-agent', adapterId: 'codex' },
    ];
    paneMissions = { 'claude-orch': 'mission-a', 'worker-x': 'mission-a' };
    killConflictingOrchestrators.mockReturnValue(['claude-orch']);
    listMissionPanes.mockResolvedValueOnce([
      {
        id: 'spec-1',
        missionId: 'mission-b',
        adapterId: 'claude',
        title: 'orch-b',
        role: 'orchestrator',
        paneId: 'orch-b',
        createdAt: 1,
      },
    ]);
    const result = await reopenMission({
      id: 'mission-b',
      title: 'B',
      description: '',
      status: 'running',
      milestones: [],
      learnings: '',
      createdAt: 1,
      updatedAt: 2,
    });
    expect(result.ok).toBe(false);
    expect(killLiveAgents).not.toHaveBeenCalled();
    expect(killConflictingOrchestrators).not.toHaveBeenCalled();
    expect(setPanes).not.toHaveBeenCalled();
  });
});
