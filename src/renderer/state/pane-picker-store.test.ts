import { beforeEach, describe, expect, it } from 'vitest';
import { usePanePickerStore } from './pane-picker-store';

describe('pane-picker-store — pedido pendente de abrir o menu', () => {
  beforeEach(() => {
    usePanePickerStore.setState({
      pendingOpen: false,
      pendingAccountsAdapterId: null,
    });
  });

  it('o pedido sem argumento continua sendo só "abra o menu"', () => {
    usePanePickerStore.getState().requestOpen();
    expect(usePanePickerStore.getState().pendingOpen).toBe(true);
    expect(usePanePickerStore.getState().pendingAccountsAdapterId).toBeNull();
  });

  it('o pedido carrega a CLI cuja vista de contas estava aberta', () => {
    usePanePickerStore.getState().requestOpen('codex');
    expect(usePanePickerStore.getState().pendingAccountsAdapterId).toBe('codex');
  });

  it('consumir zera os dois campos — o contexto vale uma vez só', () => {
    usePanePickerStore.getState().requestOpen('codex');
    usePanePickerStore.getState().consumePendingOpen();
    expect(usePanePickerStore.getState().pendingOpen).toBe(false);
    expect(usePanePickerStore.getState().pendingAccountsAdapterId).toBeNull();
  });

  it('um pedido novo sem CLI não ressuscita o contexto do anterior', () => {
    usePanePickerStore.getState().requestOpen('codex');
    usePanePickerStore.getState().consumePendingOpen();
    usePanePickerStore.getState().requestOpen();
    expect(usePanePickerStore.getState().pendingAccountsAdapterId).toBeNull();
  });
});
