import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mission, Squad } from '../../shared/orch-types';
import { useMissionSetupStore } from '../state/mission-setup-store';
import { useOrchStore } from '../state/orch-store';
import { useProductNavigationStore } from '../state/product-navigation-store';
import { useWorkspaceStore } from '../state/workspace-store';

const harness = vi.hoisted(() => ({
  askConfirm: vi.fn(),
  listMissionPanes: vi.fn(),
  reopenMission: vi.fn(),
  hardReopenWouldDisplaceLayout: vi.fn(),
  hardReopenWouldKillAgents: vi.fn(),
  isIntentFirstMissionShell: vi.fn(),
  livePaneIdsForMission: vi.fn(),
}));

vi.mock('../state/confirm-store', () => ({
  askConfirm: harness.askConfirm,
}));

vi.mock('./mission-reopen', () => ({
  hardReopenWouldDisplaceLayout: harness.hardReopenWouldDisplaceLayout,
  hardReopenWouldKillAgents: harness.hardReopenWouldKillAgents,
  isIntentFirstMissionShell: harness.isIntentFirstMissionShell,
  livePaneIdsForMission: harness.livePaneIdsForMission,
  reopenMission: harness.reopenMission,
}));

import { confirmAndReopenMission } from './confirm-reopen-mission';

const workspace = {
  path: '/tmp/nexus',
  name: 'nexus',
  lastOpenedAt: 1,
};
const squad: Squad = {
  id: 'squad-1',
  name: 'Equipe salva',
  createdAt: '1',
  builtin: false,
  orchestratorInstructions: 'Coordene a missão.',
  agents: [
    {
      id: 'coordinator',
      agentName: 'Coordenar',
      category: 'orchestrator',
      cli: 'codex',
      model: 'gpt-5.6-sol',
      allowedTools: ['nexus_task'],
      allowedSkills: [],
    },
    {
      id: 'maker',
      agentName: 'Implementar',
      category: 'executor',
      cli: 'codex',
      model: 'gpt-5.6-sol',
      allowedTools: ['Read', 'Edit'],
      allowedSkills: [],
    },
  ],
};

function blockedMission(
  intentState: 'blocked_technical' | 'blocked_user',
): Mission {
  return {
    id: `mission-${intentState}`,
    title: 'Retry',
    description: '',
    status: 'blocked',
    intentState,
    milestones: [],
    learnings: '',
    createdAt: 1,
    updatedAt: 2,
  };
}

