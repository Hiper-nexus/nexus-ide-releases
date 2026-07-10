import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { GAMIFICATION_CHANNELS } from '../../shared/gamification-types';
import { testProjectScope } from '../orch/__tests__/scope-fixture';
import { ProjectDomainStoreRegistry } from '../orch/project-domain-store-registry';
import {
  bindResolvedRendererWorkspaceScope,
  clearRendererWorkspaceScope,
} from '../persistence/renderer-workspace-scope';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    handle: vi.fn(
      (channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      },
    ),
    showSaveDialog: vi.fn(),
    showOpenDialog: vi.fn(),
  };
});

vi.mock('electron', () => ({
  ipcMain: { handle: electronMock.handle },
  dialog: {
    showSaveDialog: electronMock.showSaveDialog,
    showOpenDialog: electronMock.showOpenDialog,
  },
}));

import {
  broadcastGamificationToProject,
  registerGamificationIpc,
  registerGamificationListener,
  unregisterGamificationListener,
} from './gamification-ipc';
import { ProjectGamificationService } from './gamification-service';

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

let baseDir = '';
let runtimeManager: ProjectRuntimeManager;
let registry: ProjectDomainStoreRegistry;
let service: ProjectGamificationService;
const renderers: Renderer[] = [];

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-gamification-ipc-'));
  runtimeManager = new ProjectRuntimeManager({
    baseDir,
    appVersion: '0.12.0-test',
  });
  registry = new ProjectDomainStoreRegistry(runtimeManager);
  service = new ProjectGamificationService({
    runtimeManager,
    domainStores: registry,
    broadcast: broadcastGamificationToProject,
  });
  service.start();
  electronMock.handlers.clear();
  electronMock.handle.mockClear();
  electronMock.showSaveDialog.mockReset();
  electronMock.showOpenDialog.mockReset();
  registerGamificationIpc(service);
});

