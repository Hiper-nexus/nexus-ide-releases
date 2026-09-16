import { describe, expect, it, vi } from 'vitest';
import { testProjectScope } from './__tests__/scope-fixture';
import {
  MissionLeadership,
  MissionLeadershipError,
  sameLeadershipScope,
  type LeadershipClaim,
  type LeadershipChange,
  type LeadershipRelease,
  type LeadershipSession,
  type MissionLeadershipPorts,
} from './mission-leadership';

const scope = testProjectScope();
const target = { sessionId: 'new', paneId: 'pane-new', origin: 'adopt' as const };
const sources = ['fast-lane', 'mission-panes', 'gate', 'panes', 'renderer'] as const;
const states = ['busy', 'idle', 'spawning', 'exited', 'hibernated', 'unknown', undefined];

function fixture(operatorTakeover = false) {
  let durable: string | null = null;
  let claims: LeadershipClaim[] = [];
  const sessions = new Map<string, LeadershipSession>();
  const calls: string[] = [];
  const events: LeadershipChange[] = [];
  const releases: LeadershipRelease[] = [];
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
    clearDurableLeaderIfMatches: (_mission, sessionId) => {
      if (durable !== sessionId) return false;
      calls.push('clear-A');
      durable = null;
      return true;
    },
    releasePaneLeader: () => {
      calls.push('clear-C');
      claims = claims.filter((c) => c.source !== 'mission-panes');
      return true;
    },
    captureReleaseRuntime: () => structuredClone(claims.filter((c) => c.source !== 'mission-panes')),
    releaseRuntimeLeader: () => {
      calls.push('clear-D');
      claims = claims.filter((c) => c.source === 'mission-panes' || c.source === 'renderer');
      return true;
    },
    emitLeadershipReleased: (event) => { calls.push('release-F'); releases.push(event); },
  };
  const forScope = vi.fn(() => ports);
  const engine = new MissionLeadership({ forScope, authorizeTakeover: () => operatorTakeover });
  const session = (id: string, state: string | undefined = 'idle') => {
    sessions.set(id, { sessionId: id, paneId: `pane-${id}`, scope, missionId: 'm', state });
  };
  session('new');
  return {
    engine, ports, forScope, sessions, session, calls, events, releases,
    get durable() { return durable; },
    set durable(value: string | null) { durable = value; },
    get claims() { return claims; },
    set claims(value: LeadershipClaim[]) { claims = value; },
  };
}

