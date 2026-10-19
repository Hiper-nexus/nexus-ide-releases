import fs from 'node:fs';
import path from 'node:path';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  AI_VOICE_LABEL,
  DIGITAL_SOURCE_TYPE,
  EXPORT_LOUDNESS,
  exportVideoFilter,
  loudnormFilter,
  parseEbur128Summary,
  parseLoudnormJson,
  publishChecklist,
  VIDEO_EXPORT_PRESETS,
  type PublishChecklistItem,
  type VideoExportPresetId,
} from '../../shared/video-export-presets';
import type { HeavyCommandPermit, HeavyCommandRequest } from '../orch/heavy-command-permit';
import { readMediaInput, resolveMediaOutputPath, writeMediaOutput } from '../media/media-path-policy';
import { buildEngineEnv } from './video-engine';
import { installHint } from './video-doctor';
import { runOwnedProcess, type OwnedProcessResult } from './video-process';
import { probeMedia, type MediaProbe } from './ffprobe';
import { resolveWorkspaceDir } from './video-render';

/**
 * `nexus_video_export` (F-1595): one rendered MP4 → the file each network
 * wants. Preset size and frame rate, H.264 High yuv420p, AAC 48 kHz,
 * +faststart; loudness normalized in two passes to -14 LUFS / -1 dBTP and
 * measured again on the output; a mute version; a PNG cover; the narration
 * captions next to it; the IPTC Digital Source Type in the MP4 metadata and a
 * provenance JSON beside it; and the visible "Narração com voz gerada por IA"
 * label, on by default when the narration voice is a clone (AI Act art. 50).
 */

export type ExportLabelMode = 'auto' | 'on' | 'off';

export interface ExportRequest {
  readonly input: string;
  readonly preset: VideoExportPresetId;
  readonly projectDir?: string;
  readonly label?: ExportLabelMode;
  /** Seconds the label stays on screen; 0 = whole video. Default 6. */
  readonly labelSeconds?: number;
  readonly coverAtSec?: number;
  readonly outDir?: string;
  readonly baseDir: string;
  readonly scope: Readonly<ProjectExecutionScope>;
  readonly missionId?: string;
  readonly sessionId?: string;
  readonly signal?: AbortSignal;
  readonly assertCurrentAuthority?: () => void;
}

export interface ExportDeps {
  readonly pathValue: string;
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly lookup: (command: string) => string | null;
  readonly acquirePermit: (request: HeavyCommandRequest) => Promise<HeavyCommandPermit>;
  readonly home: string;
  readonly platform?: NodeJS.Platform;
  readonly run?: typeof runOwnedProcess;
  readonly probe?: typeof probeMedia;
  readonly fontCandidates?: readonly string[];
}

export interface SyntheticSources {
  readonly narration: Array<{ readonly file: string; readonly provider: string; readonly model: string; readonly voiceOrigin: string }>;
  readonly music: Array<{ readonly file: string; readonly provider: string; readonly model: string }>;
  readonly captions: { readonly srt?: string; readonly vtt?: string } | null;
}

export type ExportResult =
  | {
      readonly ok: true;
      readonly preset: VideoExportPresetId;
      readonly files: {
        readonly video: string;
        readonly mute: string;
        readonly cover: string;
        readonly provenance: string;
        readonly srt?: string;
        readonly vtt?: string;
      };
      readonly durationSec: number | null;
      readonly width: number;
      readonly height: number;
      readonly loudness: { readonly integratedLufs: number; readonly truePeakDb: number | null; readonly withinTarget: boolean } | null;
      readonly label: { readonly burned: boolean; readonly reason: string };
      readonly digitalSourceType: string | null;
      readonly aspectMismatch: boolean;
      readonly publishChecklist: readonly PublishChecklistItem[];
    }
  | { readonly ok: false; readonly error: string; readonly canceled?: boolean; readonly log?: readonly string[] };

const FFMPEG_TIMEOUT_MS = 30 * 60_000;
const SKIP_DIRS = new Set(['node_modules', '.git', '.hyperframes', 'renders', 'exports', '.nexus']);

export function defaultLabelFonts(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform === 'win32') {
    const fonts = path.win32.join(env.SystemRoot ?? env.windir ?? 'C:\\Windows', 'Fonts');
    return ['segoeui.ttf', 'arial.ttf', 'calibri.ttf'].map((name) => path.win32.join(fonts, name));
  }
  if (platform === 'darwin') {
    return [
      '/System/Library/Fonts/Supplemental/Arial.ttf',
      '/Library/Fonts/Arial.ttf',
      '/System/Library/Fonts/Helvetica.ttc',
    ];
  }
  return [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/TTF/DejaVuSans.ttf',
    '/usr/share/fonts/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
    '/usr/share/fonts/liberation-sans/LiberationSans-Regular.ttf',
  ];
}

