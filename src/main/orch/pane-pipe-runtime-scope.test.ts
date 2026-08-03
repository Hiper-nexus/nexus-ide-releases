import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import type { ProjectExecutionScope } from '../../shared/types';
import { testProjectScope } from './__tests__/scope-fixture';

const ptyMocks = vi.hoisted(() => ({
  dataTaps: [] as Array<(sessionId: string, data: string) => void>,
  stateTaps: [] as Array<(sessionId: string, state: string) => void>,
  exitTaps: [] as Array<(sessionId: string) => void>,
  states: new Map<string, string>(),
  writes: vi.fn(() => true),
}));

const paneMocks = vi.hoisted(() => ({
  byOwner: new Map<string, unknown>(),
  bySession: new Map<string, unknown>(),
  version: 1,
}));

const scopeMocks = vi.hoisted(() => ({
  byOwner: new Map<number, ProjectExecutionScope>(),
}));

const idMocks = vi.hoisted(() => ({ counter: 0 }));

const semanticMocks = vi.hoisted(() => ({
  injectable: new Map<string, boolean>(),
  taps: [] as Array<(entry: {
    sessionId: string;
    status: 'idle' | 'completed' | 'awaiting-input' | 'working';
  }) => void>,
}));

vi.mock('../pty/pty-manager', () => ({
  getSessionState: vi.fn(
    (sessionId: string) => ptyMocks.states.get(sessionId) ?? 'busy',
  ),
  orchWriteSession: ptyMocks.writes,
  tapSessionData: vi.fn((tap: (sessionId: string, data: string) => void) => {
    ptyMocks.dataTaps.push(tap);
    return () => undefined;
  }),
  tapSessionState: vi.fn(
    (tap: (sessionId: string, state: string) => void) => {
      ptyMocks.stateTaps.push(tap);
      return () => undefined;
    },
  ),
  tapSessionExit: vi.fn((tap: (sessionId: string) => void) => {
    ptyMocks.exitTaps.push(tap);
    return () => undefined;
  }),
}));

vi.mock('../persistence/renderer-workspace-scope', () => ({
  getRendererWorkspaceScope: vi.fn(
    (owner: { id: number }) => scopeMocks.byOwner.get(owner.id) ?? null,
  ),
}));

vi.mock('./agent-status', () => ({
  isSessionInjectableIdle: vi.fn((sessionId: string) =>
    (ptyMocks.states.get(sessionId) ?? 'busy') === 'idle' &&
    semanticMocks.injectable.get(sessionId) !== false),
  tapAgentSemanticStatus: vi.fn((tap: (entry: {
    sessionId: string;
    status: 'idle' | 'completed' | 'awaiting-input' | 'working';
  }) => void) => {
    semanticMocks.taps.push(tap);
    return () => undefined;
  }),
}));

vi.mock('./pane-registry', () => ({
  getOwnedPaneAuthzInfoBySession: vi.fn(
    (sessionId: string) => paneMocks.bySession.get(sessionId) ?? null,
  ),
  getPaneAuthzInfoOwnedByPane: vi.fn(
    (owner: { id: number }, ref: string) =>
      paneMocks.byOwner.get(`${owner.id}:${ref}`) ?? null,
  ),
  getPanesVersion: vi.fn(() => paneMocks.version),
  readSessionOutput: vi.fn(() => 'idle output'),
  stripAnsi: (value: string) => value,
}));

vi.mock('./store-util', () => ({
  makeId: vi.fn((prefix: string) => `${prefix}-${++idMocks.counter}`),
}));

import {
  addPipe,
  clearPipePartitions,
  initPanePipes,
  listPipes,
} from './pane-pipe';

type Renderer = WebContents & { id: number };

function renderer(id: number): Renderer {
  return { id } as Renderer;
}

function authorizePane(options: {
  owner: Renderer;
  scope: ProjectExecutionScope;
  paneId: string;
  sessionId: string;
  missionId?: string;
}): void {
  const authority = {
    owner: options.owner,
    paneId: options.paneId,
    sessionId: options.sessionId,
    kind: 'cli-agent',
    role: 'worker',
    missionId: options.missionId ?? 'mission-a',
    scope: options.scope,
  };
  paneMocks.byOwner.set(`${options.owner.id}:${options.paneId}`, authority);
  paneMocks.byOwner.set(`${options.owner.id}:${options.sessionId}`, authority);
  paneMocks.bySession.set(options.sessionId, authority);
}

const owners: Array<{ owner: Renderer; scope: ProjectExecutionScope }> = [];

beforeEach(() => {
  vi.useFakeTimers();
  ptyMocks.states.clear();
  ptyMocks.writes.mockClear();
  semanticMocks.injectable.clear();
  paneMocks.byOwner.clear();
  paneMocks.bySession.clear();
  paneMocks.version += 1;
  scopeMocks.byOwner.clear();
  idMocks.counter = 0;
  initPanePipes();
});

