import { create } from 'zustand';

/**
 * Pedido para abrir o "+ Pane" quando o gatilho não é o botão do grid
 * (Início → Abrir um pane). O picker consome o flag ao montar/ficar visível.
 */
export interface PanePickerStore {
  pendingOpen: boolean;
  requestOpen(): void;
  consumePendingOpen(): void;
}

export const usePanePickerStore = create<PanePickerStore>()((set) => ({
  pendingOpen: false,
  requestOpen: () => set({ pendingOpen: true }),
  consumePendingOpen: () => set({ pendingOpen: false }),
}));
