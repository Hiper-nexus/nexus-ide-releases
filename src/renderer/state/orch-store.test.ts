import { beforeEach, describe, expect, it } from 'vitest';
import { useOrchStore } from './orch-store';

/**
 * O bug do histórico de missões: bindings pane→missão eram append-only, então
 * panes mortos deixavam a missão antiga "aberta" para sempre (clique no-op,
 * sem "retomar"). O prune por panes vivos é a regressão que trava o conserto.
 */

describe('orch-store paneMissions', () => {
  beforeEach(() => {
    useOrchStore.setState({ paneMissions: {} });
  });

  it('bindPaneMission com missionId undefined não cria entrada', () => {
    useOrchStore.getState().bindPaneMission('pane-1', undefined);
    expect(useOrchStore.getState().paneMissions).toEqual({});
  });

  it('pruneMissionBindings derruba bindings de panes que saíram do layout', () => {
    const store = useOrchStore.getState();
    store.bindPaneMission('pane-a', 'mission-A');
    store.bindPaneMission('pane-b', 'mission-A');
    store.bindPaneMission('pane-c', 'mission-B');

    // Missão B substitui o grid: só o pane-c continua vivo.
    useOrchStore.getState().pruneMissionBindings(new Set(['pane-c']));

    expect(useOrchStore.getState().paneMissions).toEqual({
      'pane-c': 'mission-B',
    });
  });

  it('a missão deslocada deixa de contar como aberta (o bug reportado)', () => {
    const store = useOrchStore.getState();
    store.bindPaneMission('pane-a', 'mission-A');
    // grid substituído pela missão nova; pane-a morreu
    useOrchStore.getState().pruneMissionBindings(new Set(['pane-novo']));

    const openIds = new Set(
      Object.values(useOrchStore.getState().paneMissions),
    );
    expect(openIds.has('mission-A')).toBe(false); // agora o "retomar" aparece
  });

  it('sem mudança, o prune preserva o mesmo objeto de estado (sem re-render)', () => {
    useOrchStore.getState().bindPaneMission('pane-a', 'mission-A');
    const before = useOrchStore.getState().paneMissions;
    useOrchStore.getState().pruneMissionBindings(new Set(['pane-a']));
    expect(useOrchStore.getState().paneMissions).toBe(before);
  });
});
