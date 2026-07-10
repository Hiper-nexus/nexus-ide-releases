import { useEffect } from 'react';
import { create } from 'zustand';
import type { GamificationSnapshot } from '../../shared/gamification-types';
import { getActiveWorkspacePath } from './active-workspace';
import { useWorkspaceStore } from './workspace-store';

/**
 * Espelho no renderer do snapshot de gamificação (gamification-service no
 * main). Mesmo padrão do usage-store: pull na montagem + push via broadcast.
 * Também carrega o modo sóbrio (orch settings) — o HUD some, o XP continua.
 */

interface GamificationApi {
  snapshot(): Promise<GamificationSnapshot>;
  onChanged(cb: (snapshot: GamificationSnapshot) => void): () => void;
}

function gamificationApi(): GamificationApi | undefined {
  return (window.nexus as unknown as { gamification?: GamificationApi })
    .gamification;
}

export const EMPTY_GAMIFICATION_SNAPSHOT: GamificationSnapshot = {
  powerLevel: 0,
  tier: 'RECRUTA',
  tierFloor: 'RECRUTA',
  nextTierAt: 100_000,
  prestige: 0,
  prestigeReady: false,
  branch: 'base',
  streakDays: 0,
  shieldsLeft: 2,
  achievements: [],
  skins: [],
  selectedSkin: null,
  counters: {},
  ruleVersion: 1,
};

interface GamificationStore {
  snapshot: GamificationSnapshot;
  sober: boolean;
  profileOpen: boolean;
  hydrate(): Promise<void>;
  receive(snapshot: GamificationSnapshot): void;
  reset(): void;
  setSober(sober: boolean): void;
  openProfile(): void;
  closeProfile(): void;
  toggleProfile(): void;
}

export const useGamificationStore = create<GamificationStore>((set) => ({
  snapshot: EMPTY_GAMIFICATION_SNAPSHOT,
  sober: false,
  profileOpen: false,

  hydrate: async () => {
    const api = gamificationApi();
    const requestedWorkspace = getActiveWorkspacePath();
    if (!api || !requestedWorkspace) return;
    try {
      const snapshot = await api.snapshot();
      if (getActiveWorkspacePath() === requestedWorkspace) {
        useGamificationStore.getState().receive(snapshot);
      }
    } catch (err) {
      console.warn('[gamification] hydrate failed:', err);
    }
    try {
      const orch = await window.nexus.settings.orchGet();
      set({ sober: (orch as { soberMode?: boolean }).soberMode === true });
    } catch {
      // settings indisponíveis — segue não-sóbrio
    }
  },

  receive: (snapshot) => {
    const activeWorkspace = getActiveWorkspacePath();
    if (
      !activeWorkspace ||
      snapshot.rootRealPath !== activeWorkspace
    ) {
      return;
    }
    set({ snapshot });
  },
  reset: () =>
    set({
      snapshot: EMPTY_GAMIFICATION_SNAPSHOT,
      profileOpen: false,
    }),
  setSober: (sober) => set({ sober }),
  openProfile: () => set({ profileOpen: true }),
  closeProfile: () => set({ profileOpen: false }),
  toggleProfile: () => set((s) => ({ profileOpen: !s.profileOpen })),
}));

/** Montar uma vez no App (junto do useUsageSync) — hydrate + subscribe. */
export function useGamificationSync(): void {
  const hydrate = useGamificationStore((s) => s.hydrate);
  const reset = useGamificationStore((s) => s.reset);
  const workspacePath = useWorkspaceStore((s) => s.current?.path ?? null);
  useEffect(() => {
    reset();
    if (workspacePath) void hydrate();
  }, [hydrate, reset, workspacePath]);

  useEffect(() => {
    const api = gamificationApi();
    if (!api) return;
    return api.onChanged((snapshot) =>
      useGamificationStore.getState().receive(snapshot),
    );
  }, []);
}
