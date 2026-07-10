import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { LAYOUT_CHANNELS } from '../../shared/channels';
import type { WorkspaceLayout } from '../../shared/types';
import { testProjectScope } from '../orch/__tests__/scope-fixture';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import {
  bindResolvedRendererWorkspaceScope,
  clearRendererWorkspaceScope,
} from './renderer-workspace-scope';

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    handle: vi.fn(
      (channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      },
    ),
  };
});

vi.mock('electron', () => ({
  ipcMain: { handle: electronMock.handle },
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

let baseDir = '';
let runtimeManager: ProjectRuntimeManager;
const renderers: Renderer[] = [];

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-layout-ipc-'));
  runtimeManager = new ProjectRuntimeManager({
    baseDir,
    appVersion: '0.12.0-test',
  });
  electronMock.handlers.clear();
  electronMock.handle.mockClear();
});

afterEach(() => {
  for (const value of renderers.splice(0)) {
    clearRendererWorkspaceScope(value);
  }
  runtimeManager.closeAll();
  fs.rmSync(baseDir, { recursive: true, force: true });
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
    expect(
      invoke(LAYOUT_CHANNELS.load, windowA, {
        workspacePath: scopeA.rootRealPath,
      }),
    ).toMatchObject({ root: { id: 'leaf-A' } });
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

    invoke(LAYOUT_CHANNELS.save, windowB, {
      workspacePath: scopeB.rootRealPath,
      layout: layout('B'),
    });
    expect(
      invoke(LAYOUT_CHANNELS.load, windowA, {
        workspacePath: scopeA.rootRealPath,
      }),
    ).toMatchObject({ root: { id: 'leaf-A' } });
    expect(
      invoke(LAYOUT_CHANNELS.load, windowB, {
        workspacePath: scopeB.rootRealPath,
      }),
    ).toMatchObject({ root: { id: 'leaf-B' } });
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
});
