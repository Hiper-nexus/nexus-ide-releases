import { create } from "zustand";
import type { ContextualTab } from "../../shared/contextual-panel";

export interface ContextualPanelOpenOptions {
  readonly focus?: boolean;
}

interface ContextualPanelNavState {
  requestedTab: ContextualTab | null;
  requestId: number;
  focusRequested: boolean;
  openTab(tab: ContextualTab, options?: ContextualPanelOpenOptions): void;
  acknowledge(requestId: number): void;
}

/**
 * Renderer-only navigation intent. It changes what the operator sees, never
 * grants file, Git, pane, or mission authority.
 */
export const useContextualPanelNavStore = create<ContextualPanelNavState>(
  (set) => ({
    requestedTab: null,
    requestId: 0,
    focusRequested: false,
    openTab: (requestedTab, options) =>
      set((state) => ({
        requestedTab,
        requestId: state.requestId + 1,
        focusRequested: options?.focus ?? false,
      })),
    acknowledge: (requestId) =>
      set((state) =>
        state.requestId === requestId
          ? { requestedTab: null, focusRequested: false }
          : state,
      ),
  }),
);
