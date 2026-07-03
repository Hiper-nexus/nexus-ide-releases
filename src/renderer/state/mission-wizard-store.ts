import { create } from 'zustand';

/** Open/close state for the mission wizard modal. */
interface MissionWizardStore {
  open: boolean;
  openWizard(): void;
  close(): void;
}

export const useMissionWizardStore = create<MissionWizardStore>((set) => ({
  open: false,
  openWizard: () => set({ open: true }),
  close: () => set({ open: false }),
}));
