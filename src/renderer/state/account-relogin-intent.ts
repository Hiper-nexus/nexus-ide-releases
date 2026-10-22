import { create } from 'zustand';
import type { AccountReloginRequest } from '../../shared/account-relogin';
import { useProductNavigationStore } from './product-navigation-store';

/** Um pedido que ninguém atendeu nesse prazo não abre login depois. */
export const ACCOUNT_RELOGIN_INTENT_TTL_MS = 60_000;

export interface PendingRelogin extends AccountReloginRequest {
  readonly requestedAt: number;
}

interface AccountReloginIntentState {
  readonly pending: PendingRelogin | null;
  request(account: AccountReloginRequest, now?: number): void;
  /** Consome o pedido desta CLI (uma vez só); null se não houver um vivo. */
  take(adapterId: string, now?: number): AccountReloginRequest | null;
}

/**
 * F-1637: o pane que não subiu pede o «Entrar novamente» de uma conta. Quem
 * abre o login continua sendo o `AccountsManager` — guardar a sessão atual,
 * baseline e `cliLoginProvedNewSession` moram lá, num caminho só.
 */
export const useAccountReloginIntentStore = create<AccountReloginIntentState>()((set, get) => ({
  pending: null,
  request: (account, now = Date.now()) => set({ pending: { ...account, requestedAt: now } }),
  take: (adapterId, now = Date.now()) => {
    const pending = get().pending;
    if (!pending || pending.adapterId !== adapterId) return null;
    set({ pending: null });
    return freshAccountRelogin(pending, now);
  },
}));

/**
 * O pedido ainda vale? Quem só o lê (o painel, que escolhe a CLI) também
 * respeita o prazo: um pedido que ninguém atendeu não sequestra a navegação.
 */
export function freshAccountRelogin(
  pending: PendingRelogin | null,
  now = Date.now(),
): AccountReloginRequest | null {
  if (!pending || now - pending.requestedAt > ACCOUNT_RELOGIN_INTENT_TTL_MS) return null;
  return { adapterId: pending.adapterId, accountId: pending.accountId, accountLabel: pending.accountLabel };
}

/** Clique no cartão do pane: leva a Contas de IA e pede o login dessa conta. */
export function requestAccountRelogin(account: AccountReloginRequest): void {
  useAccountReloginIntentStore.getState().request(account);
  useProductNavigationStore.getState().openSettings('providers');
}
