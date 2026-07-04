import { create } from 'zustand';

/**
 * Open/close state for the workspace/mission wizard.
 *  - 'workspace': full "Novo workspace" flow starting at the PASTA step
 *    (launched from the launch screen).
 *  - 'mission': "Nova Missão" inside the current workspace, starting at MODO
 *    (launched from ＋ Missão or automatically when entering a folder).
 */

export type WizardVariant = 'workspace' | 'mission';

interface MissionWizardStore {
  open: boolean;
  variant: WizardVariant;
  /** When set, the wizard opens straight on this squad's review step. */
  presetSquadId: string | null;
  openForNewWorkspace(): void;
  openForMission(): void;
  /** Open directly on a squad's review (used by the Home deck shortcuts). */
  openForSquad(squadId: string): void;
  close(): void;
}

export const useMissionWizardStore = create<MissionWizardStore>((set) => ({
  open: false,
  variant: 'mission',
  presetSquadId: null,
  openForNewWorkspace: () =>
    set({ open: true, variant: 'workspace', presetSquadId: null }),
  openForMission: () =>
    set({ open: true, variant: 'mission', presetSquadId: null }),
  openForSquad: (squadId) =>
    set({ open: true, variant: 'mission', presetSquadId: squadId }),
  close: () => set({ open: false, presetSquadId: null }),
}));
