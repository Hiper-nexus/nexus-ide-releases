import { useEffect } from 'react';
import { create } from 'zustand';
import {
  DEFAULT_ONBOARDING,
  type OnboardingState,
  type VictoryKey,
} from '../../shared/onboarding-types';

/**
 * Espelho no renderer do estado de onboarding (main persiste em
 * ~/.nexus/onboarding.json). O wizard só aparece na PRIMEIRA execução —
 * completed/skipped ambos false. `markVictory` é chamado de qualquer lugar do
 * app quando o usuário destrava um marco (primeira missão, voz, etc).
 */

interface OnboardingStore {
  state: OnboardingState;
  loaded: boolean;
  hydrate(): Promise<void>;
  complete(): void;
  skip(): void;
  markVictory(key: VictoryKey): void;
}

export const useOnboardingStore = create<OnboardingStore>((set, get) => ({
  state: DEFAULT_ONBOARDING,
  loaded: false,

  hydrate: async () => {
    try {
      const state = await window.nexus.onboarding.get();
      set({ state, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },

  complete: () => {
    void window.nexus.onboarding.set({ completed: true }).then((state) => set({ state }));
  },

  skip: () => {
    void window.nexus.onboarding.set({ skipped: true }).then((state) => set({ state }));
  },

  markVictory: (key) => {
    // Só chama o main se ainda não registrada (a vitória é o primeiro momento).
    if (get().state.victories[key] !== undefined) return;
    void window.nexus.onboarding.set({ victory: key }).then((state) => set({ state }));
  },
}));

/** Conveniência: marca uma vitória sem assinar o store (fora de componentes). */
export function markVictory(key: VictoryKey): void {
  useOnboardingStore.getState().markVictory(key);
}

/** Monta uma vez no App — hidrata o estado persistido. */
export function useOnboardingSync(): void {
  const hydrate = useOnboardingStore((s) => s.hydrate);
  useEffect(() => {
    void hydrate();
  }, [hydrate]);
}