afterEach(() => {
  vi.useRealTimers();
  for (const value of renderers.splice(0)) {
    unregisterGamificationListener(value);
    clearRendererWorkspaceScope(value);
  }
  service.dispose();
  registry.dispose();
  runtimeManager.closeAll();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('gamification IPC project authority', () => {
  it('isolates actions and broadcasts to exact A windows only', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const scopeA = testProjectScope({
      projectId: 'project-a',
      checkoutId: 'main',
      rootRealPath: '/workspace/a',
    });
    const scopeB = testProjectScope({
      projectId: 'project-b',
      checkoutId: 'main',
      rootRealPath: '/workspace/b',
    });
    const scopeAFeature = testProjectScope({
      projectId: 'project-a',
      checkoutId: 'feature',
      rootRealPath: '/workspace/a-feature',
    });
    const windowA = renderer(101);
    const secondWindowA = renderer(102);
    const windowB = renderer(201);
    const windowAFeature = renderer(301);
    renderers.push(windowA, secondWindowA, windowB, windowAFeature);
    bindResolvedRendererWorkspaceScope(windowA, scopeA);
    bindResolvedRendererWorkspaceScope(secondWindowA, scopeA);
    bindResolvedRendererWorkspaceScope(windowB, scopeB);
    bindResolvedRendererWorkspaceScope(windowAFeature, scopeAFeature);
    for (const value of renderers) registerGamificationListener(value);

    expect(
      invoke(GAMIFICATION_CHANNELS.recordJarvisAction, windowA, {
        actionType: 'open_terminal',
        ok: true,
      }),
    ).toEqual(
      expect.objectContaining({
        powerLevel: 1_500,
        projectId: scopeA.projectId,
        checkoutId: scopeA.checkoutId,
        rootRealPath: scopeA.rootRealPath,
      }),
    );
    vi.advanceTimersByTime(1_100);

    expect(windowA.send).toHaveBeenCalledWith(
      GAMIFICATION_CHANNELS.changed,
      expect.objectContaining({ powerLevel: 1_500, projectId: 'project-a' }),
    );
    expect(
      secondWindowA.send.mock.calls.filter(
        ([channel]) => channel === GAMIFICATION_CHANNELS.changed,
      ),
    ).toHaveLength(1);
    expect(windowB.send).not.toHaveBeenCalled();
    expect(windowAFeature.send).not.toHaveBeenCalled();
    expect(invoke(GAMIFICATION_CHANNELS.snapshot, windowB)).toEqual(
      expect.objectContaining({ powerLevel: 0, projectId: 'project-b' }),
    );
    expect(invoke(GAMIFICATION_CHANNELS.snapshot, windowAFeature)).toEqual(
      expect.objectContaining({ powerLevel: 0, checkoutId: 'feature' }),
    );
  });

  it('rejects unbound renderers before parsing or touching storage', () => {
    const unauthorized = renderer(404);
    renderers.push(unauthorized);

    expect(() =>
      invoke(GAMIFICATION_CHANNELS.recordJarvisAction, unauthorized, {
        actionType: 'open_terminal',
        ok: true,
      }),
    ).toThrow(/authorized workspace scope/i);
    expect(() =>
      invoke(GAMIFICATION_CHANNELS.selectSkin, unauthorized, null),
    ).toThrow(/authorized workspace scope/i);
    expect(runtimeManager.getHealth(testProjectScope())).toBeNull();
  });

  it('uses physical databases for same project with different checkouts', () => {
    const mainScope = testProjectScope({
      projectId: 'project-shared',
      checkoutId: 'main',
      rootRealPath: '/workspace/main',
    });
    const featureScope = testProjectScope({
      projectId: 'project-shared',
      checkoutId: 'feature',
      rootRealPath: '/workspace/feature',
    });
    const mainWindow = renderer(501);
    const featureWindow = renderer(502);
    renderers.push(mainWindow, featureWindow);
    bindResolvedRendererWorkspaceScope(mainWindow, mainScope);
    bindResolvedRendererWorkspaceScope(featureWindow, featureScope);

    invoke(GAMIFICATION_CHANNELS.recordJarvisAction, mainWindow, {
      actionType: 'open_terminal',
      ok: true,
    });

    expect(invoke(GAMIFICATION_CHANNELS.snapshot, mainWindow)).toEqual(
      expect.objectContaining({ powerLevel: 1_500, checkoutId: 'main' }),
    );
    expect(invoke(GAMIFICATION_CHANNELS.snapshot, featureWindow)).toEqual(
      expect.objectContaining({ powerLevel: 0, checkoutId: 'feature' }),
    );
    expect(runtimeManager.open(mainScope).databasePath).not.toBe(
      runtimeManager.open(featureScope).databasePath,
    );
  });

  it('fails a profile export if the renderer changes project while dialog is open', async () => {
    const scopeA = testProjectScope({
      projectId: 'project-a',
      checkoutId: 'main',
      rootRealPath: '/workspace/a',
    });
    const scopeB = testProjectScope({
      projectId: 'project-b',
      checkoutId: 'main',
      rootRealPath: '/workspace/b',
    });
    const movingWindow = renderer(601);
    renderers.push(movingWindow);
    bindResolvedRendererWorkspaceScope(movingWindow, scopeA);
    const target = path.join(baseDir, 'profile.json');
    let finishDialog: ((value: unknown) => void) | undefined;
    electronMock.showSaveDialog.mockReturnValue(
      new Promise((resolve) => {
        finishDialog = resolve;
      }),
    );

    const pending = invoke(
      GAMIFICATION_CHANNELS.exportProfile,
      movingWindow,
    ) as Promise<unknown>;
    bindResolvedRendererWorkspaceScope(movingWindow, scopeB);
    finishDialog?.({ canceled: false, filePath: target });

    await expect(pending).resolves.toEqual({
      ok: false,
      error: 'O projeto mudou durante a exportação.',
    });
    expect(fs.existsSync(target)).toBe(false);
  });
});
