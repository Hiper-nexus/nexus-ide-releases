import { useEffect } from 'react';
import { create } from 'zustand';
import type { Pipe, PipeApi, PipeMode } from '../../shared/pipe-types';

/**
 * Renderer mirror of the main-process pipe registry ("edges que conversam").
 * Same shape as provider-store: hydrate on mount, then live-update from the
 * pipes:changed broadcast.
 */

function pipesApi(): PipeApi {
  return window.nexus.pipes;
}

interface PipeStore {
  pipes: Pipe[];
  hydrate(): Promise<void>;
  receive(list: Pipe[]): void;
  add(
    sourcePaneId: string,
    targetPaneId: string,
    mode: PipeMode,
  ): Promise<{ ok: boolean; id?: string; error?: string }>;
  remove(id: string): Promise<void>;
}

export const usePipeStore = create<PipeStore>((set) => ({
  pipes: [],

  hydrate: async () => {
    try {
      set({ pipes: await pipesApi().list() });
    } catch (err) {
      console.warn('[pipes] hydrate failed:', err);
    }
  },

  receive: (list) => set({ pipes: list }),

  add: async (sourcePaneId, targetPaneId, mode) => {
    const result = await pipesApi().add(sourcePaneId, targetPaneId, mode);
    // The changed broadcast also lands, but refreshing here keeps the caller
    // consistent even before the event fires.
    set({ pipes: await pipesApi().list() });
    return result;
  },

  remove: async (id) => {
    await pipesApi().remove(id);
    set({ pipes: await pipesApi().list() });
  },
}));

/** Mount once (e.g. in App) to hydrate + subscribe to changes. */
export function usePipeController(): void {
  const hydrate = usePipeStore((s) => s.hydrate);
  useEffect(() => {
    void hydrate();
    return pipesApi().onChanged((list) =>
      usePipeStore.getState().receive(list),
    );
  }, [hydrate]);
}
