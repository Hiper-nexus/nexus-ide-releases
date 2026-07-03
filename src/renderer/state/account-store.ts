import { useEffect } from 'react';
import { create } from 'zustand';
import type { AccountInfo, AddAccountRequest } from '../../shared/account-types';

/** Renderer mirror of the multi-account registry (secret-free). */
interface AccountStore {
  accounts: AccountInfo[];
  hydrate(): Promise<void>;
  receive(list: AccountInfo[]): void;
  add(req: AddAccountRequest): Promise<{ ok: boolean; error?: string }>;
  addActiveClaude(label: string): Promise<{ ok: boolean; email?: string; error?: string }>;
  rename(id: string, label: string): Promise<void>;
  remove(id: string): Promise<void>;
  activate(id: string): Promise<void>;
}

export const useAccountStore = create<AccountStore>((set) => ({
  accounts: [],
  hydrate: async () => {
    try {
      set({ accounts: await window.nexus.accounts.list() });
    } catch (err) {
      console.warn('[accounts] hydrate failed:', err);
    }
  },
  receive: (list) => set({ accounts: list }),
  add: (req) => window.nexus.accounts.add(req),
  addActiveClaude: (label) => window.nexus.accounts.addActiveClaude(label),
  rename: async (id, label) => {
    await window.nexus.accounts.rename(id, label);
  },
  remove: async (id) => {
    await window.nexus.accounts.remove(id);
  },
  activate: async (id) => {
    await window.nexus.accounts.activate(id);
  },
}));

export function useAccountController(): void {
  const hydrate = useAccountStore((s) => s.hydrate);
  useEffect(() => {
    void hydrate();
    return window.nexus.accounts.onChanged((list) =>
      useAccountStore.getState().receive(list),
    );
  }, [hydrate]);
}
