/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneModel } from '../../shared/types';
import { buildGridTree, listPanes } from '../lib/split-tree';
import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';
import {
  applyLeadershipReflection,
  confirmedLeaderPaneId,
  reflectLeadershipActions,
  reflectLeadershipFromMissions,
  snapshotLeadershipPanes,
  type LeadershipMissionSnapshot,
} from './leadership-reflect';

const terminal = vi.hoisted(() => ({ sessions: new Map<string, string>() }));
vi.mock('../terminal/terminal-host', () => ({
  getPaneSessionId: (paneId: string) => terminal.sessions.get(paneId) ?? null,
}));

const M1: LeadershipMissionSnapshot = {
  id: 'mission-1',
  orchestratorSessionId: 's-leader',
};
const M2: LeadershipMissionSnapshot = {
  id: 'mission-2',
  orchestratorSessionId: 's-m2',
};

/**
 * Cenário base: a missão 1 tem DOIS panes com a estrela (o líder que o Main
 * confirmou e um impostor que se promoveu sozinho antes da religação), um
 * worker, a missão 2 com o líder dela, e um shell solto do operador.
 */
function pane(id: string, patch: Partial<PaneModel>): PaneModel {
  return { id, kind: 'cli-agent', title: id, ...patch };
}

function seedScene(): void {
  terminal.sessions.clear();
  const panes: PaneModel[] = [
    pane('m1-leader', { missionId: 'mission-1', role: 'orchestrator' }),
    pane('m1-impostor', { missionId: 'mission-1', role: 'orchestrator' }),
    pane('m1-worker', { missionId: 'mission-1', role: 'worker' }),
    pane('m2-orch', { missionId: 'mission-2', role: 'orchestrator' }),
    pane('loose-orch', { kind: 'shell', role: 'orchestrator' }),
    pane('loose-2', { kind: 'shell' }),
  ];
  terminal.sessions.set('m1-leader', 's-leader');
  terminal.sessions.set('m1-impostor', 's-impostor');
  terminal.sessions.set('m1-worker', 's-worker');
  terminal.sessions.set('m2-orch', 's-m2');
  terminal.sessions.set('loose-orch', 's-loose');
  terminal.sessions.set('loose-2', 's-loose-2');
  useOrchStore.setState({ paneMissions: {} });
  useLayoutStore.setState({ root: buildGridTree(panes) });
}

function roles(): Record<string, string | undefined> {
  return Object.fromEntries(
    listPanes(useLayoutStore.getState().root).map((p) => [p.id, p.role]),
  );
}

beforeEach(() => {
  seedScene();
});

describe('confirmedLeaderPaneId — só o par (missão, sessão do Main) confirma', () => {
  it('acha o pane que carrega a sessão durável da missão', () => {
    expect(confirmedLeaderPaneId(M1, snapshotLeadershipPanes())).toBe(
      'm1-leader',
    );
  });

  it('sem sessão durável não há líder confirmado', () => {
    const panes = snapshotLeadershipPanes();
    expect(confirmedLeaderPaneId({ id: 'mission-1' }, panes)).toBeNull();
    expect(
      confirmedLeaderPaneId({ id: 'mission-1', orchestratorSessionId: null }, panes),
    ).toBeNull();
  });

  it('sessão em pane de OUTRA missão não confirma liderança aqui', () => {
    const panes = snapshotLeadershipPanes();
    expect(
      confirmedLeaderPaneId({ id: 'mission-2', orchestratorSessionId: 's-leader' }, panes),
    ).toBeNull();
  });

  it('dois panes com a mesma sessão é ambiguidade do Main: fail-closed', () => {
    const panes = snapshotLeadershipPanes().map((p) =>
      p.paneId === 'm1-impostor' ? { ...p, sessionId: 's-leader' } : p,
    );
    expect(confirmedLeaderPaneId(M1, panes)).toBeNull();
  });
});

