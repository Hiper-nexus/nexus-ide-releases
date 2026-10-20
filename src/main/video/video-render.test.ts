import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OwnedProcessOptions, OwnedProcessResult } from './video-process';
import { parseHfProgress, renderVideo, resolveWorkspaceDir, type RenderDeps } from './video-render';
import { ensureVideoEngine, readEngineState } from './video-engine-install';
import { runVideoDoctor } from './video-doctor';
import { videoEnginePaths } from './video-engine';
import type { MediaProbe } from './ffprobe';

let root: string;
let workspace: string;
let userData: string;
let manifestDir: string;

const scope = { rootRealPath: '' } as never;

function probe(overrides: Partial<MediaProbe> = {}): MediaProbe {
  return {
    durationSec: 30,
    sizeBytes: 3_400_000,
    formatName: 'mov,mp4',
    video: { codec: 'h264', width: 1080, height: 1920, fps: 30, pixFmt: 'yuv420p', profile: 'High' },
    audio: { codec: 'aac', sampleRate: 48_000, channels: 2 },
    tags: {},
    ...overrides,
  };
}

function okRun(lines: string[] = []): (options: OwnedProcessOptions) => Promise<OwnedProcessResult> {
  return async (options) => {
    for (const line of lines) options.onLine?.(line, 'stdout');
    const outIndex = options.args.indexOf('--output');
    if (outIndex > 0) fs.writeFileSync(options.args[outIndex + 1], 'mp4');
    return { exitCode: 0, timedOut: false, aborted: false, tail: lines };
  };
}

function deps(overrides: Partial<RenderDeps> = {}): RenderDeps & { released: () => number; permitRequests: unknown[] } {
  let released = 0;
  const permitRequests: unknown[] = [];
  return {
    userData,
    manifestDir,
    pathValue: '/bin',
    baseEnv: { PATH: '/bin', ELEVENLABS_API_KEY: 'xi-secret' },
    lookup: (command) => `/bin/${command}`,
    acquirePermit: async (request) => {
      permitRequests.push(request);
      return { id: 'p1', release: () => (released += 1) };
    },
    isHardened: () => false,
    now: () => new Date(2026, 9, 19, 17, 5, 9),
    run: okRun(),
    ensureEngine: async () => ({ ok: true, installed: 'already', version: '0.8.177', durationMs: 0 }),
    probe: async () => probe(),
    sweep: async () => 0,
    resolveNode: async () => ({ version: 'v22.23.2', major: 22, execPath: '/bin/node', npmCli: '/lib/npm-cli.js' }),
    released: () => released,
    permitRequests,
    ...overrides,
  };
}

function hyperframesProject(name = 'promo'): string {
  const project = path.join(workspace, name);
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'hyperframes.json'), '{}');
  fs.writeFileSync(path.join(project, 'index.html'), '<div data-composition-id="main"></div>');
  return project;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-render-'));
  workspace = path.join(root, 'ws');
  userData = path.join(root, 'ud');
  manifestDir = path.join(root, 'manifest');
  fs.mkdirSync(workspace);
  fs.mkdirSync(manifestDir);
  fs.writeFileSync(path.join(manifestDir, 'package.json'), '{"dependencies":{"hyperframes":"0.8.177"}}');
  fs.writeFileSync(path.join(manifestDir, 'package-lock.json'), '{"lockfileVersion":3}');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('parseHfProgress', () => {
  it('lê a linha de progresso de máquina do HyperFrames', () => {
    expect(parseHfProgress('@hf-progress {"stage":"capture","pct":41.6}')).toEqual({ pct: 42, stage: 'capture' });
    expect(parseHfProgress('@hf-progress {"pct":120}')).toEqual({ pct: 100, stage: null });
    expect(parseHfProgress('render 42%')).toBeNull();
    expect(parseHfProgress('@hf-progress {quebrado')).toBeNull();
  });
});

describe('resolveWorkspaceDir', () => {
  it('aceita pasta dentro e recusa fora do workspace', () => {
    hyperframesProject();
    expect(resolveWorkspaceDir('promo', workspace)).toBe(fs.realpathSync(path.join(workspace, 'promo')));
    expect(() => resolveWorkspaceDir('..', workspace)).toThrow(/fora do workspace/u);
    expect(() => resolveWorkspaceDir('nao-existe', workspace)).toThrow(/não existe/u);
  });
});

