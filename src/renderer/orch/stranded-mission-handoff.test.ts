import { describe, expect, it } from 'vitest';
import { FAILOVER_HANDOFF_HEADER } from '../../shared/failover-handoff';
import {
  cliAcceptsContinuityPrompt,
  nextContinuityInjectionDelay,
  planOperatorAgentSpawn,
  resolveStrandedMissionHandoff,
  stashPendingContinuity,
  takePendingContinuity,
} from './stranded-mission-handoff';

describe('cliAcceptsContinuityPrompt', () => {
  it('não injeta com o menu de confiança de pasta na tela (Enter cairia em "No, exit")', () => {
    const trustMenu = [
      'Quick safety check: Is this a project you created or one you trust?',
      "Claude Code'll be able to read, edit, and execute files here.",
      '❯ No, exit',
      '  Yes, I trust this folder',
      'Enter to confirm · Esc to cancel',
    ].join('\n');
    expect(cliAcceptsContinuityPrompt(trustMenu)).toBe(false);
    expect(cliAcceptsContinuityPrompt('Do you trust the files in this folder?\n1. Yes, proceed\n2. No, exit')).toBe(false);
  });

  it('menu já respondido no scrollback não segura a continuidade', () => {
    const answered =
      'Quick safety check: Is this a project you created or one you trust?\n' +
      '❯ No, exit\n  Yes, I trust this folder\n' +
      'Welcome to Claude Code!\n' +
      'resposta anterior do agente '.repeat(60) +
      '\n> ';
    expect(cliAcceptsContinuityPrompt(answered)).toBe(true);
  });

  it('rejects Claude 401 /login and in-flight API retry', () => {
    expect(
      cliAcceptsContinuityPrompt(
        '● Please run /login · API Error: 401 OAuth access token has expired.',
      ),
    ).toBe(false);
    expect(
      cliAcceptsContinuityPrompt(
        '● API error · Retrying in 1s · attempt 1/10',
      ),
    ).toBe(false);
    expect(
      cliAcceptsContinuityPrompt('Re-authenticate to continue.'),
    ).toBe(false);
  });

  it('accepts a normal idle prompt', () => {
    expect(
      cliAcceptsContinuityPrompt('~/radarbi | main | Opus 5\n> '),
    ).toBe(true);
  });
});

describe('nextContinuityInjectionDelay', () => {
  it('injects when the CLI is ready', () => {
    expect(
      nextContinuityInjectionDelay({ attempt: 0, cliReady: true }),
    ).toEqual({ action: 'inject' });
  });

  it('waits then abandons instead of typing into /login', () => {
    expect(
      nextContinuityInjectionDelay({ attempt: 0, cliReady: false }),
    ).toEqual({ action: 'wait', waitMs: 1_000 });
    expect(
      nextContinuityInjectionDelay({ attempt: 7, cliReady: false }),
    ).toEqual({ action: 'abandon' });
  });
});

