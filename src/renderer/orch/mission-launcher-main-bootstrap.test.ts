// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneModel } from '../../shared/types';

const harness = vi.hoisted(() => ({
  setPanes: vi.fn(),
  bindPaneMission: vi.fn(),
  markPersistedAuthorityOnSpawn: vi.fn(),
  waitForSession: vi.fn(async () => 'pty-main-orch'),
  toast: vi.fn(),
  hide: vi.fn(),
  focus: vi.fn(),
  openPanel: vi.fn(),
  conflictingOrchestratorPanes: vi.fn((): unknown[] => []),
  killConflictingOrchestrators: vi.fn(() => []),
  paneMissions: {} as Record<string, string>,
  missions: [] as Array<{ id: string; orchestratorSessionId?: string }>,
  getPaneSessionId: vi.fn((): string | null => null),
}));

vi.mock('../state/layout-store', () => ({
  useLayoutStore: {
    getState: () => ({
      root: {
        kind: 'leaf',
        id: 'leaf-shell',
        pane: { id: 'shell-1', kind: 'shell', title: 'shell' },
      },
      setPanes: harness.setPanes,
      focus: harness.focus,
    }),
  },
}));

vi.mock('../state/home-store', () => ({
  useHomeStore: { getState: () => ({ hide: harness.hide }) },
}));

vi.mock('../state/orch-store', () => ({
  useOrchStore: {
    getState: () => ({
      paneMissions: harness.paneMissions,
      missions: harness.missions,
      bindPaneMission: harness.bindPaneMission,
      openPanel: harness.openPanel,
    }),
  },
}));

vi.mock('../state/toast-store', () => ({
  useToastStore: { getState: () => ({ push: harness.toast }) },
}));

vi.mock('../state/active-workspace', () => ({
  getActiveWorkspacePath: () => '/workspace/a',
}));

vi.mock('../terminal/terminal-host', () => ({
  getPaneSessionId: harness.getPaneSessionId,
  markPersistedAuthorityOnSpawn: harness.markPersistedAuthorityOnSpawn,
  waitForSession: harness.waitForSession,
}));

vi.mock('./mission-auth-conflict', () => ({
  conflictingOrchestratorPanes: harness.conflictingOrchestratorPanes,
  killConflictingOrchestrators: harness.killConflictingOrchestrators,
  hardReopenWouldKillAgents: () => false,
  sharedAuthFamily: () => null,
}));

import { launchSquadMission } from './mission-launcher';

const squad = {
  id: 'saved-squad',
  name: 'Squad salvo',
  createdAt: '1',
  builtin: false,
  orchestratorInstructions: 'Coordene.',
  agents: [
    {
      id: 'orch',
      agentName: 'Maestro',
      category: 'orchestrator' as const,
      cli: 'codex',
      model: 'gpt-5.6-sol',
    },
    {
      id: 'worker',
      agentName: 'Executor',
      category: 'executor' as const,
      cli: 'codex',
      allowedTools: ['Read', 'Edit'],
    },
  ],
};

