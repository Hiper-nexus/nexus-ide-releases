import { create } from 'zustand';

/**
 * Estado de abertura do painel de inventário de configs (ConfigInventoryPanel).
 * Isolado num store próprio para não acoplar ao orch-store (mexido por outra
 * onda) — abre/fecha por atalho, botão ou comando, sem tocar em nada mais.
 */
interface ConfigInventoryStore {
  open: boolean;
  toggle(): void;
  show(): void;
  close(): void;
}

export const useConfigInventoryStore = create<ConfigInventoryStore>((set) => ({
  open: false,
  toggle: () => set((s) => ({ open: !s.open })),
  show: () => set({ open: true }),
  close: () => set({ open: false }),
}));
