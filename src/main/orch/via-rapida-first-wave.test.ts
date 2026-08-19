import { describe, expect, it } from 'vitest';
import type { SquadAgent } from '../../shared/orch-types';
import {
  countLiveFirstWaveWriters,
  FIRST_WAVE_OFFER_CLIS,
  FIRST_WAVE_WRITER_SEATS,
  planFirstWaveSeats,
  spreadPresentClisAcrossWriterRoles,
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
