import fs from 'node:fs';
import path from 'node:path';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  buildCaptionCues,
  buildNarrationTimeline,
  cuesToSrt,
  cuesToVtt,
  splitParagraphs,
  type TimedWord,
} from '../../shared/captions';
import { alignScriptToSpeech } from '../../shared/script-alignment';
import type { HeavyCommandPermit, HeavyCommandRequest } from '../orch/heavy-command-permit';
import { findMediaProvider, type MediaProviderDef } from './media-providers';
import { resolveMediaOutputPath, writeMediaOutput } from './media-path-policy';
import { parseMp3 } from './mp3-frames';
import { readWavInfo } from './wav-info';
import { ELEVENLABS_API } from './elevenlabs-voices';
import {
  buildEngineEnv,
  MIN_NODE_MAJOR,
  resolveNodeRuntime,
  videoEnginePaths,
} from '../video/video-engine';
import { ensureVideoEngine } from '../video/video-engine-install';
import { runOwnedProcess } from '../video/video-process';
import { probeMedia } from '../video/ffprobe';
import { SYNTHETIC_VOICE_LABEL, SYNTHETIC_VOICE_SOURCE_TYPE } from './voiceover';

/**
 * `nexus_voiceover_align` (F-1602, study §5.3 step 10): the person narrates
 * with their OWN recorded voice (no synthesis, no clone) and the Nexus lines
 * the script up with the audio, so captions and scene timing come from data
 * exactly as with a generated narration: the same `narration.timeline.json`,
 * `.srt` and `.vtt`, with the script's spelling.
 *
 * Two engines:
 * - `elevenlabs`: forced alignment (`POST /v1/forced-alignment`, the user's
 *   key, US$ 0.22 per hour of audio, priced before paying).
 * - `local`: Parakeet TDT 0.6B v3 through the pinned `hyperframes transcribe`,
 *   on this machine; the model (639 MB) is downloaded only with
 *   `allowModelDownload: true`, i.e. after the operator said yes.
 * Either way the recognized words only give the TIME; `alignScriptToSpeech`
 * keeps every script word. The voice is the person's: the timeline says
 * `origin: recorded` and the export burns no AI label for it.
 */

export const ALIGN_AUDIO_EXTENSIONS = ['.wav', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.flac', '.webm'] as const;
export const ALIGN_MAX_AUDIO_BYTES = 200 * 1024 * 1024;
export const ALIGN_MAX_SECONDS = 30 * 60;
/** Public API list price, 19/10/2026 (elevenlabs.io/pricing/api): same as Scribe, US$ 0.22 per hour. */
export const FORCED_ALIGNMENT_USD_PER_HOUR = 0.22;
export const PARAKEET_DOWNLOAD_MB = 639;
const LOW_MATCH = 0.7;

export type AlignEngine = 'elevenlabs' | 'local';

export interface AlignRequest {
  readonly audioPath: string;
  readonly script: string;
  readonly engine?: AlignEngine;
  /** ISO code for the recognizer (local engine); default pt. */
  readonly language?: string;
  readonly outDir?: string;
  readonly baseName?: string;
  readonly allowModelDownload?: boolean;
  readonly dryRun?: boolean;
  /**
   * F-1601: the audio is a SYNTHETIC narration the Nexus generated (Gemini TTS
   * gives no word times). The timeline then says so, exactly like
   * nexus_voiceover_generate, and the export labels and marks it.
   */
  readonly generated?: {
    readonly provider: string;
    readonly model: string;
    readonly voice: { readonly id: string; readonly name: string | null; readonly origin: string };
  };
  readonly baseDir: string;
  readonly scope: Readonly<ProjectExecutionScope>;
  readonly missionId?: string;
  readonly sessionId?: string;
  readonly signal?: AbortSignal;
  readonly assertCurrentAuthority?: () => void;
}

export interface AlignDeps {
  readonly fetchFn: typeof fetch;
  readonly getKey: (def: MediaProviderDef) => string | undefined;
  readonly userData: string;
  readonly manifestDir: string;
  readonly pathValue: string;
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly lookup: (command: string) => string | null;
  readonly acquirePermit: (request: HeavyCommandRequest) => Promise<HeavyCommandPermit>;
  readonly isHardened: () => boolean;
  readonly run?: typeof runOwnedProcess;
  readonly ensureEngine?: typeof ensureVideoEngine;
  readonly resolveNode?: typeof resolveNodeRuntime;
  readonly probe?: typeof probeMedia;
}

export interface AlignFiles {
  readonly audio: string;
  readonly timeline: string;
  readonly srt: string;
  readonly vtt: string;
}

export type AlignResult =
  | {
      readonly ok: true;
      readonly dryRun: boolean;
      readonly engine: AlignEngine;
      readonly durationSec: number;
      readonly estimatedCostUsd: number;
      readonly needsModelDownload?: boolean;
      readonly words?: number;
      readonly captions?: number;
      readonly matchedRatio?: number;
      readonly unmatchedWords?: number;
      readonly warnings?: readonly string[];
      readonly files?: AlignFiles;
    }
  | { readonly ok: false; readonly error: string; readonly needsModelDownload?: boolean; readonly log?: readonly string[] };

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveAudio(input: string, baseDir: string): string {
  const root = fs.realpathSync(path.resolve(baseDir));
  const candidate = path.isAbsolute(input) ? path.resolve(input) : path.resolve(root, input);
  let real: string;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    throw new Error(`áudio não existe: ${input}`);
  }
  if (!isInside(root, real)) throw new Error(`áudio fora do workspace: ${input}`);
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw new Error(`não é um arquivo: ${input}`);
  if (!(ALIGN_AUDIO_EXTENSIONS as readonly string[]).includes(path.extname(real).toLowerCase())) {
    throw new Error(`formato de áudio não aceito: use ${ALIGN_AUDIO_EXTENSIONS.join(', ')}`);
  }
  if (stat.size > ALIGN_MAX_AUDIO_BYTES) throw new Error('áudio grande demais (máx. 200 MB)');
  return real;
}

