import { describe, expect, it } from 'vitest';
import type { PaneModel, PaneSessionState } from '../../shared/types';
import {
  ROSTER_NO_SESSION_LABEL,
  agentCountLabel,
  describeRosterAgent,
  emptyRosterFleet,
  groupRosterFleets,
  idleFleetLabel,
  readableAgentTask,
  resolveRosterState,
  workingNowLabel,
  workingPaneIdsOf,
  workingSignature,
  type RosterContext,
} from './agent-roster';

function agentPane(patch: Partial<PaneModel> & { id: string }): PaneModel {
  return { kind: 'cli-agent', title: '', adapterId: 'claude', ...patch };
}

function context(
  states: Record<string, PaneSessionState> = {},
  extra: Partial<RosterContext> = {},
): RosterContext {
  return { states: new Map(Object.entries(states)), ...extra };
}

describe('resolveRosterState', () => {
  it('traduz o estado da sessão em palavra e tipo', () => {
    expect(resolveRosterState('busy', false)).toEqual({ kind: 'working', label: 'Trabalhando' });
    expect(resolveRosterState('spawning', false)).toEqual({ kind: 'starting', label: 'Iniciando' });
    expect(resolveRosterState('idle', false)).toEqual({ kind: 'waiting', label: 'Aguardando' });
    expect(resolveRosterState('hibernated', false)).toEqual({ kind: 'sleeping', label: 'Dormindo' });
    expect(resolveRosterState('exited', false)).toEqual({ kind: 'stopped', label: 'Encerrado' });
  });

  it('pane sem leitura de estado não finge estar aguardando nem diz que morreu', () => {
    // O host ainda não publicou "spawning": neutro, e fora da conta de trabalho.
    expect(resolveRosterState(undefined, false)).toEqual({
      kind: 'unknown',
      label: ROSTER_NO_SESSION_LABEL,
    });
  });

  it('agente ACP sem estado de sessão não é dado como encerrado nem como trabalhando', () => {
    expect(resolveRosterState(undefined, false, true)).toEqual({
      kind: 'unknown',
      label: 'Estado desconhecido',
    });
    // Com estado, vale o estado; o ACP só muda o que fazer na falta dele.
    expect(resolveRosterState('busy', false, true).kind).toBe('working');
    const acp = agentPane({ id: 'acp', agentTransport: 'acp' });
    expect(describeRosterAgent(acp, context()).kind).toBe('unknown');
    expect(workingPaneIdsOf([acp], { states: new Map() }).size).toBe(0);
  });

  it('estacionado pelo guardian vence o exited local e nunca conta como trabalho', () => {
    expect(resolveRosterState('exited', true).kind).toBe('sleeping');
    expect(resolveRosterState('busy', true).kind).toBe('sleeping');
  });
});

