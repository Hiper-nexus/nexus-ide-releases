import { useEffect } from 'react';
import { create } from 'zustand';
import type { PaneFootprintBroadcast } from '../../shared/types';

/**
 * 0.76.45: espelho renderer do push periódico main → renderers assinantes
 * (perf:paneFootprints, a cada 30s). Mesmo padrão read-only de outros
 * espelhos (cost-store, usage-store). QLT-11: a assinatura vive em quem exibe
 * — `usePaneFootprintFeed` no badge do PaneToolbar; sem badge montado o main
 * não roda `ps`.
 */

type PaneFootprintEntry = PaneFootprintBroadcast['bySessionId'][string];

interface PaneFootprintStore {
  readonly capturedAt: number | null;
  /** Série do coletor no main (0 = nenhuma ainda). */
  readonly generation: number;
  readonly sequence: number;
  readonly bySessionId: Readonly<Record<string, PaneFootprintEntry>>;
  readonly systemMemory: PaneFootprintBroadcast['systemMemory'];
}

export const usePaneFootprintStore = create<PaneFootprintStore>(() => ({
  capturedAt: null,
  generation: 0,
  sequence: 0,
  bySessionId: {},
  systemMemory: null,
}));

export function receivePaneFootprintBroadcast(
  event: PaneFootprintBroadcast,
): void {
  const current = usePaneFootprintStore.getState();
  // A sequência só se compara dentro da mesma geração: coletor religado
  // recomeça em 1 e substitui a série anterior inteira. Também absorve a
  // mesma amostra entregue a cada badge montado.
  if (event.generation === current.generation && event.sequence <= current.sequence) return;
  usePaneFootprintStore.setState({
    capturedAt: event.capturedAt,
    generation: event.generation,
    sequence: event.sequence,
    bySessionId: event.bySessionId,
    systemMemory: event.systemMemory,
  });
}

/** Assina o footprint enquanto o componente estiver montado. */
export function usePaneFootprintFeed(): void {
  // Closure própria por montagem: o preload conta ouvintes num Set, e a mesma
  // função em dois badges viraria uma assinatura só (o primeiro a desmontar
  // desligaria o outro). `window.nexus` pode faltar em teste isolado.
  useEffect(
    () => window.nexus?.perf?.onPaneFootprints?.((event) => receivePaneFootprintBroadcast(event)),
    [],
  );
}
