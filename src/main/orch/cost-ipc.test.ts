import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { COST_CHANNELS, type CostSnapshot } from '../../shared/cost-types';
import type { ProjectExecutionScope } from '../../shared/types';

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
    electronMocks.handlers.set(channel, handler);
  }),
}));

const scopeMocks = vi.hoisted(() => ({
  byRenderer: new Map<number, ProjectExecutionScope>(),
  getRendererWorkspaceScope: vi.fn((owner: { id: number }) =>
    scopeMocks.byRenderer.get(owner.id) ?? null,
  ),
  requireRendererWorkspaceScope: vi.fn((owner: { id: number }) => {
    const value = scopeMocks.byRenderer.get(owner.id);
    if (!value) throw new Error('renderer has no authorized workspace scope');
    return value;
  }),
}));

const trackerMocks = vi.hoisted(() => ({
  initCostTracker: vi.fn(),
  getCostSnapshot: vi.fn((_scope: ProjectExecutionScope) => ({
    totalUsd: 0,
    perMinuteUsd: 0,
    tokPerSec: 0,
    panes: [],
  })),
  setPaneCap: vi.fn(() => true),
  listener: null as null | ((scope: ProjectExecutionScope, snapshot: CostSnapshot) => void),
  onCostChange: vi.fn(
    (listener: (scope: ProjectExecutionScope, snapshot: CostSnapshot) => void) => {
      trackerMocks.listener = listener;
      return () => {
        if (trackerMocks.listener === listener) trackerMocks.listener = null;
      };
    },
  ),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: electronMocks.handle },
}));

vi.mock('../persistence/renderer-workspace-scope', () => ({
  getRendererWorkspaceScope: scopeMocks.getRendererWorkspaceScope,
  requireRendererWorkspaceScope: scopeMocks.requireRendererWorkspaceScope,
}));

vi.mock('./cost-tracker', () => ({
  initCostTracker: trackerMocks.initCostTracker,
  getCostSnapshot: trackerMocks.getCostSnapshot,
  setPaneCap: trackerMocks.setPaneCap,
  onCostChange: trackerMocks.onCostChange,
}));

import {
  registerCostIpc,
  registerCostListener,
  unregisterCostListener,
} from './cost-ipc';

type TestRenderer = WebContents & {
  send: ReturnType<typeof vi.fn>;
  destroyed: boolean;
  crashed: boolean;
};

function scope(projectId: string, checkoutId: string): ProjectExecutionScope {
  return Object.freeze({
    version: 1,
    installationId: 'installation-a',
    projectId,
    checkoutId,
    rootRealPath: `/workspace/${projectId}/${checkoutId}`,
    identitySource: 'manifest',
  });
}

function renderer(id: number): TestRenderer {
  const value = {
    id,
    send: vi.fn(),
    destroyed: false,
    crashed: false,
    isDestroyed: () => value.destroyed,
    isCrashed: () => value.crashed,
  };
  return value as unknown as TestRenderer;
}

describe('cost IPC project authority', () => {
  beforeEach(() => {
    electronMocks.handlers.clear();
    electronMocks.handle.mockClear();
    scopeMocks.byRenderer.clear();
    scopeMocks.getRendererWorkspaceScope.mockClear();
    scopeMocks.requireRendererWorkspaceScope.mockClear();
    trackerMocks.initCostTracker.mockClear();
    trackerMocks.getCostSnapshot.mockClear();
    trackerMocks.setPaneCap.mockClear();
    trackerMocks.onCostChange.mockClear();
    trackerMocks.listener = null;
  });

  it('derives sender scope and broadcasts only to live renderers still in that scope', () => {
    const scopeA = scope('project-a', 'checkout-a');
    const scopeB = scope('project-b', 'checkout-b');
    const windowA = renderer(101);
    const windowB = renderer(202);
    const destroyed = renderer(303);
    const crashed = renderer(404);
    destroyed.destroyed = true;
    crashed.crashed = true;
    scopeMocks.byRenderer.set(windowA.id, scopeA);
    scopeMocks.byRenderer.set(windowB.id, scopeB);
    scopeMocks.byRenderer.set(destroyed.id, scopeA);
    scopeMocks.byRenderer.set(crashed.id, scopeA);
    for (const value of [windowA, windowB, destroyed, crashed]) {
      registerCostListener(value);
    }

    registerCostIpc();
    registerCostIpc();

    expect(trackerMocks.initCostTracker).toHaveBeenCalledOnce();
    expect(trackerMocks.onCostChange).toHaveBeenCalledOnce();
    expect(electronMocks.handle).toHaveBeenCalledTimes(2);
    const snapshotHandler = electronMocks.handlers.get(COST_CHANNELS.snapshot);
    const setCapHandler = electronMocks.handlers.get(COST_CHANNELS.setCap);
    expect(snapshotHandler).toBeTypeOf('function');
    expect(setCapHandler).toBeTypeOf('function');

    snapshotHandler!({ sender: windowA });
    expect(trackerMocks.getCostSnapshot).toHaveBeenCalledWith(scopeA);
    expect(
      setCapHandler!({ sender: windowB }, { paneId: 'pane-b', capUsd: 2 }),
    ).toEqual({ ok: true });
    expect(trackerMocks.setPaneCap).toHaveBeenCalledWith(
      scopeB,
      'pane-b',
      2,
    );
    expect(
      setCapHandler!({ sender: windowB }, { paneId: '', capUsd: -1 }),
    ).toEqual({ ok: false, error: 'invalid cap payload' });
    expect(trackerMocks.setPaneCap).toHaveBeenCalledOnce();
    const unauthorized = renderer(505);
    expect(() => snapshotHandler!({ sender: unauthorized })).toThrow(
      /authorized workspace scope/i,
    );

    const snapshot: CostSnapshot = {
      totalUsd: 1,
      perMinuteUsd: 0.1,
      tokPerSec: 2,
      panes: [],
    };
    trackerMocks.listener!(scopeA, snapshot);
    expect(windowA.send).toHaveBeenCalledWith(COST_CHANNELS.changed, snapshot);
    expect(windowB.send).not.toHaveBeenCalled();
    expect(destroyed.send).not.toHaveBeenCalled();
    expect(crashed.send).not.toHaveBeenCalled();

    windowA.send.mockClear();
    scopeMocks.byRenderer.set(windowA.id, scopeB);
    trackerMocks.listener!(scopeA, snapshot);
    expect(windowA.send).not.toHaveBeenCalled();

    unregisterCostListener(windowA);
    unregisterCostListener(windowB);
    unregisterCostListener(destroyed);
    unregisterCostListener(crashed);
  });
});
