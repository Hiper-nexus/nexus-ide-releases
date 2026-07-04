import { create } from 'zustand';

/**
 * Visibility of the in-workspace Home deck (the ops-deck empty state shown
 * over the pane area). Shown when the user enters a folder that has no saved
 * mission yet — the non-modal replacement for auto-opening the wizard —
 * and dismissed as soon as the user launches anything (or opts to use the
 * plain terminal underneath).
 */

interface HomeStore {
  visible: boolean;
  show(): void;
  hide(): void;
}

export const useHomeStore = create<HomeStore>((set) => ({
  visible: false,
  show: () => set({ visible: true }),
  hide: () => set({ visible: false }),
}));
