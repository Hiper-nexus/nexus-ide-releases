import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mission } from '../../shared/orch-types';

const harness = vi.hoisted(() => ({
  askConfirm: vi.fn(),
  listMissionPanes: vi.fn(),
  reopenMission: vi.fn(),
  hardReopenWouldDisplaceLayout: vi.fn(),
  hardReopenWouldKillAgents: vi.fn(),
  isIntentFirstMissionShell: vi.fn(),
  livePaneIdsForMission: vi.fn(),
  openForArmedMission: vi.fn(),
}));

vi.mock('../state/confirm-store', () => ({
  askConfirm: harness.askConfirm,
}));

vi.mock('../state/mission-wizard-store', () => ({
  useMissionWizardStore: {
    getState: () => ({
      openForArmedMission: harness.openForArmedMission,
      saveDraft: vi.fn(),
    }),
  },
}));

vi.mock('./mission-reopen', () => ({
  hardReopenWouldDisplaceLayout: harness.hardReopenWouldDisplaceLayout,
  hardReopenWouldKillAgents: harness.hardReopenWouldKillAgents,
  isIntentFirstMissionShell: harness.isIntentFirstMissionShell,
  livePaneIdsForMission: harness.livePaneIdsForMission,
  reopenMission: harness.reopenMission,
}));

import { confirmAndReopenMission } from './confirm-reopen-mission';

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
    harness.isIntentFirstMissionShell.mockReturnValue(false);
    harness.livePaneIdsForMission.mockReturnValue([]);
    harness.hardReopenWouldDisplaceLayout.mockReturnValue(true);
    harness.hardReopenWouldKillAgents.mockReturnValue(true);
    harness.reopenMission.mockResolvedValue({ ok: true, panes: 1 });
    vi.stubGlobal('window', {
      nexus: {
        orch: {
          listMissionPanes: harness.listMissionPanes,
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

  describe('contrato de navegação', () => {
    function armedShell(): Mission {
      return {
        id: 'mission-armed',
        title: 'quero continuar codando',
        description: '',
        status: 'pending',
        intentState: 'ready_to_start',
        squadId: 'squad-1',
        milestones: [],
        learnings: '',
        createdAt: 1,
        updatedAt: 2,
      };
    }

    it('abre os panes gravados em vez de ejetar para o assistente', async () => {
      // O bug relatado: a missão tinha panes, foi classificada como shell
      // armado e o operador caiu no wizard de Nova Missão, sem volta.
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
      expect(harness.openForArmedMission).not.toHaveBeenCalled();
      expect(harness.reopenMission).toHaveBeenCalledWith(mission);
    });

    it('só abre o assistente com prova de zero panes gravados', async () => {
      const mission = armedShell();
      harness.isIntentFirstMissionShell.mockReturnValue(true);
      harness.listMissionPanes.mockResolvedValue([]);

      await expect(confirmAndReopenMission(mission)).resolves.toEqual({
        ok: true,
        panes: 0,
        intentShell: true,
      });
      expect(harness.openForArmedMission).toHaveBeenCalledWith(
        'squad-1',
        'mission-armed',
      );
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
      expect(harness.openForArmedMission).not.toHaveBeenCalled();
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
      expect(harness.openForArmedMission).not.toHaveBeenCalled();
    });
  });
});