describe('renderVideo', () => {
  it('renderiza com o motor fixado, no ambiente limpo, sob a reserva, e confere com ffprobe', async () => {
    hyperframesProject();
    const progress: number[] = [];
    let seen: OwnedProcessOptions | null = null;
    const d = deps({
      run: async (options) => {
        seen = options;
        return okRun(['@hf-progress {"pct":10}', 'Fetched 11 font face(s) for "Roboto" from Google Fonts', '@hf-progress {"pct":100}'])(options);
      },
    });
    const result = await renderVideo(
      { projectDir: 'promo', baseDir: workspace, scope, onProgress: (p) => progress.push(p.pct) },
      d,
    );
    expect(result).toMatchObject({
      ok: true,
      width: 1080,
      height: 1920,
      durationSec: 30,
      videoCodec: 'h264',
      audioCodec: 'aac',
      engine: { name: 'hyperframes', version: '0.8.177', installed: 'already' },
      orphansKilled: 0,
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.path).toBe(path.join(fs.realpathSync(workspace), 'promo', 'renders', 'promo-20261019-170509.mp4'));
    expect(result.networkAccess).toEqual(['Fetched 11 font face(s) for "Roboto" from Google Fonts']);
    expect(progress).toEqual([10, 100]);
    const options = seen as unknown as OwnedProcessOptions;
    expect(options.file).toBe('/bin/node');
    expect(options.args.slice(1, 3)).toEqual(['render', fs.realpathSync(path.join(workspace, 'promo'))]);
    expect(options.cwd).toBe(videoEnginePaths(userData).workDir);
    expect(Object.values(options.env).join(' ')).not.toContain('xi-secret');
    expect(options.env.HYPERFRAMES_NO_TELEMETRY).toBe('1');
    expect(d.permitRequests[0]).toMatchObject({ kind: 'build', label: 'hyperframes render' });
    expect(d.released()).toBe(1);
  });

  it('recusa no modo Hardened antes de tudo', async () => {
    hyperframesProject();
    const d = deps({ isHardened: () => true });
    const result = await renderVideo({ projectDir: 'promo', baseDir: workspace, scope }, d);
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/Hardened/u) });
    expect(d.permitRequests).toHaveLength(0);
  });

  it('recusa projeto Remotion com a explicação da licença', async () => {
    const project = path.join(workspace, 'reel');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ dependencies: { remotion: '4.0.537' } }));
    const result = await renderVideo({ projectDir: 'reel', baseDir: workspace, scope }, deps());
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/Remotion.*licença/su) });
  });

  it('pasta que não é projeto de vídeo diz como criar', async () => {
    fs.mkdirSync(path.join(workspace, 'site'));
    const result = await renderVideo({ projectDir: 'site', baseDir: workspace, scope }, deps());
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/hyperframes@0\.8\.177 init/u) });
  });

  it('sem ffmpeg ou com Node velho diz o comando que resolve e não reserva nada', async () => {
    hyperframesProject();
    const noFfmpeg = deps({ lookup: (command) => (command === 'ffmpeg' ? null : `/bin/${command}`) });
    expect(await renderVideo({ projectDir: 'promo', baseDir: workspace, scope }, noFfmpeg)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/ffmpeg/u),
    });
    expect(noFfmpeg.permitRequests).toHaveLength(0);
    const oldNode = deps({ resolveNode: async () => ({ version: 'v20.1.0', major: 20, execPath: '/bin/node', npmCli: null }) });
    expect(await renderVideo({ projectDir: 'promo', baseDir: workspace, scope }, oldNode)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Node\.js 22/u),
    });
  });

  it('saída fora do workspace ou que não é mp4 é recusada', async () => {
    hyperframesProject();
    expect(await renderVideo({ projectDir: 'promo', output: '../fora.mp4', baseDir: workspace, scope }, deps())).toMatchObject({
      ok: false,
      error: expect.stringMatching(/escapa o workspace/u),
    });
    expect(await renderVideo({ projectDir: 'promo', output: 'a.mov', baseDir: workspace, scope }, deps())).toMatchObject({
      ok: false,
    });
  });

  it('falha do motor devolve as últimas linhas sem progresso; reserva liberada', async () => {
    hyperframesProject();
    const d = deps({
      run: async () => ({ exitCode: 1, timedOut: false, aborted: false, tail: ['@hf-progress {"pct":3}', 'Error: lint failed', 'at x'] }),
    });
    const result = await renderVideo({ projectDir: 'promo', baseDir: workspace, scope }, d);
    expect(result).toMatchObject({ ok: false, log: ['Error: lint failed', 'at x'] });
    expect(d.released()).toBe(1);
  });

  it('cancelado devolve canceled e varre órfãos do motor', async () => {
    hyperframesProject();
    const sweep = vi.fn(async () => 2);
    const d = deps({ run: async () => ({ exitCode: null, timedOut: false, aborted: true, tail: [] }), sweep });
    const result = await renderVideo({ projectDir: 'promo', baseDir: workspace, scope }, d);
    expect(result).toMatchObject({ ok: false, canceled: true });
    expect(sweep).toHaveBeenCalledWith(videoEnginePaths(userData).root);
    expect(d.released()).toBe(1);
  });

  it('arquivo sem vídeo legível não é sucesso', async () => {
    hyperframesProject();
    const d = deps({ probe: async () => probe({ video: null }) });
    expect(await renderVideo({ projectDir: 'promo', baseDir: workspace, scope }, d)).toMatchObject({ ok: false });
  });

  it('a máquina ocupada vira frase, não código cru', async () => {
    hyperframesProject();
    const d = deps({ acquirePermit: async () => Promise.reject(new Error('heavy_command_queued')) });
    expect(await renderVideo({ projectDir: 'promo', baseDir: workspace, scope }, d)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/ocupada/u),
    });
  });
});

