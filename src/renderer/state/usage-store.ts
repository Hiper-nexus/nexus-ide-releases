import { useEffect } from 'react';
import { create } from 'zustand';
import type { UsageSnapshot } from '../../shared/usage-types';
import { getActiveWorkspacePath } from './active-workspace';
import { useWorkspaceStore } from './workspace-store';

/**
 * Espelho no renderer da telemetria REAL de tokens (usage-service no main).
 * Mesmo padrão do cost-store: pull na montagem + push via broadcast. Quando um
 * pane tem dados aqui, a UI mostra custo `real` em vez da estimativa por bytes.
 */

interface UsageApi {
  snapshot(): Promise<UsageSnapshot | null>;
  onChanged(cb: (snapshot: UsageSnapshot) => void): () => void;
}

function usageApi(): UsageApi | undefined {
  return (window.nexus as unknown as { usage?: UsageApi }).usage;
}

/**
 * O main reenvia o mesmo rollup (em cache) a cada broadcast de ~1 s; cada IPC o
 * desserializa como objeto novo. Se o conteúdo é o mesmo, mantém o objeto de
 * antes: o painel de custo não recalcula os cortes nem redesenha o gráfico à toa.
 */
function keepAnalyticsIdentity(previous: UsageSnapshot, next: UsageSnapshot): UsageSnapshot {
  const before = previous.analytics;
  const after = next.analytics;
  if (!before || !after || before === after) return next;
  if (
    before.today !== after.today ||
    before.rows.length !== after.rows.length ||
    before.sessions.length !== after.sessions.length
  ) {
    return next;
  }
  return JSON.stringify(before) === JSON.stringify(after) ? { ...next, analytics: before } : next;
}

export const EMPTY_USAGE_SNAPSHOT: UsageSnapshot = {
  byPane: {},
  byAccount: {},
  global: { costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0 },
  media: { generations: 0, costUsd: 0 },
};

/** Leitura do snapshot: a tela distingue "lendo", "falhou" e "ainda sem dados". */
export type UsageStatus = 'idle' | 'loading' | 'ready' | 'error';

interface UsageStore {
  snapshot: UsageSnapshot;
  status: UsageStatus;
  hydrate(workspacePath: string): Promise<void>;
  receive(snapshot: UsageSnapshot): void;
  reset(): void;
}

export const useUsageStore = create<UsageStore>((set) => ({
  snapshot: EMPTY_USAGE_SNAPSHOT,
  status: 'idle',

  hydrate: async (workspacePath) => {
    if (getActiveWorkspacePath() !== workspacePath) return;
    const api = usageApi();
    if (!api) return;
    set({ status: 'loading' });
    try {
      const snapshot = await api.snapshot();
      if (getActiveWorkspacePath() !== workspacePath) return;
      // `null`: o main absorveu a identidade do escopo — não há o que mostrar, mas também não há erro.
      set((state) =>
        snapshot === null
          ? { status: 'ready' }
          : { snapshot: keepAnalyticsIdentity(state.snapshot, snapshot), status: 'ready' },
      );
    } catch (err) {
      if (getActiveWorkspacePath() === workspacePath) {
        console.warn('[usage] hydrate failed:', err);
        // Leitura que falha com dados já na tela não apaga o painel: só a tela vazia mostra o erro.
        set({ status: 'error' });
      }
    }
  },

  receive: (snapshot) =>
    set((state) => ({ snapshot: keepAnalyticsIdentity(state.snapshot, snapshot), status: 'ready' })),
  reset: () => set({ snapshot: EMPTY_USAGE_SNAPSHOT, status: 'idle' }),
}));

/** Mount once — rehydrates per authorized workspace and keeps one listener. */
export function useUsageSync(): void {
  const hydrate = useUsageStore((s) => s.hydrate);
  const reset = useUsageStore((s) => s.reset);
  const workspaceHydrated = useWorkspaceStore((s) => s.hydrated);
  const workspacePath = useWorkspaceStore((s) => s.current?.path ?? null);
  useEffect(() => {
    reset();
    if (workspaceHydrated && workspacePath) void hydrate(workspacePath);
  }, [hydrate, reset, workspaceHydrated, workspacePath]);

  useEffect(() => {
    const api = usageApi();
    if (!api) return;
    return api.onChanged((snapshot) => {
      if (getActiveWorkspacePath()) useUsageStore.getState().receive(snapshot);
    });
  }, []);
}
