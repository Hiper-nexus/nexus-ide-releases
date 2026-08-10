import { beforeEach, describe, expect, it, vi } from 'vitest';

const focus = vi.fn();
const setPanes = vi.fn();
const bindPaneMission = vi.fn();
const listMissionPanes = vi.fn();
const resumeMissionBootstrap = vi.fn();
const terminalMocks = vi.hoisted(() => ({
  waitForSession: vi.fn(
    async (paneId: string): Promise<string | null> => `session-${paneId}`,
  ),
  getPaneSessionId: vi.fn(
    (paneId: string): string | null => `session-${paneId}`,
  ),
  prepareMissionPaneResume: vi.fn(),
  markPersistedAuthorityOnSpawn: vi.fn(),
}));

let layoutPanes: Array<{
  id: string;
  kind: string;
  role?: string;
  adapterId?: string;
  isStructuralPlaceholder?: boolean;
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
  prepareMissionPaneResume: terminalMocks.prepareMissionPaneResume,
  markPersistedAuthorityOnSpawn: terminalMocks.markPersistedAuthorityOnSpawn,
  waitForSession: terminalMocks.waitForSession,
  getPaneSessionId: terminalMocks.getPaneSessionId,
}));


import { reopenMission } from './mission-reopen';

describe('reopenMission soft / multi', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    layoutPanes = [
      { id: 'live-1', kind: 'cli-agent', role: 'orchestrator', adapterId: 'codex' },
    ];
    paneMissions = { 'live-1': 'mission-live' };
    terminalMocks.waitForSession.mockImplementation(
      async (paneId: string) => `session-${paneId}`,
    );
    terminalMocks.getPaneSessionId.mockImplementation(
      (paneId: string) => `session-${paneId}`,
    );
    resumeMissionBootstrap.mockResolvedValue({
      ok: false,
      error: 'A missão não está bloqueada pelo bootstrap.',
    });
    vi.stubGlobal('window', {
      nexus: {
        orch: {
          listMissionPanes,
          resumeMissionBootstrap,
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

  it('soft-focuses when the complete persisted composition already has live panes', async () => {
    listMissionPanes.mockResolvedValueOnce([
      {
        id: 'spec-live',
        missionId: 'mission-live',
        adapterId: 'codex',
        title: 'live',
        role: 'orchestrator',
        paneId: 'live-1',
        createdAt: 1,
      },
    ]);
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
    expect(listMissionPanes).toHaveBeenCalledWith('mission-live');
    expect(terminalMocks.prepareMissionPaneResume).not.toHaveBeenCalled();
    expect(setPanes).not.toHaveBeenCalled();
  });

  it('rearms a pane still in the grid when its renderer session map is stale', async () => {
    terminalMocks.getPaneSessionId.mockReturnValueOnce(null);
    listMissionPanes.mockResolvedValueOnce([
      {
        id: 'spec-live-stale',
        missionId: 'mission-live',
        adapterId: 'codex',
        title: 'live-stale',
        role: 'orchestrator',
        paneId: 'live-1',
        createdAt: 1,
      },
    ]);

    const result = await reopenMission({
      id: 'mission-live',
      title: 'Live stale',
      description: '',
      status: 'running',
      milestones: [],
      learnings: '',
      createdAt: 1,
      updatedAt: 2,
    });

    expect(result.ok).toBe(true);
    expect(terminalMocks.prepareMissionPaneResume).toHaveBeenCalledWith('live-1');
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

  it('drops the lone unused structural placeholder when reopening (no empty shell tile)', async () => {
    layoutPanes = [
      { id: 'shell-1', kind: 'shell', isStructuralPlaceholder: true },
    ];
    paneMissions = {};
    terminalMocks.getPaneSessionId.mockImplementation(() => null);
    listMissionPanes.mockResolvedValueOnce([
      {
        id: 'spec-orch',
        missionId: 'mission-solo',
        adapterId: 'codex',
        title: 'orch',
        role: 'orchestrator',
        paneId: 'orch-x',
        createdAt: 1,
      },
    ]);

    const result = await reopenMission({
      id: 'mission-solo',
      title: 'Solo',
      description: '',
      status: 'running',
      milestones: [],
      learnings: '',
      createdAt: 1,
      updatedAt: 2,
    });

    expect(result.ok).toBe(true);
    const mounted = setPanes.mock.calls[0]![0] as Array<{ id: string }>;
    expect(mounted.map((pane) => pane.id)).toEqual(['orch-x']);
  });

  it('keeps a shell the operator claimed (not a structural placeholder)', async () => {
    layoutPanes = [{ id: 'shell-1', kind: 'shell' }];
    paneMissions = {};
    terminalMocks.getPaneSessionId.mockImplementation(() => null);
    listMissionPanes.mockResolvedValueOnce([
      {
        id: 'spec-orch',
        missionId: 'mission-claimed',
        adapterId: 'codex',
        title: 'orch',
        role: 'orchestrator',
        paneId: 'orch-y',
        createdAt: 1,
      },
    ]);

    const result = await reopenMission({
      id: 'mission-claimed',
      title: 'Claimed',
      description: '',
      status: 'running',
      milestones: [],
      learnings: '',
      createdAt: 1,
      updatedAt: 2,
    });

    expect(result.ok).toBe(true);
    const mounted = setPanes.mock.calls[0]![0] as Array<{ id: string }>;
    expect(mounted.map((pane) => pane.id)).toEqual(['shell-1', 'orch-y']);
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
    expect(listMissionPanes).not.toHaveBeenCalled();
    expect(terminalMocks.prepareMissionPaneResume).not.toHaveBeenCalled();
    expect(resumeMissionBootstrap).not.toHaveBeenCalled();
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
    expect(terminalMocks.prepareMissionPaneResume).not.toHaveBeenCalled();
  });

  it('fails before rearm or spawn preparation when the complete mission would exceed grid capacity', async () => {
    layoutPanes = Array.from({ length: 16 }, (_, index) => ({
      id: `existing-${index}`,
      kind: 'shell',
    }));
    paneMissions = {};
    listMissionPanes.mockResolvedValueOnce([
      {
        id: 'spec-capacity',
        missionId: 'mission-capacity',
        adapterId: 'gemini',
        title: 'capacity-orch',
        role: 'orchestrator',
        paneId: 'pane-capacity',
        createdAt: 1,
      },
    ]);

    const result = await reopenMission({
      id: 'mission-capacity',
      title: 'Capacity',
      description: '',
      status: 'running',
      milestones: [],
      learnings: '',
      createdAt: 1,
      updatedAt: 2,
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/grid|vaga/i),
    });
    expect(terminalMocks.prepareMissionPaneResume).not.toHaveBeenCalled();
    expect(setPanes).not.toHaveBeenCalled();
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

  it('explicitly rearms each stable pane id before retrying a failed mission reopen', async () => {
    listMissionPanes.mockResolvedValueOnce([
      {
        id: 'spec-dead-orch',
        missionId: 'mission-dead',
        adapterId: 'claude',
        title: 'dead-orch',
        role: 'orchestrator',
        paneId: 'pane-dead-orch',
        createdAt: 1,
      },
    ]);

    const result = await reopenMission({
      id: 'mission-dead',
      title: 'Dead mission',
      description: '',
      status: 'running',
      milestones: [],
      learnings: '',
      createdAt: 1,
      updatedAt: 2,
    });

    expect(result.ok).toBe(true);
    expect(terminalMocks.prepareMissionPaneResume).toHaveBeenCalledOnce();
    expect(terminalMocks.prepareMissionPaneResume).toHaveBeenCalledWith(
      'pane-dead-orch',
    );
    expect(terminalMocks.waitForSession).toHaveBeenCalledWith(
      'pane-dead-orch',
      10_000,
    );
  });

  it('resumes a blocked-user mission only through main-owned bootstrap', async () => {
    resumeMissionBootstrap.mockResolvedValueOnce({
      ok: true,
      missionId: 'mission-blocked',
      pane: {
        sessionId: 'session-blocked',
        paneId: 'pane-blocked',
        adapterId: 'gemini',
        cwd: '/tmp/ws',
        title: 'Blocked · orq',
        agentName: 'Maestro',
        role: 'orchestrator',
      },
    });
    terminalMocks.waitForSession.mockResolvedValueOnce('session-blocked');

    const result = await reopenMission({
      id: 'mission-blocked',
      title: 'Blocked',
      description: '',
      status: 'blocked',
      intentState: 'blocked_user',
      intentContract: {
        version: 1,
        source: 'typed',
        goal: 'resume safely',
        acceptanceCriteria: ['resumed'],
        risk: 'normal',
        executionMode: 'autopilot',
        lane: 'standard',
        contextPolicy: 'on-demand',
        approvedAt: 1,
        dispatchedAt: 1,
        intentVersion: 1,
        budgets: {
          planningTokens: 100,
          executionTokens: 100,
          maxWorkers: 1,
          maxSteps: 10,
        },
        evidenceAttached: false,
        squadRevisionHash: 'hash',
        orchestratorRuntime: {
          adapterId: 'gemini',
          readOnly: false,
          nativeReadOnly: true,
        },
      },
      intentVersion: 1,
      milestones: [],
      learnings: '',
      createdAt: 1,
      updatedAt: 2,
    });

    expect(result.ok).toBe(true);
    expect(resumeMissionBootstrap).toHaveBeenCalledWith({
      missionId: 'mission-blocked',
    });
    expect(listMissionPanes).not.toHaveBeenCalled();
    expect(terminalMocks.prepareMissionPaneResume).not.toHaveBeenCalled();
    expect(
      terminalMocks.markPersistedAuthorityOnSpawn,
    ).toHaveBeenCalledWith('pane-blocked');
  });

  it('does not prepare panes when blocked main-owned resume fails', async () => {
    resumeMissionBootstrap.mockResolvedValueOnce({
      ok: false,
      missionId: 'mission-blocked-fail',
      reason: 'not_authorized',
      error: 'A aprovação da missão não está mais vigente.',
      cta: 'Retomar missão',
    });

    const result = await reopenMission({
      id: 'mission-blocked-fail',
      title: 'Blocked fail',
      description: '',
      status: 'blocked',
      intentState: 'blocked_user',
      milestones: [],
      learnings: '',
      createdAt: 1,
      updatedAt: 2,
    });

    expect(result).toEqual({
      ok: false,
      error: 'A aprovação da missão não está mais vigente.',
    });
    expect(terminalMocks.prepareMissionPaneResume).not.toHaveBeenCalled();
    expect(listMissionPanes).not.toHaveBeenCalled();
    expect(setPanes).not.toHaveBeenCalled();
  });

  it('opens the review wizard shell when main publishes a fresh reapproval revision', async () => {
    resumeMissionBootstrap.mockResolvedValueOnce({
      ok: false,
      missionId: 'mission-dead-graph',
      reason: 'review_required',
      intentVersion: 3,
      error: 'Revise a nova versão e aprove novamente.',
      cta: 'Revisar e aprovar',
    });

    const result = await reopenMission({
      id: 'mission-dead-graph',
      title: 'Dead graph',
      description: '',
      status: 'blocked',
      squadId: 'squad-a',
      intentState: 'blocked_technical',
      milestones: [],
      learnings: '',
      createdAt: 1,
      updatedAt: 2,
    });

    expect(result).toEqual({ ok: true, panes: 0, intentShell: true });
    expect(listMissionPanes).not.toHaveBeenCalled();
    expect(terminalMocks.prepareMissionPaneResume).not.toHaveBeenCalled();
    expect(terminalMocks.markPersistedAuthorityOnSpawn).not.toHaveBeenCalled();
    expect(setPanes).not.toHaveBeenCalled();
  });

  it('does not prepare panes when persisted composition cannot be read', async () => {
    listMissionPanes.mockRejectedValueOnce(new Error('runtime indisponível'));

    const result = await reopenMission({
      id: 'mission-read-fail',
      title: 'Read fail',
      description: '',
      status: 'running',
      milestones: [],
      learnings: '',
      createdAt: 1,
      updatedAt: 2,
    });

    expect(result).toEqual({ ok: false, error: 'runtime indisponível' });
    expect(terminalMocks.prepareMissionPaneResume).not.toHaveBeenCalled();
    expect(setPanes).not.toHaveBeenCalled();
  });

  it('materializes the exact sealed pane when main-owned bootstrap resumes directly', async () => {
    resumeMissionBootstrap.mockResolvedValueOnce({
      ok: true,
      missionId: 'mission-bootstrap',
      pane: {
        sessionId: 'session-bootstrap',
        paneId: 'pane-bootstrap',
        adapterId: 'claude',
        cwd: '/tmp/ws',
        title: 'Bootstrap · orq',
        agentName: 'Maestro',
        role: 'orchestrator',
      },
    });
    terminalMocks.waitForSession.mockResolvedValueOnce('session-bootstrap');

    const result = await reopenMission({
      id: 'mission-bootstrap',
      title: 'Bootstrap',
      description: '',
      status: 'blocked',
      intentState: 'blocked_technical',
      milestones: [],
      learnings: '',
      createdAt: 1,
      updatedAt: 2,
    });

    expect(result).toMatchObject({
      ok: true,
      panes: 1,
      sessionIds: ['session-bootstrap'],
    });
    expect(listMissionPanes).not.toHaveBeenCalled();
    expect(terminalMocks.prepareMissionPaneResume).not.toHaveBeenCalled();
    expect(
      terminalMocks.markPersistedAuthorityOnSpawn,
    ).toHaveBeenCalledWith('pane-bootstrap');
    expect(bindPaneMission).toHaveBeenCalledWith(
      'pane-bootstrap',
      'mission-bootstrap',
    );
    expect(setPanes).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'live-1' }),
      expect.objectContaining({
        id: 'pane-bootstrap',
        missionId: 'mission-bootstrap',
        role: 'orchestrator',
      }),
    ]);
  });

  it('preserves a live mission pane and prepares only a missing sibling', async () => {
    layoutPanes = [
      {
        id: 'live-1',
        kind: 'cli-agent',
        role: 'orchestrator',
        adapterId: 'codex',
      },
    ];
    paneMissions = { 'live-1': 'mission-partial' };
    listMissionPanes.mockResolvedValueOnce([
      {
        id: 'spec-live',
        missionId: 'mission-partial',
        adapterId: 'codex',
        title: 'orch',
        role: 'orchestrator',
        paneId: 'live-1',
        createdAt: 1,
      },
      {
        id: 'spec-missing',
        missionId: 'mission-partial',
        adapterId: 'gemini',
        title: 'worker',
        role: 'worker',
        paneId: 'missing-2',
        createdAt: 1,
      },
    ]);
    terminalMocks.getPaneSessionId.mockImplementation((paneId: string) =>
      paneId === 'live-1' ? 'session-live-1' : null,
    );
    terminalMocks.waitForSession.mockImplementation(async (paneId: string) =>
      `session-${paneId}`,
    );

    const result = await reopenMission({
      id: 'mission-partial',
      title: 'Partial',
      description: '',
      status: 'running',
      milestones: [],
      learnings: '',
      createdAt: 1,
      updatedAt: 2,
    });

    expect(result.ok).toBe(true);
    expect(terminalMocks.prepareMissionPaneResume).toHaveBeenCalledOnce();
    expect(terminalMocks.prepareMissionPaneResume).toHaveBeenCalledWith(
      'missing-2',
    );
    expect(terminalMocks.prepareMissionPaneResume).not.toHaveBeenCalledWith(
      'live-1',
    );
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
    expect(setPanes).not.toHaveBeenCalled();
    expect(terminalMocks.prepareMissionPaneResume).not.toHaveBeenCalled();
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
    expect(setPanes).not.toHaveBeenCalled();
  });
});
