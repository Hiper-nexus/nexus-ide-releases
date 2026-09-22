import { create } from 'zustand';

/**
 * Qual ESCOPO a vista global de Terminais está desenhando.
 *
 * Mora numa store, não no componente, porque quem escolhe o escopo quase nunca
 * é a própria vista: o assistente "Montar meus terminais" abre um espaço novo e
 * PRECISA levar o operador para dentro dele na mesma ação. Com estado local a
 * escolha morria na navegação e o operador caía de volta no mosaico da missão
 * que já estava aberta — exatamente o "abre junto, não separa" relatado.
 *
 * `null` = deixa a vista escolher sozinha (primeiro escopo com pane).
 */
interface PaneScopeStore {
  readonly activeScopeKey: string | null;
  /** Campos fixados como A e B — cada missão pode ocupar um lado. */
  readonly pinnedA: string | null;
  readonly pinnedB: string | null;
  focusScope(scopeKey: string): void;
  clearScopeFocus(): void;
  /** Fixa o escopo no lado livre (A → B → desafixa se já está em algum). */
  togglePinScope(scopeKey: string): void;
  /** Vai para o campo A ou B já fixado. */
  switchAB(side: 'a' | 'b'): void;
}

export const usePaneScopeStore = create<PaneScopeStore>((set, get) => ({
  activeScopeKey: null,
  pinnedA: null,
  pinnedB: null,
  focusScope: (scopeKey) => set({ activeScopeKey: scopeKey }),
  clearScopeFocus: () => set({ activeScopeKey: null }),
  togglePinScope: (scopeKey) => {
    const { pinnedA, pinnedB } = get();
    if (pinnedA === scopeKey) {
      set({ pinnedA: null });
      return;
    }
    if (pinnedB === scopeKey) {
      set({ pinnedB: null });
      return;
    }
    if (!pinnedA) {
      set({ pinnedA: scopeKey, activeScopeKey: scopeKey });
      return;
    }
    if (!pinnedB) {
      set({ pinnedB: scopeKey, activeScopeKey: scopeKey });
      return;
    }
    // Os dois lados ocupados: o novo pino vira o A (o B desliza para A).
    set({ pinnedA: pinnedB, pinnedB: scopeKey, activeScopeKey: scopeKey });
  },
  switchAB: (side) => {
    const { pinnedA, pinnedB } = get();
    const target = side === 'a' ? pinnedA : pinnedB;
    if (target) set({ activeScopeKey: target });
  },
}));
