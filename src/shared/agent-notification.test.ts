// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  agentNotificationStatusLabel,
  countUnread,
  evaluatePaneTransition,
  formatNotificationAgo,
  MIN_BUSY_MS_FOR_COMPLETED,
  AGENT_NOTIFICATION_MAX,
  notificationKindFromTransition,
  pushAgentNotification,
} from './agent-notification';

describe('agent-notification domain', () => {
  it('requires sustained busy before completed (anti-spam)', () => {
    const t0 = 10_000;
    // Enter busy — track epoch
    const start = evaluatePaneTransition({
      prev: 'idle',
      next: 'busy',
      busyStartedAt: undefined,
      now: t0,
    });
    expect(start.kind).toBeNull();
    expect(start.busyStartedAt).toBe(t0);

    // Short blip idle — no completed
    const blip = evaluatePaneTransition({
      prev: 'busy',
      next: 'idle',
      busyStartedAt: t0,
      now: t0 + 200,
    });
    expect(blip.kind).toBeNull();
    expect(blip.busyStartedAt).toBeUndefined();

    // Sustained busy then idle → completed
    const long = evaluatePaneTransition({
      prev: 'busy',
      next: 'idle',
      busyStartedAt: t0,
      now: t0 + MIN_BUSY_MS_FOR_COMPLETED + 50,
    });
    expect(long.kind).toBe('completed');
  });

  it('never maps hibernate→idle to needs_input (hooks own that signal)', () => {
    expect(
      evaluatePaneTransition({
        prev: 'hibernated',
        next: 'idle',
        busyStartedAt: undefined,
        now: 1,
      }).kind,
    ).toBeNull();
    expect(
      notificationKindFromTransition('hibernated', 'idle', { now: 1 }),
    ).toBeNull();
  });

  it('maps exit and formats labels', () => {
    expect(
      evaluatePaneTransition({
        prev: 'busy',
        next: 'exited',
        busyStartedAt: 1,
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
