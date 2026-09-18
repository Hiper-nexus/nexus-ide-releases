import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import {
  FILES_CHANNELS,
  type FileTreeResult,
  type ReadFileResult,
} from '../../shared/files-types';
import type { ProjectExecutionScope } from '../../shared/types';
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

import { registerFilesIpc } from './files-ipc';

type Renderer = WebContents & { id: number };

function renderer(id: number): Renderer {
  return { id } as Renderer;
}

function scope(
  rootRealPath: string,
  projectId: string,
  checkoutId: string,
): ProjectExecutionScope {
  return Object.freeze({
    version: 1,
    installationId: 'installation-test',
    projectId,
    checkoutId,
    rootRealPath,
    identitySource: 'manifest',
  });
}

function invoke<T>(channel: string, sender: Renderer, raw?: unknown): T {
  const handler = electronMock.handlers.get(channel);
  if (!handler) throw new Error(`missing handler: ${channel}`);
  return handler({ sender }, raw) as T;
}

let baseDir = '';
const renderers: Renderer[] = [];

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-files-ipc-'));
  electronMock.handlers.clear();
  electronMock.handle.mockClear();
  registerFilesIpc();
});

afterEach(() => {
  for (const value of renderers.splice(0)) {
    clearRendererWorkspaceScope(value);
  }
  fs.rmSync(baseDir, { recursive: true, force: true });
});

