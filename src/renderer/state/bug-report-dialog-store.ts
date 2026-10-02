import { create } from 'zustand';

/**
 * Estado do diálogo "Reportar um problema". Global porque três portas levam a
 * ele: o menu do app (Ajuda), a paleta de comandos (⌘K) e, no futuro, qualquer
 * tela com um "algo deu errado". O conteúdo do formulário mora no próprio
 * diálogo e some ao fechar — nada do que foi digitado fica neste store.
 */
interface BugReportDialogStore {
  readonly isOpen: boolean;
  open(): void;
  close(): void;
}

export const useBugReportDialogStore = create<BugReportDialogStore>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
}));
