import { useEffect } from 'react';
import { create } from 'zustand';
import type {
  AccountActivatedEvent,
  AccountInfo,
  AccountQuotaInfo,
  AddAccountRequest,
} from '../../shared/account-types';

/** Renderer mirror of the multi-account registry (secret-free). */
interface AccountStore {
  accounts: AccountInfo[];
  quota: AccountQuotaInfo[];
  /** After hot-swap: adapter that needs pane restart (Orca restart chip). */
  restartAdapterId: string | null;
  restartLabel: string | null;
  hydrate(): Promise<void>;
  receive(list: AccountInfo[]): void;
  receiveQuota(list: AccountQuotaInfo[]): void;
  receiveActivated(event: AccountActivatedEvent): void;
  clearRestartNotice(): void;
  /**
   * O `id` devolvido pelo main JÁ existia no contrato de IPC e sempre veio no
   * runtime; só a tipagem do renderer o escondia. Ele é o que permite
   * selecionar a conta recém-criada sem procurá-la pelo nome ou e-mail —
   * conta sem e-mail não tem outro identificador estável.
   */
  add(req: AddAccountRequest): Promise<{ ok: boolean; id?: string; error?: string }>;
  addActiveClaude(
    label: string,
  ): Promise<{ ok: boolean; id?: string; email?: string; error?: string }>;
  addActiveSession(
    adapterId: string,
    label: string,
    accountId?: string,
  ): Promise<{ ok: boolean; id?: string; email?: string; error?: string }>;
  supportsSnapshot(adapterId: string): Promise<boolean>;
  rename(id: string, label: string): Promise<{ ok: boolean; error?: string }>;
  remove(id: string): Promise<{ ok: boolean; error?: string }>;
  activate(id: string): Promise<{ ok: boolean; error?: string; needsRestart?: boolean }>;
}

export const useAccountStore = create<AccountStore>((set) => ({
  accounts: [],
  quota: [],
  restartAdapterId: null,
  restartLabel: null,
  hydrate: async () => {
    try {
      const [accounts, quota] = await Promise.all([
        window.nexus.accounts.list(),
        window.nexus.accounts.quota(),
      ]);
      set({ accounts, quota });
    } catch (err) {
      console.warn('[accounts] hydrate failed:', err);
    }
  },
  receive: (list) => set({ accounts: list }),
  receiveQuota: (list) => set({ quota: list }),
  receiveActivated: (event) => {
    if (event.needsRestart) {
      set({
        restartAdapterId: event.adapterId,
        restartLabel: event.label,
      });
    }
  },
  clearRestartNotice: () => set({ restartAdapterId: null, restartLabel: null }),
  add: (req) => window.nexus.accounts.add(req),
  addActiveClaude: (label) => window.nexus.accounts.addActiveClaude(label),
  addActiveSession: (adapterId, label, accountId) =>
    window.nexus.accounts.addActiveSession(adapterId, label, accountId),
  supportsSnapshot: async (adapterId) => {
    try {
      const res = await window.nexus.accounts.supportsSnapshot(adapterId);
      return Boolean(res.ok && res.supported);
    } catch {
      return false;
    }
  },
  // F-1293: o IPC devolve {ok,error} — propagar em vez de descartar. Rejeição
  // crua (main lançou antes do handler) também vira {ok:false}.
  rename: async (id, label) => {
    try {
      return await window.nexus.accounts.rename(id, label);
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Não consegui renomear a conta.',
      };
    }
  },
  remove: async (id) => {
    try {
      return await window.nexus.accounts.remove(id);
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Não consegui remover a conta.',
      };
    }
  },
  activate: (id) => window.nexus.accounts.activate(id),
}));

export function useAccountController(): void {
  const hydrate = useAccountStore((s) => s.hydrate);
  useEffect(() => {
    void hydrate();
    const offChanged = window.nexus.accounts.onChanged((list) => {
      useAccountStore.getState().receive(list);
      void window.nexus.accounts.quota().then((q) => {
        useAccountStore.getState().receiveQuota(q);
      });
    });
    const offActivated = window.nexus.accounts.onActivated((event) => {
      useAccountStore.getState().receiveActivated(event);
    });
    return () => {
      offChanged();
      offActivated();
    };
  }, [hydrate]);
}
