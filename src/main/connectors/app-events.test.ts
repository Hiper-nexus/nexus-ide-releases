import { describe, expect, it, beforeEach } from 'vitest';
import {
  appEventsAfter,
  emitAppEvent,
  latestAppEventSeq,
  resetAppEventsForTests,
  subscribeAppEvents,
} from './app-events';

describe('app-events — fila com cursor do conector Arms', () => {
  beforeEach(() => {
    resetAppEventsForTests();
  });

  it('cursor devolve só o que é novo e nextCursor avança', () => {
    const first = emitAppEvent('pane.spawned', { role: 'worker' });
    const second = emitAppEvent('handoff.submitted', { status: 'success' });

    const page1 = appEventsAfter(0);
    expect(page1.events.map((event) => event.seq)).toEqual([first.seq, second.seq]);
    expect(page1.nextCursor).toBe(second.seq);
    expect(page1.truncated).toBe(false);

    const third = emitAppEvent('mission.state', { status: 'running' });
    const page2 = appEventsAfter(page1.nextCursor);
    expect(page2.events.map((event) => event.seq)).toEqual([third.seq]);
    expect(latestAppEventSeq()).toBe(third.seq);
  });

  it('completion events are distinct from state observations and reach subscribers', () => {
    const received: string[] = [];
    const unsubscribe = subscribeAppEvents(event => received.push(event.kind));
    emitAppEvent('mission.state', { status: 'done' });
    emitAppEvent('mission.completed', { missionId: 'mission-test' });
    unsubscribe();
    expect(received).toEqual(['mission.state', 'mission.completed']);
    expect(appEventsAfter(0).events[1]?.payload).toEqual({ missionId: 'mission-test' });
  });

  it('payload vira imutável — mutação externa não contamina a fila', () => {
    const payload: { status: string } = { status: 'running' };
    emitAppEvent('mission.state', payload);
    payload.status = 'hacked';
    const page = appEventsAfter(0);
    expect(page.events[0]!.payload.status).toBe('running');
  });

  it('listener que explode não derruba o emissor', () => {
    subscribeAppEvents(() => {
      throw new Error('listener bugado');
    });
    expect(() => emitAppEvent('pane.exited', {})).not.toThrow();
  });

  it('ring descarta eventos antigos e marca truncated', () => {
    for (let i = 0; i < 600; i += 1) {
      emitAppEvent('pane.spawned', { n: i });
    }
    const oldest = appEventsAfter(0);
    expect(oldest.truncated).toBe(true);
    expect(oldest.events.length).toBeLessThanOrEqual(512);
    const fresh = appEventsAfter(latestAppEventSeq() - 1);
    expect(fresh.events).toHaveLength(1);
  });
});
