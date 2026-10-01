import { describe, expect, it } from 'vitest';

import {
  projectMissionSnapshot,
  projectMissionSummarySnapshot,
  resolveMissionAgentLiveState,
  type ProjectMissionSnapshotView,
} from './mission-snapshot';
import { allowedActionsForState } from './mission-snapshot';

function runningView(): ProjectMissionSnapshotView {
  return {
    mission: {
      id: 'mission-1',
      title: 'Ship the mission engine',
      objective: 'Make mission execution safe and observable.',
      workspaceLabel: 'nexus-ide',
      status: 'running',
      version: 7,
      updatedAt: 1_777_000_000_000,
    },
    hasDispatchAuthority: true,
    hasCurrentKickoffReceipt: true,
    orchestratorLive: true,
    tasks: [
      {
        id: 'task-1',
        title: 'Implement projector',
        status: 'running',
        agentId: 'agent-1',
        dependsOn: [],
        evidence: [{ id: 'evidence-1', path: 'reports/projector.json' }],
      },
    ],
    handoffs: [],
    panes: [
      {
        paneId: 'pane-1',
        agentId: 'agent-1',
        state: 'working',
        currentUnitId: 'task-1',
      },
    ],
    roster: [
      {
        id: 'agent-1',
        agentName: 'Implementer',
        category: 'executor',
        cli: 'codex',
        ownsPlanDocs: true,
        allowedSkills: ['secret-skill'],
        allowedTools: ['secret-tool'],
        persona: 'secret-persona',
      },
    ],
  };
}

describe('worktrees na projeção', () => {
  it('leva a branch (sem refs/heads) e o estado do worktree até o resumo do rail', () => {
    const view: ProjectMissionSnapshotView = {
      ...runningView(),
      worktrees: [
        { branchRef: 'refs/heads/feat/mf-103-operacao-furos', worktreePath: '/w/mf-103', status: 'ready' },
        { branchRef: 'nexus/task-2', status: 'integrated' },
      ],
    };
    const summary = projectMissionSummarySnapshot(view);
    expect(summary.worktrees).toEqual([
      { branch: 'feat/mf-103-operacao-furos', path: '/w/mf-103', status: 'ready' },
      { branch: 'nexus/task-2', status: 'integrated' },
    ]);
    // Sem worktree o campo nem aparece — payload antigo continua idêntico.
    expect(projectMissionSummarySnapshot(runningView())).not.toHaveProperty('worktrees');
  });
});

