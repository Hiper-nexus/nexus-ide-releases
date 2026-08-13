import { create } from 'zustand';
import {
  applyAgentWaitingUpdate,
  clearAgentWaitingPane,
  createAgentWaitingSnapshot,
  type AgentWaitingEntry,
  type AgentWaitingSnapshot,
  type AgentWaitingUpdate,
} from '../../shared/agent-waiting';

interface AgentWaitingStore {
  readonly snapshot: AgentWaitingSnapshot;
  apply(update: AgentWaitingUpdate): {
    entered: boolean;
    left: boolean;
    entry: AgentWaitingEntry | null;
  };
  clearPane(paneId: string): { left: boolean; entry: AgentWaitingEntry | null };
  clear(): void;
}

export const useAgentWaitingStore = create<AgentWaitingStore>((set, get) => ({
  snapshot: createAgentWaitingSnapshot(),
  apply: (update) => {
    const result = applyAgentWaitingUpdate(get().snapshot, update);
    set({ snapshot: result.next });
    return {
      entered: result.entered,
      left: result.left,
      entry: result.entry,
    };
  },
  clearPane: (paneId) => {
    const result = clearAgentWaitingPane(get().snapshot, paneId);
    set({ snapshot: result.next });
    return { left: result.left, entry: result.entry };
  },
  clear: () => set({ snapshot: createAgentWaitingSnapshot() }),
}));