describe('readableAgentTask', () => {
  it('tira a família que a toolbar acrescenta e mantém a tarefa', () => {
    expect(
      readableAgentTask(agentPane({ id: 'p', title: 'Claude · Bug visual Windows' })),
    ).toBe('Bug visual Windows');
  });

  it('não mostra a pasta da worktree que o Codex escreve no título', () => {
    expect(
      readableAgentTask(
        agentPane({ id: 'p', adapterId: 'codex', title: 'GPT · t-7bcf00cf9aa6faa9c4b738fc' }),
      ),
    ).toBeNull();
  });

  it('não mostra o nome da pasta onde a CLI roda, nem caminho, nem id de pane', () => {
    // Palavra solta sem separador só é pasta porque bate com o cwd do pane.
    const cwd = 'C:\\Users\\ana\\dev\\atlas';
    expect(readableAgentTask(agentPane({ id: 'p', cwd, title: 'Claude · Atlas' }))).toBeNull();
    expect(readableAgentTask(agentPane({ id: 'p', title: 'Claude · Atlas' }))).toBe('Atlas');
    expect(
      readableAgentTask(agentPane({ id: 'p', adapterId: 'codex', title: 'GPT · nexus-ide' })),
    ).toBeNull();
    expect(readableAgentTask(agentPane({ id: 'p', title: 'nexus-ide' }))).toBeNull();
    expect(readableAgentTask(agentPane({ id: 'p', title: '~/dev/app' }))).toBeNull();
    expect(readableAgentTask(agentPane({ id: 'p', title: 'C:\\Users\\ana' }))).toBeNull();
    expect(readableAgentTask(agentPane({ id: 'p', title: 'pane-mv8pulmq-v' }))).toBeNull();
    expect(readableAgentTask(agentPane({ id: 'p', title: 'a3f9c2b1d4e5' }))).toBeNull();
  });

  it('título genérico da ferramenta ou do próprio agente não é tarefa', () => {
    expect(readableAgentTask(agentPane({ id: 'p', title: 'claude' }))).toBeNull();
    expect(readableAgentTask(agentPane({ id: 'p', title: 'Claude · Claude Code' }))).toBeNull();
    expect(readableAgentTask(agentPane({ id: 'p', title: '' }))).toBeNull();
    expect(readableAgentTask(agentPane({ id: 'p', title: 'Pane 7' }))).toBeNull();
    expect(
      readableAgentTask(agentPane({ id: 'p', agentName: 'Frontend', title: 'Claude · Frontend' })),
    ).toBeNull();
  });

  it('aceita frase mesmo com dois-pontos, barra ou hífen no meio', () => {
    expect(readableAgentTask(agentPane({ id: 'p', title: 'fix: tratar login nulo' }))).toBe(
      'fix: tratar login nulo',
    );
    expect(readableAgentTask(agentPane({ id: 'p', title: 'Revisar src/main e pty-manager' }))).toBe(
      'Revisar src/main e pty-manager',
    );
    expect(readableAgentTask(agentPane({ id: 'p', title: 'Refatorar' }))).toBe('Refatorar');
  });

  it('o nome que o operador deu ao pane vale, mesmo parecendo um id', () => {
    // Duplo clique no título fixa o nome (`titlePinned`): é escolha humana.
    const pinned = agentPane({ id: 'p', title: 'api-server', titlePinned: true });
    expect(readableAgentTask(pinned)).toBe('api-server');
    // O mesmo texto vindo do terminal continua sendo tratado como pasta/id.
    expect(readableAgentTask({ ...pinned, titlePinned: undefined })).toBeNull();
    // Nome fixado que repete a ferramenta continua não dizendo nada.
    expect(readableAgentTask({ ...pinned, title: 'Claude', titlePinned: true })).toBeNull();
  });

  it('o prefixo da família só sai quando vem com o separador, e metacaractere não quebra', () => {
    // "GPT-5.6 review" não é "Família · texto": fica inteiro.
    expect(
      readableAgentTask(agentPane({ id: 'p', adapterId: 'codex', title: 'GPT-5.6 review' })),
    ).toBe('GPT-5.6 review');
    expect(
      readableAgentTask(agentPane({ id: 'p', adapterId: 'codex', title: 'GPT  ·  Revisar o diff' })),
    ).toBe('Revisar o diff');
    // Texto cheio de metacaracteres de regex passa sem erro.
    expect(
      readableAgentTask(agentPane({ id: 'p', title: 'Claude · Corrigir (a+b)* [x] ^ $ \\ ?' })),
    ).toBe('Corrigir (a+b)* [x] ^ $ \\ ?');
  });

  it('remove o glifo de spinner, controles e sobreposição bidi vindos do terminal', () => {
    expect(readableAgentTask(agentPane({ id: 'p', title: '✳ Corrigir login' }))).toBe('Corrigir login');
    expect(
      readableAgentTask(agentPane({ id: 'p', title: 'Corrigir\u202Elogin\u0007  agora' })),
    ).toBe('Corrigir login agora');
  });

  it('corta a tarefa longa demais com reticências', () => {
    const task = readableAgentTask(agentPane({ id: 'p', title: `Corrigir ${'x'.repeat(300)} agora` }));
    expect(task).not.toBeNull();
    expect(task!.length).toBeLessThanOrEqual(140);
    expect(task!.endsWith('…')).toBe(true);
  });
});

