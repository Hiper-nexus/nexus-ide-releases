import { describe, expect, it } from 'vitest';
import type { SquadAgent } from '../../shared/orch-types';
import {
  countLiveFirstWaveWriters,
  expandFirstWaveSeats,
  FIRST_WAVE_OFFER_CLIS,
  FIRST_WAVE_WRITER_SEATS,
  decideMetaPaneWorkerSpawn,
  liveMissionWorkerCount,
  liveWorkerSeatKeys,
  planFirstWaveSeats,
  planMetaPaneAskSeats,
  spreadPresentClisAcrossWriterRoles,
  targetFirstWaveWriterSeats,
} from './via-rapida-first-wave';

function agent(
  overrides: Partial<SquadAgent> & Pick<SquadAgent, 'id' | 'agentName' | 'category' | 'cli'>,
): SquadAgent {
  return overrides as SquadAgent;
}

const fullstackRoster: SquadAgent[] = [
  agent({
    id: 'orch',
    agentName: 'Maestro',
    category: 'orchestrator',
    cli: 'claude',
  }),
  agent({
    id: 'frontend',
    agentName: 'Frontend',
    category: 'executor',
    cli: 'codex',
  }),
  agent({
    id: 'backend',
    agentName: 'Backend',
    category: 'executor',
    cli: 'codex',
  }),
  agent({
    id: 'generalist',
    agentName: 'Generalist',
    category: 'executor',
    cli: 'codex',
  }),
];

const presentOf = (present: ReadonlySet<string>) => (row: SquadAgent) =>
  present.has(row.cli) ? 'present' : 'no-credential';

describe('spreadPresentClisAcrossWriterRoles', () => {
  it('reminta papéis do roster e cria Writer N para o resto das CLIs present', () => {
    const seated = spreadPresentClisAcrossWriterRoles(fullstackRoster, [
      'codex',
      'grok',
      'glm',
      'kimi',
    ]);
    expect(seated.map((row) => `${row.agentName}/${row.cli}`)).toEqual([
      'Frontend/codex',
      'Backend/grok',
      'Generalist/glm',
      'Writer 2/kimi',
    ]);
  });
});

describe('expandFirstWaveSeats — clone-collapse 068', () => {
  it('7 clones do mesmo Codex ganham título e agentName únicos (· 2 …)', () => {
    const motor = fullstackRoster[1]!;
    const seats = expandFirstWaveSeats([motor], 7);
    const titles = seats.map((seat) => seat.title);
    expect(titles).toEqual([
      'Frontend',
      'Frontend · 2',
      'Frontend · 3',
      'Frontend · 4',
      'Frontend · 5',
      'Frontend · 6',
      'Frontend · 7',
    ]);
    expect(new Set(titles).size).toBe(7);
    expect(new Set(seats.map((seat) => seat.agent.agentName)).size).toBe(7);
    expect(new Set(seats.map((seat) => seat.agent.id)).size).toBe(7);
  });
});

