/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mission } from '../../shared/orch-types';
import {
  PROMOTE_NEW_MISSION,
  resolvePanePromoteTarget,
} from './pane-mission-promote';

/**
 * resolvePanePromoteTarget é pura — os testes do fluxo COM diálogo ficam nos
 * testes de integração dos componentes; aqui travamos a DECISÃO (o coração do
 * F-527: nunca mais anexar silenciosamente à "missão padrão").
 */

function mission(id: string, status: Mission['status']): { id: string; title: string; status: string } {
  return { id, title: `Missão ${id}`, status };
}

describe('resolvePanePromoteTarget (F-527)', () => {
  it('vínculo direto do pane vence — promove sem perguntar', () => {
    const target = resolvePanePromoteTarget({
      paneMissionId: 'm1',
      destinationMissionId: 'm2',
      boundMissionId: 'm3',
      missions: [mission('m1', 'running'), mission('m2', 'running')],
    });
    expect(target).toEqual({ kind: 'mission', missionId: 'm1' });
  });

  it('destination da missão aberta é o vínculo quando o pane não tem', () => {
    const target = resolvePanePromoteTarget({
      destinationMissionId: 'm2',
      missions: [mission('m1', 'running'), mission('m2', 'running')],
    });
    expect(target).toEqual({ kind: 'mission', missionId: 'm2' });
  });

  it('pane solto com missões ativas → ESCOLHA explícita, nunca a primeira', () => {
    // Este era o bug: find(running|blocked) ?? missions[0] anexava à "padrão".
    const target = resolvePanePromoteTarget({
      missions: [mission('m1', 'running'), mission('m2', 'running')],
    });
    expect(target.kind).toBe('choose');
    if (target.kind === 'choose') {
      expect(target.missions.map((m) => m.id)).toEqual(['m1', 'm2']);
    }
  });

  it('missões encerradas não entram na escolha', () => {
    const target = resolvePanePromoteTarget({
      missions: [mission('m1', 'done'), mission('m2', 'failed'), mission('m3', 'blocked')],
    });
    expect(target.kind).toBe('choose');
    if (target.kind === 'choose') {
      expect(target.missions.map((m) => m.id)).toEqual(['m3']);
    }
  });

  it('sem nenhuma missão ativa → no-mission (abrir nova)', () => {
    const target = resolvePanePromoteTarget({
      missions: [mission('m1', 'done')],
    });
    expect(target).toEqual({ kind: 'no-mission' });
  });

  it('sentinela da opção nova missão não colide com ids reais', () => {
    expect(PROMOTE_NEW_MISSION).toBe('__new_mission__');
  });
});

describe('promotePaneWithMissionChoice (fluxo com diálogo)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('pane solto com 2 missões abre o diálogo e promove a ESCOLHIDA', async () => {
    const { promotePaneWithMissionChoice } = await import('./pane-mission-promote');
    const { useChoiceStore } = await import('../state/choice-store');
    const { useOrchStore } = await import('../state/orch-store');
    const { useLayoutStore } = await import('../state/layout-store');
    const promote = vi
      .spyOn(useLayoutStore.getState(), 'promoteMissionPaneRole')
      .mockImplementation(() => {});
    const bind = vi
      .spyOn(useOrchStore.getState(), 'bindPaneMission')
      .mockImplementation(() => {});
    useOrchStore.setState({
      missions: [mission('m1', 'running'), mission('m2', 'running')] as Mission[],
      paneMissions: {},
    });

    const pending = promotePaneWithMissionChoice({ paneId: 'pane-1' });
    // Responde o diálogo como o operador: escolhe a SEGUNDA missão.
    await Promise.resolve();
    const ask = useChoiceStore.getState().pending;
    expect(ask).not.toBeNull();
    expect(ask?.options.map((o) => o.value)).toEqual([
      'm1',
      'm2',
      PROMOTE_NEW_MISSION,
    ]);
    useChoiceStore.getState().decide('m2');
    const result = await pending;
    expect(result).toBe('m2');
    expect(promote).toHaveBeenCalledWith('m2', 'pane-1');
    expect(bind).toHaveBeenCalledWith('pane-1', 'm2');
    promote.mockRestore();
    bind.mockRestore();
  });

  it('opção "nova missão" abre o caminho expresso sem promover nada', async () => {
    const { promotePaneWithMissionChoice } = await import('./pane-mission-promote');
    const { useChoiceStore } = await import('../state/choice-store');
    const { useOrchStore } = await import('../state/orch-store');
    const { useLayoutStore } = await import('../state/layout-store');
    const { useProductNavigationStore } = await import(
      '../state/product-navigation-store'
    );
    const promote = vi
      .spyOn(useLayoutStore.getState(), 'promoteMissionPaneRole')
      .mockImplementation(() => {});
    const openNew = vi
      .spyOn(useProductNavigationStore.getState(), 'openNewMission')
      .mockImplementation(() => {});
    useOrchStore.setState({
      missions: [mission('m1', 'running')] as Mission[],
      paneMissions: {},
    });

    const pending = promotePaneWithMissionChoice({ paneId: 'pane-2' });
    await Promise.resolve();
    useChoiceStore.getState().decide(PROMOTE_NEW_MISSION);
    expect(await pending).toBeNull();
    expect(openNew).toHaveBeenCalledTimes(1);
    expect(promote).not.toHaveBeenCalled();
    promote.mockRestore();
    openNew.mockRestore();
  });
});
