import { useEffect } from 'react';
import { create } from 'zustand';
import type { WorkspaceInfo, WorkspaceState } from '../../shared/workspace-types';
import { setActiveWorkspacePath } from './active-workspace';

/**
 * Renderer mirror of the workspace onboarding state (current + recents). The
 * app gates on `current`: no workspace → launch screen; a workspace → the
 * terminal/mission surface rooted at that folder.
 */

interface WorkspaceStore {
  current: WorkspaceInfo | null;
  recents: WorkspaceInfo[];
  hydrated: boolean;

  hydrate(): Promise<void>;
  receive(state: WorkspaceState): void;
  pick(): Promise<void>;
  open(path: string): Promise<void>;
  close(): Promise<void>;
  remove(path: string): Promise<void>;
}

function apply(
  set: (partial: Partial<WorkspaceStore>) => void,
  state: WorkspaceState,
): void {
  setActiveWorkspacePath(state.current?.path ?? null);
  set({ current: state.current, recents: state.recents });
}

export const useWorkspaceStore = create<WorkspaceStore>((set) => ({
  current: null,
  recents: [],
  hydrated: false,

  hydrate: async () => {
    try {
      const state = await window.nexus.workspace.get();
      apply(set, state);
    } catch (err) {
      console.warn('[workspace] hydrate failed:', err);
    } finally {
      set({ hydrated: true });
    }
  },

  receive: (state) => apply(set, state),

  pick: async () => apply(set, await window.nexus.workspace.pick()),
  open: async (path) => apply(set, await window.nexus.workspace.open(path)),
  close: async () => apply(set, await window.nexus.workspace.close()),
  remove: async (path) => apply(set, await window.nexus.workspace.remove(path)),
}));

/** Boot hook: hydrate once and follow main-process broadcasts. */
export function useWorkspaceController(): void {
  const hydrate = useWorkspaceStore((s) => s.hydrate);
  useEffect(() => {
    void hydrate();
    return window.nexus.workspace.onChanged((state) =>
      useWorkspaceStore.getState().receive(state),
    );
  }, [hydrate]);
}
