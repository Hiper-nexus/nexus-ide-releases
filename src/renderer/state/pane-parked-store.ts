import { create } from 'zustand';

/**
 * 0.76.45: panes estacionados pelo guardian (orch:pane.parkRequest). Loja
 * separada de `session-state-store` — `PaneSessionState` (spawning/busy/idle/
 * exited/hibernated) é o estado de sessão do PROCESSO local; "estacionado" é
 * um veredito do MAIN sobre um pane cuja sessão ele mesmo encerrou, e o
 * renderer só reflete. Manter os dois separados evita reabrir o enum
 * compartilhado (e toda a exaustividade que depende dele) por um estado que
 * é, na prática, um overlay de UI sobre "sem sessão".
 */

export interface ParkedPaneInfo {
  readonly sessionId: string;
  readonly parkedAt: number;
  readonly reason: 'idle' | 'memory-pressure';
}

interface PaneParkedStore {
  readonly parked: ReadonlyMap<string, ParkedPaneInfo>;
  markParked(paneId: string, info: ParkedPaneInfo): void;
  clearParked(paneId: string): void;
}

export const usePaneParkedStore = create<PaneParkedStore>((set, get) => ({
  parked: new Map(),
  markParked: (paneId, info) => {
    const next = new Map(get().parked);
    next.set(paneId, info);
    set({ parked: next });
  },
  clearParked: (paneId) => {
    if (!get().parked.has(paneId)) return;
    const next = new Map(get().parked);
    next.delete(paneId);
    set({ parked: next });
  },
}));