describe('reflectLeadershipActions — o renderer espelha, nunca elege', () => {
  it('rebaixa o impostor e preserva o líder confirmado', () => {
    expect(reflectLeadershipActions({ missions: [M1], panes: snapshotLeadershipPanes() }))
      .toEqual([
        { missionId: 'mission-1', paneId: 'm1-impostor', action: 'demote' },
      ]);
  });

  it('missão SEM líder confirmado não pinta estrela em ninguém', () => {
    expect(
      reflectLeadershipActions({
        missions: [{ id: 'mission-1' }],
        panes: snapshotLeadershipPanes(),
      }),
    ).toEqual([
      { missionId: 'mission-1', paneId: 'm1-leader', action: 'demote' },
      { missionId: 'mission-1', paneId: 'm1-impostor', action: 'demote' },
    ]);
  });

  it('promove quando o Main confirmou uma sessão que o layout ainda pinta como worker', () => {
    terminal.sessions.set('m1-worker', 's-leader');
    terminal.sessions.set('m1-leader', 's-outro');
    expect(
      reflectLeadershipActions({ missions: [M1], panes: snapshotLeadershipPanes() }),
    ).toEqual([
      { missionId: 'mission-1', paneId: 'm1-leader', action: 'demote' },
      { missionId: 'mission-1', paneId: 'm1-impostor', action: 'demote' },
      { missionId: 'mission-1', paneId: 'm1-worker', action: 'promote' },
    ]);
  });

  it('o Main à frente do renderer (sessão ainda não anexou) NÃO derruba a estrela viva', () => {
    terminal.sessions.delete('m1-leader');
    expect(
      reflectLeadershipActions({ missions: [M1], panes: snapshotLeadershipPanes() }),
    ).toEqual([]);
  });

  it('missões vizinhas não se contaminam', () => {
    const actions = reflectLeadershipActions({
      missions: [M1, M2],
      panes: snapshotLeadershipPanes(),
    });
    expect(actions.some((a) => a.missionId === 'mission-2')).toBe(false);
  });
});

describe('applyLeadershipReflection — replay do mesmo snapshot não muda nada', () => {
  it('aplica o espelho no layout e deixa o Main como única autoridade', () => {
    const applied = reflectLeadershipFromMissions([M1, M2]);

    expect(applied).toBe(1);
    expect(roles()).toMatchObject({
      'm1-leader': 'orchestrator',
      'm1-impostor': 'worker',
      'm1-worker': 'worker',
      'm2-orch': 'orchestrator',
      'loose-orch': 'orchestrator',
      'loose-2': undefined,
    });
  });

  it('reaplicar o MESMO snapshot não escreve (nem `set`, nem `persist`)', () => {
    reflectLeadershipFromMissions([M1, M2]);
    const root = useLayoutStore.getState().root;

    expect(reflectLeadershipFromMissions([M1, M2])).toBe(0);
    expect(useLayoutStore.getState().root).toBe(root);
  });

  it('sem líder confirmado o layout perde a estrela, e o replay segue inerte', () => {
    terminal.sessions.set('m1-leader', 's-orfa');

    expect(reflectLeadershipFromMissions([{ id: 'mission-1' }])).toBe(2);
    expect(roles()['m1-leader']).toBe('worker');
    expect(roles()['m1-impostor']).toBe('worker');

    const root = useLayoutStore.getState().root;
    expect(reflectLeadershipFromMissions([{ id: 'mission-1' }])).toBe(0);
    expect(useLayoutStore.getState().root).toBe(root);
  });

  it('missão sem pane nenhum no layout não é tocada', () => {
    expect(
      applyLeadershipReflection({
        missions: [{ id: 'mission-fantasma', orchestratorSessionId: 's-x' }],
        panes: snapshotLeadershipPanes(),
      }),
    ).toBe(0);
  });
});

describe('promoteMissionPaneRole — passa a ser o espelho de um líder já confirmado', () => {
  it('continua isolando missões vizinhas (F-527)', () => {
    useLayoutStore.getState().promoteMissionPaneRole('mission-1', 'm1-worker');

    expect(roles()).toMatchObject({
      'm1-worker': 'orchestrator',
      'm1-leader': 'worker',
      'm1-impostor': 'worker',
      'm2-orch': 'orchestrator',
      'loose-orch': 'orchestrator',
    });
  });

  it('é idempotente: promover de novo não gera escrita', () => {
    useLayoutStore.getState().promoteMissionPaneRole('mission-1', 'm1-worker');
    const root = useLayoutStore.getState().root;

    useLayoutStore.getState().promoteMissionPaneRole('mission-1', 'm1-worker');
    expect(useLayoutStore.getState().root).toBe(root);
  });
});

describe('setPaneRole — invariante visual, nunca eleição de missão', () => {
  it('não tira a estrela de quem o Main confirmou', () => {
    useLayoutStore.getState().setPaneRole('m1-leader', 'worker');
    expect(roles()['m1-leader']).toBe('orchestrator');
  });

  it('não tira a estrela de OUTRA missão (o demote global antigo)', () => {
    useLayoutStore.getState().setPaneRole('loose-2', 'orchestrator');
    expect(roles()['m2-orch']).toBe('orchestrator');
    expect(roles()['m1-leader']).toBe('orchestrator');
  });

  it('não promove pane já pertencente a uma missão', () => {
    useLayoutStore.getState().setPaneRole('m1-worker', 'orchestrator');
    expect(roles()['m1-worker']).toBe('worker');
  });

  it('mantém a coroa única entre os panes que o operador governa', () => {
    useLayoutStore.getState().setPaneRole('loose-2', 'orchestrator');
    expect(roles()['loose-orch']).toBe('worker');
    expect(roles()['loose-2']).toBe('orchestrator');
  });
});
