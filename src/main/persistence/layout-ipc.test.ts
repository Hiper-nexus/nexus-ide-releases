import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { LAYOUT_CHANNELS } from '../../shared/channels';
import type { WorkspaceLayout } from '../../shared/types';
import { testProjectScope } from '../orch/__tests__/scope-fixture';
import {
  bindResolvedRendererWorkspaceScope,
  clearRendererWorkspaceScope,
} from './renderer-workspace-scope';

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const onHandlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    onHandlers,
    handle: vi.fn(
      (channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      },
    ),
    on: vi.fn(
      (channel: string, handler: (...args: unknown[]) => unknown) => {
        onHandlers.set(channel, handler);
      },
    ),
  };
});

const layoutStoreMock = vi.hoisted(() => {
  const save = vi.fn();
  const load = vi.fn(() => null as { layout: WorkspaceLayout } | null);
  return {
    save,
    load,
    createScopedLayoutStore: vi.fn(() => ({
      save,
      load,
    })),
  };
});

vi.mock('electron', () => ({
  ipcMain: { handle: electronMock.handle, on: electronMock.on },
}));

vi.mock('./layout-store', () => ({
  createScopedLayoutStore: layoutStoreMock.createScopedLayoutStore,
}));

import { registerLayoutIpc } from './layout-ipc';

type Renderer = WebContents & { send: ReturnType<typeof vi.fn> };

function renderer(id: number): Renderer {
  return {
    id,
    isDestroyed: () => false,
    isCrashed: () => false,
    send: vi.fn(),
  } as unknown as Renderer;
}

function invoke(channel: string, sender: Renderer, raw?: unknown): unknown {
  const handler = electronMock.handlers.get(channel);
  if (!handler) throw new Error(`missing handler: ${channel}`);
  return handler({ sender }, raw);
}

function invokeSync(channel: string, sender: Renderer, raw?: unknown): unknown {
  const handler = electronMock.onHandlers.get(channel);
  if (!handler) throw new Error(`missing on-handler: ${channel}`);
  const event = { sender, returnValue: undefined as unknown };
  handler(event, raw);
  return event.returnValue;
}

function layout(title: string): WorkspaceLayout {
  return {
    root: {
      kind: 'leaf',
      id: `leaf-${title}`,
      pane: { id: `pane-${title}`, kind: 'shell', title },
    },
    focusedPaneId: `pane-${title}`,
  };
}

const renderers: Renderer[] = [];
const runtimeManager = {} as import('../runtime/project-runtime-manager').ProjectRuntimeManager;

beforeEach(() => {
  electronMock.handlers.clear();
  electronMock.onHandlers.clear();
  electronMock.handle.mockClear();
  electronMock.on.mockClear();
  layoutStoreMock.save.mockClear();
  layoutStoreMock.load.mockReset();
  layoutStoreMock.load.mockReturnValue(null);
  layoutStoreMock.createScopedLayoutStore.mockClear();
});

afterEach(() => {
  for (const value of renderers.splice(0)) {
    clearRendererWorkspaceScope(value);
  }
});

describe('layout IPC project authority', () => {
  it('uses sender scope instead of renderer workspacePath across projects', () => {
    const scopeA = testProjectScope({
      projectId: 'project-a',
      checkoutId: 'checkout-a',
      rootRealPath: '/workspace/a',
    });
    const scopeB = testProjectScope({
      projectId: 'project-b',
      checkoutId: 'checkout-b',
      rootRealPath: '/workspace/b',
    });
    const windowA = renderer(401);
    const windowB = renderer(402);
    renderers.push(windowA, windowB);
    bindResolvedRendererWorkspaceScope(windowA, scopeA);
    bindResolvedRendererWorkspaceScope(windowB, scopeB);
    registerLayoutIpc(runtimeManager);

    expect(() =>
      invoke(LAYOUT_CHANNELS.save, windowA, {
        workspacePath: scopeB.rootRealPath,
        layout: layout('A'),
      }),
    ).toThrow(/does not match renderer scope/i);
    expect(
      invoke(LAYOUT_CHANNELS.save, windowA, {
        workspacePath: scopeA.rootRealPath,
        layout: layout('A'),
      }),
    ).toEqual({ ok: true });
    expect(layoutStoreMock.save).toHaveBeenCalledWith(layout('A'));
    layoutStoreMock.load.mockReturnValue({ layout: layout('A') });
    expect(
      invoke(LAYOUT_CHANNELS.load, windowA, {
        workspacePath: scopeA.rootRealPath,
      }),
    ).toMatchObject({ root: { id: 'leaf-A' } });
    layoutStoreMock.load.mockReturnValue(null);
    expect(
      invoke(LAYOUT_CHANNELS.load, windowB, {
        workspacePath: scopeB.rootRealPath,
      }),
    ).toBeNull();
    expect(() =>
      invoke(LAYOUT_CHANNELS.load, windowA, {
        workspacePath: scopeB.rootRealPath,
      }),
    ).toThrow(/does not match renderer scope/i);
  });

  it('captures current scope per call and rejects an unbound renderer', () => {
    const window = renderer(501);
    renderers.push(window);
    registerLayoutIpc(runtimeManager);

    expect(() =>
      invoke(LAYOUT_CHANNELS.load, window, { workspacePath: '/untrusted' }),
    ).toThrow(/authorized workspace scope/i);

    const scope = testProjectScope({ rootRealPath: '/workspace/current' });
    bindResolvedRendererWorkspaceScope(window, scope);
    expect(() =>
      invoke(LAYOUT_CHANNELS.load, window, { workspacePath: '/stale/path' }),
    ).toThrow(/does not match renderer scope/i);
  });

  it('saveSync happy path persists via scoped store', () => {
    const scope = testProjectScope({ rootRealPath: '/workspace/sync' });
    const window = renderer(601);
    renderers.push(window);
    bindResolvedRendererWorkspaceScope(window, scope);
    registerLayoutIpc(runtimeManager);

    expect(
      invokeSync(LAYOUT_CHANNELS.saveSync, window, {
        workspacePath: scope.rootRealPath,
        layout: layout('sync'),
      }),
    ).toBe(true);
    expect(layoutStoreMock.save).toHaveBeenCalledWith(layout('sync'));
  });

  it('saveSync returns false for untrusted workspace or invalid payload', () => {
    const scope = testProjectScope({ rootRealPath: '/workspace/sync-b' });
    const window = renderer(602);
    renderers.push(window);
    bindResolvedRendererWorkspaceScope(window, scope);
    registerLayoutIpc(runtimeManager);

    expect(
      invokeSync(LAYOUT_CHANNELS.saveSync, window, {
        workspacePath: '/other/path',
        layout: layout('x'),
      }),
    ).toBe(false);
    expect(invokeSync(LAYOUT_CHANNELS.saveSync, window, { bad: true })).toBe(
      false,
    );

    const unbound = renderer(603);
    renderers.push(unbound);
    expect(
      invokeSync(LAYOUT_CHANNELS.saveSync, unbound, {
        workspacePath: scope.rootRealPath,
        layout: layout('y'),
      }),
    ).toBe(false);
    // save must not run for rejected calls after the happy-path suite order
  });
});
