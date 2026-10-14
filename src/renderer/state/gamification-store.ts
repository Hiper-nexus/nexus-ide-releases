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
  snapshot(options?: { rescan?: boolean }): Promise<GamificationSnapshot>;
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
  recent: [],
  ruleVersion: 1,
};

/** Path compare resiliente a trailing slash (macOS / worktrees). */
export function sameWorkspaceRoot(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (!left || !right) return false;
  const norm = (value: string) => {
    const trimmed = value.replace(/\/+$/, '');
    return trimmed.length > 0 ? trimmed : '/';
  };
  return norm(left) === norm(right);
}

/**
 * XP ganho entre dois snapshots do MESMO perfil (projeto + checkout). `null`
 * quando o perfil mudou ou ainda não chegou do main — troca de workspace e
 * hidrate inicial nunca são "ganho".
 */
export function xpGain(
  previous: GamificationSnapshot,
  next: GamificationSnapshot,
): number | null {
  if (
    !next.projectId ||
    next.projectId !== previous.projectId ||
    next.checkoutId !== previous.checkoutId
  ) {
    return null;
  }
  return Math.max(0, next.powerLevel - previous.powerLevel);
}

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
      // rescan: true — reconcilia domínio ao abrir perfil / trocar workspace.
      const snapshot = await api.snapshot({ rescan: true });
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
    if (!activeWorkspace || !snapshot.rootRealPath) return;
    if (!sameWorkspaceRoot(snapshot.rootRealPath, activeWorkspace)) return;
    // Defensive: older main builds may omit `recent`.
    set({
      snapshot: {
        ...snapshot,
        recent: Array.isArray(snapshot.recent) ? snapshot.recent : [],
      },
    });
  },
  reset: () =>
    set({
      snapshot: EMPTY_GAMIFICATION_SNAPSHOT,
      profileOpen: false,
    }),
  setSober: (sober) => set({ sober }),
  openProfile: () => {
    set({ profileOpen: true });
    // Sempre puxa o read-model fresco (rescan no main) ao abrir o perfil.
    void useGamificationStore.getState().hydrate();
  },
  closeProfile: () => set({ profileOpen: false }),
  toggleProfile: () => {
    const next = !useGamificationStore.getState().profileOpen;
    set({ profileOpen: next });
    if (next) void useGamificationStore.getState().hydrate();
  },
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