describe('resolveStrandedMissionHandoff', () => {
  const missions = [
    { id: 'm-radar', title: 'Radar BI', status: 'running' },
  ];
  const strandedPane = {
    id: 'pane-dead',
    kind: 'cli-agent' as const,
    missionId: 'm-radar',
    adapterId: 'claude',
    role: 'orchestrator' as const,
  };

  it('hands off from the focused 401 pane so + Pane can continue the mission', () => {
    const hit = resolveStrandedMissionHandoff({
      focusedPaneId: 'pane-dead',
      panes: [strandedPane],
      paneMissions: { 'pane-dead': 'm-radar' },
      paneStates: { 'pane-dead': 'busy' },
      recentOutputByPane: {
        'pane-dead':
          'API Error: 401 OAuth access token has expired. Please run /login',
      },
      missions,
    });
    expect(hit).toEqual({
      missionId: 'm-radar',
      fromPaneId: 'pane-dead',
      role: 'orchestrator',
    });
  });

  it('does not attach when the focused agent is healthy', () => {
    expect(
      resolveStrandedMissionHandoff({
        focusedPaneId: 'pane-dead',
        panes: [strandedPane],
        paneMissions: { 'pane-dead': 'm-radar' },
        paneStates: { 'pane-dead': 'busy' },
        recentOutputByPane: {
          'pane-dead': 'working on the dashboard…',
        },
        missions,
      }),
    ).toBeNull();
  });

  it('finds a stranded sibling when focus is a new shell', () => {
    const hit = resolveStrandedMissionHandoff({
      focusedPaneId: 'pane-shell',
      panes: [
        { id: 'pane-shell', kind: 'shell' },
        strandedPane,
      ],
      paneMissions: { 'pane-dead': 'm-radar' },
      paneStates: { 'pane-dead': 'exited', 'pane-shell': 'idle' },
      recentOutputByPane: {},
      missions,
    });
    expect(hit?.fromPaneId).toBe('pane-dead');
    expect(hit?.missionId).toBe('m-radar');
  });

  it('prefere o líder que o MAIN confirma ao pane que se pintou de orquestrador', () => {
    const hit = resolveStrandedMissionHandoff({
      focusedPaneId: null,
      panes: [
        {
          id: 'pane-pintado',
          kind: 'cli-agent',
          missionId: 'm-radar',
          role: 'orchestrator',
          sessionId: 'session-pintado',
        },
        {
          id: 'pane-real',
          kind: 'cli-agent',
          missionId: 'm-radar',
          role: 'worker',
          sessionId: 'session-real',
        },
      ],
      paneMissions: {},
      paneStates: { 'pane-pintado': 'exited', 'pane-real': 'exited' },
      recentOutputByPane: {},
      missions: [
        {
          id: 'm-radar',
          status: 'running',
          orchestratorSessionId: 'session-real',
        },
      ],
    });
    expect(hit?.fromPaneId).toBe('pane-real');
  });
});

describe('pending continuity stash', () => {
  it('is consumed once so a later spawn does not re-inject', () => {
    stashPendingContinuity('pane-new', 'PACK');
    expect(takePendingContinuity('pane-new')).toBe('PACK');
    expect(takePendingContinuity('pane-new')).toBeUndefined();
  });
});

describe('planOperatorAgentSpawn', () => {
  it('builds a continuity pack for + Pane after a 401 mission pane', () => {
    const planned = planOperatorAgentSpawn({
      accountId: 'acc-good',
      focusedPaneId: 'pane-dead',
      panes: [
        {
          id: 'pane-dead',
          kind: 'cli-agent',
          missionId: 'm-radar',
          role: 'orchestrator',
        },
      ],
      paneMissions: { 'pane-dead': 'm-radar' },
      paneStates: { 'pane-dead': 'busy' },
      recentOutputByPane: {
        'pane-dead':
          'API Error: 401 OAuth access token has expired. Please run /login',
      },
      missions: [{ id: 'm-radar', title: 'Radar BI', status: 'running' }],
      fromAccountLabel: 'conta adm',
      toAccountLabel: 'arrumou a baderna',
    });
    expect(planned.accountId).toBe('acc-good');
    expect(planned.continuityPack).toContain(FAILOVER_HANDOFF_HEADER);
    expect(planned.continuityPack).toContain('m-radar');
    expect(planned.continuityPack).toContain('Radar BI');
    expect(planned.continuityPack).toContain('arrumou a baderna');
  });

  it('does not attach a pack when the focused agent is healthy', () => {
    expect(
      planOperatorAgentSpawn({
        accountId: 'acc-good',
        focusedPaneId: 'pane-ok',
        panes: [
          {
            id: 'pane-ok',
            kind: 'cli-agent',
            missionId: 'm-radar',
            role: 'orchestrator',
          },
        ],
        paneMissions: { 'pane-ok': 'm-radar' },
        paneStates: { 'pane-ok': 'busy' },
        recentOutputByPane: { 'pane-ok': 'working on the dashboard…' },
        missions: [{ id: 'm-radar', title: 'Radar BI', status: 'running' }],
        fromAccountLabel: 'conta adm',
        toAccountLabel: 'outra',
      }),
    ).toEqual({ accountId: 'acc-good' });
  });
});
