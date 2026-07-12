import { create } from 'zustand';

/** Cheatsheet de atalhos (⌘/): global para App e palette alcançarem. */
interface CheatsheetStore {
  open: boolean;
  toggle(): void;
  close(): void;
}

export const useCheatsheetStore = create<CheatsheetStore>((set) => ({
  open: false,
  toggle: () => set((s) => ({ open: !s.open })),
  close: () => set({ open: false }),
}));
