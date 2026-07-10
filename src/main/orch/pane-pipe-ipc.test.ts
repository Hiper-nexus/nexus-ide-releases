import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import type { ProjectExecutionScope } from '../../shared/types';
import { PIPE_CHANNELS, type Pipe } from '../../shared/pipe-types';
import { testProjectScope } from './__tests__/scope-fixture';

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  handle: vi.fn(
    (channel: string, handler: (...args: unknown[]) => unknown) => {
      electronMocks.handlers.set(channel, handler);
    },
  ),
}));

const pipeMocks = vi.hoisted(() => ({
  pipes: new Map<string, Pipe>(),
  owners: new Map<string, WebContents>(),
  changeListeners: [] as Array<
    (owner: WebContents, scope: ProjectExecutionScope) => void
  >,
  counter: 0,
  removePipe: vi.fn(
    (owner: WebContents, scope: ProjectExecutionScope, id: string) => {
    if (pipeMocks.owners.get(id) !== owner) return false;
    const removed = pipeMocks.pipes.delete(id);
    pipeMocks.owners.delete(id);
    if (removed) {
      for (const listener of [...pipeMocks.changeListeners]) {
        listener(owner, scope);
      }
    }
    return removed;
    },
  ),
}));

const paneMocks = vi.hoisted(() => ({
  authorities: new Map<string, unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: electronMocks.handle },
}));

vi.mock('./pane-pipe', () => ({
  initPanePipes: vi.fn(),
  listPipes: vi.fn((owner: WebContents) =>
    [...pipeMocks.pipes.values()].filter(
      (pipe) => pipeMocks.owners.get(pipe.id) === owner,
    ),
  ),
  addPipe: vi.fn(
    (
      owner: WebContents,
      scope: ProjectExecutionScope,
      sourcePaneId: string,
      targetPaneId: string,
      mode: Pipe['mode'],
    ) => {
      const source = paneMocks.authorities.get(sourcePaneId) as
        | { owner?: WebContents; scope?: ProjectExecutionScope }
        | undefined;
      const target = paneMocks.authorities.get(targetPaneId) as
        | { owner?: WebContents; scope?: ProjectExecutionScope }
        | undefined;
      if (
        source?.owner !== owner ||
        target?.owner !== owner ||
        source.scope?.projectId !== scope.projectId ||
        source.scope.checkoutId !== scope.checkoutId ||
        target.scope?.projectId !== scope.projectId ||
        target.scope.checkoutId !== scope.checkoutId ||
        sourcePaneId === targetPaneId
      ) {
        return null;
      }
      const existing = [...pipeMocks.pipes.values()].find(
        (pipe) =>
          pipeMocks.owners.get(pipe.id) === owner &&
          pipe.sourcePaneId === sourcePaneId &&
          pipe.targetPaneId === targetPaneId &&
          pipe.mode === mode,
      );
      if (existing) return existing;
      const pipe: Pipe = {
        id: `pipe-${++pipeMocks.counter}`,
        sourcePaneId,
        targetPaneId,
        mode,
      };
      pipeMocks.pipes.set(pipe.id, pipe);
      pipeMocks.owners.set(pipe.id, owner);
      for (const listener of [...pipeMocks.changeListeners]) {
        listener(owner, scope);
      }
      return pipe;
    },
  ),
  removePipe: pipeMocks.removePipe,
  clearPipePartitions: vi.fn(
    (owner: WebContents, scope?: ProjectExecutionScope) => {
      for (const [id, pipeOwner] of [...pipeMocks.owners]) {
        if (pipeOwner !== owner) continue;
        pipeMocks.owners.delete(id);
        pipeMocks.pipes.delete(id);
      }
      if (scope) {
        for (const listener of [...pipeMocks.changeListeners]) {
          listener(owner, scope);
        }
      }
    },
  ),
  onPipesChange: vi.fn((listener: (owner: WebContents, scope: ProjectExecutionScope) => void) => {
    pipeMocks.changeListeners.push(listener);
    return () => {
      const index = pipeMocks.changeListeners.indexOf(listener);
      if (index >= 0) pipeMocks.changeListeners.splice(index, 1);
    };
  }),
}));

vi.mock('./pane-registry', () => ({
  getOwnedPaneAuthzInfo: vi.fn(
    (ref: string) => paneMocks.authorities.get(ref) ?? null,
  ),
}));

import {
  bindResolvedRendererWorkspaceScope,
  clearRendererWorkspaceScope,
} from '../persistence/renderer-workspace-scope';
import {
  registerPipeIpc,
  registerPipeListener,
  unregisterPipeListener,
} from './pane-pipe-ipc';

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

function invoke(channel: string, sender: Renderer, raw?: unknown): unknown {
  const handler = electronMocks.handlers.get(channel);
  if (!handler) throw new Error(`missing handler: ${channel}`);
  return handler({ sender }, raw);
}

function authorizePane(options: {
  owner: Renderer;
  paneId: string;
  sessionId: string;
  missionId: string;
  scope: ProjectExecutionScope;
}): void {
  paneMocks.authorities.set(options.paneId, {
    owner: options.owner,
    paneId: options.paneId,
    sessionId: options.sessionId,
    kind: 'cli-agent',
    missionId: options.missionId,
    role: 'worker',
    scope: options.scope,
  });
}

const renderers: Renderer[] = [];

beforeEach(() => {
  electronMocks.handlers.clear();
  electronMocks.handle.mockClear();
  pipeMocks.pipes.clear();
  pipeMocks.owners.clear();
  pipeMocks.changeListeners.length = 0;
  pipeMocks.counter = 0;
  pipeMocks.removePipe.mockClear();
  paneMocks.authorities.clear();
  registerPipeIpc();
});