async function durationOf(file: string, deps: AlignDeps, env: Record<string, string>): Promise<number> {
  const ext = path.extname(file).toLowerCase();
  try {
    if (ext === '.wav') return readWavInfo(fs.readFileSync(file)).durationSec;
    if (ext === '.mp3') return parseMp3(fs.readFileSync(file)).durationMs / 1000;
  } catch {
    // fall through to ffprobe
  }
  const ffprobe = deps.lookup('ffprobe');
  if (!ffprobe) throw new Error('não consegui medir a duração do áudio: instale o ffmpeg (traz o ffprobe)');
  const probe = await (deps.probe ?? probeMedia)(ffprobe, file, env);
  if (!probe.durationSec) throw new Error('o áudio não tem duração legível');
  return probe.durationSec;
}

export function forcedAlignmentCostUsd(durationSec: number): number {
  return Number(((durationSec / 3600) * FORCED_ALIGNMENT_USD_PER_HOUR).toFixed(4));
}

function scriptWords(paragraphs: readonly string[]): string[] {
  return paragraphs.flatMap((paragraph) => paragraph.split(/\s+/u).filter(Boolean));
}

function parakeetInstalled(home: string): boolean {
  const dir = path.join(home, '.cache', 'hyperframes', 'parakeet');
  try {
    return fs.readdirSync(dir).some((name) => name.startsWith('parakeet-'));
  } catch {
    return false;
  }
}

async function elevenLabsWords(
  file: string,
  script: string,
  key: string,
  deps: AlignDeps,
  signal: AbortSignal | undefined,
): Promise<TimedWord[]> {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(file)]), path.basename(file));
  form.append('text', script);
  const response = await deps.fetchFn(`${ELEVENLABS_API}/v1/forced-alignment`, {
    method: 'POST',
    headers: { 'xi-api-key': key },
    body: form,
    signal,
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300).replace(/\s+/gu, ' ');
    if (response.status === 401) throw new Error('ElevenLabs recusou a chave (401): confira em Ajustes → Serviços de mídia');
    throw new Error(`ElevenLabs forced alignment falhou (HTTP ${response.status})${detail ? `: ${detail}` : ''}`);
  }
  const body = (await response.json()) as { words?: Array<{ text?: unknown; start?: unknown; end?: unknown }> };
  const words = (body.words ?? [])
    .filter((word) => typeof word.text === 'string' && word.text.trim() && typeof word.start === 'number' && typeof word.end === 'number')
    .map((word) => ({
      text: String(word.text).trim(),
      startMs: Math.round(Number(word.start) * 1000),
      endMs: Math.round(Number(word.end) * 1000),
    }));
  if (words.length === 0) throw new Error('a ElevenLabs não devolveu palavras alinhadas');
  return words;
}

