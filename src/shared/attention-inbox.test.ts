import { describe, expect, it } from 'vitest';
import { collectAttentionItems } from './attention-inbox';

describe('collectAttentionItems', () => {
  it('junta Enter, PR na fila, missão travada e CLI sem login', () => {
    const items = collectAttentionItems({
      notifications: [
        { paneId: 'p1', agentLabel: 'Claude', kind: 'needs_input' },
        { paneId: 'p2', agentLabel: 'Codex', kind: 'completed' },
      ],
      pr: {
        number: 4,
        title: 'Login mobile',
        autoMergeEnabled: true,
        mergeQueueRequired: true,
      },
      missions: [
        { id: 'm1', title: 'Auth', needsAttention: true },
        { id: 'm2', title: 'Ok', needsAttention: false },
      ],
      providers: [
        {
          adapterId: 'claude',
          label: 'Claude Code',
          enabled: true,
          installed: true,
          authStrategy: 'login-needed',
        },
        {
          adapterId: 'codex',
          label: 'Codex',
          enabled: true,
          installed: true,
          authStrategy: 'subscription',
        },
      ],
    });
    expect(items.map((i) => i.kind)).toEqual([
      'enter',
      'pr-queue',
      'mission-stuck',
      'cli-login',
    ]);
    expect(items[0]?.title).toContain('Enter');
    expect(items[1]?.title).toContain('#4');
  });

  it('waitingAgents vivo substitui needs_input histórico', () => {
    const items = collectAttentionItems({
      notifications: [
        { paneId: 'stale', agentLabel: 'Codex', kind: 'needs_input' },
      ],
      waitingAgents: [{ paneId: 'live', agentLabel: 'Claude' }],
      pr: null,
      missions: [],
      providers: [],
    });
    expect(items).toEqual([
      {
        id: 'enter:live',
        kind: 'enter',
        title: 'Claude pede Enter',
        detail: 'O agente está esperando você confirmar no terminal.',
        targetId: 'live',
      },
    ]);
  });

  it('waitingAgents vazio não recai no histórico', () => {
    expect(
      collectAttentionItems({
        notifications: [
          { paneId: 'stale', agentLabel: 'Codex', kind: 'needs_input' },
        ],
        waitingAgents: [],
        pr: null,
        missions: [],
        providers: [],
      }),
    ).toEqual([]);
  });

  it('fica vazia quando não há nada pedindo ação', () => {
    expect(
      collectAttentionItems({
        notifications: [],
        pr: null,
        missions: [],
        providers: [],
      }),
    ).toEqual([]);
  });
});
