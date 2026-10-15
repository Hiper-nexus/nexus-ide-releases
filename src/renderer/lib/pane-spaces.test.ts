import { describe, expect, it } from 'vitest';
import type { PaneModel } from '../../shared/types';
import {
  ALL_SCOPES_KEY,
  LOOSE_SCOPE_KEY,
  listPaneScopes,
  missionHomeScopeKeys,
  missionScopeKey,
  nextPaneSpaceTitle,
  newPaneSpaceId,
  paneScopeKey,
  paneScopeResolver,
  pickFallbackInScope,
  scopeKeyForPaneId,
  selectScopePanes,
  spaceScopeKey,
  withWorkingCounts,
  workingCountsByScope,
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

describe('pickFallbackInScope — fallback nunca cruza missão', () => {
  const panes = [
    pane({ id: 'a1', missionId: 'mA' }),
    pane({ id: 'a2', missionId: 'mA' }),
    pane({ id: 'b1', missionId: 'mB' }),
  ];

  it('escolhe candidato vivo do MESMO escopo do foco', () => {
    expect(pickFallbackInScope(['b1', 'a2', 'a1'], 'a1', panes, {})).toBe('a2');
    expect(pickFallbackInScope(['a1', 'b1'], 'a1', panes, {})).toBe('a1');
  });

  it('missão A sem candidato vivo devolve null — nunca cai na missão B', () => {
    expect(pickFallbackInScope(['b1'], 'a1', panes, {})).toBeNull();
  });

  it('layout solo (sem foco) aceita o primeiro candidato vivo', () => {
    expect(pickFallbackInScope(['b1', 'a1'], null, panes, {})).toBe('b1');
    expect(pickFallbackInScope([], 'a1', panes, {})).toBeNull();
  });

  it('foco que sumiu da árvore devolve null — não cai em outro campo', () => {
    expect(pickFallbackInScope(['b1', 'a1'], 'ghost-pane', panes, {})).toBeNull();
  });
});

describe('listPaneScopes — o código do motivo viaja com o estado', () => {
  it('aba de missão própria carrega o código do resumo', () => {
    const scopes = listPaneScopes({
      panes: [pane({ id: 'a1', missionId: 'mA' })],
      paneMissions: {},
      missions: [
        {
          id: 'mA',
          title: 'Missão A',
          state: 'running',
          stateReasonCode: 'awaiting-instruction',
        },
      ],
    });
    const scope = scopes.find((s) => s.id === 'mA');
    expect(scope?.state).toBe('running');
    expect(scope?.stateReasonCode).toBe('awaiting-instruction');
  });

  it('aba que hospeda a missão mostra o código da missão escolhida', () => {
    const scopes = listPaneScopes({
      panes: [
        pane({
          id: 'a1',
          missionId: 'mA',
          missionHost: true,
          spaceId: 'space-a',
          spaceTitle: 'Checkout',
        }),
        pane({ id: 'a2', spaceId: 'space-a', spaceTitle: 'Checkout' }),
      ],
      paneMissions: {},
      missions: [
        {
          id: 'mA',
          title: 'Missão A',
          state: 'running',
          stateReasonCode: 'awaiting-instruction',
        },
      ],
    });
    const scope = scopes.find((s) => s.key === 'space:space-a');
    expect(scope?.state).toBe('running');
    expect(scope?.stateReasonCode).toBe('awaiting-instruction');
    expect(scope?.missions[0]?.stateReasonCode).toBe('awaiting-instruction');
  });

  it('missão dormindo hospedada leva o código — a aba sabe que ela não segura', () => {
    const scopes = listPaneScopes({
      panes: [
        pane({
          id: 'a1',
          missionId: 'mA',
          missionHost: true,
          spaceId: 'space-a',
          spaceTitle: 'Checkout',
        }),
      ],
      paneMissions: {},
      missions: [
        {
          id: 'mA',
          title: 'Missão A',
          state: 'blocked_user',
          stateReasonCode: 'session-sleeping',
        },
      ],
    });
    const scope = scopes.find((s) => s.key === 'space:space-a');
    expect(scope?.missions[0]?.stateReasonCode).toBe('session-sleeping');
    expect(scope?.stateReasonCode).toBe('session-sleeping');
  });
});

describe('listPaneScopes — cada missão carrega o SEU orquestrador', () => {
  it('dois campos lado a lado, cada um com o orquestrador próprio', () => {
    const scopes = listPaneScopes({
      panes: [
        pane({ id: 'a-orq', missionId: 'mA', role: 'orchestrator', title: 'Orq A' }),
        pane({ id: 'a-w1', missionId: 'mA', role: 'worker' }),
        pane({ id: 'b-w1', missionId: 'mB', role: 'worker' }),
        pane({ id: 'b-orq', missionId: 'mB', role: 'orchestrator', title: 'Orq B' }),
      ],
      paneMissions: {},
      missions: [
        { id: 'mA', title: 'Missão A', state: 'running' },
        { id: 'mB', title: 'Missão B', state: 'running' },
      ],
    });
    const a = scopes.find((s) => s.id === 'mA');
    const b = scopes.find((s) => s.id === 'mB');
    expect(a?.orchestrator?.paneId).toBe('a-orq');
    expect(b?.orchestrator?.paneId).toBe('b-orq');
    expect(a?.orchestrator?.paneId).not.toBe(b?.orchestrator?.paneId);
  });

  it('campo sem orquestrador devolve null — nunca inventa o da vizinha', () => {
    const scopes = listPaneScopes({
      panes: [
        pane({ id: 'a-w1', missionId: 'mA', role: 'worker' }),
        pane({ id: 'b-orq', missionId: 'mB', role: 'orchestrator', title: 'Orq B' }),
      ],
      paneMissions: {},
      missions: [
        { id: 'mA', title: 'Missão A', state: 'running' },
        { id: 'mB', title: 'Missão B', state: 'running' },
      ],
    });
    expect(scopes.find((s) => s.id === 'mA')?.orchestrator).toBeNull();
    expect(scopes.find((s) => s.id === 'mB')?.orchestrator?.title).toBe('Orq B');
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

  it('desambigua títulos idênticos entre escopos com índices #1 e #2', () => {
    const scopes = listPaneScopes({
      panes: [
        pane({ id: 's1', spaceId: 'sp1', spaceTitle: 'Meus terminais' }),
        pane({ id: 's2', spaceId: 'sp2', spaceTitle: 'Meus terminais' }),
      ],
      paneMissions: {},
      missions,
    });
    expect(scopes.map((s) => s.title)).toEqual([
      'Meus terminais #1',
      'Meus terminais #2',
    ]);
  });
});

describe('workingCountsByScope / withWorkingCounts — o estado vivo da aba', () => {
  const panes = [
    pane({ id: 'a1', missionId: 'mA' }),
    pane({ id: 'a2', missionId: 'mA' }),
    pane({ id: 'b1', spaceId: 'sp1', spaceTitle: 'Blog' }),
    pane({ id: 'loose', kind: 'shell' }),
  ];
  const scopeOf = paneScopeResolver(panes, {});
  const missions = [{ id: 'mA', title: 'Missão A', state: 'running' }];

  it('conta quem trabalha em cada escopo e só devolve escopo com trabalho', () => {
    const counts = workingCountsByScope(panes, scopeOf, new Set(['a1', 'a2', 'loose']));
    expect([...counts]).toEqual([
      [missionScopeKey('mA'), 2],
      [LOOSE_SCOPE_KEY, 1],
    ]);
    expect(workingCountsByScope(panes, scopeOf, new Set()).size).toBe(0);
  });

  it('o agente da missão hospedada conta na aba que a hospeda', () => {
    const hosted = [
      pane({ id: 'host', spaceId: 'sp1', spaceTitle: 'Checkout', missionId: 'mA', missionHost: true }),
      pane({ id: 'worker', spaceId: 'sp1', spaceTitle: 'Checkout', missionId: 'mA' }),
    ];
    const counts = workingCountsByScope(
      hosted,
      paneScopeResolver(hosted, {}),
      new Set(['host', 'worker']),
    );
    expect([...counts]).toEqual([[spaceScopeKey('sp1'), 2]]);
  });

  it('acrescenta workingCount só nas abas com trabalho e não mexe nas demais', () => {
    const scopes = listPaneScopes({ panes, paneMissions: {}, missions });
    const counts = workingCountsByScope(panes, scopeOf, new Set(['a1', 'a2', 'loose']));
    const live = withWorkingCounts(scopes, counts);

    expect(live.map((s) => [s.key, s.workingCount])).toEqual([
      [missionScopeKey('mA'), 2],
      [spaceScopeKey('sp1'), undefined],
      [LOOSE_SCOPE_KEY, 1],
    ]);
    // A aba quieta é o MESMO objeto, e as originais não são alteradas.
    expect(live[1]).toBe(scopes[1]);
    expect(scopes.some((s) => 'workingCount' in s)).toBe(false);
  });

  it('ninguém trabalhando devolve o mesmo array — a barra não ganha identidade nova à toa', () => {
    const scopes = listPaneScopes({ panes, paneMissions: {}, missions });
    expect(withWorkingCounts(scopes, new Map())).toBe(scopes);
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

describe('coordenador local — missão começada direto pelos panes', () => {
  const panes = [
    pane({ id: 'orq', role: 'orchestrator', spaceId: 's1', spaceTitle: 'Meus terminais' }),
    pane({ id: 'w1' }),
    pane({ id: 'w2' }),
    pane({ id: 'other', spaceId: 's2', spaceTitle: 'Build da API' }),
    pane({ id: 'm1', missionId: 'mx' }),
  ];

  it('os soltos entram no campo do coordenador; espaço nomeado e missão ficam fora', () => {
    const scopes = listPaneScopes({ panes, paneMissions: {}, missions: [] });
    expect(scopes.map((s) => [s.title, s.paneCount])).toEqual([
      ['Meus terminais', 3],
      ['Build da API', 1],
      ['Missão', 1],
    ]);
    expect(scopes[0]?.orchestrator?.paneId).toBe('orq');
    expect(scopes.some((s) => s.key === LOOSE_SCOPE_KEY)).toBe(false);
    expect(
      selectScopePanes(panes, spaceScopeKey('s1'), {}).map((p) => p.id),
    ).toEqual(['orq', 'w1', 'w2']);
  });

  it('o nome do campo vem do espaço mesmo quando um solto vem primeiro', () => {
    const scopes = listPaneScopes({
      panes: [pane({ id: 'w1' }), ...panes.slice(0, 1)],
      paneMissions: {},
      missions: [],
    });
    expect(scopes[0]?.title).toBe('Meus terminais');
  });

  it('fallback de voz/anexo trata coordenador e soltos como o mesmo campo', () => {
    expect(pickFallbackInScope(['w2'], 'orq', panes, {})).toBe('w2');
    expect(pickFallbackInScope(['other'], 'orq', panes, {})).toBeNull();
  });

  it('orquestrador de missão não puxa os soltos', () => {
    const scopes = listPaneScopes({
      panes: [pane({ id: 'orq', role: 'orchestrator', missionId: 'mx' }), pane({ id: 'w1' })],
      paneMissions: {},
      missions: [],
    });
    expect(scopes.map((s) => s.key)).toEqual([missionScopeKey('mx'), LOOSE_SCOPE_KEY]);
  });

  it('sem coordenador os soltos continuam no próprio balde', () => {
    expect(paneScopeKey(pane({ id: 'w1' }), {})).toBe(LOOSE_SCOPE_KEY);
  });
});

describe('aba = feature — a missão mora na aba do pane que a começou (23/09)', () => {
  const running = [{ id: 'mx', title: 'Fechar o Epic 22', state: 'running' }];

  it('pane solto que adotou a missão leva ela, e os workers dela, para a aba Terminais', () => {
    // O agente do pane do operador criou a missão (nexus_mission_create): o
    // pane virou orquestrador e anfitrião; os workers que ele abriu nascem
    // com missionId. Antes: aba "Fechar o Epic 22" separada de "Painéis soltos".
    const panes = [
      pane({ id: 'shell', kind: 'shell' }),
      pane({ id: 'orq', role: 'orchestrator', missionId: 'mx', missionHost: true }),
      pane({ id: 'worker', role: 'worker', missionId: 'mx' }),
    ];
    const scopes = listPaneScopes({ panes, paneMissions: {}, missions: running });

    expect(scopes).toEqual([
      expect.objectContaining({
        key: LOOSE_SCOPE_KEY,
        title: 'Terminais',
        paneCount: 3,
        state: 'running',
        missions: [{ id: 'mx', title: 'Fechar o Epic 22', state: 'running' }],
        orchestrator: expect.objectContaining({ paneId: 'orq' }),
      }),
    ]);
    expect(
      selectScopePanes(panes, LOOSE_SCOPE_KEY, {}).map((entry) => entry.id),
    ).toEqual(['shell', 'orq', 'worker']);
  });

  it('anfitrião num espaço: a missão mora no espaço, com o nome dele', () => {
    const panes = [
      pane({
        id: 'orq',
        role: 'orchestrator',
        missionId: 'mx',
        missionHost: true,
        spaceId: 's1',
        spaceTitle: 'Checkout v2',
      }),
      pane({ id: 'worker', missionId: 'mx' }),
      pane({ id: 'solto' }),
    ];
    const scopes = listPaneScopes({ panes, paneMissions: {}, missions: running });

    expect(scopes.map((scope) => [scope.title, scope.paneCount])).toEqual([
      ['Checkout v2', 2],
      ['Terminais', 1],
    ]);
  });

  it('missão lançada pelo assistente (sem anfitrião) segue com aba própria', () => {
    const panes = [
      pane({ id: 'solto' }),
      pane({ id: 'maestro', role: 'orchestrator', missionId: 'mx', orchRequestId: 'orchspawn-1' }),
    ];
    const scopes = listPaneScopes({ panes, paneMissions: {}, missions: running });

    expect(scopes.map((scope) => scope.key)).toEqual([
      LOOSE_SCOPE_KEY,
      missionScopeKey('mx'),
    ]);
    expect(scopes[1]).toMatchObject({
      kind: 'mission',
      missions: [{ id: 'mx', title: 'Fechar o Epic 22', state: 'running' }],
    });
  });

  it('vínculo observado (paneMissions) também segue a casa do anfitrião', () => {
    const panes = [
      pane({ id: 'orq', role: 'orchestrator', missionHost: true, spaceId: 's1', spaceTitle: 'API' }),
      pane({ id: 'worker' }),
    ];
    const paneMissions = { orq: 'mx', worker: 'mx' };

    expect(scopeKeyForPaneId('worker', panes, paneMissions)).toBe(spaceScopeKey('s1'));
    // Ditado/anexo: o fallback enxerga orquestrador e worker no mesmo campo.
    expect(pickFallbackInScope(['worker'], 'orq', panes, paneMissions)).toBe('worker');
  });

  it('a casa é por missão: duas missões em abas diferentes nunca se misturam', () => {
    const panes = [
      pane({ id: 'orq-a', role: 'orchestrator', missionId: 'ma', missionHost: true, spaceId: 'sa', spaceTitle: 'A' }),
      pane({ id: 'orq-b', role: 'orchestrator', missionId: 'mb', missionHost: true, spaceId: 'sb', spaceTitle: 'B' }),
      pane({ id: 'wa', missionId: 'ma' }),
      pane({ id: 'wb', missionId: 'mb' }),
    ];
    const homes = missionHomeScopeKeys(panes, {});

    expect(homes.get('ma')).toBe(spaceScopeKey('sa'));
    expect(homes.get('mb')).toBe(spaceScopeKey('sb'));
    expect(selectScopePanes(panes, spaceScopeKey('sa'), {}).map((entry) => entry.id)).toEqual([
      'orq-a',
      'wa',
    ]);
  });
});

describe('F-231 — homeScopeKey: casa persistida do pane solto', () => {
  it('pane solto carimbado resolve para o escopo vivo da aba de missão', () => {
    const missionPane = pane({ id: 'm1p', missionId: 'mission-x' });
    const solto = pane({ id: 's1', homeScopeKey: missionScopeKey('mission-x') });
    const resolver = paneScopeResolver([missionPane, solto], {});
    expect(resolver(solto)).toBe(missionScopeKey('mission-x'));
  });

  it('escopo morto devolve o pane a "Terminais" — nunca aba fantasma', () => {
    const solto = pane({ id: 's1', homeScopeKey: 'mission:gone' });
    const resolver = paneScopeResolver([solto], {});
    expect(resolver(solto)).toBe(LOOSE_SCOPE_KEY);
  });

  it('o escopo da casa entra na lista de abas mesmo sem pane participante', () => {
    const missionPane = pane({ id: 'm1p', missionId: 'mission-x' });
    const solto = pane({ id: 's1', homeScopeKey: missionScopeKey('mission-x') });
    const scopes = listPaneScopes({
      panes: [missionPane, solto],
      paneMissions: {},
      missions: [{ id: 'mission-x', title: 'Missão X', state: 'running' }],
    });
    const missionScope = scopes.find((entry) => entry.key === missionScopeKey('mission-x'));
    expect(missionScope?.paneCount).toBe(2);
    expect(scopes.some((entry) => entry.key === LOOSE_SCOPE_KEY)).toBe(false);
  });
});
