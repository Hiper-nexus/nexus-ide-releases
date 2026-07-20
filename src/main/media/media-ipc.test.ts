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
    showItemInFolder: vi.fn(),
  };
});

vi.mock('electron', () => ({
  ipcMain: { handle: electronMock.handle },
  shell: { showItemInFolder: electronMock.showItemInFolder },
}));
vi.mock('./media-providers', () => ({
  listMediaProviders: vi.fn(() => []),
}));
vi.mock('./media-keys', () => ({
  hasMediaKey: vi.fn(),
  maskedMediaKey: vi.fn(),
  setMediaKey: vi.fn(() => ({ ok: true })),
}));
// Engine pesado fica fora do teste de IPC — aqui só validamos o envelope.
vi.mock('./media-generation', () => ({
  generateImage: vi.fn(),
  generateVideo: vi.fn(),
  MediaAbortError: class MediaAbortError extends Error {},
  MediaJobTimeoutError: class MediaJobTimeoutError extends Error {
    readonly jobId: string;
    readonly provider: string;
    readonly recoverable = true;
    constructor(provider: string, jobId: string) {
      super('timeout');
      this.provider = provider;
      this.jobId = jobId;
    }
  },
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

describe('media IPC — Estúdio de Mídia', () => {
  function invokeWith(
    channel: string,
    sender: Renderer,
    payload: unknown,
  ): unknown {
    const handler = electronMock.handlers.get(channel);
    if (!handler) throw new Error(`missing handler: ${channel}`);
    return handler({ sender }, payload);
  }

  function boundRenderer(id: number, s: ProjectExecutionScope): Renderer {
    const r = renderer(id);
    renderers.push(r);
    bindResolvedRendererWorkspaceScope(r, s);
    return r;
  }

  it('generate rejeita payload inválido sem tocar o engine', async () => {
    const s = scope(parent, 'project-gen', 'checkout-gen');
    const win = boundRenderer(11, s);
    registerMediaIpc(runtimeManager);
    await expect(
      invokeWith(MEDIA_CHANNELS.generate, win, {
        kind: 'image',
        // prompt e clientJobId ausentes
      }),
    ).resolves.toEqual({ ok: false, error: 'payload inválido' });
  });

  it('generate exige workspace autorizado', async () => {
    const stranger = renderer(12);
    renderers.push(stranger);
    registerMediaIpc(runtimeManager);
    await expect(
      invokeWith(MEDIA_CHANNELS.generate, stranger, {
        kind: 'image',
        prompt: 'x',
        clientJobId: 'j1',
      }),
    ).rejects.toThrow(/authorized workspace scope/i);
  });

  it('cancelGenerate é idempotente mesmo sem job ativo', () => {
    const s = scope(parent, 'project-cancel', 'checkout-cancel');
    const win = boundRenderer(13, s);
    registerMediaIpc(runtimeManager);
    expect(
      invokeWith(MEDIA_CHANNELS.cancelGenerate, win, { clientJobId: 'zzz' }),
    ).toEqual({ ok: true });
  });

  it('listArtifacts vê apenas os artefatos do próprio workspace', async () => {
    const scopeA = scope(parent, 'project-ga', 'checkout-ga');
    const scopeB = scope(parent, 'project-gb', 'checkout-gb');
    const winA = boundRenderer(14, scopeA);
    boundRenderer(15, scopeB);
    createScopedMediaUsageStore(runtimeManager, scopeA).record({
      kind: 'image',
      provider: 'google-image',
      model: 'gemini-3.1-flash-image-preview',
      storageKey: 'a.png',
      sha256: 'a'.repeat(64),
      costUsd: 0.039,
      durationMs: 100,
    });
    createScopedMediaUsageStore(runtimeManager, scopeB).record({
      kind: 'video',
      provider: 'replicate-video',
      model: 'bytedance/seedance-2.0',
      storageKey: 'b.mp4',
      sha256: 'b'.repeat(64),
      costUsd: 0.6,
      durationMs: 200,
    });
    registerMediaIpc(runtimeManager);

    const list = invokeWith(MEDIA_CHANNELS.listArtifacts, winA, undefined) as Array<{
      storageKey: string;
      kind: string;
      costUsd: number | null;
    }>;
    expect(list).toHaveLength(1);
    expect(list[0].storageKey).toBe('a.png');
    expect(list[0].kind).toBe('image');
    expect(list[0].costUsd).toBe(0.039);
  });

  it('readArtifactDataUrl devolve data URL e barra tipos sem preview', async () => {
    const s = scope(parent, 'project-preview', 'checkout-preview');
    const win = boundRenderer(16, s);
    fs.writeFileSync(path.join(s.rootRealPath, 'pic.png'), 'png-bytes');
    fs.writeFileSync(path.join(s.rootRealPath, 'notes.txt'), 'txt');
    registerMediaIpc(runtimeManager);

    const ok = (await invokeWith(MEDIA_CHANNELS.readArtifactDataUrl, win, {
      storageKey: 'pic.png',
    })) as { ok: boolean; dataUrl?: string };
    expect(ok.ok).toBe(true);
    expect(ok.dataUrl).toMatch(/^data:image\/png;base64,/);

    const unsupported = (await invokeWith(
      MEDIA_CHANNELS.readArtifactDataUrl,
      win,
      { storageKey: 'notes.txt' },
    )) as { ok: boolean; error?: string };
    expect(unsupported.ok).toBe(false);
    expect(unsupported.error).toMatch(/sem preview/);
  });

  it('readArtifactDataUrl/revealArtifact rejeitam path que escapa do workspace', async () => {
    const s = scope(parent, 'project-escape', 'checkout-escape');
    const win = boundRenderer(17, s);
    registerMediaIpc(runtimeManager);
    await expect(
      invokeWith(MEDIA_CHANNELS.readArtifactDataUrl, win, {
        storageKey: '../fora.png',
      }),
    ).rejects.toThrow(/escapa/);
    expect(() =>
      invokeWith(MEDIA_CHANNELS.revealArtifact, win, {
        storageKey: '../fora.png',
      }),
    ).toThrow(/escapa/);
    expect(electronMock.showItemInFolder).not.toHaveBeenCalled();
  });

  it('revealArtifact abre o Finder no arquivo dentro do workspace', () => {
    const s = scope(parent, 'project-reveal', 'checkout-reveal');
    const win = boundRenderer(18, s);
    fs.writeFileSync(path.join(s.rootRealPath, 'clip.mp4'), 'mp4');
    registerMediaIpc(runtimeManager);
    expect(
      invokeWith(MEDIA_CHANNELS.revealArtifact, win, {
        storageKey: 'clip.mp4',
      }),
    ).toEqual({ ok: true });
    expect(electronMock.showItemInFolder).toHaveBeenCalledWith(
      path.join(s.rootRealPath, 'clip.mp4'),
    );
  });
});
