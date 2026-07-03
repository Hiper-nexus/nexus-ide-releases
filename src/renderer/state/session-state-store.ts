import { create } from 'zustand';
import type { PaneSessionState } from '../../shared/types';

/**
 * Tracks idle/busy state per pane, keyed by pane id. Updated by the terminal
 * host when the main process emits pty:stateChange events.
 */

interface SessionStateStore {
  paneStates: Map<string, PaneSessionState>;
  setPaneState: (paneId: string, state: PaneSessionState) => void;
  clearPaneState: (paneId: string) => void;
}

export const useSessionStateStore = create<SessionStateStore>((set) => ({
  paneStates: new Map(),

  setPaneState: (paneId, state) =>
    set((s) => ({
      paneStates: new Map(s.paneStates).set(paneId, state),
    })),

  clearPaneState: (paneId) =>
    set((s) => {
      const next = new Map(s.paneStates);
      next.delete(paneId);
      return { paneStates: next };
    }),
}));