describe('instalação do motor', () => {
  const node = { version: 'v22.23.2', major: 22, execPath: '/bin/node', npmCli: '/lib/npm-cli.js' };

  it('npm ci com --ignore-scripts na pasta de preparo; só o motor que prova a versão entra', async () => {
    const paths = videoEnginePaths(userData);
    let call: OwnedProcessOptions | null = null;
    const result = await ensureVideoEngine({
      paths,
      manifestDir,
      node,
      env: { HOME: paths.home },
      now: () => new Date('2026-10-19T12:00:00Z'),
      run: async (options) => {
        call = options;
        const pkg = path.join(options.cwd, 'node_modules', 'hyperframes');
        fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
        fs.writeFileSync(path.join(pkg, 'package.json'), '{"version":"0.8.177"}');
        fs.writeFileSync(path.join(pkg, 'bin', 'hyperframes.mjs'), '');
        return { exitCode: 0, timedOut: false, aborted: false, tail: [] };
      },
    });
    expect(result).toMatchObject({ ok: true, installed: 'now', version: '0.8.177' });
    const options = call as unknown as OwnedProcessOptions;
    expect(options.args).toEqual(['/lib/npm-cli.js', 'ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error']);
    expect(path.basename(options.cwd)).toMatch(/^\.st-/u);
    expect(readEngineState(paths, manifestDir).status).toBe('ready');
    expect(fs.readdirSync(paths.root).some((name) => name.startsWith('.st-'))).toBe(false);
    // Segunda chamada não instala de novo.
    expect(await ensureVideoEngine({ paths, manifestDir, node, env: {}, run: vi.fn() })).toMatchObject({ installed: 'already' });
  });

  it('lockfile novo no app torna o motor instalado desatualizado', async () => {
    const paths = videoEnginePaths(userData);
    fs.mkdirSync(path.join(paths.engineDir, 'node_modules', 'hyperframes', 'bin'), { recursive: true });
    fs.writeFileSync(paths.cliEntry, '');
    fs.writeFileSync(paths.marker, JSON.stringify({ version: '0.8.177', lockSha256: 'outro', installedAt: 'x' }));
    expect(readEngineState(paths, manifestDir).status).toBe('outdated');
  });

  it('versão errada ou npm falhando não substitui nada e diz o porquê', async () => {
    const paths = videoEnginePaths(userData);
    const wrong = await ensureVideoEngine({
      paths,
      manifestDir,
      node,
      env: {},
      run: async (options) => {
        fs.mkdirSync(path.join(options.cwd, 'node_modules', 'hyperframes'), { recursive: true });
        fs.writeFileSync(path.join(options.cwd, 'node_modules', 'hyperframes', 'package.json'), '{"version":"9.9.9"}');
        return { exitCode: 0, timedOut: false, aborted: false, tail: [] };
      },
    });
    expect(wrong).toMatchObject({ ok: false, error: expect.stringMatching(/9\.9\.9/u) });
    const failed = await ensureVideoEngine({
      paths,
      manifestDir,
      node,
      env: {},
      run: async () => ({ exitCode: 1, timedOut: false, aborted: false, tail: ['npm error code EINTEGRITY', 'npm error sha512 mismatch'] }),
    });
    expect(failed).toMatchObject({ ok: false, error: expect.stringMatching(/EINTEGRITY/u) });
    expect(fs.existsSync(paths.engineDir)).toBe(false);
  });
});