/** Narration timelines and music provenance the Nexus wrote inside the project. */
export function findSyntheticSources(projectDir: string, maxDepth = 4): SyntheticSources {
  const narration: SyntheticSources['narration'] = [];
  const music: SyntheticSources['music'] = [];
  let captions: SyntheticSources['captions'] = null;
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.endsWith('.timeline.json') || entry.name.endsWith('.provenance.json')) {
        let parsed: Record<string, unknown>;
        try {
          if (fs.statSync(full).size > 8 * 1024 * 1024) continue;
          parsed = JSON.parse(fs.readFileSync(full, 'utf8')) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (parsed.generator === 'nexus_voiceover_generate') {
          const voice = (parsed.voice ?? {}) as Record<string, unknown>;
          narration.push({
            file: full,
            provider: String(parsed.provider ?? 'unknown'),
            model: String(parsed.model ?? 'unknown'),
            voiceOrigin: String(voice.origin ?? 'unknown'),
          });
          const caps = (parsed.captions ?? {}) as Record<string, unknown>;
          if (!captions) {
            // The timeline names its captions; an older or hand-made one falls back to the siblings.
            const sibling = full.slice(0, -'.timeline.json'.length);
            const srt = typeof caps.srt === 'string' ? path.resolve(dir, caps.srt) : `${sibling}.srt`;
            const vtt = typeof caps.vtt === 'string' ? path.resolve(dir, caps.vtt) : `${sibling}.vtt`;
            captions = {
              ...(srt && fs.existsSync(srt) ? { srt } : {}),
              ...(vtt && fs.existsSync(vtt) ? { vtt } : {}),
            };
          }
        } else if (parsed.generator === 'nexus_music_generate') {
          music.push({ file: full, provider: String(parsed.provider ?? 'unknown'), model: String(parsed.model ?? 'unknown') });
        }
      }
    }
  };
  walk(projectDir, 0);
  return { narration, music, captions };
}

export function decideLabel(
  mode: ExportLabelMode,
  sources: SyntheticSources,
): { burned: boolean; reason: string } {
  if (mode === 'on') return { burned: true, reason: 'pedido explícito' };
  if (mode === 'off') return { burned: false, reason: 'desligado pelo pedido' };
  const cloned = sources.narration.find((item) => item.voiceOrigin !== 'library' && item.voiceOrigin !== 'designed');
  return cloned
    ? { burned: true, reason: `narração com voz ${cloned.voiceOrigin === 'unknown' ? 'de origem desconhecida' : 'clonada'}` }
    : { burned: false, reason: sources.narration.length ? 'voz de biblioteca, não clonada' : 'sem narração gerada pelo Nexus' };
}

function failure(result: OwnedProcessResult, what: string): ExportResult {
  if (result.aborted) return { ok: false, error: 'exportação cancelada', canceled: true };
  if (result.timedOut) return { ok: false, error: `${what} passou de 30 min` };
  return {
    ok: false,
    error: `${what} falhou (ffmpeg ${result.exitCode ?? 'sem código'}${result.spawnError ? `, ${result.spawnError}` : ''})`,
    log: result.tail.slice(-10),
  };
}

/** A file inside the workspace after realpath, without reading it (a video can be large). */
function resolveWorkspaceFile(input: string, baseDir: string): string {
  const root = fs.realpathSync(path.resolve(baseDir));
  const candidate = path.isAbsolute(input) ? path.resolve(input) : path.resolve(root, input);
  let real: string;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    throw new Error(`vídeo de entrada não existe: ${input}`);
  }
  const relative = path.relative(root, real);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`vídeo fora do workspace: ${input}`);
  if (!fs.statSync(real).isFile()) throw new Error(`não é um arquivo: ${input}`);
  return real;
}

