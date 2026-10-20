import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { MEDIA_NO_PROJECT_ERROR } from '../../shared/media-types';
import { MEDIA_REFERENCE_CHANNELS } from '../../shared/media-reference-types';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  bindResolvedRendererWorkspaceScope,
  clearRendererWorkspaceScope,
} from '../persistence/renderer-workspace-scope';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  trashItem: vi.fn(async (_abs: string) => undefined),
}));

vi.mock('electron', () => ({ shell: { trashItem: h.trashItem } }));
vi.mock('../security/trusted-ipc', () => ({
  handleTrusted: (channel: string, fn: (...args: unknown[]) => unknown) =>
    h.handlers.set(channel, fn),
}));

import { registerMediaReferenceIpc } from './media-reference-ipc';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

type Renderer = WebContents & { id: number };
const sender = { id: 501 } as Renderer;
let parent = '';
let scope: ProjectExecutionScope;

function invoke(channel: string, payload?: unknown): unknown {
  const handler = h.handlers.get(channel);
  if (!handler) throw new Error(`missing handler: ${channel}`);
  return handler({ sender }, payload);
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

beforeEach(() => {
  parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ref-ipc-')));
  const root = path.join(parent, 'checkout');
  fs.mkdirSync(root);
  scope = Object.freeze({
    version: 1,
    installationId: 'install-a',
    projectId: 'project-a',
    checkoutId: 'checkout-a',
    rootRealPath: fs.realpathSync(root),
    identitySource: 'manifest',
  }) as ProjectExecutionScope;
  h.handlers.clear();
  h.trashItem.mockClear();
  registerMediaReferenceIpc();
});

afterEach(() => {
  clearRendererWorkspaceScope(sender);
  fs.rmSync(parent, { recursive: true, force: true });
});

describe('media reference IPC', () => {
  it('sem projeto aberto não grava nem lista', async () => {
    expect(await invoke(MEDIA_REFERENCE_CHANNELS.list)).toBeNull();
    expect(
      await invoke(MEDIA_REFERENCE_CHANNELS.save, { name: 'logo.png', data: arrayBuffer(PNG) }),
    ).toEqual({ ok: false, error: MEDIA_NO_PROJECT_ERROR });
  });

  it('grava os bytes recebidos dentro do projeto do remetente e lista em seguida', async () => {
    bindResolvedRendererWorkspaceScope(sender, scope);
    const saved = (await invoke(MEDIA_REFERENCE_CHANNELS.save, {
      name: 'Logo.png',
      data: arrayBuffer(PNG),
    })) as { ok: true; reference: { storageKey: string } };
    expect(saved.ok).toBe(true);
    expect(fs.existsSync(path.join(scope.rootRealPath, saved.reference.storageKey))).toBe(true);
    const list = (await invoke(MEDIA_REFERENCE_CHANNELS.list)) as Array<{ storageKey: string }>;
    expect(list.map((r) => r.storageKey)).toEqual([saved.reference.storageKey]);
    const preview = (await invoke(MEDIA_REFERENCE_CHANNELS.readDataUrl, {
      storageKey: saved.reference.storageKey,
    })) as { ok: boolean; dataUrl?: string };
    expect(preview.dataUrl?.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('aceita os bytes também como Uint8Array (clone estruturado do Electron)', async () => {
    bindResolvedRendererWorkspaceScope(sender, scope);
    const saved = (await invoke(MEDIA_REFERENCE_CHANNELS.save, {
      name: 'logo.png',
      data: PNG.subarray(0),
    })) as { ok: boolean };
    expect(saved.ok).toBe(true);
  });

  it('não aceita caminho de origem: só bytes', async () => {
    bindResolvedRendererWorkspaceScope(sender, scope);
    expect(
      await invoke(MEDIA_REFERENCE_CHANNELS.save, { name: 'x.png', data: '/etc/passwd' }),
    ).toEqual({ ok: false, error: 'payload inválido' });
    expect(
      await invoke(MEDIA_REFERENCE_CHANNELS.save, { name: 'x.png', path: '/etc/passwd' }),
    ).toEqual({ ok: false, error: 'payload inválido' });
  });

  it('remover manda para a Lixeira e recusa o que está fora da pasta', async () => {
    bindResolvedRendererWorkspaceScope(sender, scope);
    const saved = (await invoke(MEDIA_REFERENCE_CHANNELS.save, {
      name: 'logo.png',
      data: arrayBuffer(PNG),
    })) as { ok: true; reference: { storageKey: string } };
    expect(
      await invoke(MEDIA_REFERENCE_CHANNELS.remove, { storageKey: saved.reference.storageKey }),
    ).toEqual({ ok: true });
    expect(h.trashItem).toHaveBeenCalledWith(
      path.join(scope.rootRealPath, saved.reference.storageKey),
    );
    expect(
      await invoke(MEDIA_REFERENCE_CHANNELS.remove, { storageKey: 'package.json' }),
    ).toMatchObject({ ok: false });
    expect(h.trashItem).toHaveBeenCalledTimes(1);
  });
});
