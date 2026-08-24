import { describe, expect, it } from 'vitest';
import type { Mission } from '../../shared/orch-types';
import {
  groupMissionsForRail,
  missionHasLiveRuntime,
  missionIsOperationallyActive,
  missionRailResumeCopy,
  railDotStatus,
  railStatusDisplay,
} from './mission-rail-groups';

function mission(
  partial: Partial<Mission> & Pick<Mission, 'id' | 'title' | 'status'>,
): Mission {
  return {
    description: '',
    milestones: [],
    createdAt: 1,
    ...partial,
    learnings: partial.learnings ?? '',
    updatedAt: partial.updatedAt ?? 1,
  };
}

const automaticRecoveryAuthority: Pick<
  Mission,
  'intentVersion' | 'intentContract'
> = {
  intentVersion: 1,
  intentContract: {
    goal: 'Recuperar missão',
    intentVersion: 1,
    approvedAt: 1,
  } as Mission['intentContract'],
};

describe('groupMissionsForRail', () => {
  const missions: Mission[] = [
    mission({ id: 'a', title: 'Alpha deploy', status: 'running', updatedAt: 30 }),
    mission({ id: 'b', title: 'Beta docs', status: 'pending', updatedAt: 20 }),
    mission({ id: 'c', title: 'Gamma done', status: 'done', updatedAt: 10 }),
    mission({ id: 'd', title: 'Delta fail', status: 'failed', updatedAt: 5 }),
    mission({ id: 'e', title: 'Pinned old', status: 'pending', updatedAt: 1 }),
  ];

  it('groups pinned, active, queue, and done', () => {
    const sections = groupMissionsForRail({
      missions,
      openMissionIds: new Set(['a']),
      pinnedIds: ['e'],
      query: '',
    });
    const map = Object.fromEntries(
      sections.map((s) => [s.id, s.missions.map((m) => m.id)]),
    );
    expect(map.pinned).toEqual(['e']);
    expect(map.active).toEqual(['a']);
    expect(map.queue).toEqual(['b']);
    expect(map.done).toEqual(['c', 'd']);
  });

  it('puts status=running in Em progresso even without live panes', () => {
    // Bug: terminal rodando mas bind pane↔missão ausente → caía em Na fila.
    const sections = groupMissionsForRail({
      missions,
      openMissionIds: new Set(),
      pinnedIds: [],
      query: '',
    });
    const map = Object.fromEntries(
      sections.map((s) => [s.id, s.missions.map((m) => m.id)]),
    );
    expect(map.active).toEqual(['a']);
    // pending sem panes = fila (b e e)
    expect(map.queue).toEqual(['b', 'e']);
  });

  it('mantém bloqueada COM runtime vivo em Em progresso', () => {
    const blocked = mission({
      id: 'blk',
      title: 'Precisa de ok',
      status: 'blocked',
      orchestratorSessionId: 'pty-live',
      updatedAt: 40,
    });
    const sections = groupMissionsForRail({
      missions: [...missions, blocked],
      openMissionIds: new Set(),
      pinnedIds: [],
      query: '',
    });
    const map = Object.fromEntries(
      sections.map((s) => [s.id, s.missions.map((m) => m.id)]),
    );
    expect(map.active).toContain('blk');
    expect(map.active).toContain('a');
    expect(map.stopped).toEqual([]);
  });

  it('joga bloqueada SEM runtime para Encerradas — encerrar esvazia o rail', () => {
    // Regressão real: encerrar a missão preserva a linha durável. Enquanto
    // "Em progresso" olhava só o status, o operador encerrava as 7 missões e
    // continuava vendo as 7 como se estivessem rodando.
    const closed = mission({
      id: 'blk',
      title: 'Encerrada pelo operador',
      status: 'blocked',
      intentState: 'blocked_user',
      updatedAt: 40,
    });
    const sections = groupMissionsForRail({
      missions: [...missions, closed],
      openMissionIds: new Set(),
      pinnedIds: [],
      query: '',
    });
    const map = Object.fromEntries(
      sections.map((s) => [s.id, s.missions.map((m) => m.id)]),
    );
    expect(map.stopped).toEqual(['blk']);
    expect(map.active).toEqual(['a']);
    expect(map.queue).not.toContain('blk');
    expect(map.done).not.toContain('blk');
  });

  it('treats an operator-closed mission as stopped while its retired session pointer is clearing', () => {
    const closing = mission({
      id: 'closing',
      title: 'Encerrando agora',
      status: 'blocked',
      intentState: 'blocked_user',
      orchestratorSessionId: 'pty-retiring',
      description:
        '<!-- nexus:runtime-closed -->\n[NEXUS_RUNTIME_CLOSED] Execução encerrada pelo operador.',
      updatedAt: 41,
    });
    const sections = groupMissionsForRail({
      missions: [...missions, closing],
      openMissionIds: new Set(),
      pinnedIds: [],
      query: '',
    });
    const map = Object.fromEntries(
      sections.map((s) => [s.id, s.missions.map((m) => m.id)]),
    );

    expect(map.stopped).toContain('closing');
    expect(map.active).not.toContain('closing');
  });

  it('keeps a technical retry in progress even while its replacement PTY is pending', () => {
    const recovering = mission({
      id: 'retry',
      title: 'Recovering provider boot',
      status: 'blocked',
      intentState: 'blocked_technical',
      ...automaticRecoveryAuthority,
      // Retry dono-deste-processo: updatedAt fresco é o que separa uma
      // recuperação viva de um leftover de boot anterior.
      updatedAt: Date.now(),
    });
    const sections = groupMissionsForRail({
      missions: [...missions, recovering],
      openMissionIds: new Set(),
      pinnedIds: [],
      query: '',
    });
    const map = Object.fromEntries(
      sections.map((section) => [
        section.id,
        section.missions.map((entry) => entry.id),
      ]),
    );

    expect(map.active).toContain('retry');
    expect(map.stopped).not.toContain('retry');
  });

  it('reabrir a missão devolve o card para Em progresso', () => {
    const reopened = mission({
      id: 'blk',
      title: 'Retomada',
      status: 'blocked',
      intentState: 'blocked_user',
      updatedAt: 40,
    });
    const sections = groupMissionsForRail({
      missions: [reopened],
      openMissionIds: new Set(['blk']),
      pinnedIds: [],
      query: '',
    });
    const map = Object.fromEntries(
      sections.map((s) => [s.id, s.missions.map((m) => m.id)]),
    );
    expect(map.active).toEqual(['blk']);
    expect(map.stopped).toEqual([]);
  });

  it('filters by query across title and status', () => {
    const sections = groupMissionsForRail({
      missions,
      openMissionIds: new Set(),
      pinnedIds: [],
      query: 'deploy',
    });
    const all = sections.flatMap((s) => s.missions.map((m) => m.id));
    expect(all).toEqual(['a']);
  });

  it('keeps a completed mission in Concluídas even when transcript panes remain', () => {
    const completed = mission({
      id: 'done-panes',
      title: 'Assas',
      status: 'done',
      intentState: 'done',
      orchestratorSessionId: 'pty-stale',
      updatedAt: 50,
    });
    const sections = groupMissionsForRail({
      missions: [completed],
      openMissionIds: new Set(['done-panes']),
      pinnedIds: [],
      query: '',
    });
    const map = Object.fromEntries(
      sections.map((s) => [s.id, s.missions.map((m) => m.id)]),
    );
    expect(map.done).toEqual(['done-panes']);
    expect(map.active).toEqual([]);
    expect(missionHasLiveRuntime(completed, true)).toBe(false);
  });

  it('leftover parked não é runtime vivo mesmo com panes no grid', () => {
    const parked = mission({
      id: 'parked',
      title: 'Dormindo',
      status: 'blocked',
      intentState: 'blocked_user',
      description: 'card na rail <!-- nexus:leftover-parked -->',
    });
    expect(missionHasLiveRuntime(parked, true)).toBe(false);
    const sections = groupMissionsForRail({
      missions: [parked],
      openMissionIds: new Set(['parked']),
      pinnedIds: [],
      query: '',
    });
    const map = Object.fromEntries(
      sections.map((s) => [s.id, s.missions.map((m) => m.id)]),
    );
    expect(map.active ?? []).not.toContain('parked');
  });

  it('keeps pinned out of other sections even if active', () => {
    const sections = groupMissionsForRail({
      missions,
      openMissionIds: new Set(['e']),
      pinnedIds: ['e'],
      query: '',
    });
    expect(
      sections.find((s) => s.id === 'pinned')?.missions.map((m) => m.id),
    ).toEqual(['e']);
    expect(sections.find((s) => s.id === 'active')?.missions.map((m) => m.id)).toEqual(
      ['a'],
    );
  });
});