/** The nearest folder above the render with hyperframes.json, inside the workspace. */
function findProjectRoot(file: string, workspaceRoot: string): string {
  let dir = path.dirname(file);
  while (dir.startsWith(workspaceRoot)) {
    if (fs.existsSync(path.join(dir, 'hyperframes.json')) || fs.existsSync(path.join(dir, 'index.html'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.dirname(file);
}

function stem(file: string): string {
  return path.basename(file, path.extname(file));
}

export async function exportVideo(req: ExportRequest, deps: ExportDeps): Promise<ExportResult> {
  const preset = VIDEO_EXPORT_PRESETS[req.preset];
  if (!preset) return { ok: false, error: `preset desconhecido: ${req.preset}` };
  req.assertCurrentAuthority?.();
  const workspaceRoot = fs.realpathSync(req.baseDir);
  const input = resolveWorkspaceFile(req.input, req.baseDir);
  const projectRoot = req.projectDir
    ? resolveWorkspaceDir(req.projectDir, req.baseDir)
    : findProjectRoot(input, workspaceRoot);
  const outDir = req.outDir ?? path.join(path.relative(workspaceRoot, projectRoot) || '.', 'exports');
  const base = `${stem(input)}-${preset.id}`;
  const out = (suffix: string) => resolveMediaOutputPath(path.join(outDir, `${base}${suffix}`), req.baseDir);
  const files = {
    video: out('.mp4'),
    mute: out('-mute.mp4'),
    cover: out('-cover.png'),
    provenance: out('.provenance.json'),
  };
  const ffmpeg = deps.lookup('ffmpeg');
  const ffprobe = deps.lookup('ffprobe');
  const platform = deps.platform ?? process.platform;
  if (!ffmpeg || !ffprobe) {
    return { ok: false, error: `A exportação precisa do ffmpeg e do ffprobe no PATH. Instale com: ${installHint('ffmpeg', platform)}` };
  }
  const env = buildEngineEnv({ base: deps.baseEnv, pathValue: deps.pathValue, home: deps.home, platform });
  const probe = deps.probe ?? probeMedia;
  let source: MediaProbe;
  try {
    source = await probe(ffprobe, input, env);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  if (!source.video) return { ok: false, error: 'o arquivo de entrada não tem vídeo' };
  const sources = findSyntheticSources(projectRoot);
  const label = decideLabel(req.label ?? 'auto', sources);
  const fontFile = label.burned
    ? (deps.fontCandidates ?? defaultLabelFonts(platform)).find((candidate) => fs.existsSync(candidate)) ?? null
    : null;
  if (label.burned && !fontFile) {
    return { ok: false, error: 'Não achei uma fonte do sistema para o rótulo de IA; instale a DejaVu Sans ou exporte com label: "off" e rotule ao publicar.' };
  }
  const synthetic = sources.narration.length > 0 || sources.music.length > 0;
  const digitalSourceType = synthetic ? DIGITAL_SOURCE_TYPE.composite : null;
  const aspectMismatch =
    Math.abs(source.video.width / source.video.height - preset.width / preset.height) > 0.01;
  const coverAt = Math.max(0, Math.min(req.coverAtSec ?? 1.5, Math.max(0, (source.durationSec ?? 2) - 0.1)));
  const labelSeconds = Math.max(0, Math.min(600, Math.round(req.labelSeconds ?? 6)));

  let permit: HeavyCommandPermit;
  try {
    permit = await deps.acquirePermit({
      scope: req.scope,
      kind: 'build',
      label: 'video export',
      missionId: req.missionId,
      sessionId: req.sessionId,
      signal: req.signal,
    });
  } catch (error) {
    const message = (error as Error).message;
    return { ok: false, error: /^heavy_command_/u.test(message) ? `máquina ocupada (${message}); tente de novo em instantes` : message };
  }
  const run = deps.run ?? runOwnedProcess;
  const exec = (args: readonly string[], cwd: string) =>
    run({ file: ffmpeg, args: ['-hide_banner', '-nostats', ...args], cwd, env, signal: req.signal, timeoutMs: FFMPEG_TIMEOUT_MS });
  const partial = path.join(path.dirname(files.video), `.${base}.part.mp4`);
  try {
    fs.mkdirSync(path.dirname(files.video), { recursive: true });
    // 1st pass: measure the loudness.
    let measured: ReturnType<typeof parseLoudnormJson> = null;
    if (source.audio) {
      const pass1 = await exec(['-i', input, '-vn', '-af', loudnormFilter(), '-f', 'null', '-'], projectRoot);
      if (pass1.exitCode !== 0) return failure(pass1, 'a medição de loudness');
      measured = parseLoudnormJson(pass1.tail.join('\n'));
      if (!measured) return { ok: false, error: 'o ffmpeg não devolveu a medição de loudness', log: pass1.tail.slice(-10) };
    }
    req.assertCurrentAuthority?.();
    // 2nd pass: encode for the preset, with the measured loudness.
    const metadata = [
      '-metadata', `comment=${label.burned || sources.narration.length ? AI_VOICE_LABEL : 'Vídeo exportado pelo NexusIDE'}`,
      ...(digitalSourceType ? ['-metadata', `digital_source_type=${digitalSourceType}`] : []),
    ];
    const encode = await exec(
      [
        '-y',
        '-i', input,
        '-map', '0:v:0',
        ...(source.audio ? ['-map', '0:a:0'] : []),
        '-vf', exportVideoFilter({ preset, label: fontFile ? { text: AI_VOICE_LABEL, fontFile: path.basename(fontFile), seconds: labelSeconds } : null }),
        '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'medium', '-crf', '18',
        '-maxrate', `${preset.maxRateKbps}k`, '-bufsize', `${preset.maxRateKbps * 2}k`, '-pix_fmt', 'yuv420p',
        ...(source.audio
          ? ['-af', loudnormFilter(measured ?? undefined), '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2']
          : ['-an']),
        '-movflags', '+faststart+use_metadata_tags',
        ...metadata,
        partial,
      ],
      // drawtext reads the font by bare name: no drive colon to escape in the filter.
      fontFile ? path.dirname(fontFile) : projectRoot,
    );
    if (encode.exitCode !== 0) return failure(encode, 'a codificação');
    // 3rd pass: measure what was delivered.
    let loudness: { integratedLufs: number; truePeakDb: number | null; withinTarget: boolean } | null = null;
    if (source.audio) {
      const check = await exec(['-i', partial, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-'], projectRoot);
      const summary = check.exitCode === 0 ? parseEbur128Summary(check.tail.join('\n')) : null;
      if (summary) {
        loudness = {
          ...summary,
          withinTarget:
            Math.abs(summary.integratedLufs - EXPORT_LOUDNESS.integratedLufs) <= 1 &&
            (summary.truePeakDb === null || summary.truePeakDb <= EXPORT_LOUDNESS.truePeakDb + 0.5),
        };
      }
    }
    const delivered = await probe(ffprobe, partial, env);
    if (!delivered.video) return { ok: false, error: 'o export não tem vídeo legível' };
    req.assertCurrentAuthority?.();
    resolveMediaOutputPath(files.video, req.baseDir);
    fs.renameSync(partial, files.video);
    const mute = await exec(['-y', '-i', files.video, '-map', '0:v:0', '-c:v', 'copy', '-an', '-movflags', '+faststart+use_metadata_tags', ...metadata, files.mute], projectRoot);
    if (mute.exitCode !== 0) return failure(mute, 'a versão muda');
    const cover = await exec(['-y', '-ss', coverAt.toFixed(2), '-i', files.video, '-frames:v', '1', '-update', '1', files.cover], projectRoot);
    if (cover.exitCode !== 0) return failure(cover, 'a capa');

    const captions: { srt?: string; vtt?: string } = {};
    for (const kind of ['srt', 'vtt'] as const) {
      const from = sources.captions?.[kind];
      if (!from) continue;
      const target = out(`.${kind}`);
      writeMediaOutput(target, req.baseDir, readMediaInput(from, req.baseDir).data);
      captions[kind] = target;
    }
    const provenance = {
      version: 1,
      generator: 'nexus_video_export',
      source: path.relative(path.dirname(files.provenance), input).split(path.sep).join('/'),
      preset: preset.id,
      digitalSourceType,
      visibleLabel: label.burned ? { text: AI_VOICE_LABEL, seconds: labelSeconds || 'todo o vídeo' } : null,
      synthetic: {
        narration: sources.narration.map((item) => ({
          provider: item.provider,
          model: item.model,
          voiceOrigin: item.voiceOrigin,
          digitalSourceType: DIGITAL_SOURCE_TYPE.trained,
        })),
        music: sources.music.map((item) => ({ provider: item.provider, model: item.model, digitalSourceType: DIGITAL_SOURCE_TYPE.trained })),
      },
      loudness,
    };
    writeMediaOutput(files.provenance, req.baseDir, Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`, 'utf8'));
    return {
      ok: true,
      preset: preset.id,
      files: { ...files, ...captions },
      durationSec: delivered.durationSec,
      width: delivered.video.width,
      height: delivered.video.height,
      loudness,
      label,
      digitalSourceType,
      aspectMismatch,
      publishChecklist: publishChecklist(preset.networks, {
        voice: sources.narration.length > 0,
        clonedVoice: sources.narration.some((item) => item.voiceOrigin === 'nexus-clone' || item.voiceOrigin === 'external-clone'),
        music: sources.music.length > 0,
      }),
    };
  } finally {
    fs.rmSync(partial, { force: true });
    permit.release();
  }
}
