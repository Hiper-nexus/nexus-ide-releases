import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import type { ProjectExecutionScope } from '../../shared/types';
import { ACCOUNT_CHANNELS } from '../../shared/account-types';
import { testProjectScope } from './__tests__/scope-fixture';

const ptyMocks = vi.hoisted(() => ({
  dataTaps: [] as Array<(sessionId: string, data: string) => void>,
  exitTaps: [] as Array<(sessionId: string) => void>,
}));

const paneMocks = vi.hoisted(() => ({
  authorities: new Map<string, unknown>(),
  panes: new Map<string, unknown>(),
}));

const accountMocks = vi.hoisted(() => ({
  setCooldown: vi.fn(),
  current: {
    id: 'account-a',
    adapterId: 'claude',
    label: 'Account A',
  },
  next: {
    id: 'account-b',
    adapterId: 'claude',
    label: 'Account B',
  } as { id: string; adapterId: string; label: string } | null,
}));

vi.mock('../pty/pty-manager', () => ({
  tapSessionData: vi.fn((tap: (sessionId: string, data: string) => void) => {
    ptyMocks.dataTaps.push(tap);
    return () => {
      const index = ptyMocks.dataTaps.indexOf(tap);
      if (index >= 0) ptyMocks.dataTaps.splice(index, 1);
    };
  }),
  tapSessionExit: vi.fn((tap: (sessionId: string) => void) => {
    ptyMocks.exitTaps.push(tap);
    return () => {
      const index = ptyMocks.exitTaps.indexOf(tap);
      if (index >= 0) ptyMocks.exitTaps.splice(index, 1);
    };
  }),
}));

vi.mock('./pane-registry', () => ({
  stripAnsi: (data: string) => data,
  getOwnedPaneAuthzInfoBySession: vi.fn(
    (ref: string) => paneMocks.authorities.get(ref) ?? null,
  ),
  findPaneBySessionOwnedBy: vi.fn(
    (_owner: WebContents, ref: string) => paneMocks.panes.get(ref) ?? null,
  ),
}));

vi.mock('./limit-detector', () => ({
  detectLimit: vi.fn((buffer: string) =>
    buffer.includes('LIMIT')
      ? { reason: 'rate limit', cooldownMs: 60_000 }
      : null,
  ),
}));

vi.mock('../persistence/account-store', () => ({
  getAccount: vi.fn((id: string) =>
    id === accountMocks.current.id ? accountMocks.current : null,
  ),
  getActiveAccount: vi.fn(() => accountMocks.current),
  pickAvailable: vi.fn(() => accountMocks.next),
  setCooldown: accountMocks.setCooldown,
}));

import {
  bindResolvedRendererWorkspaceScope,
  clearRendererWorkspaceScope,
} from '../persistence/renderer-workspace-scope';
import {
  initFailover,
  registerFailoverListener,
  shutdownFailover,
  unregisterFailoverListener,
} from './failover';

type Renderer = WebContents & EventEmitter & { send: ReturnType<typeof vi.fn> };

function renderer(id: number): Renderer {
  const events = new EventEmitter() as Renderer;
  Object.assign(events, {
    id,
    isDestroyed: () => false,
    isCrashed: () => false,
    send: vi.fn(),
  });
  return events;
}

function addPane(options: {
  owner: Renderer;
  paneId: string;
  sessionId: string;
  missionId?: string;
  scope: ProjectExecutionScope;
}): void {
  const pane = {
    paneId: options.paneId,
    sessionId: options.sessionId,
    kind: 'cli-agent',
    adapterId: 'claude',
    accountId: 'account-a',
  };
  paneMocks.panes.set(options.sessionId, pane);
  paneMocks.authorities.set(options.sessionId, {
    owner: options.owner,
    ...pane,
    role: options.missionId ? 'worker' : undefined,
    missionId: options.missionId,
    scope: options.scope,
  });
}

const renderers: Renderer[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  ptyMocks.dataTaps.length = 0;
  ptyMocks.exitTaps.length = 0;
  paneMocks.authorities.clear();
  paneMocks.panes.clear();
  accountMocks.setCooldown.mockClear();
  accountMocks.next = {
    id: 'account-b',
    adapterId: 'claude',
    label: 'Account B',
  };
  initFailover();
});

afterEach(() => {
  for (const value of renderers.splice(0)) {
    unregisterFailoverListener(value);
    clearRendererWorkspaceScope(value);
  }
  shutdownFailover();
  vi.useRealTimers();
});