describe('missionIsOperationallyActive', () => {
  it('counts Main-owned technical backoff without inventing a live PTY', () => {
    expect(
      missionIsOperationallyActive(
        mission({
          id: 'retry',
          title: 'Retry',
          status: 'blocked',
          intentState: 'blocked_technical',
          ...automaticRecoveryAuthority,
          updatedAt: Date.now(),
        }),
        false,
      ),
    ).toBe(true);
    expect(
      missionIsOperationallyActive(
        mission({
          id: 'human',
          title: 'Human wait',
          status: 'blocked',
          intentState: 'blocked_user',
        }),
        false,
      ),
    ).toBe(false);
  });

  it('does not promise recovery for a stale or terminal technical row', () => {
    expect(
      missionIsOperationallyActive(
        mission({
          id: 'stale',
          title: 'Stale',
          status: 'blocked',
          intentState: 'blocked_technical',
        }),
        false,
      ),
    ).toBe(false);
    expect(
      missionIsOperationallyActive(
        mission({
          id: 'terminal',
          title: 'Terminal',
          status: 'blocked',
          intentState: 'blocked_technical',
          ...automaticRecoveryAuthority,
          description: '[NEXUS_FAILURE:terminal] autoridade divergente',
        }),
        false,
      ),
    ).toBe(false);
  });
});