describe('runVideoDoctor', () => {
  it('lista o que falta com o comando que resolve, sem instalar nada', async () => {
    // The release container sets a ~60-character TMPDIR. A win32 path-length
    // check on that temp dir crosses 260 and is not the short userData case.
    const shortUserData = fs.mkdtempSync('/tmp/nexus-vd-');
    try {
      const report = await runVideoDoctor({
        userData: shortUserData,
        manifestDir,
        workspaceDir: workspace,
        pathValue: '/bin',
        baseEnv: {},
        platform: 'win32',
        lookup: (command) => (command === 'node' ? '/bin/node' : null),
        resolveNode: async () => ({ version: 'v22.23.2', major: 22, execPath: '/bin/node', npmCli: '/lib/npm-cli.js' }),
        versionOf: async () => null,
        freeBytes: () => 50 * 1024 ** 3,
      });
      expect(report.ok).toBe(false);
      const byId = Object.fromEntries(report.checks.map((check) => [check.id, check]));
      expect(byId.node.ok).toBe(true);
      expect(byId.ffmpeg).toMatchObject({ ok: false, fix: 'winget install --id Gyan.FFmpeg -e' });
      expect(byId.engine).toMatchObject({ ok: true, detail: expect.stringMatching(/primeiro render/u) });
      expect(byId['path-length'].ok).toBe(true);
      expect(byId.telemetry.detail).toMatch(/sem telemetria/u);
      expect(fs.existsSync(videoEnginePaths(shortUserData).root)).toBe(false);
    } finally {
      fs.rmSync(shortUserData, { recursive: true, force: true });
    }
  });

  it('Node velho e disco cheio aparecem como bloqueio', async () => {
    const report = await runVideoDoctor({
      userData,
      manifestDir,
      pathValue: '/bin',
      baseEnv: {},
      platform: 'darwin',
      lookup: (command) => `/bin/${command}`,
      resolveNode: async () => ({ version: 'v20.9.0', major: 20, execPath: '/bin/node', npmCli: null }),
      versionOf: async () => 'ffmpeg version 9.0.2',
      freeBytes: () => 100 * 1024 ** 2,
    });
    const byId = Object.fromEntries(report.checks.map((check) => [check.id, check]));
    expect(byId.node).toMatchObject({ ok: false, fix: 'brew install node' });
    expect(byId.disk.ok).toBe(false);
    expect(byId['path-length']).toBeUndefined();
  });
});

