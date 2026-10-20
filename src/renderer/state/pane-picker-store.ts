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
  /**
   * F-1596: tarefa para o agente que sair DESTA abertura do picker (ex.: brief
   * do vídeo de apresentação). O picker a toma ao abrir e a descarta ao fechar
   * sem escolher: nunca vaza para um "+ Pane" aberto depois.
   */
  pendingBrief: string | null;
  requestOpen(accountsAdapterId?: string, options?: { readonly brief?: string }): void;
  consumePendingOpen(): void;
  takePendingBrief(): string | null;
}

export const usePanePickerStore = create<PanePickerStore>()((set, get) => ({
  pendingOpen: false,
  pendingAccountsAdapterId: null,
  pendingBrief: null,
  requestOpen: (accountsAdapterId, options) => {
    // Fato de ativação: o operador pediu o + Pane de verdade (qualquer origem).
    useOnboardingStore.getState().markChecklist('openedPlusPane');
    set({
      pendingOpen: true,
      pendingAccountsAdapterId: accountsAdapterId ?? null,
      pendingBrief: options?.brief?.trim() || null,
    });
  },
  consumePendingOpen: () =>
    set({ pendingOpen: false, pendingAccountsAdapterId: null }),
  takePendingBrief: () => {
    const brief = get().pendingBrief;
    set({ pendingBrief: null });
    return brief;
  },
}));
