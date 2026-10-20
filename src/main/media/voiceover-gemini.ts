import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { splitParagraphs } from '../../shared/captions';
import { findMediaProvider } from './media-providers';
import { resolveMediaOutputPath, writeMediaOutput } from './media-path-policy';
import {
  alignVoiceover,
  forcedAlignmentCostUsd,
  PARAKEET_DOWNLOAD_MB,
  type AlignDeps,
  type AlignEngine,
  type AlignFiles,
} from './voiceover-align';
import {
  GEMINI_PREBUILT_VOICES,
  GEMINI_TTS_MAX_CHARS,
  GEMINI_TTS_MODEL,
  geminiTts,
  geminiTtsCostUsd,
  isGeminiReplicatedVoiceId,
  isGeminiVoice,
  PT_CHARS_PER_SECOND,
} from './voice-providers/gemini-voice';
import { concat, decodeWav, durationSec, encodeWav } from './wav-pcm';
import { videoEnginePaths } from '../video/video-engine';
import type { ProjectExecutionScope } from '../../shared/types';

/**
 * Narration with a Gemini voice (F-1601): a library voice (Kore, Charon…) or
 * the operator's replicated voice (`voice_…`, made in Minha voz). The Gemini
 * TTS gives no word times, so the narration is synthesized per paragraph
 * (cached by text, voice and model: re-running the same script pays nothing),
 * joined into one WAV, and timed by the alignment of F-1602 — the same
 * `narration.timeline.json`, `.srt` and `.vtt` as an ElevenLabs narration,
 * marked as synthetic for the export.
 */

const PARAGRAPH_GAP_MS = 250;
const MAX_CACHE_FILES = 400;
export const GEMINI_VOICEOVER_MAX_CHARS = 20_000;

export interface GeminiVoiceoverRequest {
  readonly script: string;
  readonly voice: string;
  readonly style?: string;
  readonly outDir?: string;
  readonly baseName?: string;
  readonly alignEngine?: AlignEngine;
  readonly allowModelDownload?: boolean;
  readonly dryRun?: boolean;
  readonly baseDir: string;
  readonly scope: Readonly<ProjectExecutionScope>;
  readonly missionId?: string;
  readonly sessionId?: string;
  readonly signal?: AbortSignal;
  readonly assertCurrentAuthority?: () => void;
}

export interface GeminiVoiceoverDeps extends AlignDeps {
  readonly cacheDir: string | null;
  readonly now: () => Date;
  readonly isNexusClone: (voiceId: string) => boolean;
}

export type GeminiVoiceoverResult =
  | {
      readonly ok: true;
      readonly dryRun: boolean;
      readonly provider: 'gemini';
      readonly model: string;
      readonly voiceId: string;
      readonly voice: { readonly name: string | null; readonly origin: string };
      readonly chars: number;
      readonly chunks: number;
      readonly cachedChunks: number;
      /** TTS (what this call synthesizes) plus the alignment. */
      readonly estimatedCostUsd: number;
      readonly alignEngine: AlignEngine;
      readonly needsModelDownload?: boolean;
      readonly durationMs?: number;
      readonly words?: number;
      readonly captions?: number;
      readonly matchedRatio?: number;
      readonly warnings?: readonly string[];
      readonly files?: AlignFiles;
    }
  | { readonly ok: false; readonly error: string; readonly needsModelDownload?: boolean };

/** Paragraphs, split further at sentence ends when one is longer than the model input. */
export function geminiChunks(paragraphs: readonly string[], max = GEMINI_TTS_MAX_CHARS): string[] {
  const chunks: string[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length <= max) {
      chunks.push(paragraph);
      continue;
    }
    let current = '';
    for (const sentence of paragraph.match(/[^.!?…]+[.!?…]*\s*/gu) ?? [paragraph]) {
      if (current && current.length + sentence.length > max) {
        chunks.push(current.trim());
        current = '';
      }
      current += sentence;
    }
    if (current.trim()) chunks.push(current.trim());
  }
  return chunks;
}

