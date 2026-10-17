import { create } from 'zustand';
import type { PaneSessionState } from '../../shared/types';
import { clearPaneBirthElapsedForPane } from '../lib/pane-birth-display';

/**
 * Tracks idle/busy state per pane, keyed by pane id. Updated by the terminal
 * host when the main process emits pty:stateChange events.
 *
 * `paneStates` is the authoritative lifecycle signal (close guard, waitForIdle,
 * orchestration). `displayStates` lags busy→idle so short streaming gaps do not
 * flash the toolbar chip / fleet rollup / pane border (the “pisca” bug).
 */

/** How long the UI keeps showing busy after true idle, cancellable by new work. */
export const SESSION_IDLE_DISPLAY_HOLD_MS = 1_400;

const idleDisplayTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearIdleDisplayTimer(paneId: string): void {
  const timer = idleDisplayTimers.get(paneId);
  if (!timer) return;
  clearTimeout(timer);
  idleDisplayTimers.delete(paneId);
}

interface SessionStateStore {
  paneStates: Map<string, PaneSessionState>;
  /** Presentation state — busy sticks briefly after true idle. */
  displayStates: Map<string, PaneSessionState>;
  setPaneState: (paneId: string, state: PaneSessionState) => void;
  clearPaneState: (paneId: string) => void;
}

export const useSessionStateStore = create<SessionStateStore>((set, get) => ({
  paneStates: new Map(),
  displayStates: new Map(),

  setPaneState: (paneId, state) => {
    const prev = get().paneStates.get(paneId);
    if (prev === state) return;
    // O relógio de nascimento vive fora do React: encerra com o estado, mesmo sem overlay montado.
    if (state !== 'spawning' || prev !== 'spawning') clearPaneBirthElapsedForPane(paneId);

    // Busy → idle: publish truth now, hold the chip/fleet/border until the
    // quiet gap is real (or more output cancels the hold).
    if (
      state === 'idle' &&
      (prev === 'busy' || prev === 'spawning')
    ) {
      // Ensure display has a sticky "busy" even if truth moved first (tests /
      // late subscribers) so fleet/toolbar do not flash through a missing key.
      set((s) => {
        const display = new Map(s.displayStates);
        if (!display.has(paneId) || display.get(paneId) === 'idle') {
          display.set(paneId, prev);
        }
        return {
          paneStates: new Map(s.paneStates).set(paneId, 'idle'),
          displayStates: display,
        };
      });
      if (idleDisplayTimers.has(paneId)) return;
      const timer = setTimeout(() => {
        idleDisplayTimers.delete(paneId);
        if (get().paneStates.get(paneId) !== 'idle') return;
        set((s) => ({
          displayStates: new Map(s.displayStates).set(paneId, 'idle'),
        }));
      }, SESSION_IDLE_DISPLAY_HOLD_MS);
      idleDisplayTimers.set(paneId, timer);
      return;
    }

    clearIdleDisplayTimer(paneId);
    set((s) => ({
      paneStates: new Map(s.paneStates).set(paneId, state),
      displayStates: new Map(s.displayStates).set(paneId, state),
    }));
  },

  clearPaneState: (paneId) => {
    clearPaneBirthElapsedForPane(paneId);
    clearIdleDisplayTimer(paneId);
    set((s) => {
      const paneStates = new Map(s.paneStates);
      const displayStates = new Map(s.displayStates);
      paneStates.delete(paneId);
      displayStates.delete(paneId);
      return { paneStates, displayStates };
    });
  },
}));

/** Test helper: cancel pending display holds so fake timers stay isolated. */
export function __resetSessionStateDisplayTimersForTests(): void {
  for (const timer of idleDisplayTimers.values()) clearTimeout(timer);
  idleDisplayTimers.clear();
}