describe('planFirstWaveSeats — N present = N assentos vivos, não log-only 7', () => {
  it('20-story com ≥6 CLIs present abre ≥6 assentos (pula agy/LongCat sem auth)', () => {
    const present = new Set(['codex', 'grok', 'glm', 'kimi', 'opencode', 'aider']);
    const wave = planFirstWaveSeats({
      storyCount: 20,
      storyTitles: Array.from({ length: 20 }, (_, i) => `Story ${i + 1}`),
      agents: fullstackRoster,
      extraPresentClis: [
        ...FIRST_WAVE_OFFER_CLIS,
        'opencode',
        'aider',
        'agy',
        'longcat',
      ],
      orchestratorCli: 'claude',
      classifySeat: presentOf(present),
    });

    expect(wave.seats.length).toBe(FIRST_WAVE_WRITER_SEATS);
    expect(wave.seats.length).toBeGreaterThanOrEqual(6);
    const seatedClis = new Set(wave.seats.map((seat) => seat.agent.cli));
    expect(seatedClis.has('agy')).toBe(false);
    expect(seatedClis.has('longcat')).toBe(false);
    expect(seatedClis.has('claude')).toBe(false);
    for (const cli of present) {
      expect(seatedClis.has(cli)).toBe(true);
    }
    expect(wave.skippedNoCredential).toEqual(
      expect.arrayContaining(['agy', 'longcat']),
    );
  });

  it('auto-dispatch de N writers autenticados planeja N panes (unauth skip não infla o log)', () => {
    const present = new Set(['codex', 'grok', 'glm', 'kimi']);
    const wave = planFirstWaveSeats({
      storyCount: 20,
      agents: fullstackRoster,
      extraPresentClis: [...FIRST_WAVE_OFFER_CLIS, 'longcat'],
      orchestratorCli: 'claude',
      classifySeat: presentOf(present),
    });
    const uniquePresent = new Set(wave.presentWriters.map((row) => row.cli));
    expect(uniquePresent).toEqual(present);
    expect(wave.seats.every((seat) => present.has(seat.agent.cli))).toBe(true);
    expect(wave.skippedNoCredential).toContain('agy');
    expect(wave.skippedNoCredential).toContain('longcat');
    expect(wave.seats.length).toBe(FIRST_WAVE_WRITER_SEATS);
  });

  it('squad 4 papéis 068: senta kimi/grok/glm present, não 7× Codex; pula agy', () => {
    const squad068: SquadAgent[] = [
      agent({
        id: 'orch',
        agentName: 'Maestro',
        category: 'orchestrator',
        cli: 'claude',
      }),
      agent({
        id: 'motor',
        agentName: 'Implementar motor',
        category: 'executor',
        cli: 'codex',
      }),
      agent({
        id: 'agy',
        agentName: 'AGY',
        category: 'executor',
        cli: 'agy',
      }),
      agent({
        id: 'glm',
        agentName: 'GLM',
        category: 'reviewer',
        cli: 'glm',
      }),
    ];
    const present = new Set(['codex', 'grok', 'kimi', 'glm']);
    const wave = planFirstWaveSeats({
      storyCount: 20,
      agents: squad068,
      extraPresentClis: ['codex', 'agy', 'grok', 'glm', 'kimi'],
      orchestratorCli: 'claude',
      classifySeat: presentOf(present),
    });
    const clis = new Set(wave.seats.map((seat) => seat.agent.cli));
    expect(clis.has('agy')).toBe(false);
    expect(clis).toEqual(present);
    expect(wave.seats.some((seat) => seat.agent.agentName === 'GLM')).toBe(true);
    expect(
      wave.seats.filter((seat) => seat.agent.cli === 'codex').length,
    ).toBeLessThan(7);
    expect(new Set(wave.seats.map((seat) => seat.title)).size).toBe(
      wave.seats.length,
    );
    expect(wave.skippedNoCredential).toContain('agy');
  });
});

describe('planMetaPaneAskSeats — pergunta abre o roster, não 1 writer', () => {
  const askRoster: SquadAgent[] = [
    agent({
      id: 'orch',
      agentName: 'Coordenar e revisar',
      category: 'orchestrator',
      cli: 'claude',
    }),
    agent({
      id: 'ui',
      agentName: 'Implementar interface',
      category: 'executor',
      cli: 'codex',
    }),
    agent({
      id: 'motor',
      agentName: 'Implementar motor',
      category: 'executor',
      cli: 'cursor',
    }),
    agent({
      id: 'review',
      agentName: 'Verificar o resultado',
      category: 'reviewer',
      cli: 'glm',
    }),
  ];
  const presentOf = (present: ReadonlySet<string>) => (row: SquadAgent) =>
    present.has(row.cli) ? 'present' : 'no-credential';

  it('1 entrega selada não vira 1 Codex: senta os 3 papéis, inclusive o revisor', () => {
    // Campo 24/08: "How much is 2x2 and they have to answer you." selou 1
    // título → targetFirstWaveWriterSeats(1)=1 → só Implementar interface.
    expect(targetFirstWaveWriterSeats(1)).toBe(1);
    const writerWave = planFirstWaveSeats({
      storyCount: 1,
      storyTitles: ['How much is 2x2 and they have to answer you.'],
      agents: askRoster,
      classifySeat: presentOf(new Set(['codex', 'cursor', 'glm'])),
    });
    expect(writerWave.seats.map((seat) => seat.title)).toEqual([
      'Implementar interface',
    ]);

    const askWave = planMetaPaneAskSeats({
      agents: askRoster,
      classifySeat: presentOf(new Set(['codex', 'cursor', 'glm'])),
    });
    expect(askWave.seats.map((seat) => seat.title)).toEqual([
      'Implementar interface',
      'Implementar motor',
      'Verificar o resultado',
    ]);
    expect(askWave.seats.some((seat) => seat.agent.category === 'reviewer')).toBe(
      true,
    );
    expect(askWave.seats.some((seat) => seat.agent.category === 'orchestrator')).toBe(
      false,
    );
  });

  it('não inventa Writer N extra e pula quem já sentou ou está sem auth', () => {
    const wave = planMetaPaneAskSeats({
      agents: askRoster,
      classifySeat: presentOf(new Set(['codex', 'glm'])),
      seatedKeys: ['Implementar interface'],
    });
    expect(wave.seats.map((seat) => seat.title)).toEqual(['Verificar o resultado']);
    expect(wave.skippedNoCredential).toContain('cursor');
    expect(wave.seats.every((seat) => !seat.title.startsWith('Writer'))).toBe(
      true,
    );
  });
});

