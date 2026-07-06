import { create } from 'zustand';
import type {
  Handoff,
  McpRuntimeInfo,
  Mission,
  Squad,
  TodoList,
} from '../../shared/orch-types';
import { markVictory } from './onboarding-store';

/**
 * Renderer mirror of the orchestration domain (missions / handoffs / todos /
 * squads) plus pane→mission bindings for canvas edges. Hydrated once on boot
 * and kept fresh by main-process change events.
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

  hydrate(): Promise<void>;
  togglePanel(): void;
  openPanel(tab: OrchPanelTab): void;
  setPanelTab(tab: OrchPanelTab): void;
  toggleBoard(): void;
  closeBoard(): void;
  bindPaneMission(paneId: string, missionId: string | undefined): void;

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

  hydrate: async () => {
    try {
      const [missions, handoffs, todoLists, squads, mcpInfo] =
        await Promise.all([
          window.nexus.orch.listMissions(),
          window.nexus.orch.listHandoffs(),
          window.nexus.orch.getTodos(),
          window.nexus.orch.listSquads(),
          window.nexus.orch.getMcpInfo(),
        ]);
      set({ missions, handoffs, todoLists, squads, mcpInfo });
    } catch (err) {
      console.warn('[orch] failed to hydrate orchestration state:', err);
    }
  },

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
