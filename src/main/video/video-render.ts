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
 *
 * Variants (F-1605, study §5.3 step 13): one request renders the same video in
 * several formats or languages. Variants that share a composition differ only
 * in their variables and go through ONE `--batch` run of the engine (one CLI,
 * one manifest); a variant with another composition (another format: the
 * engine cannot change the aspect ratio of a composition) is its own render.
 * All of it runs under one heavy reservation, one after the other.
 */

export interface RenderProgress {
  readonly pct: number;
  readonly stage: string | null;
}

export interface RenderVariant {
  /** Slug used in the output name, e.g. `vertical-pt`, `wide-en`. */
  readonly name: string;
  /** Composition file inside the project (default index.html). */
  readonly composition?: string;
  /** Values for the composition's data-composition-variables. */
  readonly variables?: Readonly<Record<string, unknown>>;
}

export interface RenderRequest {
  readonly projectDir: string;
  readonly output?: string;
  readonly quality?: 'draft' | 'final';
  readonly fps?: number;
  readonly timeoutMinutes?: number;
  /** Single render: composition file inside the project (default index.html). */
  readonly composition?: string;
  /** Single render: values for the composition's variables. */
  readonly variables?: Readonly<Record<string, unknown>>;
  /** Several outputs in one request (formats, languages). Ignores output/composition/variables. */
  readonly variants?: readonly RenderVariant[];
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

export type VariantOutcome =
  | {
      readonly name: string;
      readonly ok: true;
      readonly path: string;
      readonly durationSec: number | null;
      readonly width: number;
      readonly height: number;
      readonly fps: number | null;
      readonly sizeBytes: number | null;
    }
  | { readonly name: string; readonly ok: false; readonly error: string };

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
      /** With variants: one entry per variant, in request order; the top-level fields are the first that worked. */
      readonly variants?: readonly VariantOutcome[];
    }
  | { readonly ok: false; readonly error: string; readonly canceled?: boolean; readonly log?: readonly string[] };

const DEFAULT_TIMEOUT_MIN = 20;
const MAX_TIMEOUT_MIN = 60;
export const MAX_RENDER_VARIANTS = 8;
const MAX_VARIABLES_JSON = 16 * 1024;
const VARIANT_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/u;
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

/** An .html composition file inside the project folder (realpath). */
export function resolveComposition(input: string, projectDir: string): string {
  const candidate = path.resolve(projectDir, input);
  let real: string;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    throw new Error(`composição não existe no projeto: ${input}`);
  }
  if (!isInside(projectDir, real) || path.extname(real).toLowerCase() !== '.html' || !fs.statSync(real).isFile()) {
    throw new Error(`a composição precisa ser um .html dentro do projeto: ${input}`);
  }
  return real;
}

