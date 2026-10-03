import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { USAGE_CHANNELS } from '../../shared/usage-types';
import type { ProjectExecutionScope } from '../../shared/types';
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
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
  };
});

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: {
    handle: electronMock.handle,
    removeHandler: electronMock.removeHandler,
  },
}));

import {
  initUsageTelemetry,
  shutdownUsageTelemetry,
} from './usage-service';
import { requireProjectUsageStores } from './usage-store-registry';

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

function invoke(sender: Renderer): unknown {
  const handler = electronMock.handlers.get(USAGE_CHANNELS.snapshot);
  if (!handler) throw new Error('usage snapshot handler is not registered');
  return handler({ sender });
}

let parent = '';
let runtimeManager: ProjectRuntimeManager;
const renderers: Renderer[] = [];

beforeEach(() => {
  parent = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-usage-ipc-'));
  runtimeManager = new ProjectRuntimeManager({
    baseDir: path.join(parent, 'runtime'),
    appVersion: 'usage-ipc-test',
  });
  electronMock.handlers.clear();
});

afterEach(async () => {
  await shutdownUsageTelemetry();
  for (const value of renderers.splice(0)) {
    clearRendererWorkspaceScope(value);
  }
  runtimeManager.closeAll();
  fs.rmSync(parent, { recursive: true, force: true });
});

describe('usage snapshot IPC project authority', () => {
  it('captures sender scope and never returns another checkout totals', async () => {
    const scopeA = scope(parent, 'project-a', 'checkout-a');
    const scopeB = scope(parent, 'project-a', 'checkout-b');
    const windowA = renderer(101);
    const windowB = renderer(202);
    const unauthorized = renderer(303);
    renderers.push(windowA, windowB, unauthorized);
    bindResolvedRendererWorkspaceScope(windowA, scopeA);
    bindResolvedRendererWorkspaceScope(windowB, scopeB);
    await initUsageTelemetry(runtimeManager);
    requireProjectUsageStores(scopeA).usage.record('claude', {
      sessionId: 'session-a',
      messageId: 'message-a',
      model: 'claude-sonnet-4-5',
      inputTokens: 12,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      timestamp: 100,
    });
    requireProjectUsageStores(scopeB).usage.record('codex', {
      sessionId: 'session-b',
      messageId: 'message-b',
      model: 'gpt-5',
      inputTokens: 99,
      outputTokens: 4,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      timestamp: 200,
    });

    expect(invoke(windowA)).toMatchObject({
      global: { inputTokens: 12, outputTokens: 2, turns: 1 },
    });
    expect(invoke(windowB)).toMatchObject({
      global: { inputTokens: 99, outputTokens: 4, turns: 1 },
    });
    expect(() => invoke(unauthorized)).toThrow(/authorized workspace scope/i);
  });
});
