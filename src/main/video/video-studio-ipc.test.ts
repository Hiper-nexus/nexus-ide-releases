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
  previewStart: vi.fn(),
  previewStop: vi.fn(async () => true),
  previews: [] as Array<{ id: string; url: string; project: string }>,
  align: vi.fn(),
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
vi.mock('./video-preview', () => ({
  startVideoPreview: state.previewStart,
  stopVideoPreview: state.previewStop,
  listVideoPreviews: () => state.previews,
}));
vi.mock('../media/voiceover-align', () => ({ alignVoiceover: state.align }));
vi.mock('../media/media-keys', () => ({ resolveMediaKey: () => 'xi' }));
const studio = vi.hoisted(() => ({ on: true }));
vi.mock('./video-studio-flag', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./video-studio-flag')>();
  return {
    ...actual,
    assertVideoStudioEnabled: () => {
      if (!studio.on) throw new Error(actual.VIDEO_STUDIO_DISABLED_REASON);
    },
  };
});

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

  it('prévia ao vivo: abre com o escopo da janela, aparece na lista e para por id (F-1603)', async () => {
    state.previewStart.mockResolvedValueOnce({ ok: true, reused: false, id: 'vpreview-1', url: 'http://127.0.0.1:4000/#project/promo', port: 4000, project: 'videos/promo' });
    const started = await state.trusted.get(VIDEO_STUDIO_CHANNELS.previewStart)!(event, { projectPath: 'videos/promo' });
    expect(started).toEqual({ ok: true, id: 'vpreview-1', url: 'http://127.0.0.1:4000/#project/promo', reused: false });
    const [request] = state.previewStart.mock.calls[0] as [{ projectDir: string; baseDir: string; scope: { rootRealPath: string } }];
    expect(request).toMatchObject({ projectDir: 'videos/promo', baseDir: state.root, scope: { rootRealPath: state.root } });
    expect(await state.trusted.get(VIDEO_STUDIO_CHANNELS.previewStart)!(event, {})).toMatchObject({ ok: false });
    state.previews = [{ id: 'vpreview-1', url: 'http://127.0.0.1:4000/#project/promo', project: 'videos/promo' }];
    const listed = (await state.trusted.get(VIDEO_STUDIO_CHANNELS.listProjects)!(event)) as { projects: Array<{ path: string; preview?: unknown }> };
    expect(listed.projects.find((item) => item.path === 'videos/promo')?.preview).toEqual({ id: 'vpreview-1', url: 'http://127.0.0.1:4000/#project/promo' });
    state.previews = [];
    expect(await state.trusted.get(VIDEO_STUDIO_CHANNELS.previewStop)!(event, { id: '../x' })).toEqual({ ok: false });
  });

  it('narração gravada: salva o WAV em assets do projeto e alinha, com preço antes (F-1602)', async () => {
    state.align.mockImplementation(async (request: { dryRun?: boolean }) =>
      request.dryRun
        ? { ok: true, dryRun: true, engine: 'elevenlabs', durationSec: 2, estimatedCostUsd: 0.0001 }
        : {
            ok: true,
            dryRun: false,
            engine: 'elevenlabs',
            durationSec: 2,
            estimatedCostUsd: 0.0001,
            words: 3,
            matchedRatio: 1,
            files: { timeline: path.join(state.root, 'videos', 'promo', 'assets', 'narration.timeline.json') },
          },
    );
    const wav = new Uint8Array(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(36)]));
    const align = state.trusted.get(VIDEO_STUDIO_CHANNELS.alignRecording)!;
    const view = (await align(event, { projectPath: 'videos/promo', script: 'Olá a todos.', wav, engine: 'elevenlabs' })) as {
      ok: boolean;
      audioPath: string;
      files: string[];
    };
    expect(view).toMatchObject({ ok: true, words: 3, files: ['videos/promo/assets/narration.timeline.json'] });
    expect(view.audioPath).toMatch(/^videos\/promo\/assets\/narration-recorded-\d{8}-\d{6}\.wav$/u);
    expect(fs.existsSync(path.join(state.root, view.audioPath))).toBe(true);
    expect(state.align.mock.calls.map((call) => (call[0] as { dryRun?: boolean }).dryRun)).toEqual([true, undefined]);
    expect(state.align.mock.calls[1][0]).toMatchObject({ audioPath: view.audioPath, outDir: path.join('videos/promo', 'assets'), baseName: 'narration' });
    expect(await align(event, { projectPath: 'videos/promo', script: 'x', wav: new Uint8Array([1, 2]), engine: 'local' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/WAV/u),
    });
    expect(await align(event, { projectPath: 'videos/promo', script: 'x', engine: 'local' })).toMatchObject({ ok: false });
  });

  it('com o estúdio desligado só o cancelar responde', async () => {
    studio.on = false;
    try {
      expect(state.trusted.size).toBe(10);
      for (const [channel, handler] of state.trusted) {
        if (channel === VIDEO_STUDIO_CHANNELS.cancel || channel === VIDEO_STUDIO_CHANNELS.previewStop) continue;
        await expect(Promise.resolve().then(() => handler(event, {}))).rejects.toThrow(
          /estúdio de vídeo está desligado/u,
        );
      }
      expect(await state.trusted.get(VIDEO_STUDIO_CHANNELS.cancel)!(event, { jobId: 'nenhum' })).toEqual({ ok: true });
      const id = 'vpreview-00000000-0000-4000-8000-000000000000';
      expect(await state.trusted.get(VIDEO_STUDIO_CHANNELS.previewStop)!(event, { id })).toEqual({ ok: true });
    } finally {
      studio.on = true;
    }
  });
});
