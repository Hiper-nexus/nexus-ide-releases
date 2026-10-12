import { create } from 'zustand';
import { useOnboardingStore } from './onboarding-store';

/**
 * Pedido para abrir o "+ Pane" quando o gatilho não é o botão do grid
 * (Início → Abrir um pane). O picker consome o flag ao montar/ficar visível.
 *
 * O pedido carrega opcionalmente a CLI cuja vista de contas estava aberta. É
 * o que devolve o contexto quando o login leva o operador para Terminais e o
 * menu desmonta no caminho: ele volta na tela de contas daquela CLI, não numa
 * lista genérica onde a conta recém-criada teria de ser reencontrada à mão.
 */
export interface PanePickerStore {
  pendingOpen: boolean;
  pendingAccountsAdapterId: string | null;
  requestOpen(accountsAdapterId?: string): void;
  consumePendingOpen(): void;
}

export const usePanePickerStore = create<PanePickerStore>()((set) => ({
  pendingOpen: false,
  pendingAccountsAdapterId: null,
  requestOpen: (accountsAdapterId) => {
    // Fato de ativação: o operador pediu o + Pane de verdade (qualquer origem).
    useOnboardingStore.getState().markChecklist('openedPlusPane');
    set({
      pendingOpen: true,
      pendingAccountsAdapterId: accountsAdapterId ?? null,
    });
  },
  consumePendingOpen: () =>
    set({ pendingOpen: false, pendingAccountsAdapterId: null }),
}));