async function localWords(
  req: AlignRequest,
  file: string,
  deps: AlignDeps,
): Promise<{ ok: true; words: TimedWord[] } | { ok: false; error: string; needsModelDownload?: boolean; log?: readonly string[] }> {
  const paths = videoEnginePaths(deps.userData);
  const env = buildEngineEnv({ base: deps.baseEnv, pathValue: deps.pathValue, home: paths.home });
  const node = await (deps.resolveNode ?? resolveNodeRuntime)({ nodeOnPath: deps.lookup('node'), env });
  if (!node || node.major < MIN_NODE_MAJOR) {
    return { ok: false, error: `O alinhamento local precisa do Node.js ${MIN_NODE_MAJOR} ou mais novo no PATH.` };
  }
  const run = deps.run ?? runOwnedProcess;
  fs.mkdirSync(paths.workDir, { recursive: true });
  fs.mkdirSync(paths.home, { recursive: true });
  const engine = await (deps.ensureEngine ?? ensureVideoEngine)({
    paths,
    manifestDir: deps.manifestDir,
    node,
    env,
    signal: req.signal,
  });
  if (!engine.ok) return { ok: false, error: engine.error };
  if (!parakeetInstalled(paths.home)) {
    const installed = await run({
      file: node.execPath,
      args: [paths.cliEntry, 'models', 'install', 'parakeet', '--json'],
      cwd: paths.workDir,
      env,
      signal: req.signal,
      timeoutMs: 20 * 60_000,
    });
    if (installed.aborted) return { ok: false, error: 'alinhamento cancelado' };
    if (installed.exitCode !== 0 || !parakeetInstalled(paths.home)) {
      return { ok: false, error: 'não consegui baixar o modelo Parakeet', log: installed.tail.slice(-8) };
    }
  }
  req.assertCurrentAuthority?.();
  // The CLI writes transcript.json into --dir: a private folder, never the project.
  const scratch = fs.mkdtempSync(path.join(paths.workDir, 'align-'));
  try {
    const result = await run({
      file: node.execPath,
      args: [paths.cliEntry, 'transcribe', file, '--engine=parakeet', `--language=${req.language ?? 'pt'}`, '--json', '-d', scratch],
      cwd: paths.workDir,
      env,
      signal: req.signal,
      timeoutMs: 15 * 60_000,
    });
    if (result.aborted) return { ok: false, error: 'alinhamento cancelado' };
    const transcript = path.join(scratch, 'transcript.json');
    if (result.exitCode !== 0 || !fs.existsSync(transcript)) {
      return { ok: false, error: 'o reconhecimento local falhou', log: result.tail.filter((line) => !line.includes('"type":"words"')).slice(-8) };
    }
    const raw = JSON.parse(fs.readFileSync(transcript, 'utf8')) as Array<{ text?: unknown; start?: unknown; end?: unknown }>;
    const words = raw
      .filter((word) => typeof word.text === 'string' && typeof word.start === 'number' && typeof word.end === 'number')
      .map((word) => ({ text: String(word.text), startMs: Math.round(Number(word.start) * 1000), endMs: Math.round(Number(word.end) * 1000) }));
    if (words.length === 0) return { ok: false, error: 'o reconhecimento não encontrou fala neste áudio' };
    return { ok: true, words };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

export async function alignVoiceover(req: AlignRequest, deps: AlignDeps): Promise<AlignResult> {
  req.assertCurrentAuthority?.();
  const paragraphs = splitParagraphs(req.script);
  if (paragraphs.length === 0) return { ok: false, error: 'roteiro vazio' };
  let audio: string;
  try {
    audio = resolveAudio(req.audioPath, req.baseDir);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  const def = findMediaProvider('elevenlabs');
  const key = def ? deps.getKey(def) : undefined;
  const engine: AlignEngine = req.engine ?? (key ? 'elevenlabs' : 'local');
  if (engine === 'local' && deps.isHardened()) {
    return { ok: false, error: 'Modo Hardened: o alinhamento local roda o motor de vídeo fora da sandbox do pane e fica desligado.' };
  }
  const env = buildEngineEnv({ base: deps.baseEnv, pathValue: deps.pathValue, home: videoEnginePaths(deps.userData).home });
  let durationSec: number;
  try {
    durationSec = await durationOf(audio, deps, env);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  if (durationSec > ALIGN_MAX_SECONDS) return { ok: false, error: 'áudio longo demais (máx. 30 min)' };
  const estimatedCostUsd = engine === 'elevenlabs' ? forcedAlignmentCostUsd(durationSec) : 0;
  const needsModelDownload =
    engine === 'local' && !parakeetInstalled(videoEnginePaths(deps.userData).home) ? true : undefined;

  const outDir = req.outDir?.trim() || path.relative(fs.realpathSync(req.baseDir), path.dirname(audio)) || '.';
  const baseName = req.baseName?.trim() || 'narration';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(baseName)) return { ok: false, error: 'baseName inválido' };
  const files: AlignFiles = {
    audio: resolveMediaOutputPath(path.join(outDir, `${baseName}${path.extname(audio).toLowerCase()}`), req.baseDir),
    timeline: resolveMediaOutputPath(path.join(outDir, `${baseName}.timeline.json`), req.baseDir),
    srt: resolveMediaOutputPath(path.join(outDir, `${baseName}.srt`), req.baseDir),
    vtt: resolveMediaOutputPath(path.join(outDir, `${baseName}.vtt`), req.baseDir),
  };

  if (req.dryRun) {
    return { ok: true, dryRun: true, engine, durationSec, estimatedCostUsd, ...(needsModelDownload ? { needsModelDownload } : {}) };
  }
  if (engine === 'elevenlabs' && !key) {
    return { ok: false, error: 'ElevenLabs sem chave: conecte em Ajustes → Serviços de mídia, ou use engine "local".' };
  }
  if (needsModelDownload && !req.allowModelDownload) {
    return {
      ok: false,
      needsModelDownload: true,
      error:
        `O alinhamento local baixa o modelo Parakeet (${PARAKEET_DOWNLOAD_MB} MB, uma vez). Peça o OK ao operador e chame ` +
        'de novo com allowModelDownload: true, ou use engine "elevenlabs" (US$ 0,22 por hora de áudio).',
    };
  }

  let spoken: TimedWord[];
  if (engine === 'elevenlabs') {
    try {
      spoken = await elevenLabsWords(audio, paragraphs.join('\n\n'), key!, deps, req.signal);
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  } else {
    let permit: HeavyCommandPermit;
    try {
      permit = await deps.acquirePermit({
        scope: req.scope,
        kind: 'build',
        label: 'hyperframes transcribe',
        missionId: req.missionId,
        sessionId: req.sessionId,
        signal: req.signal,
      });
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
    try {
      const local = await localWords(req, audio, deps);
      if (!local.ok) return local;
      spoken = local.words;
    } finally {
      permit.release();
    }
  }
  req.assertCurrentAuthority?.();

  const aligned = alignScriptToSpeech(scriptWords(paragraphs), spoken);
  const durationMs = Math.round(durationSec * 1000);
  const body = buildNarrationTimeline(paragraphs, aligned.words, durationMs);
  const cues = buildCaptionCues(body.words);
  const warnings: string[] = [];
  if (aligned.matchedRatio < LOW_MATCH) {
    warnings.push(
      `Só ${Math.round(aligned.matchedRatio * 100)}% das palavras do roteiro foram reconhecidas no áudio: confira se o áudio lê este roteiro.`,
    );
  }
  if (aligned.unmatched > 0) warnings.push(`${aligned.unmatched} palavra(s) do roteiro sem fala correspondente ganharam o tempo dos vizinhos.`);

  if (path.resolve(files.audio) !== path.resolve(audio)) {
    writeMediaOutput(files.audio, req.baseDir, fs.readFileSync(audio));
  }
  const relative = (to: string) => path.relative(path.dirname(files.timeline), to).split(path.sep).join('/');
  const alignment = {
    engine,
    model: engine === 'elevenlabs' ? 'forced-alignment' : 'parakeet-tdt-0.6b-v3',
    matchedRatio: Number(aligned.matchedRatio.toFixed(3)),
    unmatchedWords: aligned.unmatched,
  };
  const timeline = req.generated
    ? {
        version: 1,
        generator: 'nexus_voiceover_generate',
        audio: relative(files.audio),
        captions: { srt: relative(files.srt), vtt: relative(files.vtt) },
        provider: req.generated.provider,
        model: req.generated.model,
        voice: req.generated.voice,
        synthetic: { digitalSourceType: SYNTHETIC_VOICE_SOURCE_TYPE, label: SYNTHETIC_VOICE_LABEL },
        alignment,
        ...body,
      }
    : {
        version: 1,
        generator: 'nexus_voiceover_align',
        audio: relative(files.audio),
        captions: { srt: relative(files.srt), vtt: relative(files.vtt) },
        provider: engine === 'elevenlabs' ? 'elevenlabs' : 'local',
        model: alignment.model,
        voice: { id: null, name: null, origin: 'recorded' },
        alignment: { matchedRatio: alignment.matchedRatio, unmatchedWords: alignment.unmatchedWords },
        ...body,
      };
  writeMediaOutput(files.timeline, req.baseDir, Buffer.from(`${JSON.stringify(timeline, null, 2)}\n`, 'utf8'));
  writeMediaOutput(files.srt, req.baseDir, Buffer.from(cuesToSrt(cues), 'utf8'));
  writeMediaOutput(files.vtt, req.baseDir, Buffer.from(cuesToVtt(cues), 'utf8'));
  return {
    ok: true,
    dryRun: false,
    engine,
    durationSec,
    estimatedCostUsd,
    words: body.words.length,
    captions: cues.length,
    matchedRatio: Number(aligned.matchedRatio.toFixed(3)),
    unmatchedWords: aligned.unmatched,
    ...(warnings.length ? { warnings } : {}),
    files,
  };
}