function checkVariables(value: unknown, label: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label}: as variáveis precisam ser um objeto JSON`);
  }
  if (JSON.stringify(value).length > MAX_VARIABLES_JSON) throw new Error(`${label}: variáveis grandes demais (máx. 16 KB)`);
  return value as Record<string, unknown>;
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
const BATCH_ROW_LINE = /\bBatch row (\d+):/u;

function errorLog(tail: readonly string[]): string[] {
  return tail.filter((line) => !line.startsWith('@hf-')).slice(-12);
}

/** One engine invocation: a single output, or several variable rows through --batch. */
interface RenderJob {
  readonly composition: string | null;
  readonly rows: ReadonlyArray<{ readonly name: string | null; readonly variables?: Record<string, unknown>; readonly output: string }>;
}

function planJobs(req: RenderRequest, projectDir: string, baseDir: string, now: Date): RenderJob[] {
  const relativeProject = path.relative(fs.realpathSync(baseDir), projectDir) || '.';
  const project = path.basename(projectDir);
  const at = stamp(now);
  if (!req.variants || req.variants.length === 0) {
    const output = resolveMediaOutputPath(
      req.output ?? path.join(relativeProject, 'renders', `${project}-${at}.mp4`),
      baseDir,
    );
    if (path.extname(output).toLowerCase() !== '.mp4') {
      throw new Error('o render do Nexus grava .mp4; use nexus_video_export para outros formatos.');
    }
    return [
      {
        composition: req.composition ? resolveComposition(req.composition, projectDir) : null,
        rows: [{ name: null, variables: checkVariables(req.variables, 'variables'), output }],
      },
    ];
  }
  if (req.variants.length > MAX_RENDER_VARIANTS) throw new Error(`no máximo ${MAX_RENDER_VARIANTS} variantes por pedido`);
  const seen = new Set<string>();
  const groups = new Map<string, { composition: string | null; rows: RenderJob['rows'][number][] }>();
  for (const variant of req.variants) {
    if (!VARIANT_NAME.test(variant.name)) {
      throw new Error(`nome de variante inválido: "${variant.name}" (use letras minúsculas, números e hífen)`);
    }
    if (seen.has(variant.name)) throw new Error(`variante repetida: ${variant.name}`);
    seen.add(variant.name);
    const composition = variant.composition ? resolveComposition(variant.composition, projectDir) : null;
    const key = composition ?? '';
    const output = resolveMediaOutputPath(path.join(relativeProject, 'renders', `${project}-${variant.name}-${at}.mp4`), baseDir);
    const group = groups.get(key) ?? { composition, rows: [] };
    group.rows.push({ name: variant.name, variables: checkVariables(variant.variables, variant.name), output });
    groups.set(key, group);
  }
  return [...groups.values()];
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
  let jobs: RenderJob[];
  try {
    jobs = planJobs(req, projectDir, req.baseDir, deps.now());
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  if (req.fps !== undefined && (!Number.isInteger(req.fps) || req.fps < 1 || req.fps > 120)) {
    return { ok: false, error: 'fps precisa ser inteiro de 1 a 120' };
  }
  const timeoutMin = Math.min(MAX_TIMEOUT_MIN, Math.max(1, Math.round(req.timeoutMinutes ?? DEFAULT_TIMEOUT_MIN)));
  const totalRows = jobs.reduce((sum, job) => sum + job.rows.length, 0);

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

    const network = new Set<string>();
    const outcomes = new Map<string, VariantOutcome>();
    const probes = new Map<string, MediaProbe>();
    let rowsDone = 0;
    let lastLog: readonly string[] = [];

    for (const job of jobs) {
      const batch = job.rows.length > 1;
      const args = [paths.cliEntry, 'render', projectDir];
      if (job.composition) args.push('--composition', path.relative(projectDir, job.composition).split(path.sep).join('/'));
      if (req.quality === 'draft') args.push('--quality', 'draft');
      if (req.fps !== undefined) args.push('--fps', String(req.fps));
      let batchFile: string | null = null;
      let batchOutputs: string[] = [];
      if (batch) {
        // Rows render to an index template, renamed to the variant names after.
        const dir = path.dirname(job.rows[0].output);
        fs.mkdirSync(dir, { recursive: true });
        const tag = path.basename(job.rows[0].output).replace(/\.mp4$/iu, '');
        batchOutputs = job.rows.map((_row, index) => path.join(dir, `.${tag}-batch-${index}.mp4`));
        batchFile = path.join(paths.workDir, `batch-${process.pid}-${Date.now()}.json`);
        fs.writeFileSync(batchFile, JSON.stringify(job.rows.map((row) => row.variables ?? {})), { mode: 0o600 });
        args.push('--batch', batchFile, '--output', path.join(dir, `.${tag}-batch-{index}.mp4`));
      } else {
        const row = job.rows[0];
        fs.mkdirSync(path.dirname(row.output), { recursive: true });
        args.push('--output', row.output);
        if (row.variables) args.push('--variables', JSON.stringify(row.variables));
      }
      let currentRow = 0;
      const result = await (deps.run ?? runOwnedProcess)({
        file: nodeRuntime.execPath,
        args,
        cwd: paths.workDir,
        env,
        signal: req.signal,
        timeoutMs: timeoutMin * 60_000 * job.rows.length,
        onLine: (line) => {
          const rowMatch = BATCH_ROW_LINE.exec(line);
          if (rowMatch) currentRow = Number(rowMatch[1]);
          const progress = parseHfProgress(line);
          if (progress) {
            const pct = totalRows > 1 ? Math.round(((rowsDone + currentRow) * 100 + progress.pct) / totalRows) : progress.pct;
            req.onProgress?.({ pct: Math.min(100, pct), stage: progress.stage });
            return;
          }
          if (network.size < 10 && NETWORK_LINE.test(line)) network.add(line.slice(0, 200));
        },
      });
      if (batchFile) fs.rmSync(batchFile, { force: true });
      lastLog = errorLog(result.tail);
      if (result.aborted) {
        if (batch) for (const file of batchOutputs) fs.rmSync(file, { force: true });
        return { ok: false, error: 'render cancelado; a árvore de processos foi encerrada', canceled: true };
      }
      for (const [index, row] of job.rows.entries()) {
        const produced = batch ? batchOutputs[index] : row.output;
        const label = row.name ?? 'render';
        if (result.timedOut) {
          outcomes.set(label, { name: label, ok: false, error: `o render passou de ${timeoutMin} min por variante e foi encerrado` });
          continue;
        }
        // A batch exits non-zero when one row fails: each row is judged by its own file.
        if ((!batch && result.exitCode !== 0) || !fs.existsSync(produced)) {
          outcomes.set(label, {
            name: label,
            ok: false,
            error: `o HyperFrames terminou com código ${result.exitCode ?? 'desconhecido'}${result.spawnError ? ` (${result.spawnError})` : ''}`,
          });
          continue;
        }
        if (batch) fs.renameSync(produced, row.output);
        try {
          const probe = await (deps.probe ?? probeMedia)(ffprobePath, row.output, env);
          if (!probe.video || !probe.durationSec) throw new Error('sem vídeo legível');
          probes.set(label, probe);
          outcomes.set(label, {
            name: label,
            ok: true,
            path: row.output,
            durationSec: probe.durationSec,
            width: probe.video.width,
            height: probe.video.height,
            fps: probe.video.fps,
            sizeBytes: probe.sizeBytes,
          });
        } catch (error) {
          outcomes.set(label, { name: label, ok: false, error: `o arquivo gerado não abre: ${(error as Error).message}` });
        }
      }
      if (batch) {
        // The engine's batch manifest sits next to the outputs; the result already carries it.
        fs.rmSync(path.join(path.dirname(job.rows[0].output), 'manifest.json'), { force: true });
      }
      rowsDone += job.rows.length;
    }

    const ordered = jobs.flatMap((job) => job.rows.map((row) => outcomes.get(row.name ?? 'render')!));
    const first = ordered.find((item): item is Extract<VariantOutcome, { ok: true }> => item.ok);
    if (!first) {
      return { ok: false, error: ordered.map((item) => (item.ok ? '' : item.error)).filter(Boolean)[0] ?? 'o render falhou', log: lastLog };
    }
    const probe = probes.get(first.name)!;
    return {
      ok: true,
      path: first.path,
      durationSec: first.durationSec,
      width: first.width,
      height: first.height,
      fps: first.fps,
      videoCodec: probe.video!.codec,
      audioCodec: probe.audio?.codec ?? null,
      sizeBytes: first.sizeBytes,
      renderMs: Date.now() - startedAt,
      engine: { name: 'hyperframes', version: HYPERFRAMES_VERSION, installed: engine.installed },
      networkAccess: [...network],
      orphansKilled: 0,
      ...(req.variants && req.variants.length > 0 ? { variants: req.variants.map((variant) => outcomes.get(variant.name)!) } : {}),
    };
  }
}