function project(name: string, content: string): string {
  const root = path.join(baseDir, name);
  fs.mkdirSync(path.join(root, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(root, 'same.txt'), content, 'utf8');
  return fs.realpathSync(root);
}

describe('file explorer IPC renderer authority', () => {
  it('isolates list, read, and write by the invoking WebContents scope', () => {
    const rootA = project('project-a', 'content-a');
    const rootB = project('project-b', 'content-b');
    fs.writeFileSync(path.join(rootA, 'only-a.txt'), 'a', 'utf8');
    fs.writeFileSync(path.join(rootB, 'only-b.txt'), 'b', 'utf8');
    const windowA = renderer(101);
    const windowB = renderer(102);
    renderers.push(windowA, windowB);
    bindResolvedRendererWorkspaceScope(
      windowA,
      scope(rootA, 'project-a', 'checkout-a'),
    );
    bindResolvedRendererWorkspaceScope(
      windowB,
      scope(rootB, 'project-b', 'checkout-b'),
    );

    const listA = invoke<FileTreeResult>(FILES_CHANNELS.list, windowA, {
      relPath: '',
    });
    const listB = invoke<FileTreeResult>(FILES_CHANNELS.list, windowB, {
      relPath: '',
    });
    expect(listA.entries?.map((entry) => entry.name)).toContain('only-a.txt');
    expect(listA.entries?.map((entry) => entry.name)).not.toContain('only-b.txt');
    expect(listB.entries?.map((entry) => entry.name)).toContain('only-b.txt');
    expect(listB.entries?.map((entry) => entry.name)).not.toContain('only-a.txt');

    expect(
      invoke<ReadFileResult>(FILES_CHANNELS.read, windowA, {
        relPath: 'same.txt',
      }),
    ).toMatchObject({ ok: true, content: 'content-a' });
    expect(
      invoke<ReadFileResult>(FILES_CHANNELS.read, windowB, {
        relPath: 'same.txt',
      }),
    ).toMatchObject({ ok: true, content: 'content-b' });

    const pathFromAToB = path.relative(rootA, path.join(rootB, 'same.txt'));
    expect(
      invoke<ReadFileResult>(FILES_CHANNELS.read, windowA, {
        relPath: pathFromAToB,
      }),
    ).toEqual({ ok: false, error: 'path outside workspace' });
    expect(
      invoke(FILES_CHANNELS.write, windowA, {
        relPath: pathFromAToB,
        content: 'cross-project-write',
      }),
    ).toEqual({ ok: false, error: 'path outside workspace' });
    expect(fs.readFileSync(path.join(rootB, 'same.txt'), 'utf8')).toBe(
      'content-b',
    );

    expect(
      invoke(FILES_CHANNELS.write, windowA, {
        relPath: 'nested/from-a.txt',
        content: 'written-a',
      }),
    ).toEqual({ ok: true });
    expect(fs.readFileSync(path.join(rootA, 'nested/from-a.txt'), 'utf8')).toBe(
      'written-a',
    );
    expect(fs.existsSync(path.join(rootB, 'nested/from-a.txt'))).toBe(false);
  });

  it('captures the current sender scope for concurrent requests during a project swap', async () => {
    const rootA = project('swap-a', 'before-a');
    const rootB = project('swap-b', 'before-b');
    const windowA = renderer(201);
    const windowB = renderer(202);
    renderers.push(windowA, windowB);

    bindResolvedRendererWorkspaceScope(
      windowA,
      scope(rootA, 'project-a', 'checkout-a'),
    );
    bindResolvedRendererWorkspaceScope(
      windowB,
      scope(rootB, 'project-b', 'checkout-b'),
    );

    const [writeA, writeB] = await Promise.all([
      Promise.resolve().then(() => {
        bindResolvedRendererWorkspaceScope(
          windowA,
          scope(rootB, 'project-b', 'checkout-b'),
        );
        return invoke(FILES_CHANNELS.write, windowA, {
          relPath: 'same.txt',
          content: 'renderer-a-after-swap',
        });
      }),
      Promise.resolve().then(() => {
        bindResolvedRendererWorkspaceScope(
          windowB,
          scope(rootA, 'project-a', 'checkout-a'),
        );
        return invoke(FILES_CHANNELS.write, windowB, {
          relPath: 'same.txt',
          content: 'renderer-b-after-swap',
        });
      }),
    ]);

    expect(writeA).toEqual({ ok: true });
    expect(writeB).toEqual({ ok: true });
    expect(fs.readFileSync(path.join(rootB, 'same.txt'), 'utf8')).toBe(
      'renderer-a-after-swap',
    );
    expect(fs.readFileSync(path.join(rootA, 'same.txt'), 'utf8')).toBe(
      'renderer-b-after-swap',
    );
  });

  it.each([
    FILES_CHANNELS.list,
    FILES_CHANNELS.read,
    FILES_CHANNELS.write,
    FILES_CHANNELS.saveDropped,
    FILES_CHANNELS.importMissionAttachment,
    FILES_CHANNELS.importDroppedUri,
    FILES_CHANNELS.clipboardFileUris,
  ])(
    'fails closed for an unbound renderer on %s',
    (channel) => {
      const window = renderer(301);
      renderers.push(window);

      const raw =
        channel === FILES_CHANNELS.importDroppedUri
          ? { uri: 'file:///tmp/blocked.txt' }
          : channel === FILES_CHANNELS.saveDropped ||
              channel === FILES_CHANNELS.importMissionAttachment
            ? { name: 'drop.txt', base64: 'YmxvY2tlZA==' }
            : {
                relPath: channel === FILES_CHANNELS.list ? '' : 'same.txt',
                content: 'blocked',
              };

      expect(() => invoke(channel, window, raw)).toThrow(
        /renderer has no authorized workspace scope/i,
      );
    },
  );

  it('rejects a stale scope when its canonical root path is replaced', () => {
    const rootA = project('stale-a', 'content-a');
    const rootB = project('stale-b', 'content-b');
    const archivedA = path.join(baseDir, 'stale-a-archived');
    const window = renderer(401);
    renderers.push(window);
    bindResolvedRendererWorkspaceScope(
      window,
      scope(rootA, 'project-a', 'checkout-a'),
    );

    fs.renameSync(rootA, archivedA);
    fs.symlinkSync(
      rootB,
      rootA,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    expect(
      invoke<ReadFileResult>(FILES_CHANNELS.read, window, {
        relPath: 'same.txt',
      }),
    ).toEqual({ ok: false, error: 'path outside workspace' });
    expect(fs.readFileSync(path.join(rootB, 'same.txt'), 'utf8')).toBe(
      'content-b',
    );
  });

  it('preserves symlink escape protection for existing and new write targets', () => {
    const root = project('symlink-root', 'inside');
    const outside = project('outside', 'outside');
    const link = path.join(root, 'escape');
    fs.symlinkSync(
      outside,
      link,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const window = renderer(501);
    renderers.push(window);
    bindResolvedRendererWorkspaceScope(
      window,
      scope(root, 'project-a', 'checkout-a'),
    );

    const listed = invoke<FileTreeResult>(FILES_CHANNELS.list, window, {
      relPath: '',
    });
    expect(listed.entries?.map((entry) => entry.name)).not.toContain('escape');
    expect(
      invoke<ReadFileResult>(FILES_CHANNELS.read, window, {
        relPath: 'escape/same.txt',
      }),
    ).toEqual({ ok: false, error: 'path outside workspace' });
    expect(
      invoke(FILES_CHANNELS.write, window, {
        relPath: 'escape/new.txt',
        content: 'blocked',
      }),
    ).toEqual({ ok: false, error: 'path outside workspace' });
    expect(fs.existsSync(path.join(outside, 'new.txt'))).toBe(false);
  });

  it('rejects external hardlinks for list, read, and write without changing the inode', () => {
    const root = project('hardlink-root', 'inside');
    const outside = project('hardlink-outside', 'outside-secret');
    const externalFile = path.join(outside, 'same.txt');
    const linkedFile = path.join(root, 'external-hardlink.txt');
    fs.linkSync(externalFile, linkedFile);
    const window = renderer(601);
    renderers.push(window);
    bindResolvedRendererWorkspaceScope(
      window,
      scope(root, 'project-a', 'checkout-a'),
    );

    const listed = invoke<FileTreeResult>(FILES_CHANNELS.list, window, {
      relPath: '',
    });
    expect(listed.entries?.map((entry) => entry.name)).not.toContain(
      'external-hardlink.txt',
    );
    expect(
      invoke<ReadFileResult>(FILES_CHANNELS.read, window, {
        relPath: 'external-hardlink.txt',
      }),
    ).toEqual({ ok: false, error: 'unsafe file' });
    expect(
      invoke(FILES_CHANNELS.write, window, {
        relPath: 'external-hardlink.txt',
        content: 'must-not-write',
      }),
    ).toEqual({ ok: false, error: 'unsafe file' });
    expect(fs.readFileSync(externalFile, 'utf8')).toBe('outside-secret');
  });

  it('fails closed when the parent is swapped to an external symlink before descriptor open', () => {
    const root = project('swap-root', 'inside');
    const outside = project('swap-outside', 'outside-secret');
    fs.writeFileSync(path.join(root, 'nested', 'target.txt'), 'inside-target');
    fs.writeFileSync(path.join(outside, 'target.txt'), 'outside-target');
    const archivedParent = path.join(root, 'nested-archived');
    const window = renderer(701);
    renderers.push(window);
    bindResolvedRendererWorkspaceScope(
      window,
      scope(root, 'project-a', 'checkout-a'),
    );

    electronMock.handlers.clear();
    registerFilesIpc({
      beforeOpen(operation) {
        if (operation !== 'write') return;
        fs.renameSync(path.join(root, 'nested'), archivedParent);
        fs.symlinkSync(
          outside,
          path.join(root, 'nested'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      },
    });

    expect(
      invoke(FILES_CHANNELS.write, window, {
        relPath: 'nested/target.txt',
        content: 'must-not-write',
      }),
    ).toEqual({ ok: false, error: 'unsafe file' });
    expect(fs.readFileSync(path.join(outside, 'target.txt'), 'utf8')).toBe(
      'outside-target',
    );
    expect(fs.readFileSync(path.join(archivedParent, 'target.txt'), 'utf8')).toBe(
      'inside-target',
    );
  });

  it('does not read an external target swapped in before descriptor open', () => {
    const root = project('read-swap-root', 'inside-target');
    const outside = project('read-swap-outside', 'outside-secret');
    const original = path.join(root, 'same-original.txt');
    const window = renderer(702);
    renderers.push(window);
    bindResolvedRendererWorkspaceScope(
      window,
      scope(root, 'project-a', 'checkout-a'),
    );

    electronMock.handlers.clear();
    registerFilesIpc({
      beforeOpen(operation) {
        if (operation !== 'read') return;
        fs.renameSync(path.join(root, 'same.txt'), original);
        fs.symlinkSync(path.join(outside, 'same.txt'), path.join(root, 'same.txt'));
      },
    });

    expect(
      invoke<ReadFileResult>(FILES_CHANNELS.read, window, {
        relPath: 'same.txt',
      }),
    ).toEqual({ ok: false, error: 'unsafe file' });
    expect(fs.readFileSync(original, 'utf8')).toBe('inside-target');
  });

  it('creates new files exclusively, preserves empty files, and never overwrites a swapped target', () => {
    const root = project('create-root', 'inside');
    const window = renderer(703);
    renderers.push(window);
    bindResolvedRendererWorkspaceScope(
      window,
      scope(root, 'project-a', 'checkout-a'),
    );

    expect(
      invoke(FILES_CHANNELS.write, window, {
        relPath: 'nested/empty.txt',
        content: '',
      }),
    ).toEqual({ ok: true });
    expect(fs.existsSync(path.join(root, 'nested', 'empty.txt'))).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(root, 'nested', 'empty.txt')).mode & 0o777).toBe(
        0o600,
      );
    }

    electronMock.handlers.clear();
    registerFilesIpc({
      beforeOpen(operation) {
        if (operation === 'write') {
          fs.writeFileSync(path.join(root, 'nested', 'raced.txt'), 'attacker');
        }
      },
    });
    expect(
      invoke(FILES_CHANNELS.write, window, {
        relPath: 'nested/raced.txt',
        content: 'must-not-overwrite',
      }),
    ).toEqual({ ok: false, error: 'unsafe file' });
    expect(fs.readFileSync(path.join(root, 'nested', 'raced.txt'), 'utf8')).toBe(
      'attacker',
    );
  });

  it('imports an external blob into workspace mission-context, not ~/.nexus/dropped', () => {
    const root = project('import-root', 'inside');
    const window = renderer(801);
    renderers.push(window);
    bindResolvedRendererWorkspaceScope(
      window,
      scope(root, 'project-a', 'checkout-a'),
    );

    const result = invoke<{ ok: boolean; path?: string }>(
      FILES_CHANNELS.importMissionAttachment,
      window,
      { name: 'cliente.m4a', base64: Buffer.from('audio-bytes').toString('base64') },
    );

    expect(result.ok).toBe(true);
    expect(result.path).toMatch(
      /^\.nexus\/attachments\/mission-context\/.+cliente\.m4a$/,
    );
    expect(fs.readFileSync(path.join(root, result.path!), 'utf8')).toBe(
      'audio-bytes',
    );
  });
});

describe('drop sem File: file:// e http(s) via IPC', () => {
  it('stages a local file:// path inside the invoking renderer workspace', async () => {
    const root = project('uri-root', 'inside');
    const window = renderer(901);
    renderers.push(window);
    bindResolvedRendererWorkspaceScope(
      window,
      scope(root, 'project-a', 'checkout-a'),
    );
    const outside = path.join(baseDir, 'solto do Finder.png');
    fs.writeFileSync(outside, 'png-bytes');

    const result = await invoke<Promise<{ ok: boolean; path?: string }>>(
      FILES_CHANNELS.importDroppedUri,
      window,
      { uri: pathToFileURL(outside).href },
    );

    expect(result.ok).toBe(true);
    expect(result.path).toMatch(
      /^\.nexus\/attachments\/mission-context\/.+solto_do_Finder\.png$/,
    );
    expect(fs.readFileSync(path.join(root, result.path!), 'utf8')).toBe(
      'png-bytes',
    );
  });

  it('rejects a malformed payload and an unsupported scheme without touching disk', async () => {
    const root = project('uri-root-bad', 'inside');
    const window = renderer(902);
    renderers.push(window);
    bindResolvedRendererWorkspaceScope(
      window,
      scope(root, 'project-a', 'checkout-a'),
    );

    expect(
      await invoke<Promise<{ ok: boolean; error?: string }>>(
        FILES_CHANNELS.importDroppedUri,
        window,
        { uri: 42 },
      ),
    ).toEqual({ ok: false, error: 'invalid payload' });
    expect(
      await invoke<Promise<{ ok: boolean; error?: string }>>(
        FILES_CHANNELS.importDroppedUri,
        window,
        { uri: 'javascript:alert(1)' },
      ),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/http/i) });
    expect(fs.existsSync(path.join(root, '.nexus'))).toBe(false);
  });
});

describe('paste sem File: clipboardFileUris via IPC (F-582)', () => {
  it('returns the system pasteboard file URIs for a bound renderer', () => {
    const root = project('clip-root', 'inside');
    const window = renderer(951);
    renderers.push(window);
    bindResolvedRendererWorkspaceScope(
      window,
      scope(root, 'project-a', 'checkout-a'),
    );

    const result = invoke<{ uris: string[] }>(
      FILES_CHANNELS.clipboardFileUris,
      window,
    );

    // Sem pasteboard real no teste, o handler nunca deve vazar exceção.
    expect(result).toEqual({ uris: expect.any(Array) });
    expect(result.uris.every((uri) => uri.startsWith('file:'))).toBe(true);
  });
});