describe('renderVideo: variantes de formato e idioma (F-1605)', () => {
  function variantProject(): string {
    const project = hyperframesProject();
    fs.mkdirSync(path.join(project, 'compositions'));
    fs.writeFileSync(path.join(project, 'compositions', 'wide.html'), '<div data-composition-id="wide"></div>');
    return project;
  }

  /** Fake engine: --batch writes one file per row from the {index} template, plus its manifest. */
  function batchRun(calls: OwnedProcessOptions[], options: { failRow?: number } = {}) {
    return async (opts: OwnedProcessOptions): Promise<OwnedProcessResult> => {
      calls.push(opts);
      const output = opts.args[opts.args.indexOf('--output') + 1];
      const batchIndex = opts.args.indexOf('--batch');
      if (batchIndex > 0) {
        const rows = JSON.parse(fs.readFileSync(opts.args[batchIndex + 1], 'utf8')) as unknown[];
        rows.forEach((_row, index) => {
          opts.onLine?.(`Batch row ${index}: ${output.replace('{index}', String(index))}`, 'stdout');
          opts.onLine?.('@hf-progress {"pct":100}', 'stdout');
          if (index !== options.failRow) fs.writeFileSync(output.replace('{index}', String(index)), 'mp4');
        });
        fs.writeFileSync(path.join(path.dirname(output), 'manifest.json'), '{}');
        return { exitCode: options.failRow === undefined ? 0 : 1, timedOut: false, aborted: false, tail: [] };
      }
      opts.onLine?.('@hf-progress {"pct":100}', 'stdout');
      fs.writeFileSync(output, 'mp4');
      return { exitCode: 0, timedOut: false, aborted: false, tail: [] };
    };
  }

  it('variantes da mesma composição saem num --batch; outro formato é outro render; tudo com o nome da variante', async () => {
    const project = variantProject();
    const calls: OwnedProcessOptions[] = [];
    const progress: number[] = [];
    const d = deps({ run: batchRun(calls) });
    const result = await renderVideo(
      {
        projectDir: 'promo',
        baseDir: workspace,
        scope,
        onProgress: (p) => progress.push(p.pct),
        variants: [
          { name: 'vertical-pt', variables: { lang: 'pt' } },
          { name: 'wide-pt', composition: 'compositions/wide.html' },
          { name: 'vertical-en', variables: { lang: 'en' } },
        ],
      },
      d,
    );
    if (!result.ok) throw new Error(result.error);
    expect(calls).toHaveLength(2);
    expect(d.permitRequests).toHaveLength(1);
    const [batchCall, wideCall] = calls;
    expect(batchCall.args).toContain('--batch');
    expect(batchCall.args).not.toContain('--composition');
    expect(wideCall.args).toEqual(expect.arrayContaining(['--composition', 'compositions/wide.html']));
    expect(wideCall.args).not.toContain('--batch');
    const renders = path.join(fs.realpathSync(project), 'renders');
    expect(result.variants?.map((item) => item.name)).toEqual(['vertical-pt', 'wide-pt', 'vertical-en']);
    expect(result.variants?.every((item) => item.ok)).toBe(true);
    expect(fs.readdirSync(renders).sort()).toEqual([
      'promo-vertical-en-20261019-170509.mp4',
      'promo-vertical-pt-20261019-170509.mp4',
      'promo-wide-pt-20261019-170509.mp4',
    ]);
    expect(result.path).toBe(path.join(renders, 'promo-vertical-pt-20261019-170509.mp4'));
    expect(fs.readdirSync(videoEnginePaths(userData).workDir).filter((name) => name.startsWith('batch-'))).toEqual([]);
    expect(Math.max(...progress)).toBe(100);
  });

  it('uma linha do lote que falha não derruba as outras', async () => {
    variantProject();
    const calls: OwnedProcessOptions[] = [];
    const result = await renderVideo(
      {
        projectDir: 'promo',
        baseDir: workspace,
        scope,
        variants: [
          { name: 'pt', variables: { lang: 'pt' } },
          { name: 'en', variables: { lang: 'en' } },
        ],
      },
      deps({ run: batchRun(calls, { failRow: 1 }) }),
    );
    expect(result).toMatchObject({ ok: true, variants: [{ name: 'pt', ok: true }, { name: 'en', ok: false }] });
  });

  it('composição e variáveis de um render só vão ao motor; pedidos inválidos são recusados antes', async () => {
    variantProject();
    const calls: OwnedProcessOptions[] = [];
    await renderVideo(
      { projectDir: 'promo', baseDir: workspace, scope, composition: 'compositions/wide.html', variables: { title: 'Agendify' } },
      deps({ run: batchRun(calls) }),
    );
    expect(calls[0].args).toEqual(expect.arrayContaining(['--composition', 'compositions/wide.html', '--variables', '{"title":"Agendify"}']));
    const refuse = async (variants: unknown) =>
      renderVideo({ projectDir: 'promo', baseDir: workspace, scope, variants: variants as never }, deps({ run: batchRun([]) }));
    expect(await refuse([{ name: 'Vertical PT' }])).toMatchObject({ ok: false, error: expect.stringMatching(/nome de variante/u) });
    expect(await refuse([{ name: 'a' }, { name: 'a' }])).toMatchObject({ ok: false, error: expect.stringMatching(/repetida/u) });
    expect(await refuse(Array.from({ length: 9 }, (_v, i) => ({ name: `v${i}` })))).toMatchObject({ ok: false, error: expect.stringMatching(/8 variantes/u) });
    expect(await refuse([{ name: 'a', composition: '../fora.html' }])).toMatchObject({ ok: false });
    expect(await refuse([{ name: 'a', composition: 'hyperframes.json' }])).toMatchObject({ ok: false, error: expect.stringMatching(/\.html/u) });
    expect(await refuse([{ name: 'a', variables: ['x'] }])).toMatchObject({ ok: false, error: expect.stringMatching(/objeto JSON/u) });
  });
});
