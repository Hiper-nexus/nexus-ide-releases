import { create } from 'zustand';

/**
 * Pedido para a tela de criação destacar "escolha a pasta antes". O paste/drop
 * sem projeto só mostrava um toast efêmero (e a voz falava); aqui o seletor de
 * pasta é quem recebe foco, realce e aviso fixo. `nonce` muda a cada pedido,
 * então colar de novo reanima mesmo com o aviso já visível.
 */
interface WorkspaceRequiredState {
  nonce: number;
  request(): void;
}

export const useWorkspaceRequiredStore = create<WorkspaceRequiredState>(
  (set) => ({
    nonce: 0,
    request: () => set((state) => ({ nonce: state.nonce + 1 })),
  }),
);
