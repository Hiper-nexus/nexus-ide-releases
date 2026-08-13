import { create } from 'zustand';

interface AttentionInboxStore {
  open: boolean;
  setOpen(open: boolean): void;
  toggle(): void;
}

export const useAttentionInboxStore = create<AttentionInboxStore>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
}));
