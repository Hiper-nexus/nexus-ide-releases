import { create } from 'zustand';

/**
 * Visibilidade do painel Estúdio de Mídia. Store — não estado local do App —
 * para a WorkspaceBar e o Settings → Mídia abrirem o estúdio de qualquer lugar
 * (mesmo motivo do useIntegrationsStore: descobribilidade).
 */
interface MediaStudioStore {
  open: boolean;
  show(): void;
  hide(): void;
  toggle(): void;
}

export const useMediaStudioStore = create<MediaStudioStore>((set) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
  toggle: () => set((state) => ({ open: !state.open })),
}));
