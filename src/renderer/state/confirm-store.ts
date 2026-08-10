import { create } from 'zustand';

/**
 * Confirm estilizado da casa — substitui o window.confirm nativo (que quebra
 * o registro visual e BLOQUEIA o renderer). API por promise: qualquer fluxo
 * chama `askConfirm({...})` e aguarda a decisão; o <ConfirmDialog/> único
 * (App) renderiza o pedido corrente.
 */
export interface ConfirmRequest {
  title: string;
  body: string;
  /** Rótulo verbo+objeto ("Fechar pane"), nunca "OK". */
  confirmLabel: string;
  cancelLabel?: string;
  /** Ação destrutiva: botão de confirmação em danger. */
  danger?: boolean;
}

interface PendingConfirm extends ConfirmRequest {
  resolve(result: boolean): void;
}

interface ConfirmStore {
  pending: PendingConfirm | null;
  /** Pedidos aguardando o atual ser respondido — serialização real. */
  queue: PendingConfirm[];
  ask(request: ConfirmRequest): Promise<boolean>;
  decide(ok: boolean): void;
}

export const useConfirmStore = create<ConfirmStore>((set, get) => ({
  pending: null,
  queue: [],
  ask: (request) =>
    new Promise<boolean>((resolve) => {
      // Serializa como o window.confirm serializava: um pedido novo espera o
      // atual ser respondido — NUNCA rouba o dialog aberto (um clique jamais
      // cai numa pergunta que o usuário não leu).
      const entry: PendingConfirm = {
        ...request,
        resolve,
      };
      const { pending, queue } = get();
      if (pending) set({ queue: [...queue, entry] });
      else set({ pending: entry });
    }),
  decide: (ok) => {
    const { pending, queue } = get();
    if (!pending) return;
    const [next, ...rest] = queue;
    set({ pending: next ?? null, queue: rest });
    pending.resolve(ok);
  },
}));

/** Atalho para fluxos fora de componentes React. */
export function askConfirm(request: ConfirmRequest): Promise<boolean> {
  return useConfirmStore.getState().ask(request);
}
