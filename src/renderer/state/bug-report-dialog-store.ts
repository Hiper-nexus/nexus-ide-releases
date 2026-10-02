import { create } from 'zustand';
import { useAttentionInboxStore } from './attention-inbox-store';
import { useCheatsheetStore } from './cheatsheet-store';
import { useCommandPaletteStore } from './command-palette-store';
import { useTerminalGridDialogStore } from './terminal-grid-dialog-store';

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
  open: () => {
    // Estes overlays tratam Esc/Tab numa fase que o diálogo não alcança (e
    // registraram antes dele): aberto por baixo, o Esc fecharia o errado.
    useCommandPaletteStore.getState().close();
    useCheatsheetStore.getState().close();
    useAttentionInboxStore.getState().setOpen(false);
    useTerminalGridDialogStore.getState().close();
    set({ isOpen: true });
  },
  close: () => set({ isOpen: false }),
}));
