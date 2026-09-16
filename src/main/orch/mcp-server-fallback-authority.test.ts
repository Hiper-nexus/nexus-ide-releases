import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testProjectScope } from './__tests__/scope-fixture';

vi.mock('electron', () => ({
  app: {
    getVersion: () => 'test',
    getPath: () => path.join(os.homedir(), '.nexus-test-user-data'),
  },
  dialog: { showMessageBox: vi.fn() },
}));

const domainStoreMocks = vi.hoisted(() => ({
  getProjectDomainStores: vi.fn(),
}));
vi.mock('./project-domain-store-registry', () => ({
  getProjectDomainStores: domainStoreMocks.getProjectDomainStores,
}));

const missionLeaderGateMocks = vi.hoisted(() => ({
  requireMissionLeaderSession: vi.fn(),
}));
vi.mock('./mission-leader-gate', () => ({
  requireMissionLeaderSession: missionLeaderGateMocks.requireMissionLeaderSession,
}));

import { bindTokenToSession, mintToken, resetGateForTests } from './gate';
import { currentPtyMaestroContext } from './mcp-server';

const scope = testProjectScope();
const missionId = 'mission-fallback-v1';

function approvedMission(orchestratorSessionId: string) {
  return {
    id: missionId,
    orchestratorSessionId,
    intentVersion: 1,
    intentContract: {
      goal: 'legacy pty stream fallback',
      approvedAt: 100,
      intentVersion: 1,
      orchestratorRuntime: { nativeReadOnly: false },
    },
  };
}

function orchestratorCtx(sessionId: string) {
  const ctx = mintToken({ label: sessionId, role: 'orchestrator', missionId, scope });
  bindTokenToSession(ctx.token, sessionId);
  return ctx;
}

afterEach(() => {
  resetGateForTests();
  vi.clearAllMocks();
});

describe('currentPtyMaestroContext (legacy NEXUS_HANDOFF v1 fallback)', () => {
  it('accepts the proven current mission leader', () => {
    orchestratorCtx('leader-session');
    domainStoreMocks.getProjectDomainStores.mockReturnValue({
      missions: { get: () => approvedMission('leader-session') },
    });
    missionLeaderGateMocks.requireMissionLeaderSession.mockReturnValue({
      ok: true,
      leader: { sessionId: 'leader-session', paneId: 'pane-1', source: 'durable', proven: true },
    });

    expect(currentPtyMaestroContext('leader-session')).not.toBeNull();
    expect(missionLeaderGateMocks.requireMissionLeaderSession).toHaveBeenCalledWith(
      scope, missionId, { sessionId: 'leader-session' },
    );
  });

  it('denies a stale orchestrator token superseded by a new leader', () => {
    // The raw durable field still names this session — only the resolver
    // (mocked below) knows it has been superseded.
    orchestratorCtx('old-session');
    domainStoreMocks.getProjectDomainStores.mockReturnValue({
      missions: { get: () => approvedMission('old-session') },
    });
    missionLeaderGateMocks.requireMissionLeaderSession.mockReturnValue({
      ok: false, code: 'stale-session', hint: 'outra sessão assumiu a missão',
    });

    expect(currentPtyMaestroContext('old-session')).toBeNull();
  });

  it('denies split-brain instead of guessing a winner from the PTY stream', () => {
    orchestratorCtx('leader-a');
    domainStoreMocks.getProjectDomainStores.mockReturnValue({
      missions: { get: () => approvedMission('leader-a') },
    });
    missionLeaderGateMocks.requireMissionLeaderSession.mockReturnValue({
      ok: false, code: 'split-brain', hint: 'duas sessões vivas',
    });

    expect(currentPtyMaestroContext('leader-a')).toBeNull();
  });

  it('a worker token never reaches the leader resolver (role capability stays first)', () => {
    const ctx = mintToken({ label: 'worker-a', role: 'worker', missionId, scope });
    bindTokenToSession(ctx.token, 'worker-a');

    expect(currentPtyMaestroContext('worker-a')).toBeNull();
    expect(missionLeaderGateMocks.requireMissionLeaderSession).not.toHaveBeenCalled();
  });
});
