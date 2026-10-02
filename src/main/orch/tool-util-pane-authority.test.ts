import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentGateContext } from './gate';
import type { CallerCtx, PaneAuthzInfo } from './pane-authz';
import { testProjectScope } from './__tests__/scope-fixture';
import { authorizePaneRef } from './tool-util';

const h = vi.hoisted(() => ({
  panes: new Map<string, PaneAuthzInfo>(),
  owner: vi.fn((caller: CallerCtx): CallerCtx => ({ ...caller, ownerWebContentsId: 44 })),
}));
vi.mock('./pane-registry', () => ({
  getPaneAuthzInfo: (ref: string) => h.panes.get(ref) ?? null,
  callerWithPaneOwner: h.owner,
  listPaneSnapshots: () => [],
  listLivePaneNumbers: () => [],
}));
// As in the existing tool-util suites, keep the native PTY graph outside this
// authorization test. The pane gate and browser-owner decision remain real.
vi.mock('../pty/pty-manager', () => ({
  getAgentSessionInfo: vi.fn(() => null),
  getSessionState: vi.fn(() => 'idle'),
  isSessionStdinWritable: vi.fn(() => true),
  orchWriteSession: vi.fn(() => true),
  orchTerminateSession: vi.fn(async () => true),
  tapSessionData: vi.fn(() => () => {}),
  tapSessionExit: vi.fn(() => () => {}),
  tapSessionState: vi.fn(() => () => {}),
}));

const scope = testProjectScope({ projectId: 'project-a', checkoutId: 'checkout-a',
  rootRealPath: '/workspace/project-a' });
const caller: AgentGateContext = {
  token: 'pane-authority-token', label: 'worker-a', role: 'worker', sessionId: 'session-a',
  missionId: 'mission-a', scope, allowedTools: [], allowedSkills: null,
  stopAttempts: 0, handoffSubmitted: false,
};

describe('pane authorization origin boundary', () => {
  beforeEach(() => {
    h.panes.clear();
    h.owner.mockReset();
    h.owner.mockImplementation((ctx) => ({ ...ctx, ownerWebContentsId: 44 }));
  });

  it('authorizes a same-mission terminal peer without requiring a browser owner', () => {
    h.panes.set('peer', { paneId: 'peer', kind: 'cli-agent', sessionId: 'session-b',
      missionId: 'mission-a', role: 'worker', scope });
    h.owner.mockImplementation(() => { throw new Error('browser origin unavailable'); });
    expect(authorizePaneRef(caller, 'peer', 'read').paneId).toBe('peer');
  });

  it('preserves the terminal mission denial when browser ownership is unavailable', () => {
    h.panes.set('foreign-peer', { paneId: 'foreign-peer', kind: 'cli-agent', sessionId: 'session-b',
      missionId: 'mission-b', role: 'worker', scope });
    h.owner.mockImplementation(() => { throw new Error('browser origin unavailable'); });
    expect(() => authorizePaneRef(caller, 'foreign-peer', 'read')).toThrow(/another mission/);
  });

  it('uses the Main-derived owner for browser access', () => {
    h.panes.set('browser', { paneId: 'browser', kind: 'browser', sessionId: null,
      missionId: 'mission-a', role: 'worker', scope, ownerWebContentsId: 44 });
    const claimedOwner: AgentGateContext & CallerCtx = { ...caller, ownerWebContentsId: 99 };
    expect(authorizePaneRef(claimedOwner, 'browser', 'write').paneId).toBe('browser');
  });

  it("keeps the operator's own tab out of a worker's reach even in the right window", () => {
    h.panes.set('operator-tab', { paneId: 'operator-tab', kind: 'browser', sessionId: null,
      scope, ownerWebContentsId: 44 });
    expect(() => authorizePaneRef(caller, 'operator-tab', 'read')).toThrow(/another mission/);
    expect(() => authorizePaneRef(caller, 'operator-tab', 'write')).toThrow(/another mission/);
  });

  it('rejects a browser from another originating window', () => {
    h.panes.set('browser', { paneId: 'browser', kind: 'browser', sessionId: null,
      missionId: 'mission-a', role: 'worker', scope, ownerWebContentsId: 45 });
    const claimedOwner: AgentGateContext & CallerCtx = { ...caller, ownerWebContentsId: 45 };
    expect(() => authorizePaneRef(claimedOwner, 'browser', 'write')).toThrow(/another originating window/);
  });
});
