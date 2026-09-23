import { beforeEach, describe, expect, it } from 'vitest';
import { usePaneScopeStore } from './pane-scope-store';

const store = () => usePaneScopeStore.getState();

describe('pane-scope-store — aba ativa e aba ao lado', () => {
  beforeEach(() => {
    usePaneScopeStore.setState({ activeScopeKey: null, sideScopeKey: null });
  });

  it('abrir ao lado fixa a ativa à esquerda e a escolhida à direita', () => {
    store().showBeside('space:b', 'space:a');
    expect(store()).toMatchObject({ activeScopeKey: 'space:a', sideScopeKey: 'space:b' });
  });

  it('a aba ativa nunca abre ao lado dela mesma', () => {
    store().showBeside('space:a', 'space:a');
    expect(store().sideScopeKey).toBeNull();
  });

  it('pedir de novo a mesma aba ao lado fecha a divisão', () => {
    store().showBeside('space:b', 'space:a');
    store().showBeside('space:b', 'space:a');
    expect(store().sideScopeKey).toBeNull();
  });

  it('clicar na aba que está ao lado troca as duas de posição, sem fechar nenhuma', () => {
    store().showBeside('space:b', 'space:a');
    store().focusScope('space:b');
    expect(store()).toMatchObject({ activeScopeKey: 'space:b', sideScopeKey: 'space:a' });
  });

  it('clicar numa terceira aba mantém a divisão com a aba ao lado', () => {
    store().showBeside('space:b', 'space:a');
    store().focusScope('space:c');
    expect(store()).toMatchObject({ activeScopeKey: 'space:c', sideScopeKey: 'space:b' });
  });

  it('limpar o foco desfaz também a divisão', () => {
    store().showBeside('space:b', 'space:a');
    store().clearScopeFocus();
    expect(store()).toMatchObject({ activeScopeKey: null, sideScopeKey: null });
  });
});
