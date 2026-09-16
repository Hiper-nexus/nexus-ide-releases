// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { testProjectScope } from './__tests__/scope-fixture';
import {
  MissionLeadership,
  type LeadershipClaim,
  type LeadershipChange,
  type LeadershipRelease,
  type LeadershipSession,
  type MissionLeadershipPorts,
} from './mission-leadership';

const scope = testProjectScope();

const holder = vi.hoisted(() => ({ engine: undefined as unknown }));
vi.mock('./mission-leadership-runtime', () => ({
  getMissionLeadership: () => holder.engine,
}));

const { requireMissionLeaderSession } = await import('./mission-leader-gate');

/** Mirrors the lightweight in-memory fixture from mission-leadership.test.ts. */
function fixture() {
  let durable: string | null = null;
  let claims: LeadershipClaim[] = [];
  const sessions = new Map<string, LeadershipSession>();
  const events: LeadershipChange[] = [];
  const releases: LeadershipRelease[] = [];
  const ports: MissionLeadershipPorts<LeadershipClaim[]> = {
    readMission: () => ({ orchestratorSessionId: durable }),
    readClaims: () => claims,
    readSession: (id) => sessions.get(id) ?? null,
    transaction: (commit) => commit(),
    setDurableLeader: (_mission, leader) => { durable = leader.sessionId; return true; },
    replacePaneLeader: (_mission, leader) => {
      claims = claims.filter((c) => c.source !== 'mission-panes');
      claims.push({ ...leader, source: 'mission-panes' });
      return true;
    },
    captureRuntime: () => structuredClone(claims.filter((c) => c.source !== 'mission-panes')),
    replaceRuntimeLeader: (_mission, leader) => {
      claims = claims.filter((c) => c.source === 'mission-panes' || c.source === 'renderer');
      for (const source of ['gate', 'fast-lane', 'panes'] as const) claims.push({ ...leader, source });
      return true;
    },
    restoreRuntime: (_mission, snapshot) => {
      claims = [...claims.filter((c) => c.source === 'mission-panes'), ...snapshot];
    },
    emitLeadershipChanged: (event) => { events.push(event); },
    clearDurableLeaderIfMatches: (_mission, sessionId) => {
      if (durable !== sessionId) return false;
      durable = null;
      return true;
    },
    releasePaneLeader: () => { claims = claims.filter((c) => c.source !== 'mission-panes'); return true; },
    captureReleaseRuntime: () => structuredClone(claims.filter((c) => c.source !== 'mission-panes')),
    releaseRuntimeLeader: () => {
      claims = claims.filter((c) => c.source === 'mission-panes' || c.source === 'renderer');
      return true;
    },
    emitLeadershipReleased: (event) => { releases.push(event); },
  };
  const forScope = vi.fn(() => ports);
  const engine = new MissionLeadership({ forScope });
  const session = (id: string, state: string | undefined = 'idle') => {
    sessions.set(id, { sessionId: id, paneId: `pane-${id}`, scope, missionId: 'm', state });
  };
  return {
    engine, session, events, releases,
    get claims() { return claims; },
    set claims(value: LeadershipClaim[]) { claims = value; },
  };
}

function useFixture() {
  const f = fixture();
  holder.engine = f.engine;
  return f;
}

describe('requireMissionLeaderSession', () => {
  it('never throws and denies with no-leader when the mission has no leader at all', () => {
    useFixture();
    expect(() => requireMissionLeaderSession(scope, 'm', { sessionId: 'anyone' })).not.toThrow();
    expect(requireMissionLeaderSession(scope, 'm', { sessionId: 'anyone' }))
      .toEqual({ ok: false, code: 'no-leader', hint: expect.any(String) });
  });

  it('passes when the candidate session is the proven current leader', () => {
    const f = useFixture();
    f.session('leader-a', 'busy');
    f.engine.applyLeadership(scope, 'm', { sessionId: 'leader-a', paneId: 'pane-leader-a', origin: 'spawn' });
    const result = requireMissionLeaderSession(scope, 'm', { sessionId: 'leader-a' });
    expect(result).toMatchObject({ ok: true, leader: { sessionId: 'leader-a', proven: true } });
  });

  it('resolves the current leader without a candidate session to compare against', () => {
    const f = useFixture();
    f.session('leader-a', 'busy');
    f.engine.applyLeadership(scope, 'm', { sessionId: 'leader-a', paneId: 'pane-leader-a', origin: 'spawn' });
    const result = requireMissionLeaderSession(scope, 'm', {});
    expect(result).toMatchObject({ ok: true, leader: { sessionId: 'leader-a' } });
  });

  it('denies a stale session pointing at a superseded leader with a named code', () => {
    const f = useFixture();
    f.session('leader-a', 'busy');
    f.engine.applyLeadership(scope, 'm', { sessionId: 'leader-a', paneId: 'pane-leader-a', origin: 'spawn' });
    const result = requireMissionLeaderSession(scope, 'm', { sessionId: 'old-session' });
    expect(result).toEqual({ ok: false, code: 'stale-session', hint: expect.any(String) });
  });

  it('denies an explicit but unknown candidate session (key present, value undefined) — never the same as omitting it', () => {
    const f = useFixture();
    f.session('leader-a', 'busy');
    f.engine.applyLeadership(scope, 'm', { sessionId: 'leader-a', paneId: 'pane-leader-a', origin: 'spawn' });
    const unboundCtx: { sessionId?: string | null } = { sessionId: undefined };
    const result = requireMissionLeaderSession(scope, 'm', unboundCtx);
    expect(result).toEqual({ ok: false, code: 'stale-session', hint: expect.any(String) });
  });

  it('denies an unproven leader (durable but not classified live)', () => {
    const f = useFixture();
    f.session('leader-a', 'busy');
    f.engine.applyLeadership(scope, 'm', { sessionId: 'leader-a', paneId: 'pane-leader-a', origin: 'spawn' });
    // The physical process exited after leadership was applied: the durable
    // record still points at it, but it is no longer classified live.
    f.session('leader-a', 'exited');
    const result = requireMissionLeaderSession(scope, 'm', { sessionId: 'leader-a' });
    expect(result).toEqual({ ok: false, code: 'unproven', hint: expect.any(String) });
  });

  it('denies split-brain with a named code and never throws or wedges the mission', () => {
    const f = useFixture();
    f.session('leader-a', 'busy');
    f.session('leader-b', 'busy');
    f.claims = [
      { source: 'gate', sessionId: 'leader-a', paneId: 'pane-leader-a' },
      { source: 'fast-lane', sessionId: 'leader-b', paneId: 'pane-leader-b' },
    ];
    expect(() => requireMissionLeaderSession(scope, 'm', { sessionId: 'leader-a' })).not.toThrow();
    const result = requireMissionLeaderSession(scope, 'm', { sessionId: 'leader-a' });
    expect(result).toEqual({ ok: false, code: 'split-brain', hint: expect.any(String) });
  });

  it('a worker session sharing the leader id is not itself a role grant: callers still own the role capability check', () => {
    const f = useFixture();
    f.session('leader-a', 'busy');
    f.engine.applyLeadership(scope, 'm', { sessionId: 'leader-a', paneId: 'pane-leader-a', origin: 'spawn' });
    const result = requireMissionLeaderSession(scope, 'm', { sessionId: 'worker-b' });
    expect(result).toMatchObject({ ok: false, code: 'stale-session' });
  });
});