describe('railStatusDisplay', () => {
  it('marks live grid as Ao vivo', () => {
    expect(railStatusDisplay('pending', true)).toEqual({
      label: 'Ao vivo',
      tone: 'live',
    });
  });

  it('maps mission status to pill labels', () => {
    expect(railStatusDisplay('pending', false).label).toBe('Na fila');
    expect(railStatusDisplay('running', false).label).toBe('Em curso');
    expect(railStatusDisplay('blocked', false).label).toBe('Bloqueada');
    expect(railStatusDisplay('done', false).label).toBe('Concluída');
    expect(railStatusDisplay('failed', false).label).toBe('Falhou');
  });

  it('surfaces human-wait intent states instead of hiding them as Na fila', () => {
    expect(railStatusDisplay('pending', false, 'awaiting_goal').label).toBe(
      'Sem objetivo',
    );
    expect(railStatusDisplay('pending', false, 'intent_compiling').label).toBe(
      'Processando',
    );
    expect(railStatusDisplay('pending', false, 'ready_to_start').label).toBe(
      'Pronta',
    );
    expect(railStatusDisplay('pending', false, 'awaiting_approval')).toEqual({
      label: 'Aguarda você',
      tone: 'blocked',
    });
    expect(railStatusDisplay('blocked', false, 'blocked_user').label).toBe(
      'Aguarda você',
    );
  });

  it('leftover-parked isolado mostra Dormindo, nunca Precisa de você', () => {
    expect(
      railStatusDisplay('blocked', false, 'blocked_user', null, {
        leftoverParked: true,
      }),
    ).toEqual({ label: 'Dormindo', tone: 'blocked' });
    expect(
      railStatusDisplay('blocked', false, 'blocked_user', null, {
        leftoverParked: true,
      }).label,
    ).not.toMatch(/Precisa de você|Aguarda você|Parou/);
  });

  it('Encerrar persistido mostra Parou, leftover-park sem close não', () => {
    expect(
      railStatusDisplay('blocked', false, 'blocked_user', null, {
        leftoverParked: true,
        runtimeClosedByOperator: true,
      }),
    ).toEqual({ label: 'Parou', tone: 'blocked' });
    expect(
      railStatusDisplay('blocked', false, 'blocked_user', null, {
        leftoverParked: true,
      }),
    ).toEqual({ label: 'Dormindo', tone: 'blocked' });
  });

  // Voo real 05/08, mission-3be48989: o worker submeteu um handoff `blocked`,
  // o dispatch ficou terminal, os panes fecharam e a missão voltou para
  // awaiting_approval. O rail mostrava o MESMO "Aguarda você" de uma missão
  // que nunca rodou — o operador não tinha como saber que ela parou no meio.
  it('distingue uma missão que PAROU no meio de uma que nunca começou', () => {
    expect(
      railStatusDisplay('pending', false, 'awaiting_approval', null, {
        hasObservedRuntime: true,
        hasActiveRuntime: false,
        latestHandoffStatus: 'blocked',
      }),
    ).toEqual({ label: 'Parou — aguarda você', tone: 'blocked' });
  });

  it('mantém "Aguarda você" para a missão que nunca materializou runtime', () => {
    expect(
      railStatusDisplay('pending', false, 'awaiting_approval', null, {
        hasObservedRuntime: false,
      }),
    ).toEqual({ label: 'Aguarda você', tone: 'blocked' });
  });

  it('never lets preserved grid panes hide a human or machine block', () => {
    expect(
      railStatusDisplay('pending', true, 'awaiting_approval').label,
    ).toBe('Aguarda você');
    expect(railStatusDisplay('running', false, 'executing').label).toBe(
      'Em curso',
    );
    expect(
      railStatusDisplay('blocked', false, 'blocked_technical'),
    ).toEqual({
      label: 'Recuperando',
      tone: 'running',
    });
    expect(railStatusDisplay('blocked', true).label).toBe('Bloqueada');
  });

  it('labels exhausted technical recovery as a machine failure, not a human wait', () => {
    expect(
      railStatusDisplay(
        'blocked',
        false,
        'blocked_technical',
        null,
        { technicalRecovery: 'exhausted' },
      ),
    ).toEqual({
      label: 'Falha técnica',
      tone: 'failed',
    });
  });

  it('keeps terminal outcomes authoritative over stale intent state', () => {
    expect(railStatusDisplay('failed', false, 'ready_to_start').label).toBe(
      'Falhou',
    );
    expect(railStatusDisplay('done', false, 'awaiting_approval').label).toBe(
      'Concluída',
    );
    expect(railStatusDisplay('failed', true).label).toBe('Falhou');
    expect(railStatusDisplay('done', true).label).toBe('Concluída');
  });

  it('does not call a preserved transcript live after every agent exited', () => {
    expect(
      railStatusDisplay('running', true, 'executing', null, {
        hasActiveRuntime: false,
      }),
    ).toEqual({ label: 'Execução encerrada', tone: 'blocked' });
    expect(
      railStatusDisplay('running', true, 'executing', null, {
        hasActiveRuntime: false,
        latestHandoffStatus: 'blocked',
      }),
    ).toEqual({ label: 'Bloqueada', tone: 'blocked' });
    expect(
      railStatusDisplay('running', true, 'executing', null, {
        hasActiveRuntime: false,
        latestHandoffStatus: 'failed',
      }),
    ).toEqual({ label: 'Falhou', tone: 'failed' });
  });

  it('surfaces plan and consult lanes so promote/consult are glanceable', () => {
    expect(railStatusDisplay('running', false, 'dispatched', 'plan').label).toBe(
      'Em plano',
    );
    expect(railStatusDisplay('running', true, 'dispatched', 'plan').label).toBe(
      'Plano ao vivo',
    );
    expect(
      railStatusDisplay('running', false, 'dispatched', 'consult').label,
    ).toBe('Consulta');
    // Terminal still wins over lane.
    expect(railStatusDisplay('done', false, 'dispatched', 'plan').label).toBe(
      'Concluída',
    );
  });
});

