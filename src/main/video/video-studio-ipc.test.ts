import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { VIDEO_STUDIO_CHANNELS } from '../../shared/video-studio-types';

const state = vi.hoisted(() => ({
  trusted: new Map<string, (event: unknown, raw?: unknown) => unknown>(),
  rawIpc: vi.fn(),
  schemes: [] as string[],
  reveal: vi.fn(),
  root: '',
  render: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: state.rawIpc, on: state.rawIpc },
  protocol: { handle: (scheme: string) => state.schemes.push(scheme) },
  shell: { showItemInFolder: state.reveal },
  app: { getPath: () => '/ud', isPackaged: false, getAppPath: () => '/app' },
}));
vi.mock('../security/trusted-ipc', () => ({
  handleTrusted: (channel: string, handler: (event: unknown, raw?: unknown) => unknown) => state.trusted.set(channel, handler),
}));
vi.mock('../persistence/renderer-workspace-scope', () => ({
  requireRendererWorkspaceScope: () => ({ rootRealPath: state.root }),
}));
vi.mock('./video-render', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./video-render')>()),
  renderVideo: state.render,
}));
vi.mock('./video-runtime-deps', () => ({ videoRenderDeps: () => ({ userData: '/ud' }) }));

import { listVideoProjects, registerVideoStudioIpc } from './video-studio-ipc';

const sender = { id: 7, isDestroyed: () => false, send: vi.fn() };
const event = { sender };

beforeAll(() => {
  state.root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-studio-')));
  const promo = path.join(state.root, 'videos', 'promo');
  fs.mkdirSync(path.join(promo, 'renders'), { recursive: true });
  fs.mkdirSync(path.join(promo, 'exports'));
  fs.mkdirSync(path.join(promo, 'assets'));
  fs.writeFileSync(path.join(promo, 'hyperframes.json'), '{}');
  fs.writeFileSync(path.join(promo, 'renders', 'a.mp4'), 'aa');
  fs.writeFileSync(path.join(promo, 'exports', 'a-vertical-9x16.mp4'), 'bbb');
  fs.writeFileSync(path.join(promo, 'assets', 'narration.timeline.json'), JSON.stringify({ generator: 'nexus_voiceover_generate', voice: { origin: 'library' } }));
  const reel = path.join(state.root, 'reel');
  fs.mkdirSync(reel);
  fs.writeFileSync(path.join(reel, 'package.json'), JSON.stringify({ dependencies: { remotion: '4' } }));
  fs.mkdirSync(path.join(state.root, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(state.root, 'node_modules', 'x', 'hyperframes.json'), '{}');
  registerVideoStudioIpc();
});

afterAll(() => {
  fs.rmSync(state.root, { recursive: true, force: true });
});

describe('Vídeos do projeto — Main', () => {
  it('acha projetos HyperFrames e Remotion, nunca dentro de node_modules', () => {
    const projects = listVideoProjects(state.root);
    expect(projects.map((project) => [project.path, project.engine]).sort()).toEqual([
      ['reel', 'remotion'],
      ['videos/promo', 'hyperframes'],
    ]);
    const promo = projects.find((project) => project.engine === 'hyperframes')!;
    expect(promo.renders.map((file) => file.path)).toEqual(['videos/promo/renders/a.mp4']);
    expect(promo.exports[0]).toMatchObject({ path: 'videos/promo/exports/a-vertical-9x16.mp4', sizeBytes: 3 });
    expect(promo.hasNarration).toBe(true);
  });

  it('todo canal por handleTrusted; o player é servido pelo esquema próprio', () => {
    const expected = Object.values(VIDEO_STUDIO_CHANNELS).filter((channel) => channel !== VIDEO_STUDIO_CHANNELS.progress);
    expect([...state.trusted.keys()].sort()).toEqual(expected.sort());
    expect(state.rawIpc).not.toHaveBeenCalled();
    expect(state.schemes).toEqual(['nexus-media']);
  });

  it('URL do player só para arquivo dentro do projeto', async () => {
    const mediaUrl = state.trusted.get(VIDEO_STUDIO_CHANNELS.mediaUrl)!;
    expect(await mediaUrl(event, { path: 'videos/promo/renders/a.mp4' })).toMatchObject({ ok: true, url: expect.stringMatching(/^nexus-media:\/\/media\//u) });
    expect(await mediaUrl(event, { path: '../fora.mp4' })).toMatchObject({ ok: false });
    expect(await mediaUrl(event, { path: 'videos/promo/hyperframes.json' })).toMatchObject({ ok: false });
  });

  it('render repassa o progresso só para a janela que pediu e devolve caminho relativo', async () => {
    state.render.mockImplementation(async (request: { onProgress: (p: unknown) => void }) => {
      request.onProgress({ pct: 40, stage: 'capture' });
      return { ok: true, path: path.join(state.root, 'videos', 'promo', 'renders', 'b.mp4'), durationSec: 27, width: 1080, height: 1920, renderMs: 15_000, networkAccess: [] };
    });
    const render = state.trusted.get(VIDEO_STUDIO_CHANNELS.render)!;
    const result = await render(event, { projectPath: 'videos/promo', quality: 'draft', jobId: 'job1' });
    expect(result).toMatchObject({ ok: true, path: 'videos/promo/renders/b.mp4', durationSec: 27 });
    expect(sender.send).toHaveBeenCalledWith(VIDEO_STUDIO_CHANNELS.progress, { jobId: 'job1', pct: 40, stage: 'capture' });
    expect(await render(event, { projectPath: 'x', quality: 'ultra', jobId: 'job2' })).toMatchObject({ ok: false });
  });

  it('cancelar aborta o job da mesma janela', async () => {
    let signal: AbortSignal | undefined;
    state.render.mockImplementation(
      (request: { signal: AbortSignal }) =>
        new Promise((resolve) => {
          signal = request.signal;
          request.signal.addEventListener('abort', () => resolve({ ok: false, error: 'cancelado', canceled: true }));
        }),
    );
    const running = state.trusted.get(VIDEO_STUDIO_CHANNELS.render)!(event, { projectPath: 'videos/promo', quality: 'final', jobId: 'job3' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await state.trusted.get(VIDEO_STUDIO_CHANNELS.cancel)!({ sender: { ...sender, id: 99 } }, { jobId: 'job3' });
    expect(signal?.aborted).toBe(false);
    await state.trusted.get(VIDEO_STUDIO_CHANNELS.cancel)!(event, { jobId: 'job3' });
    expect(await running).toMatchObject({ canceled: true });
  });
});
