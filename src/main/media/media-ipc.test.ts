import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { MEDIA_CHANNELS } from '../../shared/media-types';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  bindResolvedRendererWorkspaceScope,
  clearRendererWorkspaceScope,
} from '../persistence/renderer-workspace-scope';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { createScopedMediaUsageStore } from '../usage/media-usage-store';

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
vi.mock('./media-providers', () => ({
  listMediaProviders: vi.fn(() => []),
}));
vi.mock('./media-keys', () => ({
  hasMediaKey: vi.fn(),
  maskedMediaKey: vi.fn(),
  setMediaKey: vi.fn(() => ({ ok: true })),
}));

import { registerMediaIpc } from './media-ipc';

type Renderer = WebContents & { id: number };

function renderer(id: number): Renderer {
  return { id } as Renderer;
}

function scope(
  parent: string,
  projectId: string,
  checkoutId: string,
): ProjectExecutionScope {
  const root = path.join(parent, checkoutId);
  fs.mkdirSync(root);
  return Object.freeze({
    version: 1,
    installationId: 'install-a',
    projectId,
    checkoutId,
    rootRealPath: fs.realpathSync(root),
    identitySource: 'manifest',
  });
}

function invoke(channel: string, sender: Renderer): unknown {
  const handler = electronMock.handlers.get(channel);
  if (!handler) throw new Error(`missing handler: ${channel}`);
  return handler({ sender });
}

let parent = '';
let runtimeManager: ProjectRuntimeManager;
const renderers: Renderer[] = [];

beforeEach(() => {
  parent = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-media-ipc-'));
  runtimeManager = new ProjectRuntimeManager({
    baseDir: path.join(parent, 'runtime'),
    appVersion: 'media-ipc-test',
  });
  electronMock.handlers.clear();
});

afterEach(() => {
  for (const value of renderers.splice(0)) {
    clearRendererWorkspaceScope(value);
  }
  runtimeManager.closeAll();
  fs.rmSync(parent, { recursive: true, force: true });
});

describe('media IPC project authority', () => {
  it('derives usage totals only from the sender current scope', () => {
    const scopeA = scope(parent, 'project-a', 'checkout-a');
    const scopeB = scope(parent, 'project-b', 'checkout-b');
    const windowA = renderer(101);
    const windowB = renderer(202);
    const unauthorized = renderer(303);
    renderers.push(windowA, windowB, unauthorized);
    bindResolvedRendererWorkspaceScope(windowA, scopeA);
    bindResolvedRendererWorkspaceScope(windowB, scopeB);
    createScopedMediaUsageStore(runtimeManager, scopeA).record({
      kind: 'image',
      provider: 'openai-image',
      model: 'gpt-image-1',
      storageKey: 'a.png',
      sha256: 'a'.repeat(64),
      costUsd: 0.03,
      durationMs: 1,
    });
    createScopedMediaUsageStore(runtimeManager, scopeB).record({
      kind: 'audio',
      provider: 'elevenlabs',
      model: 'eleven-v3',
      storageKey: 'b.mp3',
      sha256: 'b'.repeat(64),
      costUsd: 0.2,
      durationMs: 1,
    });
    registerMediaIpc(runtimeManager);

    expect(invoke(MEDIA_CHANNELS.usageTotals, windowA)).toEqual({
      generations: 1,
      costUsd: 0.03,
    });
    expect(invoke(MEDIA_CHANNELS.usageTotals, windowB)).toEqual({
      generations: 1,
      costUsd: 0.2,
    });
    expect(() => invoke(MEDIA_CHANNELS.usageTotals, unauthorized)).toThrow(
      /authorized workspace scope/i,
    );
  });
});
