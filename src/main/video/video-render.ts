import fs from 'node:fs';
import path from 'node:path';
import type { ProjectExecutionScope } from '../../shared/types';
import type { HeavyCommandPermit, HeavyCommandRequest } from '../orch/heavy-command-permit';
import { resolveMediaOutputPath } from '../media/media-path-policy';
import {
  buildEngineEnv,
  detectVideoProject,
  HYPERFRAMES_VERSION,
  MIN_NODE_MAJOR,
  REMOTION_REFUSAL,
  resolveNodeRuntime,
  videoEnginePaths,
} from './video-engine';
import { ensureVideoEngine } from './video-engine-install';
import { installHint } from './video-doctor';
import { runOwnedProcess, sweepEngineOrphans } from './video-process';
import { probeMedia, type MediaProbe } from './ffprobe';

/**
 * `nexus_video_render` and the Studio's Renderizar (F-1594). Rendering runs
 * the project's own HTML/JS in a headless Chrome launched with --no-sandbox
 * (study §3, finding 4), so it is an execution effect, confined to the open
 * workspace, refused in Hardened mode, and run under the same heavy-command
 * reservation the Main uses for builds and test suites.
 */

export interface RenderProgress {
  readonly pct: number;
  readonly stage: string | null;
}

export interface RenderRequest {
  readonly projectDir: string;
  readonly output?: string;
  readonly quality?: 'draft' | 'final';
  readonly fps?: number;
  readonly timeoutMinutes?: number;
  readonly baseDir: string;
  readonly scope: Readonly<ProjectExecutionScope>;
  readonly missionId?: string;
  readonly sessionId?: string;
  readonly paneId?: string;
  readonly signal?: AbortSignal;
  readonly assertCurrentAuthority?: () => void;
  readonly onProgress?: (progress: RenderProgress) => void;
}

export interface RenderDeps {
  readonly userData: string;
  readonly manifestDir: string;
  readonly pathValue: string;
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly lookup: (command: string) => string | null;
  readonly acquirePermit: (request: HeavyCommandRequest) => Promise<HeavyCommandPermit>;
  readonly isHardened: () => boolean;
  readonly now: () => Date;
  readonly run?: typeof runOwnedProcess;
  readonly ensureEngine?: typeof ensureVideoEngine;
  readonly probe?: typeof probeMedia;
  readonly sweep?: typeof sweepEngineOrphans;
  readonly resolveNode?: typeof resolveNodeRuntime;
}

export type RenderResult =
  | {
      readonly ok: true;
      readonly path: string;
      readonly durationSec: number | null;
      readonly width: number;
      readonly height: number;
      readonly fps: number | null;
      readonly videoCodec: string;
      readonly audioCodec: string | null;
      readonly sizeBytes: number | null;
      readonly renderMs: number;
      readonly engine: { readonly name: 'hyperframes'; readonly version: string; readonly installed: 'already' | 'now' };
      /** Lines where the engine reached the network (fonts, CDN scripts): the render is not self-contained. */
      readonly networkAccess: readonly string[];
      readonly orphansKilled: number;
    }
  | { readonly ok: false; readonly error: string; readonly canceled?: boolean; readonly log?: readonly string[] };

const DEFAULT_TIMEOUT_MIN = 20;
const MAX_TIMEOUT_MIN = 60;
let activeRenders = 0;

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** A directory inside the workspace, after realpath (no symlink escape). */
export function resolveWorkspaceDir(input: string, baseDir: string): string {
  const root = fs.realpathSync(path.resolve(baseDir));
  const candidate = path.isAbsolute(input) ? path.resolve(input) : path.resolve(root, input);
  if (!isInside(path.resolve(baseDir), candidate) && !isInside(root, candidate)) {
    throw new Error(`pasta fora do workspace: ${input}`);
  }
  let real: string;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    throw new Error(`pasta do projeto de vídeo não existe: ${input}`);
  }
  if (!isInside(root, real)) throw new Error(`pasta fora do workspace: ${input}`);
  if (!fs.statSync(real).isDirectory()) throw new Error(`não é uma pasta: ${input}`);
  return real;
}

function stamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(
    date.getMinutes(),
  )}${pad(date.getSeconds())}`;
}

/** `@hf-progress {"pct":42,...}` → progress; anything else → null. */
export function parseHfProgress(line: string): RenderProgress | null {
  if (!line.startsWith('@hf-progress ')) return null;
  try {
    const body = JSON.parse(line.slice('@hf-progress '.length)) as Record<string, unknown>;
    const pct = Number(body.pct);
    if (!Number.isFinite(pct)) return null;
    const stage = [body.stage, body.label, body.name, body.phase].find((value) => typeof value === 'string');
    return { pct: Math.max(0, Math.min(100, Math.round(pct))), stage: (stage as string | undefined)?.slice(0, 80) ?? null };
  } catch {
    return null;
  }
}

const NETWORK_LINE = /Google Fonts|CDN script|\bhttps?:\/\/[^\s"')]+/iu;

function errorLog(tail: readonly string[]): string[] {
  return tail.filter((line) => !line.startsWith('@hf-')).slice(-12);
}

export async function renderVideo(req: RenderRequest, deps: RenderDeps): Promise<RenderResult> {
  if (deps.isHardened()) {
    return {
      ok: false,
      error:
        'Modo Hardened: o render executa o código do projeto num Chrome sem sandbox e fica desligado neste modo. ' +
        'Renderize pelo shell do pane (npx hyperframes@' + HYPERFRAMES_VERSION + ' render) dentro da sandbox do pane.',
    };
  }
  req.assertCurrentAuthority?.();
  const projectDir = resolveWorkspaceDir(req.projectDir, req.baseDir);
  const kind = detectVideoProject(projectDir);
  if (kind === 'remotion') return { ok: false, error: REMOTION_REFUSAL };
  if (kind === 'unknown') {
    return {
      ok: false,
      error:
        'Isto não parece um projeto HyperFrames (falta hyperframes.json ou um index.html com data-composition). ' +
        `Crie com: npx hyperframes@${HYPERFRAMES_VERSION} init <nome> --non-interactive`,
    };
  }
  const now = deps.now();
  const relativeProject = path.relative(fs.realpathSync(req.baseDir), projectDir) || '.';
  const output = resolveMediaOutputPath(
    req.output ?? path.join(relativeProject, 'renders', `${path.basename(projectDir)}-${stamp(now)}.mp4`),
    req.baseDir,
  );
  if (path.extname(output).toLowerCase() !== '.mp4') {
    return { ok: false, error: 'o render do Nexus grava .mp4; use nexus_video_export para outros formatos.' };
  }
  if (req.fps !== undefined && (!Number.isInteger(req.fps) || req.fps < 1 || req.fps > 120)) {
    return { ok: false, error: 'fps precisa ser inteiro de 1 a 120' };
  }
  const timeoutMin = Math.min(MAX_TIMEOUT_MIN, Math.max(1, Math.round(req.timeoutMinutes ?? DEFAULT_TIMEOUT_MIN)));

  const paths = videoEnginePaths(deps.userData);
  const env = buildEngineEnv({ base: deps.baseEnv, pathValue: deps.pathValue, home: paths.home });
  const node = await (deps.resolveNode ?? resolveNodeRuntime)({ nodeOnPath: deps.lookup('node'), env });
  if (!node || node.major < MIN_NODE_MAJOR) {
    return {
      ok: false,
      error: `O motor de vídeo precisa do Node.js ${MIN_NODE_MAJOR} ou mais novo no PATH. Instale com: ${installHint('node', process.platform)}`,
    };
  }
  const ffprobe = deps.lookup('ffprobe');
  if (!deps.lookup('ffmpeg') || !ffprobe) {
    return {
      ok: false,
      error: `O HyperFrames precisa do ffmpeg e do ffprobe no PATH. Instale com: ${installHint('ffmpeg', process.platform)}`,
    };
  }

  const nodeRuntime = node;
  const ffprobePath = ffprobe;
  req.assertCurrentAuthority?.();
  let permit: HeavyCommandPermit;
  try {
    permit = await deps.acquirePermit({
      scope: req.scope,
      kind: 'build',
      label: 'hyperframes render',
      missionId: req.missionId,
      sessionId: req.sessionId,
      paneId: req.paneId,
      signal: req.signal,
    });
  } catch (error) {
    const message = (error as Error).message;
    return {
      ok: false,
      error: /^heavy_command_/u.test(message)
        ? `A máquina está ocupada com outro comando pesado neste projeto (${message}); tente de novo em instantes.`
        : message,
      ...(req.signal?.aborted ? { canceled: true } : {}),
    };
  }

  activeRenders += 1;
  const startedAt = Date.now();
  let orphansKilled = 0;
  let outcome: RenderResult;
  try {
    outcome = await renderInsidePermit();
  } finally {
    activeRenders -= 1;
    // A crashed render can leave Chrome workers behind; only sweep when no
    // other render is using the engine's Chrome right now.
    if (activeRenders === 0) {
      orphansKilled = await (deps.sweep ?? sweepEngineOrphans)(paths.root).catch(() => 0);
    }
    permit.release();
  }
  return outcome.ok ? { ...outcome, orphansKilled } : outcome;

  async function renderInsidePermit(): Promise<RenderResult> {
    fs.mkdirSync(paths.workDir, { recursive: true });
    fs.mkdirSync(paths.home, { recursive: true });
    const engine = await (deps.ensureEngine ?? ensureVideoEngine)({
      paths,
      manifestDir: deps.manifestDir,
      node: nodeRuntime,
      env,
      signal: req.signal,
    });
    if (!engine.ok) return { ok: false, error: engine.error, ...(req.signal?.aborted ? { canceled: true } : {}) };
    req.assertCurrentAuthority?.();
    fs.mkdirSync(path.dirname(output), { recursive: true });

    const network = new Set<string>();
    const args = [paths.cliEntry, 'render', projectDir, '--output', output];
    if (req.quality === 'draft') args.push('--quality', 'draft');
    if (req.fps !== undefined) args.push('--fps', String(req.fps));
    const result = await (deps.run ?? runOwnedProcess)({
      file: nodeRuntime.execPath,
      args,
      cwd: paths.workDir,
      env,
      signal: req.signal,
      timeoutMs: timeoutMin * 60_000,
      onLine: (line) => {
        const progress = parseHfProgress(line);
        if (progress) {
          req.onProgress?.(progress);
          return;
        }
        if (network.size < 10 && NETWORK_LINE.test(line)) network.add(line.slice(0, 200));
      },
    });
    if (result.aborted) return { ok: false, error: 'render cancelado; a árvore de processos foi encerrada', canceled: true };
    if (result.timedOut) return { ok: false, error: `o render passou de ${timeoutMin} min e foi encerrado`, log: errorLog(result.tail) };
    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: `o HyperFrames terminou com código ${result.exitCode ?? 'desconhecido'}${result.spawnError ? ` (${result.spawnError})` : ''}`,
        log: errorLog(result.tail),
      };
    }

    let probe: MediaProbe;
    try {
      probe = await (deps.probe ?? probeMedia)(ffprobePath, output, env);
    } catch (error) {
      return { ok: false, error: `o render terminou mas o arquivo não abre: ${(error as Error).message}`, log: errorLog(result.tail) };
    }
    if (!probe.video || !probe.durationSec) {
      return { ok: false, error: 'o arquivo gerado não tem vídeo legível', log: errorLog(result.tail) };
    }
    return {
      ok: true,
      path: output,
      durationSec: probe.durationSec,
      width: probe.video.width,
      height: probe.video.height,
      fps: probe.video.fps,
      videoCodec: probe.video.codec,
      audioCodec: probe.audio?.codec ?? null,
      sizeBytes: probe.sizeBytes,
      renderMs: Date.now() - startedAt,
      engine: { name: 'hyperframes', version: HYPERFRAMES_VERSION, installed: engine.installed },
      networkAccess: [...network],
      orphansKilled: 0,
    };
  }
}