describe('confirmAndReopenMission', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    useWorkspaceStore.setState({ current: workspace });
    useOrchStore.setState({ squads: [squad] });
    useMissionSetupStore.setState({
      workspacePath: workspace.path,
      draft: {
        objective: '',
        title: '',
        contextPaths: [],
        roster: [],
        advanced: { lane: 'standard' },
        step: 'mission',
        revision: 0,
      },
      persistence: { status: 'idle' },
      workspaceDrafts: {},
      entryContext: null,
    } as never);
    useProductNavigationStore.setState({
      destination: { kind: 'terminal' },
      settingsReturnDestination: null,
    });
    harness.isIntentFirstMissionShell.mockReturnValue(false);
    harness.livePaneIdsForMission.mockReturnValue([]);
    harness.hardReopenWouldDisplaceLayout.mockReturnValue(true);
    harness.hardReopenWouldKillAgents.mockReturnValue(true);
    harness.reopenMission.mockResolvedValue({ ok: true, panes: 1 });
    vi.stubGlobal('window', {
      nexus: {
        orch: {
          listMissionPanes: harness.listMissionPanes,
          missionControlPlane: vi.fn(async () => ({ queue: [] })),
        },
      },
    });
  });

  it.each(['blocked_technical', 'blocked_user'] as const)(
    'routes %s straight to Main-owned resume without renderer conflict prompts',
    async (intentState) => {
      const mission = blockedMission(intentState);

      await expect(confirmAndReopenMission(mission)).resolves.toEqual({
        ok: true,
        panes: 1,
      });
      expect(harness.reopenMission).toHaveBeenCalledWith(mission);
      expect(harness.listMissionPanes).not.toHaveBeenCalled();
      expect(harness.askConfirm).not.toHaveBeenCalled();
    },
  );

  it('clique duplo reabre a missão uma vez só', async () => {
    const mission = blockedMission('blocked_technical');
    let release!: () => void;
    harness.reopenMission.mockImplementationOnce(
      () => new Promise((resolve) => { release = () => resolve({ ok: true, panes: 1 }); }),
    );
    const first = confirmAndReopenMission(mission);
    const second = confirmAndReopenMission(mission);
    expect(second).toBe(first);
    release();
    await expect(first).resolves.toEqual({ ok: true, panes: 1 });
    expect(harness.reopenMission).toHaveBeenCalledTimes(1);
  });

  describe('contrato de navegação', () => {
    function armedShell(): Mission {
      return {
        id: 'mission-armed',
        title: 'quero continuar codando',
        description: 'quero continuar codando',
        status: 'pending',
        intentState: 'ready_to_start',
        squadId: 'squad-1',
        milestones: [],
        learnings: '',
        createdAt: 1,
        updatedAt: 2,
      };
    }

    it('abre os panes gravados em vez de substituir a missão no Setup', async () => {
      // Pane evidence keeps the operator on the existing mission terminals.
      const mission = armedShell();
      harness.isIntentFirstMissionShell.mockReturnValue(true);
      harness.listMissionPanes.mockResolvedValue([
        { role: 'orchestrator', adapterId: 'claude' },
        { role: 'worker', adapterId: 'claude' },
      ]);
      harness.hardReopenWouldDisplaceLayout.mockReturnValue(false);
      harness.reopenMission.mockResolvedValue({ ok: true, panes: 2 });

      await expect(confirmAndReopenMission(mission)).resolves.toEqual({
        ok: true,
        panes: 2,
      });
      expect(useProductNavigationStore.getState().destination).toEqual({
        kind: 'terminal',
      });
      expect(harness.reopenMission).toHaveBeenCalledWith(mission);
    });

    it('abre Mission Setup apenas com prova de zero panes gravados', async () => {
      const mission = armedShell();
      harness.isIntentFirstMissionShell.mockReturnValue(true);
      harness.listMissionPanes.mockResolvedValue([]);

      await expect(confirmAndReopenMission(mission)).resolves.toEqual({
        ok: true,
        panes: 0,
        intentShell: true,
      });
      expect(useProductNavigationStore.getState().destination).toEqual({
        kind: 'mission-setup',
      });
      expect(useMissionSetupStore.getState().draft).toMatchObject({
        objective: 'quero continuar codando',
        step: 'review',
      });
    });

    it('permanece na página com aviso quando o estado não é reconhecido', async () => {
      const mission = { ...armedShell(), intentState: undefined };
      harness.isIntentFirstMissionShell.mockReturnValue(false);
      harness.listMissionPanes.mockResolvedValue([]);
      harness.hardReopenWouldDisplaceLayout.mockReturnValue(false);

      const result = await confirmAndReopenMission(mission);

      expect(result.ok).toBe(false);
      expect(result.error).toContain('Nova missão');
      // Nunca o assistente como fallback de estado desconhecido.
      expect(useProductNavigationStore.getState().destination).toEqual({
        kind: 'terminal',
      });
      expect(harness.reopenMission).not.toHaveBeenCalled();
    });

    it('foca os panes vivos sem consultar classificação de shell', async () => {
      const mission = armedShell();
      harness.isIntentFirstMissionShell.mockReturnValue(true);
      harness.livePaneIdsForMission.mockReturnValue(['pane-a', 'pane-b']);
      harness.listMissionPanes.mockResolvedValue([]);
      harness.hardReopenWouldDisplaceLayout.mockReturnValue(false);
      harness.reopenMission.mockResolvedValue({ ok: true, panes: 2, soft: true });

      await expect(confirmAndReopenMission(mission)).resolves.toEqual({
        ok: true,
        panes: 2,
        soft: true,
      });
      expect(useProductNavigationStore.getState().destination).toEqual({
        kind: 'terminal',
      });
    });
  });
});
