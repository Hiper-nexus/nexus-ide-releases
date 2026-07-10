import { describe, expect, it } from 'vitest';
import {
  authorizePaneAccess,
  canListPane,
  type CallerCtx,
  type PaneAuthzInfo,
} from './pane-authz';
import { testProjectScope } from './__tests__/scope-fixture';

const scope = testProjectScope({ projectId: 'project-a', checkoutId: 'checkout-a' });
const worker: CallerCtx = { role: 'worker', missionId: 'm1', sessionId: 'wself', scope };
const orchestrator: CallerCtx = {
  role: 'orchestrator',
  missionId: 'm1',
  sessionId: 'oself',
  scope,
};
const user: CallerCtx = { role: 'user', sessionId: 'uself', scope };

function pane(over: Partial<PaneAuthzInfo>): PaneAuthzInfo {
  return {
    paneId: 'p',
    sessionId: 'sess',
    kind: 'cli-agent',
    missionId: 'm1',
    role: 'worker',
    scope,
    ...over,
  };
}

describe('authorizePaneAccess', () => {
  it('always allows acting on your own pane', () => {
    const own = pane({ sessionId: 'wself', missionId: 'other', kind: 'shell' });
    expect(authorizePaneAccess(worker, own, 'write').allow).toBe(true);
  });

  it('lets a worker read/write a cli-agent pane in its own mission', () => {
    const peer = pane({ sessionId: 'peer', missionId: 'm1' });
    expect(authorizePaneAccess(worker, peer, 'read').allow).toBe(true);
    expect(authorizePaneAccess(worker, peer, 'write').allow).toBe(true);
  });

  it('blocks a worker from another mission (read AND write)', () => {
    const foreign = pane({ sessionId: 'x', missionId: 'm2' });
    expect(authorizePaneAccess(worker, foreign, 'read').allow).toBe(false);
    expect(authorizePaneAccess(worker, foreign, 'write').allow).toBe(false);
  });

  it("blocks a worker from the user's shell pane", () => {
    const shell = pane({ sessionId: 'sh', kind: 'shell', missionId: undefined, role: undefined });
    const decision = authorizePaneAccess(worker, shell, 'read');
    expect(decision.allow).toBe(false);
    expect(decision.reason).toMatch(/shell/);
  });

  it("blocks a worker from the user's browser pane", () => {
    const browser = pane({ sessionId: null, kind: 'browser', missionId: undefined, role: undefined });
    const decision = authorizePaneAccess(worker, browser, 'write');
    expect(decision.allow).toBe(false);
    expect(decision.reason).toMatch(/browser/);
  });

  it('blocks cross-mission browser navigation', () => {
    const browser = pane({ sessionId: null, kind: 'browser', missionId: 'm2', role: undefined });
    expect(authorizePaneAccess(orchestrator, browser, 'write').allow).toBe(false);
  });

  it('lets the orchestrator navigate browser panes in its own mission', () => {
    const browser = pane({ sessionId: null, kind: 'browser', missionId: 'm1', role: undefined });
    expect(authorizePaneAccess(orchestrator, browser, 'write').allow).toBe(true);
  });

  it('lets a worker observe but not drive the orchestrator pane', () => {
    const orch = pane({ sessionId: 'o', role: 'orchestrator', missionId: 'm1' });
    expect(authorizePaneAccess(worker, orch, 'read').allow).toBe(true);
    expect(authorizePaneAccess(worker, orch, 'wait').allow).toBe(true);
    expect(authorizePaneAccess(worker, orch, 'write').allow).toBe(false);
    expect(authorizePaneAccess(worker, orch, 'close').allow).toBe(false);
  });

  it('lets the orchestrator drive worker panes in its own mission', () => {
    const w = pane({ sessionId: 'w', role: 'worker', missionId: 'm1' });
    expect(authorizePaneAccess(orchestrator, w, 'write').allow).toBe(true);
    expect(authorizePaneAccess(orchestrator, w, 'close').allow).toBe(true);
  });

  it('blocks the orchestrator from another mission', () => {
    const w = pane({ sessionId: 'w', missionId: 'm2' });
    expect(authorizePaneAccess(orchestrator, w, 'read').allow).toBe(false);
  });

  it('treats the user role as unrestricted', () => {
    const anything = pane({ sessionId: 'z', missionId: 'm9', kind: 'shell' });
    expect(authorizePaneAccess(user, anything, 'write').allow).toBe(true);
  });

  it('blocks another checkout before own-session and user-role shortcuts', () => {
    const foreignScope = testProjectScope({
      projectId: 'project-a',
      checkoutId: 'checkout-b',
    });
    const sameSession = pane({ sessionId: 'wself', scope: foreignScope });
    const userTarget = pane({ sessionId: 'z', scope: foreignScope });

    expect(authorizePaneAccess(worker, sameSession, 'read').allow).toBe(false);
    expect(authorizePaneAccess(user, userTarget, 'write').allow).toBe(false);
  });

  it('fails closed for a pane without trusted project metadata', () => {
    expect(authorizePaneAccess(user, pane({ scope: undefined }), 'read').allow).toBe(false);
  });
});

describe('canListPane', () => {
  it('hides other missions and shells from a worker, shows its own mission', () => {
    expect(canListPane(worker, pane({ sessionId: 'a', missionId: 'm1' }))).toBe(true);
    expect(canListPane(worker, pane({ sessionId: 'b', missionId: 'm2' }))).toBe(false);
    expect(canListPane(worker, pane({ sessionId: 'c', kind: 'shell', missionId: undefined }))).toBe(false);
  });
});

describe('authorizePaneAccess — user-opened browser pane', () => {
  const userOpenedBrowser = pane({
    sessionId: null,
    kind: 'browser',
    missionId: undefined,
    role: undefined,
  });

  it('allows the user only inside the same trusted project checkout', () => {
    expect(authorizePaneAccess(user, userOpenedBrowser, 'read').allow).toBe(true);
    expect(authorizePaneAccess(user, userOpenedBrowser, 'write').allow).toBe(true);
  });

  it('keeps mission agents out of a user-owned browser surface', () => {
    expect(authorizePaneAccess(orchestrator, userOpenedBrowser, 'read').allow).toBe(false);
    expect(authorizePaneAccess(worker, userOpenedBrowser, 'read').allow).toBe(false);
  });
});
