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
  focusScope(scopeKey: string): void;
  clearScopeFocus(): void;
}

export const usePaneScopeStore = create<PaneScopeStore>((set) => ({
  activeScopeKey: null,
  focusScope: (scopeKey) => set({ activeScopeKey: scopeKey }),
  clearScopeFocus: () => set({ activeScopeKey: null }),
}));