describe('account failover authority and lifecycle', () => {
  it('emits only to the exact pane owner across projects with colliding pane ids', () => {
    const scopeA = testProjectScope();
    const scopeB = testProjectScope({
      installationId: 'installation-b',
      projectId: 'project-b',
      checkoutId: 'checkout-b',
      rootRealPath: '/workspace/b',
    });
    const windowA = renderer(101);
    const windowB = renderer(202);
    renderers.push(windowA, windowB);
    bindResolvedRendererWorkspaceScope(windowA, scopeA);
    bindResolvedRendererWorkspaceScope(windowB, scopeB);
    registerFailoverListener(windowA);
    registerFailoverListener(windowB);
    addPane({
      owner: windowA,
      paneId: 'shared-pane',
      sessionId: 'session-a',
      missionId: 'mission-a',
      scope: scopeA,
    });
    addPane({
      owner: windowB,
      paneId: 'shared-pane',
      sessionId: 'session-b',
      missionId: 'mission-b',
      scope: scopeB,
    });

    ptyMocks.dataTaps[0]('session-a', 'LIMIT');

    expect(windowA.send).toHaveBeenCalledWith(
      ACCOUNT_CHANNELS.failover,
      expect.objectContaining({ paneId: 'shared-pane', switched: true }),
    );
    expect(windowB.send).not.toHaveBeenCalled();
    expect(accountMocks.setCooldown).toHaveBeenCalledOnce();
  });

  it('fails closed before account mutation for ambiguous, unscoped or ownerless panes', () => {
    const scope = testProjectScope();
    const owner = renderer(303);
    const unregistered = renderer(404);
    renderers.push(owner, unregistered);
    bindResolvedRendererWorkspaceScope(owner, scope);
    bindResolvedRendererWorkspaceScope(unregistered, scope);
    registerFailoverListener(owner);
    addPane({
      owner,
      paneId: 'ambiguous-pane',
      sessionId: 'ambiguous-session',
      scope,
    });
    paneMocks.authorities.set('ambiguous-session', null);
    addPane({
      owner,
      paneId: 'unscoped-pane',
      sessionId: 'unscoped-session',
      scope,
    });
    paneMocks.authorities.set('unscoped-session', {
      ...(paneMocks.authorities.get('unscoped-session') as object),
      scope: undefined,
    });
    addPane({
      owner: unregistered,
      paneId: 'ownerless-pane',
      sessionId: 'ownerless-session',
      scope,
    });

    ptyMocks.dataTaps[0]('ambiguous-session', 'LIMIT');
    ptyMocks.dataTaps[0]('unscoped-session', 'LIMIT');
    ptyMocks.dataTaps[0]('ownerless-session', 'LIMIT');

    expect(accountMocks.setCooldown).not.toHaveBeenCalled();
    expect(owner.send).not.toHaveBeenCalled();
    expect(unregistered.send).not.toHaveBeenCalled();
  });

  it('clears partial detector buffers on scope change, session exit and destroy', () => {
    const scopeA = testProjectScope();
    const scopeB = testProjectScope({
      projectId: 'project-b',
      checkoutId: 'checkout-b',
      rootRealPath: '/workspace/b',
    });
    const owner = renderer(505);
    renderers.push(owner);
    bindResolvedRendererWorkspaceScope(owner, scopeA);
    registerFailoverListener(owner);
    addPane({
      owner,
      paneId: 'pane-a',
      sessionId: 'session-a',
      missionId: 'mission-a',
      scope: scopeA,
    });

    ptyMocks.dataTaps[0]('session-a', 'LIM');
    bindResolvedRendererWorkspaceScope(owner, scopeB);
    bindResolvedRendererWorkspaceScope(owner, scopeA);
    ptyMocks.dataTaps[0]('session-a', 'IT');
    ptyMocks.dataTaps[0]('session-a', 'LIM');
    ptyMocks.exitTaps[0]('session-a');
    ptyMocks.dataTaps[0]('session-a', 'IT');
    ptyMocks.dataTaps[0]('session-a', 'LIM');
    owner.emit('destroyed');
    ptyMocks.dataTaps[0]('session-a', 'IT');

    expect(accountMocks.setCooldown).not.toHaveBeenCalled();
    expect(owner.send).not.toHaveBeenCalled();
  });
});