describe('missionRailResumeCopy', () => {
  it('describes technical retry as automatic recovery, not a human block', () => {
    expect(
      missionRailResumeCopy(
        'blocked',
        false,
        'blocked_technical',
      ),
    ).toEqual({
      meta: 'Recuperação automática',
      title: 'O Nexus está preparando uma nova tentativa',
    });
    expect(
      missionRailResumeCopy('blocked', true, 'blocked_technical'),
    ).toEqual({
      meta: 'Recuperação automática',
      title: 'O Nexus está preparando uma nova tentativa',
    });
  });

  it('offers diagnosis and retry when technical recovery is exhausted', () => {
    expect(
      missionRailResumeCopy(
        'blocked',
        false,
        'blocked_technical',
        null,
        'exhausted',
      ),
    ).toEqual({
      meta: 'Falha técnica',
      title: 'Ver diagnóstico e tentar novamente',
    });
  });

  it('labels an off-grid running mission as recoverable instead of focusable', () => {
    expect(missionRailResumeCopy('running', false)).toEqual({
      meta: 'Retomar panes salvos',
      title: 'Panes salvos — clique para retomar',
    });
  });

  it('points plan-lane missions at the promote control', () => {
    expect(missionRailResumeCopy('running', false, 'dispatched', 'plan')).toEqual(
      {
        meta: '▶ Executar plano',
        title:
          'Lane plan (só plan.md) — clique ▶ para promover a código PREVC',
      },
    );
  });

  it('keeps a live mission focused on its existing grid panes', () => {
    expect(missionRailResumeCopy('running', true)).toEqual({
      meta: null,
      title: 'Missão aberta no grid — clique para focar',
    });
  });

  it('labels a blocked mission for retry', () => {
    expect(missionRailResumeCopy('blocked', false)).toEqual({
      meta: 'Clique para retomar',
      title: 'Missão bloqueada — clique para retomar',
    });
  });

  it('falls back to generic resume copy for completed missions', () => {
    expect(missionRailResumeCopy('done', false)).toEqual({
      meta: null,
      title: 'Retomar esta missão',
    });
  });

  // Perda-de-trabalho-por-UI (voo real 05/08, mission-3be48989): a missão
  // tinha plano selado de 8 tasks, worktree e commit, e o único caminho
  // oferecido era "Continuar plano" — que abre o wizard de objetivo, a tela de
  // uma missão que nunca foi planejada. O convite não pode ser esse.
  it('nunca convida ao wizard de objetivo uma missão que já materializou runtime', () => {
    const copy = missionRailResumeCopy(
      'pending',
      false,
      'awaiting_approval',
      null,
      'recovering',
      { hasObservedRuntime: true, latestHandoffStatus: 'blocked' },
    );
    expect(copy.meta).toBe('Ver por que parou');
    expect(copy.title).toContain('parou');
    // O plano e o trabalho já feito continuam no banco: dizer isso é o que
    // impede o operador de achar que precisa recomeçar do zero.
    expect(copy.title).toContain('preservado');
    expect(copy.meta).not.toBe('Continuar plano');
  });

  it('mantém o convite ao plano quando a missão nunca materializou runtime', () => {
    expect(
      missionRailResumeCopy('pending', false, 'awaiting_approval', null, 'recovering', {
        hasObservedRuntime: false,
      }),
    ).toEqual({
      meta: 'Continuar plano',
      title: 'Plano armado — clique para revisar e começar',
    });
  });

  it('labels intent-first shells to reopen the goal wizard', () => {
    expect(missionRailResumeCopy('pending', false, 'awaiting_goal')).toEqual({
      meta: 'Definir objetivo',
      title: 'Sem panes ainda — clique para descrever o objetivo',
    });
    expect(missionRailResumeCopy('pending', false, 'ready_to_start')).toEqual({
      meta: 'Continuar plano',
      title: 'Plano armado — clique para revisar e começar',
    });
  });
});