afterEach(() => {
  for (const value of renderers.splice(0)) {
    unregisterPipeListener(value);
    clearRendererWorkspaceScope(value);
  }
});

describe('pane pipe IPC project authority', () => {
  it('isolates list, mutation and broadcasts to the exact owning renderer', () => {
    const scopeA = testProjectScope();
    const scopeB = testProjectScope({
      projectId: 'project-b',
      checkoutId: 'checkout-b',
      rootRealPath: '/workspace/b',
    });
    const windowA = renderer(101);
    const windowB = renderer(202);
    renderers.push(windowA, windowB);
    bindResolvedRendererWorkspaceScope(windowA, scopeA);
    bindResolvedRendererWorkspaceScope(windowB, scopeB);
    registerPipeListener(windowA);
    registerPipeListener(windowB);
    authorizePane({
      owner: windowA,
      paneId: 'source-a',
      sessionId: 'source-session-a',
      missionId: 'mission-a',
      scope: scopeA,
    });
    authorizePane({
      owner: windowA,
      paneId: 'target-a',
      sessionId: 'target-session-a',
      missionId: 'mission-a',
      scope: scopeA,
    });

    const added = invoke(PIPE_CHANNELS.add, windowA, {
      sourcePaneId: 'source-a',
      targetPaneId: 'target-a',
      mode: 'stream',
    });

    expect(added).toEqual({ ok: true, id: 'pipe-1' });
    expect(invoke(PIPE_CHANNELS.list, windowA)).toEqual([
      expect.objectContaining({ id: 'pipe-1' }),
    ]);
    expect(invoke(PIPE_CHANNELS.list, windowB)).toEqual([]);
    expect(
      invoke(PIPE_CHANNELS.remove, windowB, { id: 'pipe-1' }),
    ).toEqual({ ok: false });
    expect(pipeMocks.pipes.has('pipe-1')).toBe(true);
    expect(windowA.send).toHaveBeenCalledWith(
      PIPE_CHANNELS.changed,
      [expect.objectContaining({ id: 'pipe-1' })],
    );
    expect(windowB.send).not.toHaveBeenCalledWith(
      PIPE_CHANNELS.changed,
      expect.arrayContaining([expect.objectContaining({ id: 'pipe-1' })]),
    );
  });

  it('rejects unbound, cross-project and ambiguous pane ids', () => {
    const scopeA = testProjectScope();
    const scopeB = testProjectScope({
      projectId: 'project-b',
      checkoutId: 'checkout-b',
      rootRealPath: '/workspace/b',
    });
    const windowA = renderer(303);
    const windowB = renderer(404);
    const unbound = renderer(505);
    renderers.push(windowA, windowB, unbound);
    bindResolvedRendererWorkspaceScope(windowA, scopeA);
    bindResolvedRendererWorkspaceScope(windowB, scopeB);
    registerPipeListener(windowA);
    registerPipeListener(windowB);
    registerPipeListener(unbound);
    authorizePane({
      owner: windowA,
      paneId: 'source-a',
      sessionId: 'source-session-a',
      missionId: 'mission-a',
      scope: scopeA,
    });
    authorizePane({
      owner: windowB,
      paneId: 'target-b',
      sessionId: 'target-session-b',
      missionId: 'mission-b',
      scope: scopeB,
    });

    expect(() => invoke(PIPE_CHANNELS.list, unbound)).toThrow(
      /authorized workspace scope/i,
    );
    expect(
      invoke(PIPE_CHANNELS.add, windowA, {
        sourcePaneId: 'source-a',
        targetPaneId: 'target-b',
        mode: 'stream',
      }),
    ).toEqual({ ok: false, error: 'pane authority mismatch' });
    paneMocks.authorities.set('source-a', null);
    expect(
      invoke(PIPE_CHANNELS.add, windowA, {
        sourcePaneId: 'source-a',
        targetPaneId: 'source-a',
        mode: 'stream',
      }),
    ).toEqual({ ok: false, error: 'pane authority mismatch' });
    expect(pipeMocks.pipes.size).toBe(0);
  });

  it('removes owner state on workspace switch and WebContents destruction', () => {
    const scopeA = testProjectScope();
    const scopeB = testProjectScope({
      projectId: 'project-b',
      checkoutId: 'checkout-b',
      rootRealPath: '/workspace/b',
    });
    const window = renderer(606);
    renderers.push(window);
    bindResolvedRendererWorkspaceScope(window, scopeA);
    registerPipeListener(window);
    authorizePane({
      owner: window,
      paneId: 'source',
      sessionId: 'source-session',
      missionId: 'mission-a',
      scope: scopeA,
    });
    authorizePane({
      owner: window,
      paneId: 'target',
      sessionId: 'target-session',
      missionId: 'mission-a',
      scope: scopeA,
    });
    invoke(PIPE_CHANNELS.add, window, {
      sourcePaneId: 'source',
      targetPaneId: 'target',
      mode: 'onIdle',
    });

    bindResolvedRendererWorkspaceScope(window, scopeB);

    expect(pipeMocks.pipes.size).toBe(0);
    expect(pipeMocks.removePipe).not.toHaveBeenCalled();

    bindResolvedRendererWorkspaceScope(window, scopeA);
    invoke(PIPE_CHANNELS.add, window, {
      sourcePaneId: 'source',
      targetPaneId: 'target',
      mode: 'stream',
    });
    window.emit('destroyed');
    expect(pipeMocks.pipes.size).toBe(0);
  });
});
