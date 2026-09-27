import { create } from 'zustand';
import type { MissionSummarySnapshot } from '../../shared/mission-engine-contract';
import type {
  Handoff,
  McpRuntimeInfo,
  Mission,
  Squad,
  TodoList,
} from '../../shared/orch-types';
import { getActiveWorkspacePath } from './active-workspace';

/**
 * Renderer mirror of the orchestration domain (missions / handoffs / todos /
 * squads) plus pane→mission bindings for canvas edges. Project data is reset
 * and rehydrated whenever the main-authorized workspace changes.
 */

interface OrchState {
  missions: Mission[];
  missionSummaries: MissionSummarySnapshot[];
  /** Empty is authoritative only after a canonical list or broadcast arrives. */
  missionSummariesHydrated: boolean;
  handoffs: Handoff[];
  todoLists: TodoList[];
  squads: Squad[];
  mcpInfo: McpRuntimeInfo | null;
  /**
   * paneId → missionId for panes spawned by the orchestration layer.
   *
   * ÍNDICE, nunca autoridade: diz a que missão um pane pertence (classificação
   * de aba, herança de espaço, prune). NÃO diz quem LIDERA a missão — isso é
   * `mission.orchestratorSessionId` no Main. Nenhum leitor pode escolher líder
   * a partir daqui.
   */
  paneMissions: Record<string, string>;
  /**
   * Path this store currently mirrors. Null while switching workspaces so
   * late IPC from the previous project cannot repaint the mission list.
   */
  boundWorkspacePath: string | null;
  /** Bumps on every reset so in-flight hydrate calls drop their result. */
  workspaceEpoch: number;
  /**
   * Summaries de missões ATIVAS de outros workspaces (rail multi-workspace,
   * 2026-08-17). Key = root path. Não é project-scoped: sobrevive à troca de
   * workspace para o operador não perder a visão do que roda nos vizinhos.
   */
  crossWorkspaceSummaries: Record<string, MissionSummarySnapshot[]>;
  /** Bumps a cada hydrateCrossWorkspace; resposta atrasada é descartada. */
  crossWorkspaceEpoch: number;

  hydrate(workspacePath: string): Promise<void>;
  /** Refresca as missões ativas dos workspaces vizinhos (paths conhecidos). */
  hydrateCrossWorkspace(paths: readonly string[]): Promise<void>;
  resetProjectState(): void;
  bindPaneMission(paneId: string, missionId: string | undefined): void;
  /** O pane saiu desta missão (a mão do operador devolvida pelo Main). */
  unbindPaneMission(paneId: string, missionId: string): void;
  /** Remove bindings de panes que não existem mais no layout. */
  pruneMissionBindings(livePaneIds: Set<string>): void;

  setMissions(missions: Mission[]): void;
  setMissionSummaries(items: MissionSummarySnapshot[]): void;
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
  missionSummaries: [],
  missionSummariesHydrated: false,
  handoffs: [],
  todoLists: [],
  squads: [],
  mcpInfo: null,
  paneMissions: {},
  boundWorkspacePath: null,
  workspaceEpoch: 0,
  crossWorkspaceSummaries: {},
  crossWorkspaceEpoch: 0,

  hydrateCrossWorkspace: async (paths) => {
    const epoch = get().crossWorkspaceEpoch + 1;
    set({ crossWorkspaceEpoch: epoch });
    const wanted = [...new Set(paths)];
    const results = await Promise.allSettled(
      wanted.map((path) => window.nexus.mission.listForWorkspace(path)),
    );
    if (get().crossWorkspaceEpoch !== epoch) return;
    const next: Record<string, MissionSummarySnapshot[]> = {};
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') next[wanted[index]!] = result.value;
    });
    // Keys fora do pedido atual caem fora (workspace removido dos recentes
    // não fica preso no rail).
    set({ crossWorkspaceSummaries: next });
  },

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
      missionSummaries: stateBeforeHydration.missionSummaries,
      handoffs: stateBeforeHydration.handoffs,
      todoLists: stateBeforeHydration.todoLists,
      squads: stateBeforeHydration.squads,
      mcpInfo: stateBeforeHydration.mcpInfo,
    };

    const canonicalHydration = Promise.resolve()
      .then(() => window.nexus.mission.list())
      .then(
        (missionSummaries) => {
          if (getActiveWorkspacePath() !== workspacePath) return;
          if (get().workspaceEpoch !== epoch) return;
          if (
            get().missionSummaries === hydrationBaseline.missionSummaries
          ) {
            set({ missionSummaries, missionSummariesHydrated: true });
          }
        },
        (reason) => {
          if (
            getActiveWorkspacePath() === workspacePath &&
            get().workspaceEpoch === epoch
          ) {
            console.warn(
              '[orch] failed to hydrate canonical mission summaries:',
              reason,
            );
          }
        },
      );
    // Começa os auxiliares em paralelo, mas observa suas rejeições desde já.
    const auxiliaryHydration = Promise.allSettled([
      window.nexus.orch.listHandoffs(),
      window.nexus.orch.getTodos(),
      window.nexus.orch.listSquads(),
      window.nexus.orch.getMcpInfo(),
    ] as const);
    let missions: Mission[];
    try {
      missions = await window.nexus.orch.listMissions();
    } catch (reason) {
      if (
        getActiveWorkspacePath() === workspacePath &&
        get().workspaceEpoch === epoch
      ) {
        console.warn('[orch] failed to hydrate legacy mission state:', reason);
      }
      await canonicalHydration;
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
    await canonicalHydration;
  },

  resetProjectState: () =>
    set((s) => ({
      missions: [],
      missionSummaries: [],
      missionSummariesHydrated: false,
      handoffs: [],
      todoLists: [],
      squads: [],
      paneMissions: {},
      boundWorkspacePath: null,
      workspaceEpoch: s.workspaceEpoch + 1,
    })),


  bindPaneMission: (paneId, missionId) =>
    set((s) => {
      if (!missionId) return s;
      // Rebinding do mesmo par é no-op: este método é chamado em todo broadcast
      // de missão, e devolver um objeto novo acordava todo assinante (abas,
      // toolbar, canvas) sem nada ter mudado.
      if (s.paneMissions[paneId] === missionId) return s;
      return { paneMissions: { ...s.paneMissions, [paneId]: missionId } };
    }),

  unbindPaneMission: (paneId, missionId) =>
    set((s) => {
      if (s.paneMissions[paneId] !== missionId) return s;
      const { [paneId]: _released, ...paneMissions } = s.paneMissions;
      return { paneMissions };
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

  setMissionSummaries: (missionSummaries) => {
    const path = getActiveWorkspacePath();
    if (!acceptsWorkspacePayload(path)) return;
    set({ missionSummaries, missionSummariesHydrated: true });
  },
  setMissions: (missions) => {
    const path = getActiveWorkspacePath();
    if (!acceptsWorkspacePayload(path)) return;
    set({ missions });
  },
  setHandoffs: (handoffs) => {
    const path = getActiveWorkspacePath();
    if (!acceptsWorkspacePayload(path)) return;
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