describe('projectMissionSnapshot', () => {
  it('Via Rápida: running sem recibo cerimonial continua running', () => {
    // O tripé autoridade+recibo+liveness era do motor antigo e projetava
    // "Precisa de reparo" sobre equipes vivas. Sob a Via Rápida (padrão),
    // running é running; a vida real está nos panes e no observador.
    const view = runningView();
    view.hasCurrentKickoffReceipt = false;

    const snapshot = projectMissionSnapshot(view);

    expect(snapshot.state).toBe('running');
  });

  it('BUG corrigido: running sem runtime real NÃO projeta "Trabalhando"', () => {
    // BUG: após restart, se o restore falhou, o mission.status ficava 'running'
    // no banco mas o runtime não existia (orchestratorLive: false, todos panes
    // stopped). O rail mostrava "Trabalhando" mentindo ao operador.
    // CORREÇÃO: verificar liveness real antes de aceitar status 'running'.
    const view = runningView();
    view.mission.status = 'running'; // stale status no banco
    view.orchestratorLive = false; // orquestrador NÃO está vivo
    view.panes = [
      {
        paneId: 'pane-1',
        agentId: 'agent-1',
        state: 'stopped', // sessão não existe
        currentUnitId: undefined,
      },
    ];

    const snapshot = projectMissionSnapshot(view);

    // Deve projetar blocked_technical, NÃO running
    expect(snapshot.state).toBe('blocked_technical');
    expect(snapshot.stateReason?.code).toBe('restore-failed');
    expect(snapshot.stateReason?.label).toContain('runtime não foi restaurado');
  });

  it('running com orquestrador vivo E panes stopped continua running', () => {
    // Se o orquestrador está vivo mas workers estão stopped, ainda é running
    // porque há runtime ativo (o orquestrador).
    const view = runningView();
    view.orchestratorLive = true;
    view.panes = [
      {
        paneId: 'pane-1',
        agentId: 'agent-1',
        state: 'stopped',
        currentUnitId: undefined,
      },
    ];

    const snapshot = projectMissionSnapshot(view);

    expect(snapshot.state).toBe('running');
  });

  it('running com orquestrador morto mas workers queued continua running', () => {
    // Se há panes queued/working/waiting, há runtime ativo mesmo sem
    // orquestrador (workers podem estar esperando tarefas).
    const view = runningView();
    view.orchestratorLive = false;
    view.panes = [
      {
        paneId: 'pane-1',
        agentId: 'agent-1',
        state: 'queued', // worker na fila = runtime existe
        currentUnitId: undefined,
      },
    ];

    const snapshot = projectMissionSnapshot(view);

    expect(snapshot.state).toBe('blocked_technical');
    expect(snapshot.stateReason?.code).toBe('session-dead');
    expect(snapshot.stateReason?.label).toBe('Dormindo');
  });

  it('leftover-park sem Encerrar é Dormindo mesmo com openQuestion', () => {
    const view = runningView();
    view.mission.status = 'blocked';
    view.mission.updatedAt = Date.now();
    view.orchestratorLive = false;
    view.leftoverParked = true;
    view.panes = [];
    view.openQuestion = {
      id: 'question-stale',
      prompt: 'Qual canal de publicação?',
      options: [{ id: 'stable', label: 'Stable' }],
      allowFreeText: false,
    };

    const snapshot = projectMissionSnapshot(view);
    const summary = projectMissionSummarySnapshot(view);

    expect(snapshot.state).toBe('blocked_user');
    expect(snapshot.stateReason?.code).toBe('session-sleeping');
    expect(snapshot.stateReason?.label).toBe('Dormindo');
    expect(snapshot.stateReason?.code).not.toBe('open-question');
    expect(snapshot.stateReason?.code).not.toBe('runtime-closed');
    expect(snapshot.question).toBeUndefined();
    expect(summary.needsAttention).toBe(false);
  });

  it('selo leftover parked segue o persist: Dormindo, não Precisa de você', () => {
    const view = runningView();
    view.mission.status = 'blocked';
    view.mission.updatedAt = Date.now();
    view.orchestratorLive = false;
    view.leftoverParked = true;
    view.panes = [];

    const snapshot = projectMissionSnapshot(view);
    const summary = projectMissionSummarySnapshot(view);

    expect(snapshot.state).toBe('blocked_user');
    expect(snapshot.stateReason?.code).toBe('session-sleeping');
    expect(snapshot.stateReason?.label).toBe('Dormindo');
    expect(summary.needsAttention).toBe(false);
    expect(snapshot.allowedActions).toEqual(['resume']);
  });

  it('Encerrar + openQuestion continua Parou, não Precisa de você', () => {
    const view = runningView();
    view.mission.status = 'blocked';
    view.mission.updatedAt = Date.now();
    view.orchestratorLive = false;
    view.runtimeClosedByOperator = true;
    view.leftoverParked = true;
    view.panes = [];
    view.openQuestion = {
      id: 'question-stale',
      prompt: 'Qual canal de publicação?',
      options: [{ id: 'stable', label: 'Stable' }],
      allowFreeText: false,
    };

    const snapshot = projectMissionSnapshot(view);

    expect(snapshot.stateReason?.code).toBe('runtime-closed');
    expect(snapshot.stateReason?.label).toBe('Parou');
    expect(snapshot.stateReason?.code).not.toBe('session-dead');
    expect(snapshot.stateReason?.code).not.toBe('open-question');
    expect(snapshot.question).toBeUndefined();
  });

  it('Encerrar persistido pinta Parou, não session-dead', () => {
    const view = runningView();
    view.mission.status = 'blocked';
    view.mission.updatedAt = Date.now();
    view.orchestratorLive = false;
    view.runtimeClosedByOperator = true;
    view.leftoverParked = true;
    view.panes = [];

    const snapshot = projectMissionSnapshot(view);
    const summary = projectMissionSummarySnapshot(view);

    expect(snapshot.state).toBe('blocked_user');
    expect(snapshot.stateReason?.code).toBe('runtime-closed');
    expect(snapshot.stateReason?.label).toBe('Parou');
    expect(snapshot.stateReason?.code).not.toBe('session-dead');
    expect(summary.needsAttention).toBe(false);
  });

  it('done + leftover-parked leftover no texto continua Pronto — session-dead não mente', () => {
    const view = runningView();
    view.mission.status = 'done';
    view.mission.result = {
      outcome: 'success',
      summary: 'Pronto justified by files-modified/handoff (20/20).',
      evidenceIds: [],
      artifactRefs: ['server.js'],
    };
    view.leftoverParked = true;
    view.orchestratorLive = false;
    view.tasks[0]!.status = 'done';
    view.panes = [];

    const snapshot = projectMissionSnapshot(view);

    expect(snapshot.state).toBe('completed');
    expect(snapshot.stateReason).toBeUndefined();
  });

  it('leftover blocked de antes do boot segue o persist, não session-dead', () => {
    const view = runningView();
    view.mission.status = 'blocked';
    view.mission.updatedAt = 1;
    view.orchestratorLive = false;
    view.panes = [];

    const snapshot = projectMissionSnapshot(view);

    expect(snapshot.state).toBe('blocked_technical');
    expect(snapshot.stateReason?.code).toBe('mission-blocked');
    expect(snapshot.stateReason?.label).not.toBe('Parou');
  });

  it('chef-idle nomeia a causa e o reparo no stateReason (F-244)', () => {
    const view = runningView();
    view.mission.status = 'blocked';
    view.mission.updatedAt = 1;
    view.mission.intentState = 'blocked_technical';
    view.mission.description =
      'objetivo\n\n[NEXUS_CHEF_IDLE] Orquestrador ocioso aguardando 1 ' +
      'worker(s) por 60min sem progresso. Use Retomar no rail.\n';
    view.orchestratorLive = false;
    view.panes = [];

    const snapshot = projectMissionSnapshot(view);

    expect(snapshot.state).toBe('blocked_technical');
    expect(snapshot.stateReason?.code).toBe('mission-blocked');
    expect(snapshot.stateReason?.label).toBe(
      'O coordenador ficou ocioso esperando a equipe e o Nexus pausou a missão.',
    );
    expect(snapshot.stateReason?.detail).toContain('última tela');
    expect(snapshot.stateReason?.detail).toContain('ocioso aguardando 1 worker');
    expect(snapshot.stateReason?.detail?.length).toBeLessThanOrEqual(16_384);
  });

  it('bloqueio sem marcador admite que a causa não está registrada (F-244)', () => {
    const view = runningView();
    view.mission.status = 'blocked';
    view.mission.updatedAt = 1;
    view.mission.description = 'objetivo do operador\n';
    view.orchestratorLive = false;
    view.panes = [];

    const snapshot = projectMissionSnapshot(view);

    expect(snapshot.stateReason?.code).toBe('mission-blocked');
    expect(snapshot.stateReason?.label).toBe('Motivo não registrado.');
    expect(snapshot.stateReason?.detail).toContain('aba Atividade');
  });

  it('leftover pending de antes do boot não fica Pronta para iniciar', () => {
    const view = runningView();
    view.mission.status = 'pending';
    view.mission.updatedAt = 1;
    view.orchestratorLive = false;
    view.panes = [];

    const snapshot = projectMissionSnapshot(view);

    expect(snapshot.state).toBe('blocked_technical');
    expect(snapshot.stateReason?.code).toBe('session-dead');
    expect(snapshot.stateReason?.label).toBe('Dormindo');
    expect(snapshot.stateReason?.code).not.toBe('runtime-closed');
  });

  it('runtime-closed tem precedência sobre restore-failed', () => {
    // Se o operador encerrou explicitamente (runtimeClosedByOperator: true),
    // isso vence o restore-failed — é blocked_user com reason runtime-closed.
    const view = runningView();
    view.mission.status = 'running';
    view.orchestratorLive = false;
    view.runtimeClosedByOperator = true;
    view.panes = [
      {
        paneId: 'pane-1',
        agentId: 'agent-1',
        state: 'stopped',
        currentUnitId: undefined,
      },
    ];

    const snapshot = projectMissionSnapshot(view);

    expect(snapshot.state).toBe('blocked_user');
    expect(snapshot.stateReason?.code).toBe('runtime-closed');
  });

  it('running sem panes e sem orquestrador ainda é kickoff, não restore-failed', () => {
    const view = runningView();
    view.orchestratorLive = false;
    view.panes = [];

    const snapshot = projectMissionSnapshot(view);

    expect(snapshot.state).toBe('running');
  });

  it('projects done with residual plan work as blocked technical', () => {
    const view = runningView();
    view.mission.status = 'done';
    view.tasks[0]!.status = 'pending';
    view.panes[0]!.state = 'done';

    const snapshot = projectMissionSnapshot(view);

    expect(snapshot.state).toBe('blocked_technical');
    expect(snapshot.stateReason?.code).toBe('residual-work');
    expect(snapshot.allowedActions).toEqual(['resume', 'stop']);
  });

  it('gives an open clarification precedence over technical contradictions', () => {
    const view = runningView();
    view.hasCurrentKickoffReceipt = false;
    view.openQuestion = {
      id: 'question-1',
      prompt: 'Which release channel should we use?',
      options: [{ id: 'stable', label: 'Stable' }],
      allowFreeText: false,
    };

    const snapshot = projectMissionSnapshot(view);

    expect(snapshot.state).toBe('blocked_user');
    expect(snapshot.stateReason?.code).toBe('open-question');
    expect(snapshot.question).toEqual(view.openQuestion);
    expect(snapshot.allowedActions).toEqual(['answer-question', 'stop']);
    expect(projectMissionSummarySnapshot(view).needsAttention).toBe(true);
  });

  it('Pronto justified (done+result) vira completed mesmo com leftover writers', () => {
    const view = runningView();
    view.mission.status = 'done';
    view.mission.result = {
      outcome: 'success',
      summary: 'Pronto justified by files-modified/handoff (5/5).',
      evidenceIds: [],
      artifactRefs: ['server.js'],
    };
    view.tasks[0]!.status = 'done';
    view.panes = [
      { paneId: 'generalist', agentId: 'agent-1', state: 'working' },
      { paneId: 'ux', agentId: 'agent-1', state: 'working' },
    ];

    const snapshot = projectMissionSnapshot(view);

    expect(snapshot.state).toBe('completed');
  });

  it('projects a verified terminal plan as completed', () => {
    const view = runningView();
    view.mission.status = 'done';
    view.mission.result = {
      outcome: 'success',
      summary: 'Mission engine shipped and verified.',
      evidenceIds: ['evidence-1'],
      artifactRefs: ['commit-1'],
    };
    view.tasks[0]!.status = 'done';
    view.panes[0]!.state = 'done';
    view.handoffs = [
      {
        id: 'handoff-1',
        sourceAgentId: 'agent-1',
        targetAgentId: 'agent-2',
        kind: 'handoff',
        settled: true,
      },
    ];

    const snapshot = projectMissionSnapshot(view);

    expect(snapshot.state).toBe('completed');
    expect(snapshot.stateReason).toBeUndefined();
    expect(snapshot.progress).toEqual({ completed: 1, total: 1 });
    expect(snapshot.result).toEqual(view.mission.result);
    // Concluída oferece `resume`: a entrega ainda espera a revisão humana
    // e o operador pode não aprovar. É a decisão explícita que reabre a
    // coordenação para o ajuste ("Pedir um ajuste" no board).
    expect(snapshot.allowedActions).toEqual(['resume']);
  });

  it('marks every roster member done after verified completion closes their panes', () => {
    const view = runningView();
    view.mission.status = 'done';
    view.mission.result = {
      outcome: 'success',
      summary: 'Mission engine shipped and verified.',
      evidenceIds: ['evidence-1'],
      artifactRefs: ['commit-1'],
    };
    view.tasks[0]!.status = 'done';
    view.panes = [];
    view.roster = [
      {
        id: 'coordinator',
        agentName: 'Coordinator',
        category: 'orchestrator',
        cli: 'codex',
      },
      ...view.roster,
    ];

    const snapshot = projectMissionSnapshot(view);

    expect(snapshot.state).toBe('completed');
    expect(snapshot.agents.map((agent) => agent.state)).toEqual([
      'done',
      'done',
    ]);
  });

  it('keeps a canonical result completed despite stale residual projections', () => {
    const view = runningView();
    view.mission.status = 'done';
    view.mission.result = {
      outcome: 'success',
      summary: 'Canonical result already committed by MissionEngine.',
      evidenceIds: ['evidence-1'],
      artifactRefs: ['commit-1'],
    };
    view.tasks[0]!.status = 'pending';
    view.panes[0]!.state = 'working';
    view.handoffs = [
      {
        id: 'handoff-stale',
        sourceAgentId: 'agent-1',
        targetAgentId: 'agent-1',
        kind: 'handoff',
        settled: false,
      },
    ];

    const snapshot = projectMissionSnapshot(view);

    expect(snapshot.state).toBe('completed');
    expect(snapshot.stateReason).toBeUndefined();
    // Concluída oferece `resume`: a entrega ainda espera a revisão humana
    // e o operador pode não aprovar. É a decisão explícita que reabre a
    // coordenação para o ajuste ("Pedir um ajuste" no board).
    expect(snapshot.allowedActions).toEqual(['resume']);
    expect(snapshot.result).toEqual(view.mission.result);
    expect(snapshot.agents.map((agent) => agent.state)).toEqual(['done']);
  });

  it('emits only evidence ids and non-authority roster fields', () => {
    const snapshot = projectMissionSnapshot(runningView());

    expect(snapshot.units[0]?.evidenceIds).toEqual(['evidence-1']);
    expect(snapshot.agents[0]).toEqual({
      id: 'agent-1',
      agentName: 'Implementer',
      category: 'executor',
      cli: 'codex',
      state: 'working',
      currentUnitId: 'task-1',
      paneId: 'pane-1',
    });
    expect(JSON.stringify(snapshot)).not.toContain('reports/projector.json');
    expect(JSON.stringify(snapshot)).not.toContain('secret-');
  });

  it.each([
    '/Users/operator/private.txt',
    'C:\\private.txt',
    '../private.txt',
    'safe\u0000private.txt',
  ])(
    'rejects non-root-relative evidence path %s',
    (path) => {
      const view = runningView();
      view.tasks[0]!.evidence = [{ id: 'evidence-1', path }];

      expect(() => projectMissionSnapshot(view)).toThrow();
    },
  );
});

