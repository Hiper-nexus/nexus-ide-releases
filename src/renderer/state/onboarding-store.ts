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
    // Optimistic: never leave the user staring at a dead primary CTA while
    // main IPC is slow, hung after a failed quit proof, or offline.
    const previous = get().state;
    set({ state: { ...previous, completed: true } });
    void window.nexus.onboarding
      .set({ completed: true })
      .then((state) => set({ state }))
      .catch((err) => {
        console.warn('[onboarding] falha ao persistir complete:', err);
        // Keep the dismiss — blocking the deck is worse than a missed disk write.
      });
  },

  skip: () => {
    const previous = get().state;
    set({ state: { ...previous, skipped: true } });
    void window.nexus.onboarding
      .set({ skipped: true })
      .then((state) => set({ state }))
      .catch((err) => {
        console.warn('[onboarding] falha ao persistir skip:', err);
      });
  },

  markVictory: (key) => {
    // Só chama o main se ainda não registrada (a vitória é o primeiro momento).
    if (get().state.victories[key] !== undefined) return;
    void window.nexus.onboarding
      .set({ victory: key })
      .then((state) => set({ state }))
      .catch((err) => console.warn(`[onboarding] falha ao persistir vitória "${key}":`, err));
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