afterEach(() => {
  for (const { owner, scope } of owners.splice(0)) {
    scopeMocks.byOwner.set(owner.id, scope);
    clearPipePartitions(owner);
  }
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('pane pipe runtime project partitions', () => {
  it('queues automatic pipe input until the target is semantically injectable', async () => {
    const scope = testProjectScope();
    const owner = renderer(99);
    owners.push({ owner, scope });
    scopeMocks.byOwner.set(owner.id, scope);
    authorizePane({ owner, scope, paneId: 'source', sessionId: 'source-wait' });
    authorizePane({ owner, scope, paneId: 'target', sessionId: 'target-wait' });
    ptyMocks.states.set('target-wait', 'idle');
    semanticMocks.injectable.set('target-wait', false);
    expect(addPipe(owner, scope, 'source', 'target', 'stream')).not.toBeNull();

    ptyMocks.dataTaps[0]('source-wait', 'must wait\n');
    await vi.advanceTimersByTimeAsync(200);
    expect(ptyMocks.writes).not.toHaveBeenCalled();

    semanticMocks.injectable.set('target-wait', true);
    semanticMocks.taps[0]({ sessionId: 'target-wait', status: 'completed' });
    expect(ptyMocks.writes).toHaveBeenCalledWith('target-wait', 'must wait\r');
  });

  it('routes colliding pane ids only inside the exact owner and scope', async () => {
    const scopeA = testProjectScope();
    const scopeB = testProjectScope({
      installationId: 'installation-b',
      projectId: 'project-b',
      checkoutId: 'checkout-b',
      rootRealPath: '/workspace/b',
    });
    const ownerA = renderer(101);
    const ownerB = renderer(202);
    owners.push({ owner: ownerA, scope: scopeA }, { owner: ownerB, scope: scopeB });
    scopeMocks.byOwner.set(ownerA.id, scopeA);
    scopeMocks.byOwner.set(ownerB.id, scopeB);
    authorizePane({ owner: ownerA, scope: scopeA, paneId: 'source', sessionId: 'source-a' });
    authorizePane({ owner: ownerA, scope: scopeA, paneId: 'target', sessionId: 'target-a' });
    authorizePane({ owner: ownerB, scope: scopeB, paneId: 'source', sessionId: 'source-b' });
    authorizePane({ owner: ownerB, scope: scopeB, paneId: 'target', sessionId: 'target-b' });
    ptyMocks.states.set('target-a', 'idle');
    ptyMocks.states.set('target-b', 'idle');

    expect(addPipe(ownerA, scopeA, 'source', 'target', 'stream')).not.toBeNull();
    expect(addPipe(ownerB, scopeB, 'source', 'target', 'stream')).not.toBeNull();
    expect(listPipes(ownerA, scopeA)).toHaveLength(1);
    expect(listPipes(ownerB, scopeB)).toHaveLength(1);

    ptyMocks.dataTaps[0]('source-a', 'hello A\n');
    // Adaptive flush: shallow queues (≤4 lines) use 300ms interval
    await vi.advanceTimersByTimeAsync(350);

    expect(ptyMocks.writes).toHaveBeenCalledWith('target-a', 'hello A\r');
    expect(ptyMocks.writes).not.toHaveBeenCalledWith('target-b', 'hello A\r');
  });

  it('enforces capacity independently per owner/project partition', () => {
    const scopeA = testProjectScope();
    const scopeB = testProjectScope({
      projectId: 'project-b',
      checkoutId: 'checkout-b',
      rootRealPath: '/workspace/b',
    });
    const ownerA = renderer(303);
    const ownerB = renderer(404);
    owners.push({ owner: ownerA, scope: scopeA }, { owner: ownerB, scope: scopeB });
    scopeMocks.byOwner.set(ownerA.id, scopeA);
    scopeMocks.byOwner.set(ownerB.id, scopeB);
    authorizePane({ owner: ownerA, scope: scopeA, paneId: 'source', sessionId: 'source-a' });
    authorizePane({ owner: ownerB, scope: scopeB, paneId: 'source', sessionId: 'source-b' });

    for (let index = 0; index <= 64; index += 1) {
      authorizePane({
        owner: ownerA,
        scope: scopeA,
        paneId: `target-${index}`,
        sessionId: `target-a-${index}`,
      });
    }
    for (let index = 0; index < 64; index += 1) {
      expect(
        addPipe(ownerA, scopeA, 'source', `target-${index}`, 'stream'),
      ).not.toBeNull();
    }
    expect(addPipe(ownerA, scopeA, 'source', 'target-64', 'stream')).toBeNull();

    authorizePane({
      owner: ownerB,
      scope: scopeB,
      paneId: 'target-64',
      sessionId: 'target-b-64',
    });
    expect(
      addPipe(ownerB, scopeB, 'source', 'target-64', 'stream'),
    ).not.toBeNull();
  });

  it('cancels pending forwarding state when the source session exits', async () => {
    const scope = testProjectScope();
    const owner = renderer(505);
    owners.push({ owner, scope });
    scopeMocks.byOwner.set(owner.id, scope);
    authorizePane({ owner, scope, paneId: 'source', sessionId: 'source-session' });
    authorizePane({ owner, scope, paneId: 'target', sessionId: 'target-session' });
    addPipe(owner, scope, 'source', 'target', 'stream');

    ptyMocks.dataTaps[0]('source-session', 'must not deliver\n');
    ptyMocks.exitTaps[0]('source-session');
    await vi.advanceTimersByTimeAsync(200);

    expect(ptyMocks.writes).not.toHaveBeenCalled();
  });

  it('fails closed when only a near-matching scope is supplied', () => {
    const scope = testProjectScope();
    const foreignRoot = testProjectScope({ rootRealPath: '/workspace/other' });
    const owner = renderer(606);
    owners.push({ owner, scope });
    scopeMocks.byOwner.set(owner.id, scope);
    authorizePane({ owner, scope, paneId: 'source', sessionId: 'source-session' });
    authorizePane({ owner, scope, paneId: 'target', sessionId: 'target-session' });

    expect(addPipe(owner, foreignRoot, 'source', 'target', 'stream')).toBeNull();
    expect(listPipes(owner, foreignRoot)).toEqual([]);
  });
});