describe('resolveMissionAgentLiveState', () => {
  it('projects busy and spawning sessions as working', () => {
    expect(
      resolveMissionAgentLiveState({ sessionState: 'busy', taskState: 'queued' }),
    ).toBe('working');
    expect(
      resolveMissionAgentLiveState({
        sessionState: 'spawning',
        taskState: 'queued',
      }),
    ).toBe('working');
  });

  it('projects awaiting-input as waiting without inventing it from idle', () => {
    expect(
      resolveMissionAgentLiveState({
        semantic: 'awaiting-input',
        sessionState: 'idle',
        taskState: 'queued',
      }),
    ).toBe('waiting');
    expect(
      resolveMissionAgentLiveState({
        semantic: 'idle',
        sessionState: 'idle',
        taskState: 'queued',
      }),
    ).toBe('queued');
  });

  it('keeps sealed running tasks visible over quiet transport', () => {
    expect(
      resolveMissionAgentLiveState({
        semantic: 'idle',
        sessionState: 'idle',
        taskState: 'working',
      }),
    ).toBe('working');
    expect(
      resolveMissionAgentLiveState({
        semantic: 'completed',
        sessionState: 'idle',
        taskState: 'working',
      }),
    ).toBe('working');
  });

  it('pane sem sessão viva é fila, não interrupção (doutrina Overclock)', () => {
    // Turno encerrado / restart: sem processo físico a tarefa volta à fila
    // para o orquestrador (re-spawnado) re-disparar. "Interrompido" era o
    // rótulo que fazia o operador achar que a missão tinha quebrado sozinha.
    expect(
      resolveMissionAgentLiveState({
        sessionState: null,
        taskState: 'queued',
      }),
    ).toBe('queued');
    expect(
      resolveMissionAgentLiveState({
        sessionState: null,
        taskState: 'working',
      }),
    ).toBe('queued');
  });

  it('projects hook error as failed and completed idle as done', () => {
    expect(
      resolveMissionAgentLiveState({
        semantic: 'error',
        sessionState: 'idle',
        taskState: 'queued',
      }),
    ).toBe('failed');
    expect(
      resolveMissionAgentLiveState({
        semantic: 'completed',
        sessionState: 'idle',
        taskState: 'done',
      }),
    ).toBe('done');
  });
});

