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
  /** Durable mission report selected for inspection; never runtime authority. */
  selectedMissionId: string | null;
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
  openMissionDetail(missionId: string): void;
  clearMissionDetail(): void;
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
  selectedMissionId: null,
  boardOpen: false,
  paneMissions: {},
  boundWorkspacePath: null,
  workspaceEpoch: 0,

  hydrate: async (workspacePath) => {
    if (getActiveWorkspacePath() !== workspacePath) return;
    const epoch = get().workspaceEpoch + 1;
    // Bind before the first IPC await. Broadcasts can arrive while the
    // snapshot is in flight; the epoch and reference baselines below make the
    // newer push win without accepting a previous workspace's payload.
    set({
      boundWorkspacePath: workspacePath,
      workspaceEpoch: epoch,
    });
    const stateBeforeHydration = get();
    const hydrationBaseline = {
      missions: stateBeforeHydration.missions,
      handoffs: stateBeforeHydration.handoffs,
      todoLists: stateBeforeHydration.todoLists,
      squads: stateBeforeHydration.squads,
      mcpInfo: stateBeforeHydration.mcpInfo,
    };

    // Começa os auxiliares em paralelo, mas observa suas rejeições desde já.
    // A lista de missões é a fronteira essencial: assim que chega, vincula o
    // workspace para que broadcasts posteriores não sejam descartados.
    const auxiliaryHydration = Promise.allSettled([
      window.nexus.orch.listHandoffs(),
      window.nexus.orch.getTodos(),
      window.nexus.orch.listSquads(),
      window.nexus.orch.getMcpInfo(),
    ] as const);
    let missions: Mission[];
    try {
      missions = await window.nexus.orch.listMissions();
    } catch (err) {
      if (
        getActiveWorkspacePath() === workspacePath &&
        get().workspaceEpoch === epoch
      ) {
        console.warn('[orch] failed to hydrate mission state:', err);
      }
      return;
    }
    if (getActiveWorkspacePath() !== workspacePath) return;
    if (get().workspaceEpoch !== epoch) return;
    if (get().missions === hydrationBaseline.missions) {
      set({ missions });
    }

    const [handoffs, todoLists, squads, mcpInfo] = await auxiliaryHydration;
    if (getActiveWorkspacePath() !== workspacePath) return;
    if (get().workspaceEpoch !== epoch) return;

    const auxiliaryPatch: Partial<
      Pick<OrchState, 'handoffs' | 'todoLists' | 'squads' | 'mcpInfo'>
    > = {};
    const current = get();
    if (
      handoffs.status === 'fulfilled' &&
      current.handoffs === hydrationBaseline.handoffs
    ) {
      auxiliaryPatch.handoffs = handoffs.value;
    } else {
      if (handoffs.status === 'rejected') {
        console.warn(
          '[orch] failed to hydrate auxiliary handoffs:',
          handoffs.reason,
        );
      }
    }
    if (
      todoLists.status === 'fulfilled' &&
      current.todoLists === hydrationBaseline.todoLists
    ) {
      auxiliaryPatch.todoLists = todoLists.value;
    } else {
      if (todoLists.status === 'rejected') {
        console.warn(
          '[orch] failed to hydrate auxiliary todoLists:',
          todoLists.reason,
        );
      }
    }
    if (
      squads.status === 'fulfilled' &&
      current.squads === hydrationBaseline.squads
    ) {
      auxiliaryPatch.squads = squads.value;
    } else {
      if (squads.status === 'rejected') {
        console.warn(
          '[orch] failed to hydrate auxiliary squads:',
          squads.reason,
        );
      }
    }
    if (
      mcpInfo.status === 'fulfilled' &&
      current.mcpInfo === hydrationBaseline.mcpInfo
    ) {
      auxiliaryPatch.mcpInfo = mcpInfo.value;
    } else {
      if (mcpInfo.status === 'rejected') {
        console.warn(
          '[orch] failed to hydrate auxiliary mcpInfo:',
          mcpInfo.reason,
        );
      }
    }
    if (Object.keys(auxiliaryPatch).length > 0) set(auxiliaryPatch);
  },

  resetProjectState: () =>
    set((s) => ({
      missions: [],
      handoffs: [],
      todoLists: [],
      squads: [],
      paneMissions: {},
      boundWorkspacePath: null,
      selectedMissionId: null,
      workspaceEpoch: s.workspaceEpoch + 1,
    })),

  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
  openPanel: (tab) =>
    set({ panelOpen: true, panelTab: tab, selectedMissionId: null }),
  openMissionDetail: (missionId) =>
    set({
      panelOpen: true,
      panelTab: 'missions',
      selectedMissionId: missionId,
    }),
  clearMissionDetail: () => set({ selectedMissionId: null }),
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
