import { create } from 'zustand';

/**
 * Qual ESCOPO (aba) a vista global de Terminais está desenhando.
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
  /**
   * Aba aberta AO LADO da ativa (tela dividida). Substitui os pinos A/B: o
   * operador não fixava dois campos para alternar — queria ver os dois.
   */
  readonly sideScopeKey: string | null;
  focusScope(scopeKey: string): void;
  clearScopeFocus(): void;
  /** Abre `scopeKey` ao lado da aba ativa; a mesma aba fecha a divisão. */
  showBeside(scopeKey: string, activeScopeKey: string | null): void;
  closeBeside(): void;
}

export const usePaneScopeStore = create<PaneScopeStore>((set, get) => ({
  activeScopeKey: null,
  sideScopeKey: null,
  focusScope: (scopeKey) => {
    const { activeScopeKey, sideScopeKey } = get();
    // Clicar na aba que está ao lado a traz para a frente e manda a ativa para
    // o lado: as duas continuam na tela, só trocam de posição.
    if (sideScopeKey === scopeKey) {
      set({
        activeScopeKey: scopeKey,
        sideScopeKey:
          activeScopeKey && activeScopeKey !== scopeKey ? activeScopeKey : null,
      });
      return;
    }
    set({ activeScopeKey: scopeKey });
  },
  clearScopeFocus: () => set({ activeScopeKey: null, sideScopeKey: null }),
  showBeside: (scopeKey, activeScopeKey) => {
    if (!activeScopeKey || scopeKey === activeScopeKey) return;
    if (get().sideScopeKey === scopeKey) {
      set({ sideScopeKey: null });
      return;
    }
    set({ activeScopeKey, sideScopeKey: scopeKey });
  },
  closeBeside: () => set({ sideScopeKey: null }),
}));