function cacheKey(text: string, voice: string, style: string | undefined): string {
  return createHash('sha256').update(JSON.stringify(['gemini', GEMINI_TTS_MODEL, voice, style ?? '', text])).digest('hex');
}

function cached(cacheDir: string | null, key: string): Buffer | null {
  if (!cacheDir) return null;
  try {
    return fs.readFileSync(path.join(cacheDir, `gemini-${key}.wav`));
  } catch {
    return null;
  }
}

function store(cacheDir: string | null, key: string, wav: Buffer): void {
  if (!cacheDir) return;
  try {
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(cacheDir, `gemini-${key}.wav`), wav, { mode: 0o600 });
    const files = fs
      .readdirSync(cacheDir)
      .filter((name) => name.startsWith('gemini-'))
      .map((name) => ({ name, at: fs.statSync(path.join(cacheDir, name)).mtimeMs }))
      .sort((left, right) => left.at - right.at);
    for (const old of files.slice(0, Math.max(0, files.length - MAX_CACHE_FILES))) {
      fs.rmSync(path.join(cacheDir, old.name), { force: true });
    }
  } catch {
    // The cache only saves money; a failing cache never fails the narration.
  }
}

function geminiKey(deps: AlignDeps): string | undefined {
  const def = findMediaProvider('google-image');
  return def ? deps.getKey(def) : undefined;
}

function parakeetReady(home: string): boolean {
  try {
    return fs.readdirSync(path.join(home, '.cache', 'hyperframes', 'parakeet')).some((name) => name.startsWith('parakeet-'));
  } catch {
    return false;
  }
}

