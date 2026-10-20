import fs from 'node:fs';
import path from 'node:path';
import { protocol, shell, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { VIDEO_EXPORT_PRESET_IDS, type VideoExportPresetId } from '../../shared/video-export-presets';
import {
  VIDEO_STUDIO_CHANNELS,
  type VideoDoctorView,
  type VideoExportView,
  type VideoPreviewView,
  type NarrationAlignView,
  type VideoFileInfo,
  type VideoProjectInfo,
  type VideoRenderView,
  type VideoStudioListResult,
} from '../../shared/video-studio-types';
import type { ProjectExecutionScope } from '../../shared/types';
import { requireRendererWorkspaceScope } from '../persistence/renderer-workspace-scope';
import { handleTrusted } from '../security/trusted-ipc';
import { assertVideoStudioEnabled } from './video-studio-flag';
import { createMediaStreamHandler, grantMediaStreamUrl, MEDIA_STREAM_SCHEME } from './media-stream-protocol';
import { detectVideoProject, videoEnginePaths } from './video-engine';
import { runVideoDoctor } from './video-doctor';
import { exportVideo, findSyntheticSources } from './video-export';
import { renderVideo, resolveWorkspaceDir } from './video-render';
import { videoRenderDeps } from './video-runtime-deps';
import { listVideoPreviews, startVideoPreview, stopVideoPreview } from './video-preview';
import { alignVoiceover } from '../media/voiceover-align';
import { resolveMediaKey } from '../media/media-keys';
import { writeMediaOutput } from '../media/media-path-policy';
import { reserveMediaSpend } from '../media/media-budget';

/**
 * Estúdio de Mídia → "Vídeos do projeto" (F-1596): the human's buttons for
 * the same engine the agents use. Every channel is `handleTrusted`; the
 * workspace is the renderer's authorized scope, resolved again per call.
 */

const SKIP = new Set(['node_modules', '.git', '.hyperframes', 'renders', 'exports', '.nexus', 'dist', 'build', 'out', '.vite']);
const MAX_PROJECTS = 50;
const jobs = new Map<string, AbortController>();

function posix(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/') || '.';
}

function videoFiles(root: string, dir: string, max: number): VideoFileInfo[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => /\.mp4$/iu.test(name) && !name.startsWith('.'))
    .map((name) => {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      return { path: posix(root, full), sizeBytes: stat.size, modifiedAt: stat.mtimeMs };
    })
    .sort((left, right) => right.modifiedAt - left.modifiedAt)
    .slice(0, max);
}

export function listVideoProjects(
  workspaceRoot: string,
  maxDepth = 3,
  previews: readonly { id: string; url: string; project: string }[] = [],
): VideoProjectInfo[] {
  const root = fs.realpathSync(workspaceRoot);
  const projects: VideoProjectInfo[] = [];
  const walk = (dir: string, depth: number) => {
    if (projects.length >= MAX_PROJECTS || depth > maxDepth) return;
    const kind = detectVideoProject(dir);
    if (kind === 'hyperframes' || kind === 'remotion') {
      const synthetic = kind === 'hyperframes' ? findSyntheticSources(dir) : { narration: [], music: [] };
      projects.push({
        name: path.basename(dir),
        path: posix(root, dir),
        engine: kind,
        renders: videoFiles(root, path.join(dir, 'renders'), 10),
        exports: videoFiles(root, path.join(dir, 'exports'), 20),
        hasNarration: synthetic.narration.length > 0,
        hasMusic: synthetic.music.length > 0,
        ...previewOf(previews, posix(root, dir)),
      });
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink() && !SKIP.has(entry.name) && !entry.name.startsWith('.')) {
        walk(path.join(dir, entry.name), depth + 1);
      }
    }
  };
  walk(root, 0);
  return projects;
}

function previewOf(
  previews: readonly { id: string; url: string; project: string }[],
  project: string,
): { preview?: { id: string; url: string } } {
  const found = previews.find((item) => item.project === project);
  return found ? { preview: { id: found.id, url: found.url } } : {};
}

function scopeOf(event: IpcMainInvokeEvent): Readonly<ProjectExecutionScope> {
  return requireRendererWorkspaceScope(event.sender);
}

function jobKey(event: IpcMainInvokeEvent, jobId: string): string {
  return `${event.sender.id}:${jobId}`;
}

function relativeFile(root: string, file: string): string {
  return posix(fs.realpathSync(root), file);
}

const jobId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u);
const workspacePath = z.string().min(1).max(1024);

/** Every studio channel but "cancel" needs the internal key on (Ajustes → Experimental). */
function handleStudio(channel: string, handler: Parameters<typeof handleTrusted>[1]): void {
  handleTrusted(channel, (event, ...args) => {
    assertVideoStudioEnabled();
    return handler(event, ...args);
  });
}

