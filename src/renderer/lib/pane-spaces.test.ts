import { describe, expect, it } from 'vitest';
import type { PaneModel } from '../../shared/types';
import {
  ALL_SCOPES_KEY,
  LOOSE_SCOPE_KEY,
  listPaneScopes,
  missionScopeKey,
  nextPaneSpaceTitle,
  newPaneSpaceId,
  paneScopeKey,
  selectScopePanes,
  spaceScopeKey,
} from './pane-spaces';

function pane(patch: Partial<PaneModel> & { id: string }): PaneModel {
  return {
    kind: 'cli-agent',
    title: patch.id,
    ...patch,
  } as PaneModel;
}

describe('paneScopeKey — quem é o dono do pane', () => {
  it('missão vence espaço quando os dois estão no pane', () => {
    const subject = pane({ id: 'p1', missionId: 'm1', spaceId: 's1' });
    expect(paneScopeKey(subject, {})).toBe(missionScopeKey('m1'));
  });

  it('usa o vínculo observado do orch-store quando o pane não carrega missão', () => {
    expect(paneScopeKey(pane({ id: 'p1' }), { p1: 'm9' })).toBe(
      missionScopeKey('m9'),
    );
  });

  it('cai no espaço quando não há missão nenhuma', () => {
    expect(paneScopeKey(pane({ id: 'p1', spaceId: 's1' }), {})).toBe(
      spaceScopeKey('s1'),
    );
  });

  it('pane sem missão e sem espaço fica no balde de soltos', () => {
    expect(paneScopeKey(pane({ id: 'p1' }), {})).toBe(LOOSE_SCOPE_KEY);
  });
});

describe('selectScopePanes — o mosaico de um escopo só', () => {
  const panes = [
    pane({ id: 'a1', missionId: 'mA' }),
    pane({ id: 'a2', missionId: 'mA' }),
    pane({ id: 'b1', spaceId: 'sB', spaceTitle: 'Meus terminais 2' }),
    pane({ id: 'loose', kind: 'shell' }),
  ];

  it('missão mostra só os panes dela', () => {
    expect(
      selectScopePanes(panes, missionScopeKey('mA'), {}).map((p) => p.id),
    ).toEqual(['a1', 'a2']);
  });

  it('o ESPAÇO novo não arrasta os panes da missão aberta', () => {
    expect(
      selectScopePanes(panes, spaceScopeKey('sB'), {}).map((p) => p.id),
    ).toEqual(['b1']);
  });

  it('soltos são um escopo próprio, não um apêndice de toda missão', () => {
    expect(selectScopePanes(panes, LOOSE_SCOPE_KEY, {}).map((p) => p.id)).toEqual(
      ['loose'],
    );
  });

  it('"Todos" devolve a árvore inteira', () => {
    expect(selectScopePanes(panes, ALL_SCOPES_KEY, {}).map((p) => p.id)).toEqual([
      'a1',
      'a2',
      'b1',
      'loose',
    ]);
  });

  it('escopo desconhecido não devolve o mosaico inteiro por engano', () => {
    expect(selectScopePanes(panes, missionScopeKey('sumiu'), {})).toEqual([]);
  });
});

describe('listPaneScopes — as abas que o operador vê', () => {
  const missions = [
    { id: 'mA', title: 'Missão A', state: 'running' },
    { id: 'mSetup', title: 'Missão nascendo', state: 'setup' },
    { id: 'mDone', title: 'Missão velha', state: 'done' },
  ];

  it('dá uma aba por missão com pane, inclusive a que ainda está em setup', () => {
    const scopes = listPaneScopes({
      panes: [
        pane({ id: 'a1', missionId: 'mA' }),
        pane({ id: 's1', missionId: 'mSetup' }),
      ],
      paneMissions: {},
      missions,
    });
    expect(scopes.map((s) => s.key)).toEqual([
      missionScopeKey('mA'),
      missionScopeKey('mSetup'),
    ]);
    expect(scopes.map((s) => s.title)).toEqual(['Missão A', 'Missão nascendo']);
  });

  it('espaço vira aba com o nome que o operador leu na criação', () => {
    const scopes = listPaneScopes({
      panes: [
        pane({ id: 'a1', missionId: 'mA' }),
        pane({ id: 'b1', spaceId: 'sB', spaceTitle: 'Meus terminais 2' }),
      ],
      paneMissions: {},
      missions,
    });
    expect(scopes.map((s) => s.key)).toEqual([
      missionScopeKey('mA'),
      spaceScopeKey('sB'),
    ]);
    expect(scopes[1]?.title).toBe('Meus terminais 2');
  });

  it('missão terminal continua com aba enquanto tiver pane — nada some da tela sozinho', () => {
    const scopes = listPaneScopes({
      panes: [pane({ id: 'd1', missionId: 'mDone' })],
      paneMissions: {},
      missions,
    });
    expect(scopes.map((s) => s.key)).toEqual([missionScopeKey('mDone')]);
  });

  it('missão sem pane nenhum não vira aba vazia', () => {
    const scopes = listPaneScopes({
      panes: [pane({ id: 'b1', spaceId: 'sB', spaceTitle: 'Meus terminais' })],
      paneMissions: {},
      missions,
    });
    expect(scopes.map((s) => s.key)).toEqual([spaceScopeKey('sB')]);
  });

  it('conta os panes de cada aba', () => {
    const scopes = listPaneScopes({
      panes: [
        pane({ id: 'a1', missionId: 'mA' }),
        pane({ id: 'a2', missionId: 'mA' }),
        pane({ id: 'loose', kind: 'shell' }),
      ],
      paneMissions: {},
      missions,
    });
    expect(scopes.map((s) => [s.key, s.paneCount])).toEqual([
      [missionScopeKey('mA'), 2],
      [LOOSE_SCOPE_KEY, 1],
    ]);
  });

  it('pane de missão que o renderer ainda não conhece não some — vira aba com rótulo neutro', () => {
    const scopes = listPaneScopes({
      panes: [pane({ id: 'x1', missionId: 'desconhecida' })],
      paneMissions: {},
      missions,
    });
    expect(scopes.map((s) => s.key)).toEqual([missionScopeKey('desconhecida')]);
    expect(scopes[0]?.title).toBe('Missão');
  });
});

describe('nomes de espaço', () => {
  it('o primeiro espaço do workspace é "Meus terminais"', () => {
    expect(nextPaneSpaceTitle([])).toBe('Meus terminais');
  });

  it('o próximo numera a partir do que já existe, sem repetir nome', () => {
    const panes = [
      pane({ id: 'b1', spaceId: 's1', spaceTitle: 'Meus terminais' }),
      pane({ id: 'b2', spaceId: 's2', spaceTitle: 'Meus terminais 2' }),
    ];
    expect(nextPaneSpaceTitle(panes)).toBe('Meus terminais 3');
  });

  it('ignora rótulo que o operador renomeou na hora de numerar', () => {
    const panes = [pane({ id: 'b1', spaceId: 's1', spaceTitle: 'Build da API' })];
    expect(nextPaneSpaceTitle(panes)).toBe('Meus terminais 2');
  });

  it('cada espaço nasce com id próprio', () => {
    expect(newPaneSpaceId()).not.toBe(newPaneSpaceId());
  });
});
