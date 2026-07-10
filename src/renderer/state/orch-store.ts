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

  hydrate(workspacePath: string): Promise<void>;
  resetProjectState(): void;
  togglePanel(): void;
  openPanel(tab: OrchPanelTab): void;
  setPanelTab(tab: OrchPanelTab): void;
  toggleBoard(): void;
  closeBoard(): void;
  bindPaneMission(paneId: string, missionId: string | undefined): void;
  /** Remove bindings de panes que não existem mais no layout. */
  pruneMissionBindings(livePaneIds: Set<string>): void;

  setMissions(missions: Mission[]): void;
  setHandoffs(handoffs: Handoff[]): void;
  setTodoLists(lists: TodoList[]): void;
  setSquads(squads: Squad[]): void;
}

export const useOrchStore = create<OrchState>((set) => ({
  missions: [],
  handoffs: [],
  todoLists: [],
  squads: [],
  mcpInfo: null,
  panelOpen: false,
  panelTab: 'missions',
  boardOpen: false,
  paneMissions: {},

  hydrate: async (workspacePath) => {
    if (getActiveWorkspacePath() !== workspacePath) return;
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
      set({ missions, handoffs, todoLists, squads, mcpInfo });
    } catch (err) {
      if (getActiveWorkspacePath() === workspacePath) {
        console.warn('[orch] failed to hydrate orchestration state:', err);
      }
    }
  },

  resetProjectState: () =>
    set({
      missions: [],
      handoffs: [],
      todoLists: [],
      paneMissions: {},
    }),

  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
  openPanel: (tab) => set({ panelOpen: true, panelTab: tab }),
  setPanelTab: (tab) => set({ panelTab: tab }),
  toggleBoard: () => set((s) => ({ boardOpen: !s.boardOpen })),
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
    if (missions.length > 0) markVictory('firstMission');
    set({ missions });
  },
  setHandoffs: (handoffs) => {
    if (handoffs.length > 0) markVictory('firstHandoff');
    set({ handoffs });
  },
  setTodoLists: (todoLists) => set({ todoLists }),
  setSquads: (squads) => set({ squads }),
}));
