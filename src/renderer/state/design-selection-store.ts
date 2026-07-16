import { create } from 'zustand';
import type {
  BrowserDesignAnnotationSummary,
  BrowserDesignElementContext,
} from '../../shared/browser-design';
import type { BrowserDesignEventPayload } from '../../shared/types';

/**
 * Design-mode state per browser pane (VISUAL-EDIT-001, F2). Single renderer
 * source of truth fed by the main-process push, so late-mounted consumers
 * (a sidebar opened AFTER the click) still see the current selection.
 */

export interface DesignPaneState {
  isActive: boolean;
  selection: BrowserDesignElementContext | null;
  /** Multi-selection set (F4 shift+click), oldest first. */
  selections: BrowserDesignElementContext[];
  /**
   * Annotation summaries mirrored from the MAIN-owned store (Orca Design Mode
   * parity). Refreshed from every annotation IPC response; cleared when a
   * 'navigation' mode event arrives — annotations die with the document, but
   * SURVIVE a plain design-mode off.
   */
  annotations: BrowserDesignAnnotationSummary[];
}

const MAX_SELECTIONS = 8;

interface DesignSelectionState {
  byPane: Record<string, DesignPaneState>;
  applyEvent(payload: BrowserDesignEventPayload): void;
  setAnnotations(
    paneId: string,
    annotations: BrowserDesignAnnotationSummary[],
  ): void;
  reset(): void;
}

const EMPTY: DesignPaneState = {
  isActive: false,
  selection: null,
  selections: [],
  annotations: [],
};

export const useDesignSelectionStore = create<DesignSelectionState>((set) => ({
  byPane: {},
  applyEvent: ({ paneId, event }) => {
    set((state) => {
      const current = state.byPane[paneId] ?? EMPTY;
      if (event.type === 'mode' && event.mode) {
        return {
          byPane: {
            ...state.byPane,
            [paneId]: {
              isActive: event.mode.active,
              selection: event.mode.active ? current.selection : null,
              selections: event.mode.active ? current.selections : [],
              annotations:
                !event.mode.active && event.mode.reason === 'navigation'
                  ? []
                  : current.annotations,
            },
          },
        };
      }
      if (event.type === 'selection' && event.selection) {
        const selection = event.selection;
        let selections: BrowserDesignElementContext[];
        if (selection.additive) {
          const existing = current.selections.findIndex(
            (candidate) => candidate.ref === selection.ref,
          );
          selections =
            existing >= 0
              ? current.selections.filter((_, index) => index !== existing)
              : [...current.selections, selection].slice(-MAX_SELECTIONS);
        } else {
          selections = [selection];
        }
        return {
          byPane: {
            ...state.byPane,
            [paneId]: {
              ...current,
              selection: selections.at(-1) ?? null,
              selections,
            },
          },
        };
      }
      return state;
    });
  },
  setAnnotations: (paneId, annotations) => {
    set((state) => ({
      byPane: {
        ...state.byPane,
        [paneId]: {
          ...(state.byPane[paneId] ?? EMPTY),
          annotations,
        },
      },
    }));
  },
  reset: () => set({ byPane: {} }),
}));

/** Wire the main-process push into the store; returns the unsubscribe. */
export function initDesignSelectionStore(): () => void {
  return window.nexus.browser.onDesignEvent((payload) => {
    useDesignSelectionStore.getState().applyEvent(payload);
  });
}
