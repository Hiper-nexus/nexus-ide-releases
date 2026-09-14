import { create } from 'zustand';

/**
 * Diálogo de escolha da casa — mesma disciplina do confirm-store (fila
 * serializada, um pedido corrente, <ChoiceDialog/> único no App), para
 * perguntas cuja resposta é UMA OPÇÃO entre várias, não sim/não.
 * Caso F-527: "este pane não pertence a missão nenhuma — qual missão ele
 * deve liderar?" nunca mais é decidido silenciosamente por um fallback.
 */

export interface ChoiceOption {
  /** Valor devolvido ao resolver; '__cancel__' nunca é usado como valor. */
  value: string;
  label: string;
  detail?: string;
  /** Estilo de destaque (a ação preferida da pergunta). */
  primary?: boolean;
}

export interface ChoiceRequest {
  title: string;
  body?: string;
  options: readonly ChoiceOption[];
  cancelLabel?: string;
}

interface PendingChoice extends ChoiceRequest {
  resolve(value: string | null): void;
}

interface ChoiceStore {
  pending: PendingChoice | null;
  queue: PendingChoice[];
  ask(request: ChoiceRequest): Promise<string | null>;
  decide(value: string | null): void;
}

export const useChoiceStore = create<ChoiceStore>((set, get) => ({
  pending: null,
  queue: [],
  ask: (request) =>
    new Promise<string | null>((resolve) => {
      const entry: PendingChoice = { ...request, resolve };
      const { pending, queue } = get();
      if (pending) set({ queue: [...queue, entry] });
      else set({ pending: entry });
    }),
  decide: (value) => {
    const { pending, queue } = get();
    if (!pending) return;
    const [next, ...rest] = queue;
    set({ pending: next ?? null, queue: rest });
    pending.resolve(value);
  },
}));

/** Atalho para fluxos fora de componentes React. */
export function askChoice(request: ChoiceRequest): Promise<string | null> {
  return useChoiceStore.getState().ask(request);
}
