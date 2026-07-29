import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mission } from '../../shared/orch-types';

const harness = vi.hoisted(() => ({
  askConfirm: vi.fn(),
  listMissionPanes: vi.fn(),
  reopenMission: vi.fn(),
  hardReopenWouldDisplaceLayout: vi.fn(),
  hardReopenWouldKillAgents: vi.fn(),
  isIntentFirstMissionShell: vi.fn(),
}));

vi.mock('../state/confirm-store', () => ({
  askConfirm: harness.askConfirm,
}));

vi.mock('../state/mission-wizard-store', () => ({
  useMissionWizardStore: {
    getState: () => ({
      openForArmedMission: vi.fn(),
      saveDraft: vi.fn(),
    }),
  },
}));

vi.mock('./mission-reopen', () => ({
  hardReopenWouldDisplaceLayout: harness.hardReopenWouldDisplaceLayout,
  hardReopenWouldKillAgents: harness.hardReopenWouldKillAgents,
  isIntentFirstMissionShell: harness.isIntentFirstMissionShell,
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
});
