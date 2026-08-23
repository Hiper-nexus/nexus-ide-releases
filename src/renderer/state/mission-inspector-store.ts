import { create } from 'zustand';
import type { MissionSnapshot } from '../../shared/mission-engine-contract';

export type InspectorTab =
  | 'agent'
  | 'plan'
  | 'chat'
  | 'activity'
  | 'team'
  | 'result';

export interface MissionInspectorState {
  missionId: string | null;
  tab: InspectorTab;
  selectedAgentId: string | null;
}

export interface MissionInspectorActions {
  bindSnapshot(snapshot: MissionSnapshot): void;
  selectMissionTab(missionId: string, tab: InspectorTab): void;
  selectAgent(agentId: string): void;
  selectTab(tab: InspectorTab): void;
}

export type MissionInspectorStore = MissionInspectorState &
  MissionInspectorActions;


/**
 * Aba de abertura de uma missão pela ótica de quem chega nela agora.
 * Estado desconhecido cai em Atividade — a aba que nunca mente.
 */
export function inspectorTabForState(
  state: string | null | undefined,
): InspectorTab {
  switch (state) {
    case 'completed':
      return 'result';
    case 'blocked_user':
      return 'chat';
    case 'failed':
    case 'blocked_technical':
    case 'recovering':
      return 'activity';
    default:
      return 'activity';
  }
}

export const useMissionInspectorStore = create<MissionInspectorStore>()(
  (set, get) => ({
    missionId: null,
    tab: 'agent',
    selectedAgentId: null,

    bindSnapshot: (snapshot) => {
      const { missionId, selectedAgentId, tab } = get();
      const isSameMission = missionId === snapshot.id;

      if (!isSameMission) {
        const orchestrator = snapshot.agents.find(
          (a) => a.category === 'orchestrator'
        );
        set({
          missionId: snapshot.id,
          // A aba de abertura responde o ESTADO: entrega concluída abre no
          // Resultado, pergunta pendente na Conversa, falha na Atividade.
          // Abrir sempre em Atividade fazia quem veio conferir a entrega cair
          // num log de eventos.
          tab:
            missionId === null
              ? tab
              : inspectorTabForState(snapshot.state),
          selectedAgentId: orchestrator?.id ?? snapshot.agents[0]?.id ?? null,
        });
      } else {
        const selectedStillExists = snapshot.agents.some(
          (a) => a.id === selectedAgentId
        );
        if (selectedAgentId !== null && selectedStillExists) {
          set({
            missionId: snapshot.id,
          });
        } else {
          const orchestrator = snapshot.agents.find(
            (a) => a.category === 'orchestrator'
          );
          set({
            missionId: snapshot.id,
            selectedAgentId: orchestrator?.id ?? snapshot.agents[0]?.id ?? null,
          });
        }
      }
    },

    selectMissionTab: (missionId, tab) => {
      const missionChanged = get().missionId !== missionId;
      set({
        missionId,
        tab,
        ...(missionChanged ? { selectedAgentId: null } : {}),
      });
    },

    selectAgent: (agentId) => {
      set({
        selectedAgentId: agentId,
        tab: 'agent',
      });
    },

    selectTab: (tab) => {
      set({ tab });
    },
  })
);
