import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { isRunningPreviewUrl, isRunningPreviewUrlForScope } from '../orch/preview-server';
import {
  listVideoPreviews,
  MAX_LIVE_PREVIEWS,
  probeStudio,
  startVideoPreview,
  stopAllVideoPreviews,
  stopVideoPreview,
  type PreviewDeps,
} from './video-preview';

/** F-1603 — prévia ao vivo: Studio do HyperFrames como processo do Main, confiável só enquanto vive. */

let root: string;
const scope = {
  version: 1 as const,
  installationId: 'i',
  projectId: 'p',
  checkoutId: 'c',
  rootRealPath: '',
  identitySource: 'manifest' as const,
};

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  constructor(readonly pid: number) {
    super();
  }
}

interface Harness {
  deps: PreviewDeps;
  spawned: Array<{ file: string; args: readonly string[]; options: SpawnOptions; child: FakeChild }>;
  killed: number[];
}

function harness(overrides: Partial<PreviewDeps> & { studioPid?: (childPid: number) => number; announce?: boolean } = {}): Harness {
  const spawned: Harness['spawned'] = [];
  const killed: number[] = [];
  let nextPid = 4100;
  let nextPort = 47100;
  const deps: PreviewDeps = {
    userData: path.join(root, 'ud'),
    manifestDir: path.join(root, 'manifest'),
    pathValue: '/bin',
    baseEnv: { ELEVENLABS_API_KEY: 'segredo', OPENAI_API_KEY: 'segredo', PATH: '/bin' },
    lookup: (command) => (command === 'node' ? '/bin/node' : null),
    isHardened: () => false,
    resolveNode: async () => ({ execPath: '/bin/node', major: 22, version: 'v22.0.0' }) as never,
    ensureEngine: async () => ({ ok: true, installed: 'already' }) as never,
    freePort: async () => nextPort++,
    readyTimeoutMs: 2_000,
    spawnFn: (file, args, options) => {
      const child = new FakeChild(nextPid++);
      spawned.push({ file, args, options, child });
      if (overrides.announce !== false) {
        const port = Number(String(args.find((arg) => arg.startsWith('--port=')) ?? '').slice('--port='.length));
        setTimeout(() => child.stdout.write(`\u001b[36m  Server    http://localhost:${port}\u001b[39m\n`), 5);
      }
      return child as unknown as ChildProcess;
    },
    killTree: async (pid) => {
      killed.push(pid);
      const entry = spawned.find((item) => item.child.pid === pid);
      entry?.child.emit('exit', null);
    },
    fetchFn: (async (input: string | URL) => {
      const port = Number(new URL(String(input)).port);
      const entry = spawned.find((item) => item.args.includes(`--port=${port}`));
      if (!entry) throw new Error('ECONNREFUSED');
      const projectDir = String(entry.args[2]);
      return new Response(
        JSON.stringify({
          isHyperframes: true,
          pid: overrides.studioPid ? overrides.studioPid(entry.child.pid) : entry.child.pid,
          projectDir,
        }),
        { status: 200 },
      );
    }) as typeof fetch,
    ...overrides,
  };
  return { deps, spawned, killed };
}

function project(name: string, kind: 'hyperframes' | 'remotion' = 'hyperframes'): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  if (kind === 'hyperframes') fs.writeFileSync(path.join(dir, 'hyperframes.json'), '{}');
  else fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { remotion: '4' } }));
  return name;
}

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-vpreview-')));
  scope.rootRealPath = root;
});

