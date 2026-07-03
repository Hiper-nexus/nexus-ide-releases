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
  openForNewWorkspace(): void;
  openForMission(): void;
  close(): void;
}

export const useMissionWizardStore = create<MissionWizardStore>((set) => ({
  open: false,
  variant: 'mission',
  openForNewWorkspace: () => set({ open: true, variant: 'workspace' }),
  openForMission: () => set({ open: true, variant: 'mission' }),
  close: () => set({ open: false }),
}));