describe('decideMetaPaneWorkerSpawn — seating, not prompt', () => {
  const roster = [
    'Implementar interface',
    'Implementar motor',
    'Verificar o resultado',
  ];
  const seated = [...roster];

  it('não meta-de-pane: spawn segue a política geral', () => {
    expect(
      decideMetaPaneWorkerSpawn({
        isMetaPaneMission: false,
        requestedAgentName: undefined,
        rosterWorkerNames: roster,
        liveWorkerKeys: seated,
      }),
    ).toEqual({ allowed: true });
  });

  it('recusa qualquer spawn extra quando o roster já está sentado', () => {
    const decision = decideMetaPaneWorkerSpawn({
      isMetaPaneMission: true,
      requestedAgentName: 'Implementar motor',
      rosterWorkerNames: roster,
      liveWorkerKeys: seated,
      liveWorkerCount: 3,
    });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('expected refuse');
    expect(decision.reason).toMatch(/already live/i);
  });

  it('recusa ad-hoc sem agentName quando a first-wave já sentou', () => {
    const decision = decideMetaPaneWorkerSpawn({
      isMetaPaneMission: true,
      requestedAgentName: undefined,
      rosterWorkerNames: roster,
      liveWorkerKeys: ['Implementar interface', 'Implementar motor'],
    });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('expected refuse');
    expect(decision.reason).toMatch(/ad-hoc/i);
  });

  it('recusa cópia de integrante já aberto', () => {
    const decision = decideMetaPaneWorkerSpawn({
      isMetaPaneMission: true,
      requestedAgentName: 'Implementar interface',
      rosterWorkerNames: roster,
      liveWorkerKeys: ['Implementar interface', 'Implementar motor'],
    });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('expected refuse');
    expect(decision.reason).toMatch(/already has a live pane/i);
  });

  it('recusa nome que não está no roster', () => {
    const decision = decideMetaPaneWorkerSpawn({
      isMetaPaneMission: true,
      requestedAgentName: 'Writer 2',
      rosterWorkerNames: roster,
      liveWorkerKeys: ['Implementar interface', 'Implementar motor'],
    });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('expected refuse');
    expect(decision.reason).toMatch(/not a roster member/i);
  });

  it('liveMissionWorkerCount conta pane sem role como worker', () => {
    expect(
      liveMissionWorkerCount(
        [
          { missionId: 'm1', role: 'orchestrator', state: 'busy' },
          { missionId: 'm1', role: 'worker', state: 'busy' },
          { missionId: 'm1', state: 'idle' },
          { missionId: 'm1', role: 'worker', state: 'exited' },
        ],
        'm1',
      ),
    ).toBe(2);
  });

  it('liveWorkerSeatKeys ignora shell/exited e ocupa o nome vivo', () => {
    expect(
      liveWorkerSeatKeys(
        [
          {
            missionId: 'm1',
            role: 'worker',
            state: 'busy',
            agentName: 'Implementar motor',
            title: 'Implementar motor',
          },
          {
            missionId: 'm1',
            role: 'worker',
            state: 'exited',
            agentName: 'Implementar interface',
            title: 'Implementar interface',
          },
          {
            missionId: 'm1',
            role: 'orchestrator',
            state: 'idle',
            agentName: 'Coordenar e revisar',
          },
        ],
        'm1',
      ),
    ).toEqual(['Implementar motor', 'Implementar motor']);
  });

  it('permite preencher o único assento que faltou', () => {
    expect(
      decideMetaPaneWorkerSpawn({
        isMetaPaneMission: true,
        requestedAgentName: 'Verificar o resultado',
        rosterWorkerNames: roster,
        liveWorkerKeys: ['Implementar interface', 'Implementar motor'],
      }),
    ).toEqual({ allowed: true });
  });
});

