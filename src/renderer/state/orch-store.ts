import { create } from 'zustand';
import type {
  Handoff,
  McpRuntimeInfo,
  Mission,
  Squad,
  TodoList,
} from '../../shared/orch-types';
import { markVictory } from './onboarding-store';
import { getActiveWorkspacePath } from './active-workspace';
import { claimRightDrawer, registerRightDrawer } from './right-drawer';

/**
 * Renderer mirror of the orchestration domain (missions / handoffs / todos /
 * squads) plus pane→mission bindings for canvas edges. Project data is reset
 * and rehydrated whenever the main-authorized workspace changes.
 */

export type OrchPanelTab = 'missions' | 'handoffs' | 'todos' | 'squads';

interface OrchState {
  missions: Mission[];
  handoffs: Handoff[];
  todoLists: TodoList[];
  squads: Squad[];
  mcpInfo: McpRuntimeInfo | null;
  panelOpen: boolean;
  panelTab: OrchPanelTab;
  /** Ops Board — pipeline espacial de missões (overlay de workspace). */
  boardOpen: boolean;
  /** paneId → missionId for panes spawned by the orchestration layer. */
  paneMissions: Record<string, string>;
  /**
   * Path this store currently mirrors. Null while switching workspaces so
   * late IPC from the previous project cannot repaint the mission list.
   */
  boundWorkspacePath: string | null;
  /** Bumps on every reset so in-flight hydrate calls drop their result. */
  workspaceEpoch: number;

  hydrate(workspacePath: string): Promise<void>;
  resetProjectState(): void;
  togglePanel(): void;
  openPanel(tab: OrchPanelTab): void;
  setPanelTab(tab: OrchPanelTab): void;
  toggleBoard(): void;
  openBoard(): void;
  closeBoard(): void;
  bindPaneMission(paneId: string, missionId: string | undefined): void;
  /** Remove bindings de panes que não existem mais no layout. */
  pruneMissionBindings(livePaneIds: Set<string>): void;

  setMissions(missions: Mission[]): void;
  setHandoffs(handoffs: Handoff[]): void;
  setTodoLists(lists: TodoList[]): void;
  setSquads(squads: Squad[]): void;
}

function acceptsWorkspacePayload(path: string | null): boolean {
  if (!path) return false;
  const active = getActiveWorkspacePath();
  if (active !== path) return false;
  const { boundWorkspacePath } = useOrchStore.getState();
  return boundWorkspacePath === path;
}

export const useOrchStore = create<OrchState>((set, get) => ({
  missions: [],
  handoffs: [],
  todoLists: [],
  squads: [],
  mcpInfo: null,
  panelOpen: false,
  panelTab: 'missions',
  boardOpen: false,
  paneMissions: {},
  boundWorkspacePath: null,
  workspaceEpoch: 0,

  hydrate: async (workspacePath) => {
    if (getActiveWorkspacePath() !== workspacePath) return;
    const epoch = get().workspaceEpoch;
    try {
      const [missions, handoffs, todoLists, squads, mcpInfo] =
        await Promise.all([
          window.nexus.orch.listMissions(),
          window.nexus.orch.listHandoffs(),
          window.nexus.orch.getTodos(),
          window.nexus.orch.listSquads(),
          window.nexus.orch.getMcpInfo(),
        ]);
      if (getActiveWorkspacePath() !== workspacePath) return;
      if (get().workspaceEpoch !== epoch) return;
      set({
        missions,
        handoffs,
        todoLists,
        squads,
        mcpInfo,
        boundWorkspacePath: workspacePath,
      });
    } catch (err) {
      if (
        getActiveWorkspacePath() === workspacePath &&
        get().workspaceEpoch === epoch
      ) {
        console.warn('[orch] failed to hydrate orchestration state:', err);
      }
    }
  },

  resetProjectState: () =>
    set((s) => ({
      missions: [],
      handoffs: [],
      todoLists: [],
      squads: [],
      paneMissions: {},
      boundWorkspacePath: null,
      workspaceEpoch: s.workspaceEpoch + 1,
    })),

  togglePanel: () => {
    const panelOpen = !get().panelOpen;
    // Opening this drawer claims the shared right slot, closing the omp panel.
    if (panelOpen) claimRightDrawer('orch');
    set({ panelOpen });
  },
  openPanel: (tab) => {
    claimRightDrawer('orch');
    set({ panelOpen: true, panelTab: tab });
  },
  setPanelTab: (tab) => set({ panelTab: tab }),
  toggleBoard: () => set((s) => ({ boardOpen: !s.boardOpen })),
  openBoard: () => set({ boardOpen: true }),
  closeBoard: () => set({ boardOpen: false }),

  bindPaneMission: (paneId, missionId) =>
    set((s) => {
      if (!missionId) return s;
      return { paneMissions: { ...s.paneMissions, [paneId]: missionId } };
    }),

  // Sem o prune, os bindings de panes mortos marcavam a missão deslocada como
  // "aberta" PARA SEMPRE: o clique no rail virava no-op e o board escondia o
  // "retomar" — a missão antiga sumia sem volta (o bug do histórico).
  pruneMissionBindings: (livePaneIds) =>
    set((s) => {
      const entries = Object.entries(s.paneMissions).filter(([paneId]) =>
        livePaneIds.has(paneId),
      );
      if (entries.length === Object.keys(s.paneMissions).length) return s;
      return { paneMissions: Object.fromEntries(entries) };
    }),

  setMissions: (missions) => {
    const path = getActiveWorkspacePath();
    if (!acceptsWorkspacePayload(path)) return;
    if (missions.length > 0) markVictory('firstMission');
    set({ missions });
  },
  setHandoffs: (handoffs) => {
    const path = getActiveWorkspacePath();
    if (!acceptsWorkspacePayload(path)) return;
    if (handoffs.length > 0) markVictory('firstHandoff');
    set({ handoffs });
  },
  setTodoLists: (todoLists) => {
    const path = getActiveWorkspacePath();
    if (!acceptsWorkspacePayload(path)) return;
    set({ todoLists });
  },
  setSquads: (squads) => {
    const path = getActiveWorkspacePath();
    if (!acceptsWorkspacePayload(path)) return;
    set({ squads });
  },
}));

// Right-drawer exclusivity: closing is a plain state write (never routed back
// through togglePanel/openPanel), so a claim from the omp panel cannot recurse.
registerRightDrawer('orch', () => {
  if (useOrchStore.getState().panelOpen) {
    useOrchStore.setState({ panelOpen: false });
  }
});
