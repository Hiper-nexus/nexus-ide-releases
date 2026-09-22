import { beforeEach, describe, expect, it } from 'vitest';
import { usePaneScopeStore } from './pane-scope-store';

const store = () => usePaneScopeStore.getState();

describe('pane-scope-store — pinos A/B', () => {
  beforeEach(() => {
    usePaneScopeStore.setState({ activeScopeKey: null, pinnedA: null, pinnedB: null });
  });

  it('fixa o primeiro campo como A e o segundo como B, focando cada um', () => {
    store().togglePinScope('mission:1');
    expect(store()).toMatchObject({ pinnedA: 'mission:1', pinnedB: null, activeScopeKey: 'mission:1' });
    store().togglePinScope('mission:2');
    expect(store()).toMatchObject({ pinnedA: 'mission:1', pinnedB: 'mission:2', activeScopeKey: 'mission:2' });
  });

  it('com A e B ocupados, o B antigo desliza para A e o novo vira B', () => {
    store().togglePinScope('mission:1');
    store().togglePinScope('mission:2');
    store().togglePinScope('mission:3');
    expect(store()).toMatchObject({ pinnedA: 'mission:2', pinnedB: 'mission:3', activeScopeKey: 'mission:3' });
  });

  it('clicar de novo no pino desafixa só aquele lado', () => {
    store().togglePinScope('mission:1');
    store().togglePinScope('mission:2');
    store().togglePinScope('mission:1');
    expect(store()).toMatchObject({ pinnedA: null, pinnedB: 'mission:2' });
    // O lado livre é reocupado primeiro.
    store().togglePinScope('mission:3');
    expect(store()).toMatchObject({ pinnedA: 'mission:3', pinnedB: 'mission:2' });
  });

  it('switchAB vai para o campo fixado e ignora lado vazio', () => {
    store().togglePinScope('mission:1');
    store().togglePinScope('mission:2');
    store().switchAB('a');
    expect(store().activeScopeKey).toBe('mission:1');
    store().switchAB('b');
    expect(store().activeScopeKey).toBe('mission:2');
    usePaneScopeStore.setState({ pinnedA: null });
    store().switchAB('a');
    expect(store().activeScopeKey).toBe('mission:2');
  });

  it('nunca muta o estado anterior (snapshots independentes)', () => {
    const before = store();
    store().togglePinScope('mission:1');
    expect(before.pinnedA).toBeNull();
    expect(store()).not.toBe(before);
  });
});