describe('countLiveFirstWaveWriters', () => {
  const connected = new Set(['pty-1', 'pty-2', 'pty-3', 'pty-4', 'pty-5', 'pty-6']);
  const isConnected = (sessionId: string) => connected.has(sessionId);

  it('não conta tile de grafo / spawning sem PTY writable', () => {
    expect(
      countLiveFirstWaveWriters(
        [
          {
            missionId: 'm-068',
            role: 'orchestrator',
            sessionId: 'maestro',
          },
          { missionId: 'm-068', role: 'worker', sessionId: 'ghost-graph' },
          { missionId: 'm-068', role: 'worker', sessionId: null },
          { missionId: 'm-other', role: 'worker', sessionId: 'pty-1' },
        ],
        'm-068',
        isConnected,
      ),
    ).toBe(0);
  });

  it('tile leftover/spawning sem PTY writable não come o orçamento da first-wave', () => {
    const ghosts = [
      { missionId: 'm-068', role: 'worker' as const, sessionId: 'graph-only' },
      { missionId: 'm-068', role: 'worker' as const, sessionId: 'spawning-mute' },
    ];
    const live = countLiveFirstWaveWriters(ghosts, 'm-068', () => false);
    const wave = planFirstWaveSeats({
      storyCount: 20,
      agents: fullstackRoster,
      extraPresentClis: ['codex', 'grok', 'glm', 'kimi', 'opencode', 'aider'],
      orchestratorCli: 'claude',
      liveWritableWorkers: live,
      classifySeat: (row) =>
        ['codex', 'grok', 'glm', 'kimi', 'opencode', 'aider'].includes(row.cli)
          ? 'present'
          : 'no-credential',
    });
    expect(live).toBe(0);
    expect(wave.seats.length).toBe(FIRST_WAVE_WRITER_SEATS);
  });

  it('N writers autenticados com PTY connected+writable = N panes vivos, não um log 7', () => {
    const panes = [
      { missionId: 'm-068', role: 'orchestrator' as const, sessionId: 'maestro' },
      ...Array.from({ length: 6 }, (_, index) => ({
        missionId: 'm-068',
        role: 'worker' as const,
        sessionId: `pty-${index + 1}`,
      })),
      { missionId: 'm-068', role: 'worker' as const, sessionId: 'log-only-7' },
    ];
    expect(countLiveFirstWaveWriters(panes, 'm-068', isConnected)).toBe(6);
  });
});

describe('modelo do assento respeita a escolha do usuário (grok 4.6→4.5, 19/08)', () => {
  it('writer sintético NÃO carrega modelo hardcoded — spawn resolve provider-default', () => {
    const seated = spreadPresentClisAcrossWriterRoles(
      [
        {
          id: 'orch',
          agentName: 'Maestro',
          category: 'orchestrator',
          cli: 'claude',
        } as never,
      ],
      ['grok'],
    );
    expect(seated).toHaveLength(1);
    expect(seated[0]!.cli).toBe('grok');
    // model ausente/vazio: req.model não pode sombrear o defaultModel do
    // provider configurado pelo usuário.
    expect(seated[0]!.model ?? '').toBe('');
  });

  it('remint de papel para outro CLI LIMPA o modelo do CLI antigo', () => {
    const seated = spreadPresentClisAcrossWriterRoles(
      [
        {
          id: 'w1',
          agentName: 'Implementar parte',
          category: 'executor',
          cli: 'cursor-agent',
          model: 'cursor-fast',
        } as never,
      ],
      ['codex'],
    );
    expect(seated).toHaveLength(1);
    expect(seated[0]!.cli).toBe('codex');
    expect(seated[0]!.model ?? '').toBe('');
  });

  it('agente nomeado do roster PRESERVA o modelo escolhido no wizard', () => {
    const seated = spreadPresentClisAcrossWriterRoles(
      [
        {
          id: 'w1',
          agentName: 'Implementar parte',
          category: 'executor',
          cli: 'grok',
          model: 'grok-4.6',
        } as never,
      ],
      ['grok'],
    );
    expect(seated).toHaveLength(1);
    expect(seated[0]!.model).toBe('grok-4.6');
  });
});