export async function generateGeminiVoiceover(
  req: GeminiVoiceoverRequest,
  deps: GeminiVoiceoverDeps,
): Promise<GeminiVoiceoverResult> {
  req.assertCurrentAuthority?.();
  const voice = req.voice.trim();
  if (!isGeminiVoice(voice)) {
    return {
      ok: false,
      error: `voz do Gemini desconhecida: ${voice}. Use uma voz de nexus_voice_list (biblioteca: ${GEMINI_PREBUILT_VOICES.slice(0, 4).join(', ')}…, ou a sua voz_…).`,
    };
  }
  const paragraphs = splitParagraphs(req.script);
  const chars = paragraphs.reduce((total, paragraph) => total + paragraph.length, 0);
  if (chars === 0) return { ok: false, error: 'roteiro vazio' };
  if (chars > GEMINI_VOICEOVER_MAX_CHARS) {
    return { ok: false, error: `roteiro com ${chars} caracteres; o limite por narração é ${GEMINI_VOICEOVER_MAX_CHARS}` };
  }
  const chunks = geminiChunks(paragraphs);
  const keys = chunks.map((chunk) => cacheKey(chunk, voice, req.style));
  const cachedChunks = keys.filter((key) => cached(deps.cacheDir, key) !== null).length;
  const uncachedChars = chunks.reduce((total, chunk, index) => total + (cached(deps.cacheDir, keys[index]) ? 0 : chunk.length), 0);
  const elevenKey = (() => {
    const def = findMediaProvider('elevenlabs');
    return def ? deps.getKey(def) : undefined;
  })();
  const home = videoEnginePaths(deps.userData).home;
  const alignEngine: AlignEngine = req.alignEngine ?? (parakeetReady(home) || !elevenKey ? 'local' : 'elevenlabs');
  const estimatedSeconds = chars / PT_CHARS_PER_SECOND;
  const ttsUsd = geminiTtsCostUsd(uncachedChars / PT_CHARS_PER_SECOND, deps.now());
  const alignUsd = alignEngine === 'elevenlabs' ? forcedAlignmentCostUsd(estimatedSeconds) : 0;
  const origin = isGeminiReplicatedVoiceId(voice) ? (deps.isNexusClone(voice) ? 'nexus-clone' : 'external-clone') : 'library';
  const needsModelDownload = alignEngine === 'local' && !parakeetReady(home) ? true : undefined;
  const base = {
    ok: true as const,
    provider: 'gemini' as const,
    model: GEMINI_TTS_MODEL,
    voiceId: voice,
    voice: { name: isGeminiReplicatedVoiceId(voice) ? null : voice, origin },
    chars,
    chunks: chunks.length,
    cachedChunks,
    alignEngine,
  };
  if (req.dryRun) {
    return {
      ...base,
      dryRun: true,
      estimatedCostUsd: Number((ttsUsd + alignUsd).toFixed(4)),
      ...(needsModelDownload ? { needsModelDownload } : {}),
    };
  }
  if (needsModelDownload && !req.allowModelDownload) {
    return {
      ok: false,
      needsModelDownload: true,
      error:
        `Os tempos da narração do Gemini saem do alinhamento local, que baixa o modelo Parakeet (${PARAKEET_DOWNLOAD_MB} MB, uma vez). ` +
        'Peça o OK ao operador e chame de novo com allowModelDownload: true, ou use alignEngine "elevenlabs".',
    };
  }
  const key = geminiKey(deps);
  if (!key) return { ok: false, error: 'Gemini sem chave: conecte o Google (Gemini) em Ajustes → Serviços de mídia.' };

  const outDir = req.outDir?.trim() || 'narration';
  const baseName = req.baseName?.trim() || 'narration';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(baseName)) return { ok: false, error: 'baseName inválido' };
  const audioPath = resolveMediaOutputPath(path.join(outDir, `${baseName}.wav`), req.baseDir);

  let paidSeconds = 0;
  const clips = [];
  for (const [index, chunk] of chunks.entries()) {
    req.assertCurrentAuthority?.();
    if (req.signal?.aborted) return { ok: false, error: 'narração cancelada' };
    let wav = cached(deps.cacheDir, keys[index]);
    if (!wav) {
      try {
        wav = await geminiTts({ key, fetchFn: deps.fetchFn, signal: req.signal, text: chunk, voice, style: req.style });
      } catch (error) {
        return { ok: false, error: (error as Error).message };
      }
      store(deps.cacheDir, keys[index], wav);
      paidSeconds += durationSec(decodeWav(wav));
    }
    clips.push(decodeWav(wav));
  }
  const joined = concat(clips, PARAGRAPH_GAP_MS);
  writeMediaOutput(audioPath, req.baseDir, encodeWav(joined.pcm));

  const aligned = await alignVoiceover(
    {
      audioPath,
      script: paragraphs.join('\n\n'),
      engine: alignEngine,
      outDir,
      baseName,
      allowModelDownload: req.allowModelDownload,
      baseDir: req.baseDir,
      scope: req.scope,
      missionId: req.missionId,
      sessionId: req.sessionId,
      signal: req.signal,
      assertCurrentAuthority: req.assertCurrentAuthority,
      generated: { provider: 'gemini', model: GEMINI_TTS_MODEL, voice: { id: voice, ...base.voice } },
    },
    deps,
  );
  if (!aligned.ok) return { ok: false, error: `narração gerada em ${path.basename(audioPath)}, mas o alinhamento falhou: ${aligned.error}`, ...(aligned.needsModelDownload ? { needsModelDownload: true } : {}) };
  return {
    ...base,
    dryRun: false,
    estimatedCostUsd: Number((geminiTtsCostUsd(paidSeconds, deps.now()) + aligned.estimatedCostUsd).toFixed(4)),
    durationMs: Math.round(aligned.durationSec * 1000),
    words: aligned.words,
    captions: aligned.captions,
    matchedRatio: aligned.matchedRatio,
    ...(aligned.warnings ? { warnings: aligned.warnings } : {}),
    files: aligned.files,
  };
}