describe('railDotStatus', () => {
  it('keeps the activity dot running throughout technical recovery', () => {
    expect(railDotStatus('blocked', 'running', false)).toBe('running');
    expect(railDotStatus('blocked', 'running', true)).toBe('running');
  });

  it('preserves real human blocks and terminal outcomes', () => {
    expect(railDotStatus('blocked', 'blocked', false)).toBe('blocked');
    expect(railDotStatus('failed', 'failed', true)).toBe('failed');
    expect(railDotStatus('done', 'done', true)).toBe('done');
  });
});

describe('arquivamento tira da vista sem apagar nada', () => {
  const base = [
    mission({ id: 'live', title: 'Rodando', status: 'running', updatedAt: 9 }),
    mission({
      id: 'closed',
      title: 'Encerrada',
      status: 'blocked',
      intentState: 'blocked_user',
      updatedAt: 8,
    }),
  ];

  it('missão arquivada sai de todas as seções e cai em Arquivadas', () => {
    const sections = groupMissionsForRail({
      missions: base,
      openMissionIds: new Set(),
      pinnedIds: [],
      archivedIds: ['closed'],
      query: '',
    });
    const map = Object.fromEntries(
      sections.map((s) => [s.id, s.missions.map((m) => m.id)]),
    );
    expect(map.archived).toEqual(['closed']);
    expect(map.stopped).toEqual([]);
    expect(map.active).toEqual(['live']);
  });

  it('runtime vivo cancela o arquivamento na vista', () => {
    // Um agente que voltou a rodar não pode ficar invisível.
    const sections = groupMissionsForRail({
      missions: base,
      openMissionIds: new Set(),
      pinnedIds: [],
      archivedIds: ['live'],
      query: '',
    });
    const map = Object.fromEntries(
      sections.map((s) => [s.id, s.missions.map((m) => m.id)]),
    );
    expect(map.active).toEqual(['live']);
    expect(map.archived).toEqual([]);
  });

  it('arquivada fixada não volta pelo pin', () => {
    const sections = groupMissionsForRail({
      missions: base,
      openMissionIds: new Set(),
      pinnedIds: ['closed'],
      archivedIds: ['closed'],
      query: '',
    });
    const map = Object.fromEntries(
      sections.map((s) => [s.id, s.missions.map((m) => m.id)]),
    );
    expect(map.pinned).toEqual([]);
    expect(map.archived).toEqual(['closed']);
  });
});
