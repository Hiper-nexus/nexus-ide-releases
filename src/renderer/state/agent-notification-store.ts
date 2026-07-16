import { create } from 'zustand';
import {
  pushAgentNotification,
  type AgentNotification,
  type AgentNotificationKind,
} from '../../shared/agent-notification';

interface AgentNotificationStore {
  readonly items: AgentNotification[];
  readonly open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  push: (input: {
    paneId: string;
    agentLabel: string;
    kind: AgentNotificationKind;
    createdAt?: number;
  }) => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
  clear: () => void;
}

export const useAgentNotificationStore = create<AgentNotificationStore>(
  (set) => ({
    items: [],
    open: false,
    setOpen: (open) => set({ open }),
    toggle: () => set((s) => ({ open: !s.open })),
    push: (input) =>
      set((s) => ({
        items: pushAgentNotification(s.items, {
          paneId: input.paneId,
          agentLabel: input.agentLabel,
          kind: input.kind,
          createdAt: input.createdAt ?? Date.now(),
        }),
      })),
    markRead: (id) =>
      set((s) => ({
        items: s.items.map((item) =>
          item.id === id ? { ...item, read: true } : item,
        ),
      })),
    markAllRead: () =>
      set((s) => ({
        items: s.items.map((item) =>
          item.read ? item : { ...item, read: true },
        ),
      })),
    clear: () => set({ items: [] }),
  }),
);