describe('approved mission main-owned presentation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.paneMissions = {};
    harness.missions = [];
    vi.stubGlobal('window', {
      nexus: {
        settings: {
          orchGet: vi.fn(async () => ({
            intentFirstMissionRuntimeV1: true,
            // A fresh profile may still default to Claude. Approved dispatch
            // must preflight and reconcile conflicts from the saved Codex roster.
            defaultAdapterId: 'claude',
            defaultModel: '',
            defaultAccountId: '',
          })),
        },
        accounts: { list: vi.fn(async () => []) },
        quota: { snapshot: vi.fn(async () => null) },
        orch: {
          updateMission: vi.fn(),
          bootstrapMissionOrchestrator: vi.fn(async () => ({
            ok: true as const,
            missionId: 'mission-approved',
            pane: {
              paneId: 'pane-main-orch',
              sessionId: 'pty-main-orch',
              adapterId: 'codex',
              model: 'gpt-5.6-sol',
              accountId: 'account-main',
              effort: 'high',
              cwd: '/workspace/a',
              title: 'Squad salvo · orq',
              agentName: 'Maestro',
              role: 'orchestrator' as const,
            },
            kickoff: {
              accepted: false as const,
              reason: 'timeout' as const,
              detail: 'Sem borda idle→busy.',
              cta: 'Retomar missão',
            },
          })),
          bindMissionOrchestrator: vi.fn(),
          submitMissionKickoff: vi.fn(),
        },
      },
    });
  });

  it('sends only missionId, mounts the sealed pane and adopts without restart', async () => {
    const authorizeDispatch = vi.fn(async () => undefined);
    const result = await launchSquadMission(
      squad,
      [
        {
          id: 'codex',
          kind: 'cli-pty',
          label: 'Codex',
          icon: 'C',
          models: { list: ['gpt-5.6-sol'], default: 'gpt-5.6-sol' },
          installed: true,
          installCommand: 'npm i -g codex',
          idleTimeoutMs: 800,
          orchestratorCapable: true,
          orchestrationEvidence: 'experimental',
        },
      ],
      {
        existingMissionId: 'mission-approved',
        goalPrompt: 'renderer copy must not become authority',
        adapterId: 'codex',
        authorizeDispatch,
      },
    );

    expect(result).toEqual({
      ok: false,
      paneId: 'pane-main-orch',
      missionId: 'mission-approved',
      error: 'Sem borda idle→busy. Próxima ação: Retomar missão.',
    });
    expect(authorizeDispatch).toHaveBeenCalledOnce();
    expect(window.nexus.orch.bootstrapMissionOrchestrator).toHaveBeenCalledWith({
      missionId: 'mission-approved',
    });
    expect(window.nexus.orch.bootstrapMissionOrchestrator).toHaveBeenCalledTimes(1);
    expect(harness.conflictingOrchestratorPanes).not.toHaveBeenCalled();
    expect(harness.killConflictingOrchestrators).not.toHaveBeenCalled();
    expect(window.nexus.orch.updateMission).not.toHaveBeenCalled();
    expect(window.nexus.orch.bindMissionOrchestrator).not.toHaveBeenCalled();
    expect(window.nexus.orch.submitMissionKickoff).not.toHaveBeenCalled();
    expect(harness.markPersistedAuthorityOnSpawn).toHaveBeenCalledWith(
      'pane-main-orch',
    );
    expect(harness.setPanes).toHaveBeenCalledWith([
      expect.objectContaining<Partial<PaneModel>>({
        id: 'pane-main-orch',
        adapterId: 'codex',
        model: 'gpt-5.6-sol',
        accountId: 'account-main',
        effort: 'high',
        cwd: '/workspace/a',
        missionId: 'mission-approved',
        role: 'orchestrator',
      }),
    ]);
    expect(harness.waitForSession).toHaveBeenCalledWith(
      'pane-main-orch',
      20_000,
    );
    expect(harness.toast).not.toHaveBeenCalled();
  });

  it('leaves exclusive replacement to the single main-owned approval', async () => {
    vi.mocked(
      window.nexus.orch.bootstrapMissionOrchestrator,
    ).mockResolvedValueOnce({
      ok: true,
      missionId: 'mission-approved',
      pane: {
        paneId: 'pane-main-orch',
        sessionId: 'pty-main-orch',
        adapterId: 'codex',
        model: 'gpt-5.6-sol',
        accountId: 'account-main',
        effort: 'high',
        cwd: '/workspace/a',
        title: 'Squad salvo · orq',
        agentName: 'Maestro',
        role: 'orchestrator',
      },
      kickoff: {
        accepted: true,
      },
    });
    harness.conflictingOrchestratorPanes.mockReturnValue([
      {
        id: 'pane-old',
        kind: 'cli-agent',
        title: 'Old',
        adapterId: 'codex',
        role: 'orchestrator',
      } as PaneModel,
    ]);
    harness.paneMissions = { 'pane-old': 'mission-old' };
    const authorizeDispatch = vi.fn(async () => undefined);

    const result = await launchSquadMission(
      squad,
      [
        {
          id: 'codex',
          kind: 'cli-pty',
          label: 'Codex',
          icon: 'C',
          models: { list: ['gpt-5.6-sol'], default: 'gpt-5.6-sol' },
          installed: true,
          installCommand: 'npm i -g codex',
          idleTimeoutMs: 800,
          orchestratorCapable: true,
          orchestrationEvidence: 'verified',
        },
      ],
      {
        existingMissionId: 'mission-approved',
        goalPrompt: 'approved goal',
        authorizeDispatch,
      },
    );

    expect(result).toEqual({
      ok: true,
      paneId: 'pane-main-orch',
      missionId: 'mission-approved',
    });
    expect(authorizeDispatch).toHaveBeenCalledOnce();
    expect(window.nexus.orch.bootstrapMissionOrchestrator).toHaveBeenCalledOnce();
    expect(window.nexus.orch.updateMission).not.toHaveBeenCalled();
    expect(harness.conflictingOrchestratorPanes).not.toHaveBeenCalled();
    expect(harness.killConflictingOrchestrators).not.toHaveBeenCalled();
    expect(harness.setPanes).toHaveBeenCalled();
  });

  it('mutates no prior mission when authorization of the incoming mission fails', async () => {
    harness.conflictingOrchestratorPanes.mockReturnValue([
      {
        id: 'pane-old',
        kind: 'cli-agent',
        title: 'Old',
        adapterId: 'codex',
        role: 'orchestrator',
      } as PaneModel,
    ]);
    harness.paneMissions = { 'pane-old': 'mission-old' };
    const authorizeDispatch = vi.fn(async () => {
      throw new Error('user_denied');
    });

    const result = await launchSquadMission(
      squad,
      [
        {
          id: 'codex',
          kind: 'cli-pty',
          label: 'Codex',
          icon: 'C',
          models: { list: ['gpt-5.6-sol'], default: 'gpt-5.6-sol' },
          installed: true,
          installCommand: 'npm i -g codex',
          idleTimeoutMs: 800,
          orchestratorCapable: true,
          orchestrationEvidence: 'verified',
        },
      ],
      {
        existingMissionId: 'mission-approved',
        goalPrompt: 'approved goal',
        authorizeDispatch,
      },
    );

    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(/não foi autorizada.*user_denied/i),
    });
    expect(window.nexus.orch.updateMission).not.toHaveBeenCalled();
    expect(
      window.nexus.orch.bootstrapMissionOrchestrator,
    ).not.toHaveBeenCalled();
    expect(harness.setPanes).not.toHaveBeenCalled();
  });
});
