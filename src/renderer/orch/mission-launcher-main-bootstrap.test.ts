// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneModel } from '../../shared/types';

const harness = vi.hoisted(() => ({
  accountsList: vi.fn(async () => []),
  quotaSnapshot: vi.fn(async () => null),
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

const codexMainRoute = {
  id: 'codex',
  kind: 'cli-pty' as const,
  label: 'Codex',
  icon: 'C',
  models: { list: ['gpt-5.6-sol'], default: 'gpt-5.6-sol' },
  installed: true,
  installCommand: 'npm i -g codex',
  idleTimeoutMs: 800,
  orchestratorCapable: true,
  missionControlCapable: true,
  orchestrationEvidence: 'verified' as const,
  capabilities: {
    launchable: true,
    promptInjectable: true,
    statusObservable: true,
    resumable: true,
    autonomousReadOnly: true,
    governedWriter: true,
    verifiedMaestro: true,
  },
};

describe('approved mission main-owned presentation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.conflictingOrchestratorPanes.mockReturnValue([]);
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
        accounts: { list: harness.accountsList },
        quota: { snapshot: harness.quotaSnapshot },
        orch: {
          updateMission: vi.fn(),
          authorizeImmediateSquadLaunch: vi.fn(async () => ({
            grant: 'grant-immediate',
          })),
          createMission: vi.fn(async () => ({
            id: 'mission-immediate',
            title: 'Squad salvo',
            description: 'Squad salvo',
            status: 'running' as const,
            milestones: [],
            learnings: '',
            createdAt: 1,
            updatedAt: 1,
          })),
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
              retryScheduled: true,
            },
          })),
          bindMissionOrchestrator: vi.fn(),
          submitMissionKickoff: vi.fn(async () => ({
            accepted: true as const,
            reason: 'accepted' as const,
            detail: 'ok',
            cta: 'Abrir missão',
            retryScheduled: false,
          })),
        },
      },
    });
  });

  it('returns starting as soon as Main accepts approval without waiting for bootstrap presentation', async () => {
    const bootstrapNeverSettles = new Promise<never>(() => undefined);
    vi.mocked(
      window.nexus.orch.bootstrapMissionOrchestrator,
    ).mockReturnValueOnce(bootstrapNeverSettles);
    const authorizeDispatch = vi.fn(async () => undefined);
    const result = await launchSquadMission(
      squad,
      [{ ...codexMainRoute, orchestrationEvidence: 'experimental' }],
      {
        existingMissionId: 'mission-approved',
        goalPrompt: 'renderer copy must not become authority',
        adapterId: 'codex',
        authorizeDispatch,
      },
    );

    expect(result).toEqual({
      ok: true,
      missionId: 'mission-approved',
      starting: true,
    });
    expect(authorizeDispatch).toHaveBeenCalledOnce();
    // Main derives and seals the approved runtime itself. Renderer account and
    // quota discovery is legacy-launch UX and must not delay the native
    // approval sheet on an intent-first mission.
    expect(harness.accountsList).not.toHaveBeenCalled();
    expect(harness.quotaSnapshot).not.toHaveBeenCalled();
    // approveMissionIntent already schedules the main-owned bootstrap. The
    // renderer must not start a duplicate request or keep the wizard waiting
    // for PTY presentation.
    expect(
      window.nexus.orch.bootstrapMissionOrchestrator,
    ).not.toHaveBeenCalled();
    expect(harness.conflictingOrchestratorPanes).not.toHaveBeenCalled();
    expect(harness.killConflictingOrchestrators).not.toHaveBeenCalled();
    expect(window.nexus.orch.updateMission).not.toHaveBeenCalled();
    expect(window.nexus.orch.bindMissionOrchestrator).not.toHaveBeenCalled();
    expect(window.nexus.orch.submitMissionKickoff).not.toHaveBeenCalled();
    expect(harness.markPersistedAuthorityOnSpawn).not.toHaveBeenCalled();
    expect(harness.setPanes).not.toHaveBeenCalled();
    expect(harness.waitForSession).not.toHaveBeenCalled();
    expect(harness.toast).not.toHaveBeenCalled();
  });

  it('leaves exclusive replacement and physical startup to the approved Main request', async () => {
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
      [codexMainRoute],
      {
        existingMissionId: 'mission-approved',
        goalPrompt: 'approved goal',
        authorizeDispatch,
      },
    );

    expect(result).toEqual({
      ok: true,
      missionId: 'mission-approved',
      starting: true,
    });
    expect(authorizeDispatch).toHaveBeenCalledOnce();
    expect(
      window.nexus.orch.bootstrapMissionOrchestrator,
    ).not.toHaveBeenCalled();
    expect(window.nexus.orch.updateMission).not.toHaveBeenCalled();
    expect(harness.conflictingOrchestratorPanes).not.toHaveBeenCalled();
    expect(harness.killConflictingOrchestrators).not.toHaveBeenCalled();
    expect(harness.setPanes).not.toHaveBeenCalled();
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
      [codexMainRoute],
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

  it('focuses the launched orchestrator after preserving shells so Canvas cannot stack a shell above the mission', async () => {
    const currentSettings = await window.nexus.settings.orchGet();
    vi.mocked(window.nexus.settings.orchGet).mockResolvedValueOnce({
      ...currentSettings,
      intentFirstMissionRuntimeV1: false,
      defaultAdapterId: 'codex',
      defaultModel: '',
      defaultAccountId: '',
    });

    const result = await launchSquadMission(
      squad,
      [codexMainRoute],
      { forceLegacyLaunch: true },
    );

    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result).toMatchObject({
      ok: true,
      missionId: 'mission-immediate',
    });
    if (!result.paneId) {
      throw new Error('legacy squad launch did not return its orchestrator pane');
    }
    expect(harness.setPanes).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'shell-1', kind: 'shell' }),
      expect.objectContaining({
        id: result.paneId,
        kind: 'cli-agent',
        role: 'orchestrator',
      }),
    ]);
    expect(harness.focus).toHaveBeenCalledWith(result.paneId);
    expect(harness.focus.mock.invocationCallOrder[0]).toBeGreaterThan(
      harness.setPanes.mock.invocationCallOrder[0]!,
    );
  });
});