describe('describeRosterAgent', () => {
  it('nome do agente do squad, CLI com modelo e tarefa legível', () => {
    const agent = describeRosterAgent(
      agentPane({
        id: 'p1',
        agentName: 'Frontend',
        model: 'claude-sonnet-4-5',
        effort: 'high',
        paneNumber: 7,
        title: 'Claude · Corrigir histórico omitido',
      }),
      context({ p1: 'busy' }),
    );
    expect(agent).toMatchObject({
      paneId: 'p1',
      kind: 'working',
      working: true,
      stateLabel: 'Trabalhando',
      name: 'Frontend',
      cli: 'Claude Sonnet 4.5',
      cliDetail: 'Claude Sonnet 4.5 · High',
      task: 'Corrigir histórico omitido',
      orchestrator: false,
      paneNumber: 7,
    });
  });

  it('sem nome de squad: Orquestrador, depois "Pane N", depois "Agente"', () => {
    const state = context();
    expect(describeRosterAgent(agentPane({ id: 'a', role: 'orchestrator' }), state).name).toBe(
      'Orquestrador',
    );
    expect(describeRosterAgent(agentPane({ id: 'b', paneNumber: 12 }), state).name).toBe('Pane 12');
    expect(describeRosterAgent(agentPane({ id: 'c' }), state).name).toBe('Agente');
    expect(describeRosterAgent(agentPane({ id: 'a', role: 'orchestrator' }), state).orchestrator).toBe(
      true,
    );
  });

  it('apelido de modelo ganha inicial maiúscula', () => {
    expect(describeRosterAgent(agentPane({ id: 'p', model: 'sonnet' }), context()).cli).toBe(
      'Claude Sonnet',
    );
    expect(describeRosterAgent(agentPane({ id: 'p' }), context()).cli).toBe('Claude');
  });

  it('família desconhecida usa o rótulo do adapter ou o id, com o modelo cru', () => {
    const unknown = agentPane({ id: 'p', adapterId: 'minha-cli' });
    expect(describeRosterAgent(unknown, context()).cli).toBe('minha-cli');
    expect(
      describeRosterAgent(unknown, context({}, { adapterLabel: () => 'Minha CLI' })).cli,
    ).toBe('Minha CLI');
    expect(
      describeRosterAgent({ ...unknown, model: 'm-1' }, context()).cli,
    ).toBe('minha-cli · m-1');
  });

  it('usa o estado de apresentação e o veredito de estacionado', () => {
    const parked = { has: (paneId: string) => paneId === 'p2' };
    const state = context({ p1: 'idle', p2: 'exited' }, { parked });
    expect(describeRosterAgent(agentPane({ id: 'p1' }), state).kind).toBe('waiting');
    expect(describeRosterAgent(agentPane({ id: 'p2' }), state).kind).toBe('sleeping');
    expect(describeRosterAgent(agentPane({ id: 'p3' }), state).stateLabel).toBe(ROSTER_NO_SESSION_LABEL);
  });
});

describe('groupRosterFleets', () => {
  const panes: PaneModel[] = [
    agentPane({ id: 'w1', title: 'Claude · Tarefa A', missionId: 'm1' }),
    agentPane({ id: 'orq', role: 'orchestrator', adapterId: 'codex', missionId: 'm1' }),
    agentPane({ id: 'w2', adapterId: 'grok', title: 'Grok · Tarefa B' }),
    agentPane({ id: 'w3', adapterId: 'kimi' }),
    { id: 'sh', kind: 'shell', title: 'zsh' },
    { id: 'br', kind: 'browser', title: 'browser' },
  ];

  it('separa por missão, terminais soltos e total; shell e browser não são agentes', () => {
    const fleets = groupRosterFleets(
      panes,
      { w3: 'm2' },
      context({ w1: 'busy', orq: 'busy', w2: 'busy', w3: 'idle' }),
    );
    expect(fleets.all.agents.map((a) => a.paneId)).toEqual(['orq', 'w1', 'w2', 'w3']);
    expect(fleets.all.workingCount).toBe(3);
    expect(fleets.loose.agents.map((a) => a.paneId)).toEqual(['w2']);
    expect([...fleets.byMission.keys()].sort()).toEqual(['m1', 'm2']);
    expect(fleets.byMission.get('m1')?.agents.map((a) => a.paneId)).toEqual(['orq', 'w1']);
    expect(fleets.byMission.get('m2')?.agents.map((a) => a.paneId)).toEqual(['w3']);
  });

  it('orquestrador primeiro e a ordem não muda quando o estado muda', () => {
    const order = (states: Record<string, PaneSessionState>) =>
      groupRosterFleets(panes, {}, context(states)).byMission.get('m1')!.agents.map((a) => a.paneId);
    expect(order({})).toEqual(['orq', 'w1']);
    expect(order({ w1: 'busy' })).toEqual(['orq', 'w1']);
    expect(order({ orq: 'busy', w1: 'idle' })).toEqual(['orq', 'w1']);
  });

  it('conta quem trabalha e marca paralelo só a partir de dois', () => {
    const fleet = (states: Record<string, PaneSessionState>) =>
      groupRosterFleets(panes, {}, context(states)).byMission.get('m1')!;
    expect(fleet({ w1: 'busy', orq: 'idle' })).toMatchObject({ workingCount: 1, parallel: false });
    expect(fleet({ w1: 'busy', orq: 'busy' })).toMatchObject({ workingCount: 2, parallel: true });
    expect(fleet({ w1: 'idle', orq: 'exited' })).toMatchObject({ workingCount: 0, parallel: false });
  });

  it('iniciando e dormindo não contam como trabalhando', () => {
    const fleets = groupRosterFleets(
      panes,
      {},
      context({ w1: 'spawning', orq: 'hibernated', w2: 'exited' }),
    );
    expect(fleets.all.workingCount).toBe(0);
  });

  it('sem agentes devolve a frota vazia compartilhada', () => {
    const fleets = groupRosterFleets([{ id: 'sh', kind: 'shell', title: 'zsh' }], {}, context());
    expect(fleets.all).toBe(emptyRosterFleet());
    expect(fleets.loose.agents).toHaveLength(0);
    expect(fleets.byMission.size).toBe(0);
  });
});

