import { describe, expect, it } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  authorizeAutomatedReviewBrowserAccess,
  authorizePaneAccess,
  canListPane,
  type CallerCtx,
  type PaneAuthzInfo,
} from './pane-authz';
import { testProjectScope } from './__tests__/scope-fixture';

const scope = testProjectScope({ projectId: 'project-a', checkoutId: 'checkout-a' });
const worker: CallerCtx = { role: 'worker', missionId: 'm1', sessionId: 'wself', scope, ownerWebContentsId: 1 };
const orchestrator: CallerCtx = {
  role: 'orchestrator',
  missionId: 'm1',
  sessionId: 'oself',
  scope,
  ownerWebContentsId: 1,
};
const user: CallerCtx = { role: 'user', sessionId: 'uself', scope, ownerWebContentsId: 1 };

function pane(over: Partial<PaneAuthzInfo>): PaneAuthzInfo {
  return {
    paneId: 'p',
    sessionId: 'sess',
    kind: 'cli-agent',
    missionId: 'm1',
    role: 'worker',
    scope,
    ownerWebContentsId: 1,
    ...over,
  };
}

describe('authorizePaneAccess', () => {
  it('confines worker write/close to the same execution worktree, keeping cross-worktree observation', () => {
    const isolated = { ...worker, executionScope: { ...scope, rootRealPath: '/worktrees/a' } };
    const peer = pane({ executionScope: { ...scope, rootRealPath: '/worktrees/b' } });
    for (const action of ['write', 'close'] as const) {
      expect(authorizePaneAccess(isolated, peer, action).allow).toBe(false);
      expect(authorizePaneAccess(worker, peer, action).allow).toBe(false);
      expect(authorizePaneAccess(isolated, pane({ executionScope: isolated.executionScope }), action).allow).toBe(true);
      expect(authorizePaneAccess(orchestrator, peer, action).allow).toBe(true);
    }
    expect(authorizePaneAccess(isolated, peer, 'read').allow).toBe(true);
    expect(authorizePaneAccess(isolated, peer, 'wait').allow).toBe(true);
    expect(authorizePaneAccess(isolated, pane({}), 'write').allow).toBe(false);
  });
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

  it("blocks a worker from the operator's browser tab, even in the same window", () => {
    const browser = pane({ sessionId: null, kind: 'browser', missionId: undefined, role: undefined });
    const decision = authorizePaneAccess(worker, browser, 'write');
    expect(decision.allow).toBe(false);
    expect(decision.reason).toMatch(/mission/);
  });

  it('lets a worker control a browser pane of its OWN mission in its originating window', () => {
    const own = pane({ sessionId: null, kind: 'browser', missionId: 'm1', role: 'worker' });
    for (const action of ['read', 'wait', 'write', 'close'] as const) {
      expect(authorizePaneAccess(worker, own, action).allow).toBe(true);
    }
    expect(canListPane(worker, own)).toBe(true);
  });

  it('denies a caller without a mission a browser pane without a mission (undefined is not a match)', () => {
    const { missionId: _mission, ...noMission } = worker;
    const operatorTab = pane({ sessionId: null, kind: 'browser', missionId: undefined, role: undefined });
    for (const caller of [noMission as CallerCtx, { ...noMission, role: 'orchestrator' } as CallerCtx]) {
      for (const action of ['read', 'wait', 'write', 'close'] as const) {
        expect(authorizePaneAccess(caller, operatorTab, action).allow).toBe(false);
      }
      expect(canListPane(caller, operatorTab)).toBe(false);
    }
  });

  it('keeps a worker out of a browser pane that belongs to another window or mission', () => {
    const foreignWindow = pane({ sessionId: null, kind: 'browser', missionId: 'm1', ownerWebContentsId: 2 });
    const foreignMission = pane({ sessionId: null, kind: 'browser', missionId: 'm2' });
    for (const target of [foreignWindow, foreignMission]) {
      expect(authorizePaneAccess(worker, target, 'read').allow).toBe(false);
      expect(authorizePaneAccess(worker, target, 'write').allow).toBe(false);
      expect(canListPane(worker, target)).toBe(false);
    }
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

  it('mão do operador adotada por missão mantém o alcance de antes; worker rebaixado não', () => {
    const adopted: CallerCtx = { ...orchestrator, promotedFromUserSession: true };
    const otherTab = pane({ missionId: undefined, role: undefined, kind: 'cli-agent' });
    expect(authorizePaneAccess(adopted, otherTab, 'read').allow).toBe(true);
    expect(authorizePaneAccess(adopted, pane({ missionId: 'm2' }), 'read').allow).toBe(true);
    expect(canListPane(adopted, otherTab)).toBe(true);
    const demoted: CallerCtx = { ...worker, promotedFromUserSession: true };
    expect(authorizePaneAccess(demoted, otherTab, 'read').allow).toBe(false);
    expect(authorizePaneAccess(orchestrator, otherTab, 'read').allow).toBe(false);
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

  it('F-231: Maestro lê/escreve o pane do operador, mas close é recusado ("só ele fecha")', () => {
    const op = pane({ sessionId: 's-op', operatorOpened: true });
    expect(authorizePaneAccess(orchestrator, op, 'read').allow).toBe(true);
    expect(authorizePaneAccess(orchestrator, op, 'write').allow).toBe(true);
    const close = authorizePaneAccess(orchestrator, op, 'close');
    expect(close.allow).toBe(false);
    expect(close.reason).toMatch(/aberto pelo operador/);
    // Nem worker da mesma missão fecha a mão do operador.
    expect(authorizePaneAccess(worker, op, 'close').allow).toBe(false);
    // O próprio operador (role user) continua fechando o que é dele.
    expect(authorizePaneAccess(user, op, 'close').allow).toBe(true);
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
    for (const caller of [worker, orchestrator]) {
      for (const action of ['read', 'wait', 'write', 'close'] as const) {
        expect(authorizePaneAccess(caller, userOpenedBrowser, action).allow).toBe(false);
      }
      expect(canListPane(caller, userOpenedBrowser)).toBe(false);
    }
  });

  it("an orchestrator promoted from the operator's own pane keeps the operator's reach in its window", () => {
    const promoted: CallerCtx = { ...orchestrator, promotedFromUserSession: true };
    for (const action of ['read', 'write', 'close'] as const) {
      expect(authorizePaneAccess(promoted, userOpenedBrowser, action).allow).toBe(true);
    }
    expect(authorizePaneAccess({ ...promoted, ownerWebContentsId: 2 }, userOpenedBrowser, 'read').allow).toBe(false);
  });

  it('denies foreign and missing Main owner identity to any caller that has a session', () => {
    for (const caller of [worker, orchestrator, user]) {
      for (const ownerWebContentsId of [undefined, 0, 2]) {
        const target = { ...userOpenedBrowser, ownerWebContentsId };
        expect(authorizePaneAccess(caller, target, 'write').allow).toBe(false);
        expect(canListPane(caller, target)).toBe(false);
      }
      expect(authorizePaneAccess({ ...caller, ownerWebContentsId: undefined }, userOpenedBrowser, 'read').allow).toBe(false);
    }
  });

  it("the operator's renderer hand (Jarvis/IPC, role user, no PTY session) keeps its reach in the exact scope", () => {
    const { sessionId: _session, ...rendererHand } = user;
    const handCtx: CallerCtx = { ...rendererHand, ownerWebContentsId: undefined };
    for (const action of ['read', 'wait', 'write', 'close'] as const) {
      expect(authorizePaneAccess(handCtx, userOpenedBrowser, action).allow).toBe(true);
    }
    expect(canListPane(handCtx, userOpenedBrowser)).toBe(true);
    // O escopo exato continua valendo para quem não tem sessão.
    expect(authorizePaneAccess(handCtx, { ...userOpenedBrowser, scope: { ...scope, rootRealPath: '/another/workspace' } }, 'read').allow).toBe(false);
  });

  it('lets the operator\'s own agent pane (role user, with session) use its own window tabs', () => {
    for (const action of ['read', 'write', 'close'] as const) {
      expect(authorizePaneAccess(user, userOpenedBrowser, action).allow).toBe(true);
    }
  });

  it('requires equality of every browser scope identity field', () => {
    const foreignScopes: ProjectExecutionScope[] = [
      { ...scope, version: 2 } as unknown as ProjectExecutionScope,
      { ...scope, installationId: 'other-installation' },
      { ...scope, projectId: 'other-project' },
      { ...scope, checkoutId: 'other-checkout' },
      { ...scope, rootRealPath: '/another/workspace' },
      { ...scope, identitySource: 'other' } as unknown as ProjectExecutionScope,
    ];
    for (const caller of [worker, orchestrator, user]) {
      for (const foreignScope of foreignScopes) {
        expect(authorizePaneAccess(caller, { ...userOpenedBrowser, scope: foreignScope }, 'read').allow).toBe(false);
      }
    }
  });
});

describe('authorizeAutomatedReviewBrowserAccess', () => {
  const boundBrowser = pane({
    paneId: 'browser-review',
    sessionId: null,
    kind: 'browser',
    missionId: 'm1',
    role: undefined,
  });
  const grant = {
    paneId: 'browser-review',
    missionId: 'm1',
    scope,
  };

  it('allows only read/wait on the exact mission and pane binding', () => {
    expect(
      authorizeAutomatedReviewBrowserAccess(worker, boundBrowser, 'read', grant),
    ).toEqual({ allow: true });
    expect(
      authorizeAutomatedReviewBrowserAccess(worker, boundBrowser, 'wait', grant),
    ).toEqual({ allow: true });
    expect(
      authorizeAutomatedReviewBrowserAccess(worker, boundBrowser, 'write', grant)
        .allow,
    ).toBe(false);
    expect(
      authorizeAutomatedReviewBrowserAccess(worker, boundBrowser, 'close', grant)
        .allow,
    ).toBe(false);
  });

  it('rejects pane, mission, scope and caller-role substitution', () => {
    expect(
      authorizeAutomatedReviewBrowserAccess(
        worker,
        pane({ ...boundBrowser, paneId: 'browser-other' }),
        'read',
        grant,
      ).allow,
    ).toBe(false);
    expect(
      authorizeAutomatedReviewBrowserAccess(
        { ...worker, missionId: 'm2' },
        boundBrowser,
        'read',
        grant,
      ).allow,
    ).toBe(false);
    expect(
      authorizeAutomatedReviewBrowserAccess(
        worker,
        pane({
          ...boundBrowser,
          scope: testProjectScope({
            projectId: 'project-a',
            checkoutId: 'checkout-b',
          }),
        }),
        'read',
        grant,
      ).allow,
    ).toBe(false);
    expect(
      authorizeAutomatedReviewBrowserAccess(
        orchestrator,
        boundBrowser,
        'read',
        grant,
      ).allow,
    ).toBe(false);
  });
});
