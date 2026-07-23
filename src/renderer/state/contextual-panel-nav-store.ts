import { create } from "zustand";
import type { ContextualTab } from "../../shared/contextual-panel";

interface ContextualPanelNavState {
  requestedTab: ContextualTab | null;
  requestId: number;
  openTab(tab: ContextualTab): void;
}

/**
 * Renderer-only navigation intent. It changes what the operator sees, never
 * grants file, Git, pane, or mission authority.
 */
export const useContextualPanelNavStore = create<ContextualPanelNavState>(
  (set) => ({
    requestedTab: null,
    requestId: 0,
    openTab: (requestedTab) =>
      set((state) => ({
        requestedTab,
        requestId: state.requestId + 1,
      })),
  }),
);
