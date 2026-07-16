import { create } from 'zustand';

/**
 * Visibility of the Integrations panel (GitHub, Linear, port-forward). A store
 * — not App-local state — so the CommandPalette (⌘K) and WorkspaceBar can open
 * it from anywhere, making GitHub discoverable instead of buried under ⋯→Apps.
 */
interface IntegrationsStore {
  open: boolean;
  show(): void;
  hide(): void;
  toggle(): void;
}

export const useIntegrationsStore = create<IntegrationsStore>((set) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
  toggle: () => set((state) => ({ open: !state.open })),
}));
