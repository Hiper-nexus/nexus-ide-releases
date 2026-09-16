import { describe, expect, it, vi } from 'vitest';
import { testProjectScope } from './__tests__/scope-fixture';
import {
  MissionLeadership,
  type LeadershipClaim,
  type LeadershipChange,
  type LeadershipSession,
  type MissionLeadershipPorts,
} from './mission-leadership';

const scope = testProjectScope();
const target = { sessionId: 'new', paneId: 'pane-new', origin: 'adopt' as const };
const sources = ['fast-lane', 'mission-panes', 'gate', 'panes', 'renderer'] as const;
const states = ['busy', 'idle', 'spawning', 'exited', 'hibernated', 'unknown', undefined];

function fixture() {
  let durable: string | null = null;
  let claims: LeadershipClaim[] = [];
  const sessions = new Map<string, LeadershipSession>();
  const calls: string[] = [];
  const events: LeadershipChange[] = [];
  const ports: MissionLeadershipPorts<LeadershipClaim[]> = {
    readMission: () => ({ orchestratorSessionId: durable }),
    readClaims: () => claims,
    readSession: (id) => sessions.get(id) ?? null,
    transaction: (commit) => {
      const before = { durable, claims: structuredClone(claims) };
      try {
        commit();
        calls.push('commit');
      } catch (error) {
        durable = before.durable;
        claims = before.claims;
        throw error;
      }
    },
    setDurableLeader: (_mission, leader) => {
      calls.push('A');
      durable = leader.sessionId;
      return true;
    },
    replacePaneLeader: (_mission, leader) => {
      calls.push('C');
      claims = claims.filter((c) => c.source !== 'mission-panes');
      claims.push({ ...leader, source: 'mission-panes' });
      return true;
    },
    captureRuntime: () => structuredClone(claims.filter((c) => c.source !== 'mission-panes')),
    replaceRuntimeLeader: (_mission, leader) => {
      calls.push('D');
      claims = claims.filter((c) => c.source === 'mission-panes' || c.source === 'renderer');
      for (const source of ['gate', 'fast-lane', 'panes'] as const) {
        claims.push({ ...leader, source });
      }
      return true;
    },
    restoreRuntime: (_mission, snapshot) => {
      calls.push('restore');
      claims = [...claims.filter((c) => c.source === 'mission-panes'), ...snapshot];
    },
    emitLeadershipChanged: (event) => {
      calls.push('F');
      events.push(event);
    },
  };
  const forScope = vi.fn(() => ports);
  const engine = new MissionLeadership({ forScope });
  const session = (id: string, state: string | undefined = 'idle') => {
    sessions.set(id, { sessionId: id, paneId: `pane-${id}`, scope, missionId: 'm', state });
  };
  session('new');
  return {
    engine, ports, forScope, sessions, session, calls, events,
    get durable() { return durable; },
    set durable(value: string | null) { durable = value; },
    get claims() { return claims; },
    set claims(value: LeadershipClaim[]) { claims = value; },
  };
}

