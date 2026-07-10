import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { NOTE_CHANNELS } from '../../shared/note-types';
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

import {
  registerNotesIpc,
  registerNotesListener,
  unregisterNotesListener,
} from './notes-ipc';

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

function note(id = 'note-shared') {
  return {
    id,
    text: 'Scoped note',
    x: 10,
    y: 20,
    w: 220,
    h: 180,
    color: 'yellow' as const,
  };
}

let baseDir = '';
let runtimeManager: ProjectRuntimeManager;
const renderers: Renderer[] = [];

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-notes-ipc-'));
  runtimeManager = new ProjectRuntimeManager({
    baseDir,
    appVersion: '0.12.0-test',
  });
  electronMock.handlers.clear();
  electronMock.handle.mockClear();
});

afterEach(() => {
  for (const value of renderers.splice(0)) {
    unregisterNotesListener(value);
    clearRendererWorkspaceScope(value);
  }
  runtimeManager.closeAll();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('notes IPC project authority', () => {
  it('isolates A/B data and broadcasts only to windows currently in A', () => {
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
    const windowA = renderer(101);
    const secondWindowA = renderer(102);
    const windowB = renderer(201);
    renderers.push(windowA, secondWindowA, windowB);
    bindResolvedRendererWorkspaceScope(windowA, scopeA);
    bindResolvedRendererWorkspaceScope(secondWindowA, scopeA);
    bindResolvedRendererWorkspaceScope(windowB, scopeB);
    registerNotesListener(windowA);
    registerNotesListener(secondWindowA);
    registerNotesListener(windowB);
    registerNotesIpc(runtimeManager);

    expect(() =>
      invoke(NOTE_CHANNELS.save, windowA, {
        workspacePath: scopeB.rootRealPath,
        note: note(),
      }),
    ).toThrow(/does not match renderer scope/i);
    expect(windowA.send).not.toHaveBeenCalled();
    expect(
      invoke(NOTE_CHANNELS.save, windowA, {
        workspacePath: scopeA.rootRealPath,
        note: note(),
      }),
    ).toEqual({ ok: true });

    expect(windowA.send).toHaveBeenCalledWith(
      NOTE_CHANNELS.changed,
      expect.objectContaining({
        workspacePath: scopeA.rootRealPath,
        notes: [
          expect.objectContaining({
            id: 'note-shared',
            projectId: scopeA.projectId,
            checkoutId: scopeA.checkoutId,
          }),
        ],
      }),
    );
    expect(secondWindowA.send).toHaveBeenCalledOnce();
    expect(windowB.send).not.toHaveBeenCalled();
    expect(
      invoke(NOTE_CHANNELS.list, windowB, {
        workspacePath: scopeB.rootRealPath,
      }),
    ).toEqual([]);

    invoke(NOTE_CHANNELS.save, windowB, {
      workspacePath: scopeB.rootRealPath,
      note: { ...note(), text: 'Project B copy' },
    });
    expect(() =>
      invoke(NOTE_CHANNELS.list, windowB, {
        workspacePath: scopeA.rootRealPath,
      }),
    ).toThrow(/does not match renderer scope/i);
    expect(
      invoke(NOTE_CHANNELS.remove, windowA, { id: 'note-shared' }),
    ).toEqual({ ok: true });
    expect(
      invoke(NOTE_CHANNELS.list, windowB, {
        workspacePath: scopeB.rootRealPath,
      }),
    ).toEqual([
      expect.objectContaining({ id: 'note-shared', text: 'Project B copy' }),
    ]);
  });

  it('re-evaluates listener scope and rejects renderers with no authority', () => {
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
    const movingWindow = renderer(301);
    const unauthorized = renderer(302);
    renderers.push(movingWindow, unauthorized);
    bindResolvedRendererWorkspaceScope(movingWindow, scopeA);
    registerNotesListener(movingWindow);
    registerNotesIpc(runtimeManager);
    bindResolvedRendererWorkspaceScope(movingWindow, scopeB);

    const sourceA = renderer(303);
    renderers.push(sourceA);
    bindResolvedRendererWorkspaceScope(sourceA, scopeA);
    registerNotesListener(sourceA);
    invoke(NOTE_CHANNELS.save, sourceA, {
      workspacePath: scopeA.rootRealPath,
      note: note('note-a'),
    });

    expect(movingWindow.send).not.toHaveBeenCalled();
    expect(() =>
      invoke(NOTE_CHANNELS.list, unauthorized, {
        workspacePath: '/untrusted',
      }),
    ).toThrow(/authorized workspace scope/i);
  });
});