export function registerVideoStudioIpc(): void {
  protocol.handle(MEDIA_STREAM_SCHEME, createMediaStreamHandler());

  handleStudio(VIDEO_STUDIO_CHANNELS.listProjects, (event): VideoStudioListResult => {
    try {
      const scope = scopeOf(event);
      return { ok: true, projects: listVideoProjects(scope.rootRealPath, 3, listVideoPreviews(scope)) };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  });

  handleStudio(VIDEO_STUDIO_CHANNELS.doctor, async (event): Promise<VideoDoctorView> => {
    try {
      const deps = videoRenderDeps();
      const report = await runVideoDoctor({
        userData: deps.userData,
        manifestDir: deps.manifestDir,
        workspaceDir: scopeOf(event).rootRealPath,
        pathValue: deps.pathValue,
        baseEnv: deps.baseEnv,
        lookup: deps.lookup,
      });
      return { ok: report.ok, engineVersion: report.engine.version, checks: report.checks };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  });

  handleStudio(VIDEO_STUDIO_CHANNELS.render, async (event, raw): Promise<VideoRenderView> => {
    const parsed = z
      .object({ projectPath: workspacePath, quality: z.enum(['draft', 'final']), jobId })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'pedido inválido' };
    const scope = scopeOf(event);
    const controller = new AbortController();
    const key = jobKey(event, parsed.data.jobId);
    jobs.set(key, controller);
    try {
      const result = await renderVideo(
        {
          projectDir: parsed.data.projectPath,
          quality: parsed.data.quality,
          baseDir: scope.rootRealPath,
          scope,
          signal: controller.signal,
          onProgress: (progress) => {
            if (!event.sender.isDestroyed()) {
              event.sender.send(VIDEO_STUDIO_CHANNELS.progress, { jobId: parsed.data.jobId, ...progress });
            }
          },
        },
        videoRenderDeps(),
      );
      if (!result.ok) return result;
      return {
        ok: true,
        path: relativeFile(scope.rootRealPath, result.path),
        durationSec: result.durationSec,
        width: result.width,
        height: result.height,
        renderMs: result.renderMs,
        networkAccess: result.networkAccess,
      };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    } finally {
      jobs.delete(key);
    }
  });

  handleStudio(VIDEO_STUDIO_CHANNELS.previewStart, async (event, raw): Promise<VideoPreviewView> => {
    const parsed = z.object({ projectPath: workspacePath }).safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'pedido inválido' };
    const scope = scopeOf(event);
    try {
      const result = await startVideoPreview(
        { projectDir: parsed.data.projectPath, baseDir: scope.rootRealPath, scope },
        videoRenderDeps(),
      );
      return result.ok ? { ok: true, id: result.id, url: result.url, reused: result.reused } : result;
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  });

  // F-1602: a narração gravada no Estúdio vai para <projeto>/assets e é alinhada ao roteiro.
  handleStudio(VIDEO_STUDIO_CHANNELS.alignRecording, async (event, raw): Promise<NarrationAlignView> => {
    const parsed = z
      .object({
        projectPath: workspacePath,
        script: z.string().min(1).max(50_000),
        wav: z.instanceof(Uint8Array).refine((bytes) => bytes.byteLength <= 64 * 1024 * 1024).optional(),
        audioPath: workspacePath.optional(),
        engine: z.enum(['elevenlabs', 'local']),
        allowModelDownload: z.boolean().optional(),
      })
      .strict()
      .safeParse(raw);
    if (!parsed.success || (!parsed.data.wav && !parsed.data.audioPath)) return { ok: false, error: 'Gravação ou pedido inválido.' };
    const scope = scopeOf(event);
    try {
      const projectDir = resolveWorkspaceDir(parsed.data.projectPath, scope.rootRealPath);
      let audioPath = parsed.data.audioPath;
      if (parsed.data.wav) {
        const wav = Buffer.from(parsed.data.wav);
        if (wav.toString('latin1', 0, 4) !== 'RIFF' || wav.toString('latin1', 8, 12) !== 'WAVE') {
          return { ok: false, error: 'A gravação não é WAV.' };
        }
        const stamp = new Date().toISOString().replace(/[-:]/gu, '').replace(/\..*$/u, '').replace('T', '-');
        const file = path.join(projectDir, 'assets', `narration-recorded-${stamp}.wav`);
        writeMediaOutput(file, scope.rootRealPath, wav);
        audioPath = relativeFile(scope.rootRealPath, file);
      }
      const runtime = videoRenderDeps();
      const deps = { ...runtime, fetchFn: fetch, getKey: resolveMediaKey };
      const request = {
        audioPath: audioPath!,
        script: parsed.data.script,
        engine: parsed.data.engine,
        outDir: path.join(relativeFile(scope.rootRealPath, projectDir), 'assets'),
        baseName: 'narration',
        allowModelDownload: parsed.data.allowModelDownload === true,
        baseDir: scope.rootRealPath,
        scope,
      };
      const priced = await alignVoiceover({ ...request, dryRun: true }, deps);
      if (!priced.ok) return { ...priced, audioPath };
      const spend = reserveMediaSpend({ provider: priced.engine, usd: priced.estimatedCostUsd }, null, 'voiceover_align');
      if (!spend.ok) return { ok: false, error: spend.error, audioPath };
      let result: Awaited<ReturnType<typeof alignVoiceover>>;
      try {
        result = await alignVoiceover(request, deps);
      } catch (error) {
        spend.release();
        throw error;
      }
      if (!result.ok) {
        spend.release();
        return { ok: false, error: result.error, audioPath, ...(result.needsModelDownload ? { needsModelDownload: true } : {}) };
      }
      spend.settle(result.estimatedCostUsd);
      return {
        ok: true,
        audioPath: audioPath!,
        words: result.words ?? 0,
        matchedRatio: result.matchedRatio ?? 0,
        costUsd: result.estimatedCostUsd,
        warnings: result.warnings ?? [],
        files: result.files ? Object.values(result.files).map((file) => relativeFile(scope.rootRealPath, file)) : [],
      };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  });

  // Parar a prévia vale sempre, como cancelar: encerra um processo do próprio Nexus.
  handleTrusted(VIDEO_STUDIO_CHANNELS.previewStop, async (event, raw): Promise<{ ok: boolean }> => {
    const parsed = z.object({ id: z.string().regex(/^vpreview-[0-9a-f-]{36}$/u) }).safeParse(raw);
    if (!parsed.success) return { ok: false };
    return { ok: await stopVideoPreview(parsed.data.id, scopeOf(event)) };
  });

  handleTrusted(VIDEO_STUDIO_CHANNELS.cancel, (event, raw): { ok: true } => {
    const parsed = z.object({ jobId }).safeParse(raw);
    if (parsed.success) jobs.get(jobKey(event, parsed.data.jobId))?.abort();
    return { ok: true };
  });

  handleStudio(VIDEO_STUDIO_CHANNELS.exportVideo, async (event, raw): Promise<VideoExportView> => {
    const parsed = z
      .object({
        inputPath: workspacePath,
        preset: z.enum(VIDEO_EXPORT_PRESET_IDS as [VideoExportPresetId, ...VideoExportPresetId[]]),
        label: z.enum(['auto', 'on', 'off']),
        jobId,
      })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'pedido inválido' };
    const scope = scopeOf(event);
    const controller = new AbortController();
    const key = jobKey(event, parsed.data.jobId);
    jobs.set(key, controller);
    try {
      const deps = videoRenderDeps();
      const result = await exportVideo(
        {
          input: parsed.data.inputPath,
          preset: parsed.data.preset,
          label: parsed.data.label,
          baseDir: scope.rootRealPath,
          scope,
          signal: controller.signal,
        },
        {
          pathValue: deps.pathValue,
          baseEnv: deps.baseEnv,
          lookup: deps.lookup,
          acquirePermit: deps.acquirePermit,
          home: videoEnginePaths(deps.userData).home,
        },
      );
      if (!result.ok) return result;
      const files: Record<string, string> = {};
      for (const [name, file] of Object.entries(result.files)) {
        if (file) files[name] = relativeFile(scope.rootRealPath, file);
      }
      return {
        ok: true,
        files,
        loudness: result.loudness,
        label: result.label,
        aspectMismatch: result.aspectMismatch,
        publishChecklist: result.publishChecklist,
      };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    } finally {
      jobs.delete(key);
    }
  });

  handleStudio(VIDEO_STUDIO_CHANNELS.mediaUrl, (event, raw) => {
    const parsed = z.object({ path: workspacePath }).safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'pedido inválido' };
    try {
      const root = fs.realpathSync(scopeOf(event).rootRealPath);
      const file = fs.realpathSync(path.resolve(root, parsed.data.path));
      const relative = path.relative(root, file);
      if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.statSync(file).isFile()) {
        return { ok: false, error: 'arquivo fora do projeto' };
      }
      return { ok: true, url: grantMediaStreamUrl(file) };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  });

  handleStudio(VIDEO_STUDIO_CHANNELS.reveal, (event, raw) => {
    const parsed = z.object({ path: workspacePath }).safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'pedido inválido' };
    try {
      const root = scopeOf(event).rootRealPath;
      const target = fs.statSync(path.resolve(root, parsed.data.path)).isDirectory()
        ? resolveWorkspaceDir(parsed.data.path, root)
        : fs.realpathSync(path.resolve(root, parsed.data.path));
      const relative = path.relative(fs.realpathSync(root), target);
      if (relative.startsWith('..') || path.isAbsolute(relative)) return { ok: false, error: 'fora do projeto' };
      shell.showItemInFolder(target);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  });
}