describe('resolveMissionLeader / assertSingleLeader', () => {
  it('returns null for a missing mission or for no leadership evidence', () => {
    const f = fixture();
    expect(f.engine.resolveMissionLeader(scope, 'm')).toBeNull();
    f.ports.readMission = () => null;
    expect(f.engine.resolveMissionLeader(scope, 'm')).toBeNull();
  });

  it('keeps dead durable authority unproven, even with a live alternative', () => {
    const f = fixture();
    f.durable = 'old';
    f.session('old', 'exited');
    f.claims = [{ source: 'panes', sessionId: 'new', paneId: 'pane-new' }];
    expect(f.engine.resolveMissionLeader(scope, 'm')).toEqual({
      sessionId: 'old', paneId: 'pane-old', source: 'durable', proven: false,
    });
    expect(() => f.engine.assertSingleLeader(scope, 'm')).toThrow('leadership_split_brain');
  });

  it('does not invent a pane for a durable session lost on restart', () => {
    const f = fixture();
    f.durable = 'lost';
    expect(f.engine.resolveMissionLeader(scope, 'm')).toEqual({
      sessionId: 'lost', paneId: null, source: 'durable', proven: false,
    });
  });

  it('never proves a durable session with a missing or unknown physical state', () => {
    for (const state of [null, undefined, 'unknown', 'exited', 'hibernated']) {
      const f = fixture();
      f.durable = 'new';
      f.sessions.set('new', { ...f.sessions.get('new')!, state });
      expect(f.engine.resolveMissionLeader(scope, 'm')?.proven).toBe(false);
    }
  });

  it('detects every disagreement with durable authority, even when both sessions are absent', () => {
    for (const source of sources) {
      const f = fixture();
      f.sessions.clear();
      f.durable = 'old';
      f.claims = [{ source, sessionId: 'new', paneId: 'pane-new' }];
      expect(() => f.engine.assertSingleLeader(scope, 'm')).toThrow(/old.*new|new.*old/);
    }
  });

  it('exhaustively uses the shared liveness classification for every source', () => {
    for (const source of sources) {
      for (const state of states) {
        const f = fixture();
        f.session('new', state ?? 'unknown');
        f.claims = [{ source, sessionId: 'new', paneId: 'pane-new' }];
        const live = ['busy', 'idle', 'spawning'].includes(state ?? '');
        expect(f.engine.resolveMissionLeader(scope, 'm')?.proven ?? false).toBe(live);
        f.durable = 'new';
        expect(f.engine.resolveMissionLeader(scope, 'm')?.proven).toBe(live);
      }
    }
  });

  it('detects every pair of disagreeing sources regardless of order or liveness', () => {
    for (const left of sources) {
      for (const right of sources) {
        for (const state of states) {
          const f = fixture();
          f.session('old', state ?? 'unknown');
          f.claims = [
            { source: left, sessionId: 'old', paneId: 'pane-old' },
            { source: right, sessionId: 'new', paneId: 'pane-new' },
          ];
          expect(() => f.engine.assertSingleLeader(scope, 'm')).toThrow('leadership_split_brain');
          f.claims.reverse();
          expect(() => f.engine.assertSingleLeader(scope, 'm')).toThrow('leadership_split_brain');
          if (['busy', 'idle', 'spawning'].includes(state ?? '')) {
            expect(() => f.engine.resolveMissionLeader(scope, 'm')).toThrow('leadership_split_brain');
          }
        }
      }
    }
  });

  it('deduplicates agreement and detects conflicting pane ids without sessions', () => {
    const f = fixture();
    f.claims = sources.map((source) => ({ source, sessionId: 'new', paneId: 'pane-new' }));
    expect(() => f.engine.assertSingleLeader(scope, 'm')).not.toThrow();
    expect(f.engine.resolveMissionLeader(scope, 'm')?.source).toBe('live');
    f.claims.push({ source: 'mission-panes', sessionId: null, paneId: 'other' });
    expect(() => f.engine.assertSingleLeader(scope, 'm')).toThrow('leadership_split_brain');
  });
});

