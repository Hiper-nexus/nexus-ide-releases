import { create } from 'zustand';
import type { PaneFootprintBroadcast } from '../../shared/types';

/**
 * 0.76.45: espelho renderer do push periódico main → todos os renderers
 * (perf:paneFootprints, a cada 30s). Mesmo padrão read-only de outros
 * espelhos (cost-store, usage-store), mas sem hook de montagem: um único
 * broadcast global não tem estado por workspace para (re)hidratar, então a
 * subscrição vive aqui mesmo — o PaneToolbar só lê o mapa por sessionId.
 */

type PaneFootprintEntry = PaneFootprintBroadcast['bySessionId'][string];

interface PaneFootprintStore {
  readonly capturedAt: number | null;
  readonly bySessionId: Readonly<Record<string, PaneFootprintEntry>>;
  readonly systemMemory: PaneFootprintBroadcast['systemMemory'];
}

export const usePaneFootprintStore = create<PaneFootprintStore>(() => ({
  capturedAt: null,
  bySessionId: {},
  systemMemory: null,
}));

/** Exportado só para teste — a subscrição real é o efeito module-level abaixo. */
export function receivePaneFootprintBroadcast(
  event: PaneFootprintBroadcast,
): void {
  usePaneFootprintStore.setState({
    capturedAt: event.capturedAt,
    bySessionId: event.bySessionId,
    systemMemory: event.systemMemory,
  });
}

// `window` pode nem existir (teste unitário fora do ambiente jsdom) e
// `window.nexus` pode faltar em teste isolado (preload não injetado) —
// encadeamento opcional em vez de try/catch, mesmo idioma de cost-store.
if (typeof window !== 'undefined') {
  window.nexus?.perf?.onPaneFootprints?.(receivePaneFootprintBroadcast);
}
