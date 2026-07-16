import { create } from 'zustand';
import type {
  MemoryBridge,
  MemoryRecallResult,
  MemoryStatsResult,
  MemoryUiHit,
  MemoryUiKind,
  MemoryUiStats,
} from '../../shared/memory-ui-types';

/**
 * Renderer mirror do painel de memória agentic por workspace (entrega C2).
 *
 * A memória vive no main (SQLite FTS5, um banco por workspace + global). Este
 * store guarda só o estado da UI: stats do banco, a busca debounced (recall) e
 * a navegação por teclado nos resultados. Toda leitura passa pelo bridge
 * `window.nexus.memory`; nada é assumido sem a resposta do main.
 *
 * Envelope `enabled`: quando a flag `feature.memory.workspaceMemory` está OFF o
 * main devolve `{ enabled: false }` — o painel mostra o estado "desligado" em
 * vez de quebrar. `enabled === null` = ainda não sabemos (antes da 1ª resposta).
 */

const RECALL_DEBOUNCE_MS = 220;
const RECALL_LIMIT = 24;

export interface MemoryUiState {
  panelOpen: boolean;

  /** null = desconhecido (antes da primeira resposta do main). */
  enabled: boolean | null;
  statsLoading: boolean;
  stats: MemoryUiStats | null;

  query: string;
  kindFilter: MemoryUiKind | null;
  recalling: boolean;
  /** A query que produziu `results` (evita mostrar resultado de outra busca). */
  resultsQuery: string;
  results: readonly MemoryUiHit[];
  /** Índice do resultado sob foco de teclado (-1 = nenhum). */
  activeIndex: number;

  error: string | null;

  openPanel(): void;
  closePanel(): void;
  togglePanel(): void;
  refreshStats(): Promise<void>;
  setQuery(query: string): void;
  setKindFilter(kind: MemoryUiKind | null): void;
  runRecallNow(): Promise<void>;
  moveActive(delta: number): void;
  setActive(index: number): void;
  forget(id: string): Promise<void>;
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let statsSeq = 0;
let recallSeq = 0;

/**
 * Reach the memory bridge without depending on the (separately stitched)
 * NexusApi.memory declaration — the cast keeps this store compilable on its own
 * and stays consistent once the preload/types wiring lands (both use
 * MemoryBridge). `memory` may be absent during a preload/renderer version skew.
 */
function memoryApi(): MemoryBridge | undefined {
  const nexus = window.nexus as unknown as { memory?: MemoryBridge } | undefined;
  return nexus?.memory;
}

function clearDebounce(): void {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

function applyEnabledEnvelope(
  result: MemoryStatsResult | MemoryRecallResult,
): boolean {
  if (!result.enabled) {
    useMemoryStore.setState({ enabled: false });
    return false;
  }
  // A primeira resposta positiva confirma que a flag está ligada.
  if (useMemoryStore.getState().enabled !== true) {
    useMemoryStore.setState({ enabled: true });
  }
  return true;
}

export const useMemoryStore = create<MemoryUiState>((set, get) => ({
  panelOpen: false,
  enabled: null,
  statsLoading: false,
  stats: null,
  query: '',
  kindFilter: null,
  recalling: false,
  resultsQuery: '',
  results: [],
  activeIndex: -1,
  error: null,

  openPanel() {
    if (get().panelOpen) return;
    set({ panelOpen: true });
    void get().refreshStats();
    if (get().query.trim()) void get().runRecallNow();
  },

  closePanel() {
    clearDebounce();
    set({ panelOpen: false });
  },

  togglePanel() {
    if (get().panelOpen) get().closePanel();
    else get().openPanel();
  },

  async refreshStats() {
    const api = memoryApi();
    if (!api) {
      set({ enabled: false, statsLoading: false });
      return;
    }
    const seq = ++statsSeq;
    set({ statsLoading: true, error: null });
    try {
      const result = await api.stats();
      if (seq !== statsSeq) return; // resposta obsoleta
      const on = applyEnabledEnvelope(result);
      set({
        statsLoading: false,
        stats: on && result.enabled ? result.stats : null,
      });
    } catch {
      if (seq !== statsSeq) return;
      // Escopo ausente ou binário nativo indisponível: erro suave, sem derrubar.
      set({
        statsLoading: false,
        error: 'Não foi possível ler as estatísticas de memória.',
      });
    }
  },

  setQuery(query) {
    set({ query });
    clearDebounce();
    if (!query.trim()) {
      // Query vazia: limpa resultados e cancela buscas pendentes.
      recallSeq++;
      set({ results: [], resultsQuery: '', recalling: false, activeIndex: -1 });
      return;
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void get().runRecallNow();
    }, RECALL_DEBOUNCE_MS);
  },

  setKindFilter(kind) {
    set({ kindFilter: kind });
    if (get().query.trim()) void get().runRecallNow();
  },

  async runRecallNow() {
    clearDebounce();
    const api = memoryApi();
    const query = get().query.trim();
    if (!query) {
      set({ results: [], resultsQuery: '', activeIndex: -1 });
      return;
    }
    if (!api) {
      set({ enabled: false });
      return;
    }
    const seq = ++recallSeq;
    const kind = get().kindFilter;
    set({ recalling: true, error: null });
    try {
      const result = await api.recall({
        query,
        limit: RECALL_LIMIT,
        ...(kind ? { kind } : {}),
      });
      if (seq !== recallSeq) return; // busca mais nova em voo
      const on = applyEnabledEnvelope(result);
      set({
        recalling: false,
        results: on && result.enabled ? result.hits : [],
        resultsQuery: query,
        activeIndex: -1,
      });
    } catch {
      if (seq !== recallSeq) return;
      set({
        recalling: false,
        error: 'A busca de memórias falhou.',
      });
    }
  },

  moveActive(delta) {
    const { results, activeIndex } = get();
    if (results.length === 0) return;
    const next = Math.max(
      0,
      Math.min(results.length - 1, (activeIndex < 0 ? -1 : activeIndex) + delta),
    );
    set({ activeIndex: next });
  },

  setActive(index) {
    set({ activeIndex: index });
  },

  async forget(id) {
    const api = memoryApi();
    if (!api?.forget) return;
    try {
      const result = await api.forget(id);
      if (!result.enabled || !result.forgotten) return;
      // Remove otimisticamente do resultado e atualiza os contadores.
      set((state) => ({
        results: state.results.filter((hit) => hit.id !== id),
        activeIndex: -1,
      }));
      void get().refreshStats();
    } catch {
      set({ error: 'Não foi possível esquecer esta memória.' });
    }
  },
}));