describe('rótulos da frota', () => {
  it('"N trabalhando agora" e contagem de agentes em português', () => {
    expect(workingNowLabel(1)).toBe('1 trabalhando agora');
    expect(workingNowLabel(3)).toBe('3 trabalhando agora');
    expect(agentCountLabel(1)).toBe('1 agente');
    expect(agentCountLabel(4)).toBe('4 agentes');
  });

  it('frota quieta diz por que está quieta', () => {
    const fleetOf = (...states: PaneSessionState[]) =>
      groupRosterFleets(
        states.map((_, index) => agentPane({ id: `p${index}` })),
        {},
        context(Object.fromEntries(states.map((state, index) => [`p${index}`, state]))),
      ).all;
    expect(idleFleetLabel(fleetOf('idle', 'idle'))).toBe('aguardando');
    expect(idleFleetLabel(fleetOf('exited', 'hibernated'))).toBe('parados');
    expect(idleFleetLabel(fleetOf('idle', 'exited'))).toBe('nenhum trabalhando');
    expect(
      idleFleetLabel(
        groupRosterFleets(
          [agentPane({ id: 'acp', agentTransport: 'acp' })],
          {},
          context(),
        ).all,
      ),
    ).toBe('nenhum trabalhando');
    expect(idleFleetLabel(emptyRosterFleet())).toBe('');
  });
});

describe('workingSignature', () => {
  const panes: PaneModel[] = [agentPane({ id: 'a' }), agentPane({ id: 'b' }), agentPane({ id: 'c' })];
  const signature = (states: Record<string, PaneSessionState>) =>
    workingSignature(panes, { states: new Map(Object.entries(states)) });

  it('só muda quando muda o CONJUNTO de quem trabalha', () => {
    const base = signature({ a: 'busy' });
    // Quem não trabalha pode ir e vir entre estados sem mexer na assinatura.
    expect(signature({ a: 'busy', b: 'idle' })).toBe(base);
    expect(signature({ a: 'busy', b: 'spawning', c: 'exited' })).toBe(base);
    expect(signature({ a: 'busy', b: 'hibernated' })).toBe(base);
    // Entrar ou sair do trabalho muda.
    expect(signature({ a: 'busy', b: 'busy' })).not.toBe(base);
    expect(signature({ a: 'idle' })).not.toBe(base);
  });

  it('ninguém trabalhando é a assinatura vazia', () => {
    expect(signature({})).toBe('');
    expect(signature({ a: 'idle', b: 'exited' })).toBe('');
  });
});

describe('workingPaneIdsOf', () => {
  const panes: PaneModel[] = [
    agentPane({ id: 'a' }),
    agentPane({ id: 'b' }),
    agentPane({ id: 'c' }),
    agentPane({ id: 'd' }),
    { id: 'sh', kind: 'shell', title: 'zsh' },
  ];

  it('só agente em busy conta; shell, parado, iniciando e sem sessão ficam de fora', () => {
    const working = workingPaneIdsOf(panes, {
      states: new Map<string, PaneSessionState>([
        ['a', 'busy'],
        ['b', 'idle'],
        ['c', 'spawning'],
        ['sh', 'busy'],
      ]),
    });
    expect([...working]).toEqual(['a']);
  });

  it('estacionado pelo guardian não conta, mesmo com o estado local em busy', () => {
    const working = workingPaneIdsOf(panes, {
      states: new Map<string, PaneSessionState>([
        ['a', 'busy'],
        ['d', 'busy'],
      ]),
      parked: { has: (paneId) => paneId === 'a' },
    });
    expect([...working]).toEqual(['d']);
  });

  it('bate com a contagem do rail para os mesmos panes e estados', () => {
    const states = new Map<string, PaneSessionState>([
      ['a', 'busy'],
      ['b', 'busy'],
      ['c', 'idle'],
    ]);
    expect(workingPaneIdsOf(panes, { states }).size).toBe(
      groupRosterFleets(panes, {}, { states }).all.workingCount,
    );
  });
});
