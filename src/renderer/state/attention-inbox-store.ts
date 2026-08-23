import { create } from 'zustand';

interface AttentionInboxStore {
  open: boolean;
  /**
   * Quantos itens esperam a pessoa. Publicado pela própria AttentionInbox, que
   * fica montada mesmo fechada e já projeta a lista. O rail lê daqui para
   * mostrar "Precisa de você" — antes a lista só abria por ⌘J ou pela paleta,
   * ou seja, era inalcançável para quem não decora atalhos.
   */
  count: number;
  setOpen(open: boolean): void;
  setCount(count: number): void;
  toggle(): void;
}

export const useAttentionInboxStore = create<AttentionInboxStore>((set) => ({
  open: false,
  count: 0,
  setOpen: (open) => set({ open }),
  setCount: (count) =>
    set((s) => (s.count === count ? s : { ...s, count })),
  toggle: () => set((s) => ({ open: !s.open })),
}));