describe('projectMissionSnapshot live pane preference', () => {
  it('prefers live pane waiting over task fallback queued', () => {
    const view = runningView();
    view.tasks[0]!.status = 'pending';
    view.panes[0] = {
      paneId: 'pane-1',
      agentId: 'agent-1',
      state: 'waiting',
      currentUnitId: 'task-1',
    };

    const snapshot = projectMissionSnapshot(view);
    expect(snapshot.agents[0]).toMatchObject({
      id: 'agent-1',
      state: 'waiting',
      paneId: 'pane-1',
      currentUnitId: 'task-1',
    });
  });
});

describe('missão falhada não pode ter apagar como única saída', () => {
  it('failed oferece resume — a segunda chance', () => {
    // Antes: allowedActions vazio, então o board só mostrava "Remover".
    expect(allowedActionsForState('failed', undefined)).toEqual(['resume']);
  });

  it('estados de transição continuam sem ação', () => {
    for (const state of ['draft', 'starting', 'stopping'] as const) {
      expect(allowedActionsForState(state, undefined)).toEqual([]);
    }
  });
});

describe('awaiting-instruction — Maestro vivo esperando o próximo pedido (F-198)', () => {
  it('orquestrador ocioso e nenhum pane em trabalho: running com o motivo honesto', () => {
    const view: ProjectMissionSnapshotView = {
      ...runningView(),
      tasks: [],
      panes: [
        { paneId: 'pane-orch', agentId: 'orchestrator', state: 'queued' },
      ],
      roster: [],
      orchestratorIdle: true,
    };

    const snapshot = projectMissionSnapshot(view);

    expect(snapshot.state).toBe('running');
    expect(snapshot.stateReason).toEqual({
      code: 'awaiting-instruction',
      label: 'Aguardando sua instrução',
      detail:
        'O orquestrador está pronto e espera o próximo pedido. Escreva no terminal dele ou oriente a missão pelo Quadro.',
    });
    // Direct nunca fica indisponível por um Maestro parado no prompt.
    expect(snapshot.allowedActions).toEqual(['direct', 'stop']);
  });

  it.each(['working', 'waiting', 'blocked'] as const)(
    'pane %s suprime o motivo — a missão tem trabalho em curso',
    (state) => {
      const view: ProjectMissionSnapshotView = {
        ...runningView(),
        orchestratorIdle: true,
        panes: [
          { paneId: 'pane-orch', agentId: 'orchestrator', state: 'queued' },
          { paneId: 'pane-w1', agentId: 'agent-1', state },
        ],
      };

      const snapshot = projectMissionSnapshot(view);

      expect(snapshot.state).toBe('running');
      expect(snapshot.stateReason).toBeUndefined();
      expect(snapshot.allowedActions).toEqual(['direct', 'stop']);
    },
  );

  it('sem orchestratorIdle o running não ganha motivo (payload antigo idêntico)', () => {
    const view: ProjectMissionSnapshotView = {
      ...runningView(),
      tasks: [],
      panes: [
        { paneId: 'pane-orch', agentId: 'orchestrator', state: 'queued' },
      ],
      roster: [],
    };

    const snapshot = projectMissionSnapshot(view);

    expect(snapshot.state).toBe('running');
    expect(snapshot.stateReason).toBeUndefined();
  });
});