describe('applyLeadership', () => {
  it('commits A → C → D before notifying F, then resolves the same leader', () => {
    const f = fixture();
    const result = f.engine.applyLeadership(scope, 'm', target);
    expect(f.calls).toEqual(['A', 'C', 'D', 'commit', 'F']);
    expect(result.rendererNotified).toBe(true);
    expect(f.events[0]).toMatchObject({ scope, missionId: 'm', ...target, type: 'mission-leadership-changed' });
    expect(f.engine.resolveMissionLeader(scope, 'm')).toEqual(result.leader);
    expect(() => f.engine.assertSingleLeader(scope, 'm')).not.toThrow();
  });

  it('adopts an unassigned owned session without changing its physical state', () => {
    const f = fixture();
    f.sessions.set('new', { ...f.sessions.get('new')!, missionId: undefined });
    const before = structuredClone([...f.sessions]);
    f.engine.applyLeadership(scope, 'm', target);
    expect([...f.sessions]).toEqual(before);
  });

  it('never installs a second live leader for any origin or claim source', () => {
    for (const origin of ['spawn', 'adopt', 'respawn', 'promote'] as const) {
      for (const source of sources) {
        for (const state of ['busy', 'idle', 'spawning']) {
          const f = fixture();
          f.session('old', state);
          f.claims = [{ source, sessionId: 'old', paneId: 'pane-old' }];
          const before = structuredClone([...f.sessions]);
          expect(() => f.engine.applyLeadership(scope, 'm', { ...target, origin })).toThrow('leadership_existing_session');
          expect(f.calls).toEqual([]);
          expect([...f.sessions]).toEqual(before);
        }
      }
    }
  });

  it('spawn/respawn require physical removal even for exited registered sessions', () => {
    for (const origin of ['spawn', 'respawn'] as const) {
      for (const state of states) {
        const f = fixture();
        f.durable = 'old';
        f.session('old', state ?? 'unknown');
        expect(() => f.engine.applyLeadership(scope, 'm', { ...target, origin })).toThrow('leadership_existing_session');
        f.sessions.delete('old');
        expect(f.engine.applyLeadership(scope, 'm', { ...target, origin }).leader.sessionId).toBe('new');
      }
    }
  });

  it('adopt/promote demote exited authority without terminating any session', () => {
    for (const origin of ['adopt', 'promote'] as const) {
      const f = fixture();
      f.durable = 'old';
      f.session('old', 'exited');
      f.claims = sources.filter((s) => s !== 'renderer').map((source) => ({ source, sessionId: 'old', paneId: 'pane-old' }));
      const before = structuredClone([...f.sessions]);
      f.engine.applyLeadership(scope, 'm', { ...target, origin });
      expect([...f.sessions]).toEqual(before);
      expect(() => f.engine.assertSingleLeader(scope, 'm')).not.toThrow();
    }
  });

  it('rejects unverifiable adoption targets and predecessors without side effects', () => {
    const f = fixture();
    f.session('new', 'unknown');
    expect(() => f.engine.applyLeadership(scope, 'm', target)).toThrow('leadership_target_not_live');
    f.session('new');
    f.durable = 'old';
    f.session('old', 'unknown');
    expect(() => f.engine.applyLeadership(scope, 'm', target)).toThrow('leadership_existing_session');
    expect(f.calls).toEqual([]);
  });

  it.each(['setDurableLeader', 'replacePaneLeader', 'replaceRuntimeLeader'] as const)(
    'rolls back a rejected %s and emits no event', (method) => {
      const f = fixture();
      f.durable = 'old';
      f.claims = [{ source: 'gate', sessionId: 'old', paneId: 'pane-old' }];
      const before = structuredClone(f.claims);
      const original = f.ports[method];
      f.ports[method] = (...args) => { original(...args); return false; };
      expect(() => f.engine.applyLeadership(scope, 'm', target)).toThrow('leadership_write_refused');
      expect(f.durable).toBe('old');
      expect(f.claims).toEqual(before);
      expect(f.events).toEqual([]);
    },
  );

  it('compensates runtime even if the database commit itself fails', () => {
    const f = fixture();
    const transact = f.ports.transaction;
    f.ports.transaction = (commit) => transact(() => { commit(); throw new Error('commit failed'); });
    expect(() => f.engine.applyLeadership(scope, 'm', target)).toThrow('commit failed');
    expect(f.durable).toBeNull();
    expect(f.claims).toEqual([]);
    expect(f.events).toEqual([]);
  });

  it('rolls back and restores partially mutated runtime after an exception', () => {
    const f = fixture();
    const write = f.ports.replaceRuntimeLeader;
    f.ports.replaceRuntimeLeader = (...args) => { write(...args); throw new Error('gate failed halfway'); };
    expect(() => f.engine.applyLeadership(scope, 'm', target)).toThrow('gate failed halfway');
    expect(f.durable).toBeNull();
    expect(f.claims).toEqual([]);
    expect(f.events).toEqual([]);
  });

  it('reports compensation failure instead of masking incomplete rollback', () => {
    const f = fixture();
    f.ports.replaceRuntimeLeader = () => { throw new Error('gate failed'); };
    f.ports.restoreRuntime = () => { throw new Error('restore failed'); };
    expect(() => f.engine.applyLeadership(scope, 'm', target)).toThrow('leadership_rollback_failed');
    expect(f.events).toEqual([]);
  });

  it('reports notification failure as committed and can replay by applying again', () => {
    const f = fixture();
    const emit = f.ports.emitLeadershipChanged;
    f.ports.emitLeadershipChanged = () => { throw new Error('renderer unavailable'); };
    const result = f.engine.applyLeadership(scope, 'm', target);
    expect(result.rendererNotified).toBe(false);
    expect(f.durable).toBe('new');
    f.ports.emitLeadershipChanged = emit;
    expect(f.engine.applyLeadership(scope, 'm', target).rendererNotified).toBe(true);
  });

  it('blocks reentrant reads and writes while stores are only partly updated', () => {
    const f = fixture();
    const write = f.ports.replacePaneLeader;
    f.ports.replacePaneLeader = (...args) => {
      expect(() => f.engine.resolveMissionLeader(scope, 'm')).toThrow('leadership_busy');
      expect(() => f.engine.assertSingleLeader(scope, 'm')).toThrow('leadership_busy');
      expect(() => f.engine.applyLeadership(scope, 'm', target)).toThrow('leadership_busy');
      return write(...args);
    };
    f.engine.applyLeadership(scope, 'm', target);
  });

  it('does not expose a stale renderer projection as a failed database commit', () => {
    const f = fixture();
    f.claims = [{ source: 'renderer', sessionId: 'old', paneId: 'pane-old' }];
    expect(f.engine.applyLeadership(scope, 'm', target).rendererNotified).toBe(true);
    expect(() => f.engine.assertSingleLeader(scope, 'm')).toThrow('leadership_split_brain');
  });

  it('checks writer postconditions before commit, including a silent no-op', () => {
    const f = fixture();
    f.ports.setDurableLeader = () => true;
    expect(() => f.engine.applyLeadership(scope, 'm', target)).toThrow('leadership_write_incomplete');
    expect(f.events).toEqual([]);
  });

  it('rolls back when liveness disappears during the synchronous write', () => {
    const f = fixture();
    const write = f.ports.replaceRuntimeLeader;
    f.ports.replaceRuntimeLeader = (...args) => {
      write(...args);
      f.sessions.delete('new');
      return true;
    };
    expect(() => f.engine.applyLeadership(scope, 'm', target)).toThrow('leadership_target_not_live');
    expect(f.durable).toBeNull();
    expect(f.claims).toEqual([]);
    expect(f.events).toEqual([]);
  });

  it('rejects missing missions and invalid origins before performing writes', () => {
    const f = fixture();
    expect(() => f.engine.applyLeadership(scope, 'm', {
      ...target, origin: 'invalid' as 'adopt',
    })).toThrow();
    f.ports.readMission = () => null;
    expect(() => f.engine.applyLeadership(scope, 'm', target)).toThrow('leadership_mission_missing');
    expect(f.calls).toEqual([]);
  });

  it('passes each complete scope to the dependency resolver without sharing state', () => {
    const a = fixture();
    const b = fixture();
    const other = { ...scope, checkoutId: 'other', rootRealPath: '/other' };
    b.sessions.set('new', { ...b.sessions.get('new')!, scope: other });
    const engine = new MissionLeadership({
      forScope: (requested) => requested.checkoutId === other.checkoutId ? b.ports : a.ports,
    });
    engine.applyLeadership(other, 'm', target);
    expect(engine.resolveMissionLeader(scope, 'm')).toBeNull();
    expect(engine.resolveMissionLeader(other, 'm')?.sessionId).toBe('new');
    expect(a.calls).toEqual([]);
  });

  it('validates input, pane identity, mission ownership and the full scope', () => {
    const f = fixture();
    expect(() => f.engine.applyLeadership(scope, ' ', target)).toThrow();
    expect(() => f.engine.applyLeadership(scope, 'm', { ...target, paneId: 'wrong' })).toThrow('leadership_target_mismatch');
    f.sessions.set('new', { ...f.sessions.get('new')!, missionId: 'another' });
    expect(() => f.engine.applyLeadership(scope, 'm', target)).toThrow('leadership_scope_mismatch');
    f.sessions.set('new', { ...f.sessions.get('new')!, missionId: 'm', scope: { ...scope, checkoutId: 'another' } });
    expect(() => f.engine.applyLeadership(scope, 'm', target)).toThrow('leadership_scope_mismatch');
    expect(f.calls).toEqual([]);
  });
});
