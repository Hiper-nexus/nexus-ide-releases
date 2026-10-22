import { afterEach, describe, expect, it } from 'vitest';
import {
  ACCOUNT_RELOGIN_INTENT_TTL_MS,
  freshAccountRelogin,
  requestAccountRelogin,
  useAccountReloginIntentStore,
} from './account-relogin-intent';
import { useProductNavigationStore } from './product-navigation-store';

const CONTA_B = { adapterId: 'claude', accountId: 'acct-b', accountLabel: 'conta b' };

afterEach(() => useAccountReloginIntentStore.setState({ pending: null }));

describe('pedido de login vindo do pane (F-1642)', () => {
  it('é atendido uma vez só, e só pela CLI dele', () => {
    const store = useAccountReloginIntentStore.getState();
    store.request(CONTA_B, 1_000);
    expect(store.take('codex', 1_001)).toBeNull();
    expect(store.take('claude', 1_001)).toEqual(CONTA_B);
    expect(store.take('claude', 1_002)).toBeNull();
  });

  it('pedido que ninguém atendeu no prazo não abre login depois', () => {
    const store = useAccountReloginIntentStore.getState();
    store.request(CONTA_B, 1_000);
    expect(store.take('claude', 1_000 + ACCOUNT_RELOGIN_INTENT_TTL_MS + 1)).toBeNull();
    expect(useAccountReloginIntentStore.getState().pending).toBeNull();
  });

  it('o clique leva a Contas de IA com o pedido pendente', () => {
    requestAccountRelogin(CONTA_B);
    expect(useProductNavigationStore.getState().destination)
      .toMatchObject({ kind: 'settings', section: 'providers' });
    expect(useAccountReloginIntentStore.getState().pending).toMatchObject(CONTA_B);
  });

  it('pedido vencido deixa de valer para quem só o lê (a seleção do painel)', () => {
    useAccountReloginIntentStore.getState().request(CONTA_B, 1_000);
    const pending = useAccountReloginIntentStore.getState().pending;
    expect(freshAccountRelogin(pending, 1_000 + ACCOUNT_RELOGIN_INTENT_TTL_MS)).toMatchObject(CONTA_B);
    expect(freshAccountRelogin(pending, 1_000 + ACCOUNT_RELOGIN_INTENT_TTL_MS + 1)).toBeNull();
    expect(freshAccountRelogin(null, 1_000)).toBeNull();
  });
});