afterEach(async () => {
  await stopAllVideoPreviews();
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('prévia ao vivo do vídeo', () => {
  it('sobe o Studio fixado sem shell, sem chaves e só em loopback, e o registra como prévia confiável', async () => {
    const { deps, spawned } = harness();
    const result = await startVideoPreview({ projectDir: project('promo'), baseDir: root, scope }, deps);
    expect(result).toMatchObject({ ok: true, reused: false, project: 'promo' });
    if (!result.ok) throw new Error(result.error);
    expect(result.url).toBe(`http://127.0.0.1:${result.port}/#project/promo`);
    const [call] = spawned;
    expect(call.file).toBe('/bin/node');
    expect(call.args.slice(1, 3)).toEqual(['preview', path.join(root, 'promo')]);
    expect(call.args).toEqual(expect.arrayContaining(['--no-open', '--force-new', '--foreground']));
    expect(call.options).toMatchObject({ shell: false, windowsHide: true });
    const env = call.options.env as Record<string, string>;
    expect(env.ELEVENLABS_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.HYPERFRAMES_NO_TELEMETRY).toBe('1');
    expect(env.HYPERFRAMES_PREVIEW_HOST).toBeUndefined();
    expect(isRunningPreviewUrl(result.url)).toBe(true);
    expect(isRunningPreviewUrlForScope(result.url, scope)).toBe(true);
    expect(listVideoPreviews(scope)).toEqual([expect.objectContaining({ id: result.id, project: 'promo' })]);
  });

  it('a mesma pasta reaproveita o Studio vivo; parar mata a árvore e tira a confiança', async () => {
    const { deps, spawned, killed } = harness();
    const first = await startVideoPreview({ projectDir: project('reuse'), baseDir: root, scope }, deps);
    const again = await startVideoPreview({ projectDir: 'reuse', baseDir: root, scope }, deps);
    if (!first.ok || !again.ok) throw new Error('falhou');
    expect(again).toMatchObject({ reused: true, id: first.id });
    expect(spawned).toHaveLength(1);
    expect(await stopVideoPreview(first.id, { projectId: 'outro', checkoutId: 'c' })).toBe(false);
    expect(await stopVideoPreview(first.id, scope)).toBe(true);
    expect(killed).toEqual([spawned[0].child.pid]);
    expect(isRunningPreviewUrl(first.url)).toBe(false);
    expect(listVideoPreviews(scope)).toEqual([]);
  });

  it('o processo que morre sozinho deixa de ser confiável', async () => {
    const { deps, spawned } = harness();
    const result = await startVideoPreview({ projectDir: project('dies'), baseDir: root, scope }, deps);
    if (!result.ok) throw new Error(result.error);
    spawned[0].child.emit('exit', 1);
    expect(isRunningPreviewUrl(result.url)).toBe(false);
    expect(listVideoPreviews(scope)).toEqual([]);
  });

  it('servidor que responde com outro pid não é o nosso: mata o filho e recusa', async () => {
    const { deps, killed, spawned } = harness({ studioPid: (pid) => pid + 999, readyTimeoutMs: 700 });
    const result = await startVideoPreview({ projectDir: project('impostor'), baseDir: root, scope }, deps);
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/não respondeu a tempo/u) });
    expect(killed).toEqual([spawned[0].child.pid]);
    expect(isRunningPreviewUrl(`http://127.0.0.1:${spawned[0].args.find((arg) => arg.startsWith('--port='))?.slice(7)}/`)).toBe(false);
  });

  it('recusa Remotion, pasta fora do workspace, modo Hardened e mais de três prévias', async () => {
    const { deps } = harness();
    expect(await startVideoPreview({ projectDir: project('reel', 'remotion'), baseDir: root, scope }, deps)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Remotion/u),
    });
    expect(await startVideoPreview({ projectDir: os.tmpdir(), baseDir: root, scope }, deps)).toMatchObject({ ok: false });
    expect(
      await startVideoPreview({ projectDir: project('hard'), baseDir: root, scope }, { ...deps, isHardened: () => true }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/Hardened/u) });
    for (let index = 0; index < MAX_LIVE_PREVIEWS; index += 1) {
      expect(await startVideoPreview({ projectDir: project(`cap${index}`), baseDir: root, scope }, deps)).toMatchObject({ ok: true });
    }
    expect(await startVideoPreview({ projectDir: project('cap-extra'), baseDir: root, scope }, deps)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/3 prévias/u),
    });
  });

  it('a sonda só aceita a resposta do HyperFrames para a pasta pedida', async () => {
    const reply = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    const projectDir = path.join(root, 'promo');
    expect(await probeStudio(1, { pid: 7, projectDir }, reply({ isHyperframes: true, pid: 7, projectDir: projectDir.toUpperCase() }))).toBe(true);
    expect(await probeStudio(1, { pid: 7, projectDir }, reply({ isHyperframes: true, pid: 7, projectDir }))).toBe(true);
    expect(await probeStudio(1, { pid: 7, projectDir }, reply({ isHyperframes: true, pid: 7, projectDir: root }))).toBe(false);
    expect(await probeStudio(1, { pid: 7, projectDir }, reply({ pid: 7, projectDir }))).toBe(false);
    const failing = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    expect(await probeStudio(1, { pid: 7, projectDir }, failing)).toBe(false);
  });
});
