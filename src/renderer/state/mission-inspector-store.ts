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
  selectAgent(agentId: string): void;
  selectTab(tab: InspectorTab): void;
}

export type MissionInspectorStore = MissionInspectorState &
  MissionInspectorActions;

export const useMissionInspectorStore = create<MissionInspectorStore>()(
  (set, get) => ({
    missionId: null,
    tab: 'agent',
    selectedAgentId: null,

    bindSnapshot: (snapshot) => {
      const { missionId, selectedAgentId } = get();
      const isSameMission = missionId === snapshot.id;

      if (!isSameMission) {
        const orchestrator = snapshot.agents.find(
          (a) => a.category === 'orchestrator'
        );
        set({
          missionId: snapshot.id,
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
