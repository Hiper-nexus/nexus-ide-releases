// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  agentAttentionPhrase,
  agentNotificationStatusLabel,
  shouldPingHumanForNotification,
  countUnread,
  evaluatePaneTransition,
  formatNotificationAgo,
  MIN_BUSY_MS_FOR_COMPLETED,
  AGENT_NOTIFICATION_MAX,
  type BusyEpoch,
  pushAgentNotification,
} from './agent-notification';

describe('agent-notification domain', () => {
  it('requires sustained busy from a real turn before completed (anti-spam)', () => {
    const t0 = 10_000;
    // idle→busy abre época elegível (turno real do usuário)
    const start = evaluatePaneTransition({
      prev: 'idle',
      next: 'busy',
      busyEpoch: undefined,
      now: t0,
    });
    expect(start.kind).toBeNull();
    expect(start.busyEpoch).toEqual({ startedAt: t0, fromIdle: true });

    // Short blip idle — no completed
    const blip = evaluatePaneTransition({
      prev: 'busy',
      next: 'idle',
      busyEpoch: start.busyEpoch,
      now: t0 + 200,
    });
    expect(blip.kind).toBeNull();
    expect(blip.busyEpoch).toBeUndefined();

    // Sustained busy then idle → completed
    const long = evaluatePaneTransition({
      prev: 'busy',
      next: 'idle',
      busyEpoch: start.busyEpoch,
      now: t0 + MIN_BUSY_MS_FOR_COMPLETED + 50,
    });
    expect(long.kind).toBe('completed');
  });

  it('never completes a boot/respawn epoch (spawning→busy→idle)', () => {
    const t0 = 5_000;
    // spawning nunca abre época
    const spawn = evaluatePaneTransition({
      prev: undefined,
      next: 'spawning',
      busyEpoch: undefined,
      now: t0,
    });
    expect(spawn.busyEpoch).toBeUndefined();

    // spawning→busy abre época NÃO-elegível (fromIdle=false)
    const busy = evaluatePaneTransition({
      prev: 'spawning',
      next: 'busy',
      busyEpoch: spawn.busyEpoch,
      now: t0,
    });
    expect(busy.busyEpoch).toEqual({ startedAt: t0, fromIdle: false });

    // Boot leva muito mais que o mínimo — ainda assim NÃO completa
    const idle = evaluatePaneTransition({
      prev: 'busy',
      next: 'idle',
      busyEpoch: busy.busyEpoch,
      now: t0 + MIN_BUSY_MS_FOR_COMPLETED + 5_000,
    });
    expect(idle.kind).toBeNull();
  });

  it('never maps hibernate→idle to needs_input (hooks own that signal)', () => {
    expect(
      evaluatePaneTransition({
        prev: 'hibernated',
        next: 'idle',
        busyEpoch: undefined,
        now: 1,
      }).kind,
    ).toBeNull();
  });

  it('maps exit and formats labels', () => {
    const epoch: BusyEpoch = { startedAt: 1, fromIdle: true };
    expect(
      evaluatePaneTransition({
        prev: 'busy',
        next: 'exited',
        busyEpoch: epoch,
        now: 2,
      }).kind,
    ).toBe('exited');
    expect(agentNotificationStatusLabel('completed')).toBe('CONCLUÍDO');
    expect(agentNotificationStatusLabel('needs_input')).toBe('PRECISA DE INPUT');
    const now = 1_000_000;
    expect(formatNotificationAgo(now, now - 30_000)).toBe('agora');
    expect(formatNotificationAgo(now, now - 5 * 60_000)).toBe('5 min');
  });

  it('dedupes and caps the feed; counts unread', () => {
    const t = 1000;
    let items = pushAgentNotification([], {
      paneId: 'p1',
      agentLabel: 'Claude',
      kind: 'completed',
      createdAt: t,
    });
    items = pushAgentNotification(items, {
      paneId: 'p1',
      agentLabel: 'Claude',
      kind: 'completed',
      createdAt: t + 500,
    });
    expect(items).toHaveLength(1);
    expect(countUnread(items)).toBe(1);
    items = items.map((i) => ({ ...i, read: true }));
    expect(countUnread(items)).toBe(0);

    for (let i = 0; i < AGENT_NOTIFICATION_MAX + 10; i += 1) {
      items = pushAgentNotification(items, {
        paneId: `p${i + 2}`,
        agentLabel: 'Claude',
        kind: 'completed',
        createdAt: t + 10_000 + i * 3_000,
      });
    }
    expect(items).toHaveLength(AGENT_NOTIFICATION_MAX);
    expect(items[0]?.paneId).toBe(`p${AGENT_NOTIFICATION_MAX + 11}`);
  });
});

describe('agentAttentionPhrase', () => {
  it('pede Enter e revisão em português', () => {
    expect(agentAttentionPhrase('needs_input', 'Claude')).toBe(
      'Claude precisa que você aperte Enter.',
    );
    expect(agentAttentionPhrase('completed', 'Codex')).toBe(
      'Codex terminou e espera sua revisão.',
    );
    expect(shouldPingHumanForNotification('exited')).toBe(false);
    expect(shouldPingHumanForNotification('completed')).toBe(true);
  });
});
