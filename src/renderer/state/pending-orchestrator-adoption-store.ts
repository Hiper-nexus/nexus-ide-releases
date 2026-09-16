import { create } from 'zustand';

/**
 * "Este painel vai liderar a próxima missão."
 *
 * O operador clica "Tornar orquestrador" num terminal solto. Não existe missão
 * para liderar, e uma missão precisa de um objetivo — ninguém consegue briefar
 * um Maestro sem saber o que entregar. Então o clique leva ao Novo pedido e
 * DEIXA O PAINEL MARCADO: quando a missão arrancar, ela adota esse painel em
 * vez de subir um coordenador em branco.
 *
 * Mora fora do mission-setup-store de propósito. Lá, qualquer escrita bumpa
 * `revision`, o `authorityKey` muda e o start em voo é invalidado — marcar o
 * painel não pode ter esse efeito colateral.
 */
export interface PendingOrchestratorAdoption {
  readonly paneId: string;
  readonly paneTitle: string | null;
}

interface PendingOrchestratorAdoptionStore {
  readonly pending: PendingOrchestratorAdoption | null;
  request(input: PendingOrchestratorAdoption): void;
  /** Consome a marcação: um start, uma adoção. */
  take(): PendingOrchestratorAdoption | null;
  clear(): void;
}

export const usePendingOrchestratorAdoptionStore =
  create<PendingOrchestratorAdoptionStore>((set, get) => ({
    pending: null,
    request: (input) => set({ pending: input }),
    take: () => {
      const { pending } = get();
      if (pending) set({ pending: null });
      return pending;
    },
    clear: () => set({ pending: null }),
  }));