describe('revised leadership contracts', () => {
  it.each(['busy', 'idle', 'spawning'])('operator takeover replaces a %s leader and preserves both processes', (state) => {
    const f = fixture(true);
    f.session('old', state);
    f.engine.applyLeadership(scope, 'm', { sessionId: 'old', paneId: 'pane-old', origin: 'spawn' });
    const physical = structuredClone([...f.sessions]);
    f.calls.length = 0;
    const result = f.engine.applyLeadership(scope, 'm', { ...target, origin: 'takeover', reason: 'Operador escolheu outro painel' });
    expect(result.event).toMatchObject({ origin: 'takeover', reason: 'Operador escolheu outro painel', previousSessionIds: ['old'], previousPaneIds: ['pane-old'] });
    expect(f.calls).toEqual(['A', 'C', 'D', 'commit', 'F']);
    expect([...f.sessions]).toEqual(physical);
    expect(f.durable).toBe('new');
    expect(f.claims.every((claim) => claim.sessionId === 'new')).toBe(true);
    expect(() => f.engine.assertSingleLeader(scope, 'm')).not.toThrow();
  });

  it.each(['promote', 'adopt'] as const)('%s still rejects live predecessors with operator takeover permission', (origin) => {
    const f = fixture(true);
    f.durable = 'old';
    f.session('old');
    expect(() => f.engine.applyLeadership(scope, 'm', { ...target, origin }))
      .toThrow(expect.objectContaining({ code: 'existing_session' }));
    expect(f.calls).toEqual([]);
  });

  it('takeover requires a nonblank reason before accessing stores', () => {
    const f = fixture(true);
    for (const reason of [undefined, '', ' \n\t ']) {
      const input = { ...target, origin: 'takeover', reason } as unknown as Parameters<typeof f.engine.applyLeadership>[2];
      expect(() => f.engine.applyLeadership(scope, 'm', input))
        .toThrow(expect.objectContaining({ code: 'write_incomplete' }));
    }
    expect(f.forScope).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
  });

  it('takeover denies missing operator authority even with a valid reason or forged flag', () => {
    const f = fixture();
    const takeover = { ...target, origin: 'takeover' as const, reason: 'Trocar líder' };
    expect(() => f.engine.applyLeadership(scope, 'm', takeover))
      .toThrow(expect.objectContaining({ code: 'scope_mismatch' }));
    const noAuthority = new MissionLeadership({ forScope: f.forScope });
    expect(() => noAuthority.applyLeadership(scope, 'm', takeover))
      .toThrow(expect.objectContaining({ code: 'scope_mismatch' }));
    expect(() => f.engine.applyLeadership(scope, 'm', { ...takeover, operator: true } as typeof takeover)).toThrow();
    expect(f.forScope).not.toHaveBeenCalled();
  });

  it('takeover without a live predecessor behaves like promote and still rejects unverifiable', () => {
    for (const state of ['absent', 'exited', 'unknown']) {
      const f = fixture(true);
      if (state !== 'absent') { f.durable = 'old'; f.session('old', state); }
      const run = () => f.engine.applyLeadership(scope, 'm', { ...target, origin: 'takeover', reason: 'Escolha do operador' });
      if (state === 'unknown') expect(run).toThrow(expect.objectContaining({ code: 'existing_session' }));
      else expect(run().leader.sessionId).toBe('new');
    }
  });

  it('takeover uses the same postconditions and compensation after partial demotion', () => {
    const f = fixture(true);
    f.session('old');
    f.engine.applyLeadership(scope, 'm', { sessionId: 'old', paneId: 'pane-old', origin: 'spawn' });
    const before = structuredClone(f.claims);
    const write = f.ports.replaceRuntimeLeader;
    f.ports.replaceRuntimeLeader = (...args) => {
      write(...args);
      f.claims.push({ source: 'gate', sessionId: 'old', paneId: 'pane-old' });
      return true;
    };
    expect(() => f.engine.applyLeadership(scope, 'm', { ...target, origin: 'takeover', reason: 'Troca do operador' }))
      .toThrow(expect.objectContaining({ code: 'split_brain' }));
    expect(f.durable).toBe('old');
    expect(f.claims).toEqual(before);
    expect(f.events).toHaveLength(1);
  });

  it('create accepts the creator already in A, or the initial empty binding', () => {
    for (const durable of [null, 'new']) {
      const f = fixture();
      f.durable = durable;
      const result = f.engine.applyLeadership(scope, 'm', { ...target, origin: 'create' });
      expect(result.leader.sessionId).toBe('new');
      expect(f.events).toHaveLength(1);
      expect(f.events[0].origin).toBe('create');
    }
  });

  it('create cannot replace a predecessor, including dead and unregistered leaders', () => {
    for (const state of ['idle', 'exited', 'unknown', 'absent']) {
      const f = fixture();
      f.durable = 'old';
      if (state !== 'absent') f.session('old', state);
      expect(() => f.engine.applyLeadership(scope, 'm', { ...target, origin: 'create' }))
        .toThrow(expect.objectContaining({ code: 'existing_session' }));
      expect(f.calls).toEqual([]);
    }
  });

  it('create rejects pane-only evidence of a different predecessor', () => {
    const f = fixture();
    f.claims = [{ source: 'mission-panes', sessionId: null, paneId: 'previous' }];
    expect(() => f.engine.applyLeadership(scope, 'm', { ...target, origin: 'create' }))
      .toThrow(expect.objectContaining({ code: 'existing_session' }));
  });

  it('release commits CAS A, demotion C and revocation D before its event', () => {
    const f = fixture();
    f.engine.applyLeadership(scope, 'm', target);
    f.calls.length = 0;
    const physical = structuredClone([...f.sessions]);
    expect(f.engine.releaseLeadership(scope, 'm', { sessionId: 'new', reason: 'teardown' }))
      .toMatchObject({ released: true, rendererNotified: true });
    expect(f.calls).toEqual(['clear-A', 'clear-C', 'clear-D', 'commit', 'release-F']);
    expect(f.releases).toEqual([expect.objectContaining({
      type: 'mission-leadership-released', missionId: 'm', sessionId: 'new', reason: 'teardown', paneIds: ['pane-new'],
    })]);
    expect(f.engine.resolveMissionLeader(scope, 'm')).toBeNull();
    expect([...f.sessions]).toEqual(physical);
    expect(f.engine.releaseLeadership(scope, 'm', { sessionId: 'new', reason: 'duplicate' })).toEqual({ released: false });
    expect(f.releases).toHaveLength(1);
  });

  it('release cannot clear a successor, even if the CAS loses inside the transaction', () => {
    const f = fixture();
    f.engine.applyLeadership(scope, 'm', target);
    f.calls.length = 0;
    const transact = f.ports.transaction;
    f.ports.transaction = (commit) => { f.durable = 'successor'; transact(commit); };
    expect(f.engine.releaseLeadership(scope, 'm', { sessionId: 'new', reason: 'late-exit' })).toEqual({ released: false });
    expect(f.durable).toBe('successor');
    expect(f.calls).toEqual(['commit']);
    expect(f.releases).toEqual([]);
    expect(f.engine.releaseLeadership(scope, 'm', { sessionId: 'new', reason: 'late-exit' })).toEqual({ released: false });
  });

  it.each(['releasePaneLeader', 'releaseRuntimeLeader'] as const)('rolls back a partial %s', (method) => {
    const f = fixture();
    f.engine.applyLeadership(scope, 'm', target);
    const before = structuredClone(f.claims);
    const release = f.ports[method];
    f.ports[method] = (...args) => { release(...args); return false; };
    expect(() => f.engine.releaseLeadership(scope, 'm', { sessionId: 'new', reason: 'teardown' }))
      .toThrow(expect.objectContaining({ code: 'write_incomplete' }));
    expect(f.durable).toBe('new');
    expect(f.claims).toEqual(before);
    expect(f.releases).toEqual([]);
  });

  it('release works after the PTY disappears and reports committed notification failure', () => {
    const f = fixture();
    f.engine.applyLeadership(scope, 'm', target);
    f.sessions.clear();
    f.ports.emitLeadershipReleased = () => { throw new Error('renderer unavailable'); };
    expect(f.engine.releaseLeadership(scope, 'm', { sessionId: 'new', reason: 'exited' }))
      .toMatchObject({ released: true, rendererNotified: false });
    expect(f.durable).toBeNull();
  });

  it('release rejects conflicting authority and cannot succeed after a no-op revoke', () => {
    const f = fixture();
    f.engine.applyLeadership(scope, 'm', target);
    f.claims.push({ source: 'gate', sessionId: 'other', paneId: 'pane-other' });
    expect(() => f.engine.releaseLeadership(scope, 'm', { sessionId: 'new', reason: 'exit' }))
      .toThrow(expect.objectContaining({ code: 'split_brain' }));
    f.claims = f.claims.filter((c) => c.sessionId !== 'other');
    f.ports.releaseRuntimeLeader = () => true;
    expect(() => f.engine.releaseLeadership(scope, 'm', { sessionId: 'new', reason: 'exit' }))
      .toThrow(expect.objectContaining({ code: 'write_incomplete' }));
    expect(f.durable).toBe('new');
  });

  it('exposes all seven typed domain error codes with no gate/context data', () => {
    const cases = [
      ['split_brain', (f: ReturnType<typeof fixture>) => { f.durable = 'old'; f.session('old'); f.claims = [{ source: 'gate', sessionId: 'new', paneId: 'pane-new' }]; return () => f.engine.resolveMissionLeader(scope, 'm'); }],
      ['existing_session', (f: ReturnType<typeof fixture>) => { f.durable = 'old'; f.session('old'); return () => f.engine.applyLeadership(scope, 'm', target); }],
      ['target_not_live', (f: ReturnType<typeof fixture>) => { f.session('new', 'exited'); return () => f.engine.applyLeadership(scope, 'm', target); }],
      ['write_incomplete', (f: ReturnType<typeof fixture>) => { f.ports.setDurableLeader = () => false; return () => f.engine.applyLeadership(scope, 'm', target); }],
      ['scope_mismatch', (f: ReturnType<typeof fixture>) => { f.sessions.set('new', { ...f.sessions.get('new')!, scope: { ...scope, checkoutId: 'other' } }); return () => f.engine.applyLeadership(scope, 'm', target); }],
      ['busy', (f: ReturnType<typeof fixture>) => { f.ports.setDurableLeader = () => { f.engine.resolveMissionLeader(scope, 'm'); return true; }; return () => f.engine.applyLeadership(scope, 'm', target); }],
      ['mission_missing', (f: ReturnType<typeof fixture>) => { f.ports.readMission = () => null; return () => f.engine.applyLeadership(scope, 'm', target); }],
    ] as const;
    for (const [code, setup] of cases) {
      const operation = setup(fixture());
      let error: unknown;
      try { operation(); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(MissionLeadershipError);
      expect(error).toMatchObject({ code });
      expect(Object.isFrozen((error as MissionLeadershipError).payload)).toBe(true);
    }
  });

  it('normalizes legacy XOR filesystem identities without merging distinct workspaces', () => {
    const complete = { ...scope, workspaceRootDevice: '1', workspaceRootInode: '2' };
    for (const legacy of [scope, { ...scope, workspaceRootDevice: '1' }, { ...scope, workspaceRootInode: '2' }]) {
      const f = fixture();
      f.sessions.set('new', { ...f.sessions.get('new')!, scope: complete });
      expect(f.engine.applyLeadership(legacy, 'm', target).leader.proven).toBe(true);
      expect(sameLeadershipScope(legacy, complete)).toBe(true);
      expect(sameLeadershipScope(legacy, { ...complete, checkoutId: 'foreign' })).toBe(false);
    }
    expect(sameLeadershipScope(complete, { ...complete, workspaceRootInode: '3' })).toBe(false);
  });

  it('uses the same busy guard for complete and legacy scope identities, including release', () => {
    const f = fixture();
    const write = f.ports.setDurableLeader;
    f.ports.setDurableLeader = (...args) => {
      for (const legacy of [scope, { ...scope, workspaceRootDevice: '1' }]) {
        expect(() => f.engine.releaseLeadership(legacy, 'm', { sessionId: 'new', reason: 'exit' }))
          .toThrow(expect.objectContaining({ code: 'busy' }));
      }
      return write(...args);
    };
    f.engine.applyLeadership({ ...scope, workspaceRootDevice: '1', workspaceRootInode: '2' }, 'm', target);
  });

  it('validation and typed diagnostic payloads never echo unknown token/context fields', () => {
    const f = fixture();
    const secret = 'secret-for-redaction-test';
    const input = { ...target, token: secret };
    let error: unknown;
    try { f.engine.applyLeadership(scope, 'm', input); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(MissionLeadershipError);
    expect(error).toMatchObject({ code: 'write_incomplete' });
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
    const payload = { missionId: 'm', token: secret, context: { token: secret } };
    expect(JSON.stringify(new MissionLeadershipError('scope_mismatch', payload))).not.toContain(secret);
  });
});

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
      liveness: 'exited',
    });
    expect(() => f.engine.assertSingleLeader(scope, 'm')).toThrow('leadership_split_brain');
  });

  it('does not invent a pane for a durable session lost on restart', () => {
    const f = fixture();
    f.durable = 'lost';
    expect(f.engine.resolveMissionLeader(scope, 'm')).toEqual({
      sessionId: 'lost', paneId: null, source: 'durable', proven: false,
      liveness: 'unregistered',
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

  it('spawn/respawn accept exited records but reject live/unverifiable predecessors', () => {
    for (const origin of ['spawn', 'respawn'] as const) {
      for (const state of states) {
        const f = fixture();
        f.durable = 'old';
        f.session('old', state ?? 'unknown');
        if (state === 'exited' || state === 'hibernated') {
          expect(f.engine.applyLeadership(scope, 'm', { ...target, origin }).leader.sessionId).toBe('new');
        } else {
          expect(() => f.engine.applyLeadership(scope, 'm', { ...target, origin })).toThrow('leadership_existing_session');
        }
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
