import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildCaptionCues,
  buildNarrationTimeline,
  cuesToSrt,
  cuesToVtt,
  splitParagraphs,
  wordsFromAlignment,
  type CharacterAlignment,
  type TimedWord,
} from '../../shared/captions';
import {
  findMediaProvider,
  resolveMediaModel,
  type MediaProviderDef,
} from './media-providers';
import { resolveMediaOutputPath, writeMediaOutput } from './media-path-policy';
import { joinMp3, parseMp3, type Mp3Audio } from './mp3-frames';
import {
  ELEVENLABS_API,
  getElevenLabsVoice,
  type VoiceOrigin,
} from './elevenlabs-voices';
import { isNexusClonedVoice } from './voice-origin';

/**
 * Narration with timing (F-1591). The script is spoken by ElevenLabs
 * `/with-timestamps`, which returns the audio AND the start/end of every
 * character. The Nexus writes four files the video composition reads:
 * `<name>.mp3`, `<name>.timeline.json` (words, sentences, paragraphs in ms),
 * `<name>.srt` and `<name>.vtt`. Scene timing comes from this file, never
 * from the model (study 2026-10-19, §1.1 and §5.2.5).
 *
 * Cost control: `dryRun` prices the call without paying, and every chunk is
 * cached by (text, voice, model, settings) in the Main-owned cache, so asking
 * for the same narration again, or after editing one paragraph, pays only for
 * what changed.
 */

export const VOICEOVER_MAX_CHARS = 20_000;
/** One request per paragraph; a longer paragraph is split by sentence. */
const CHUNK_MAX_CHARS = 2_500;
const OUTPUT_FORMAT = 'mp3_44100_128';
const MAX_CHUNK_AUDIO_BYTES = 40 * 1024 * 1024;
const CACHE_SCHEMA = 1;
const CACHE_MAX_ENTRIES = 400;
const BASE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/u;
export const SYNTHETIC_VOICE_SOURCE_TYPE =
  'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia';
export const SYNTHETIC_VOICE_LABEL = 'Narração com voz gerada por IA';

export interface VoiceSettingsInput {
  readonly stability?: number;
  readonly similarityBoost?: number;
  readonly style?: number;
  readonly speed?: number;
}

export interface VoiceoverRequest {
  readonly script: string;
  readonly voiceId?: string;
  readonly model?: string;
  /** Folder inside the workspace (default `narration`). */
  readonly outDir?: string;
  /** File stem (default `narration`): lowercase letters, digits, `-` and `_`. */
  readonly baseName?: string;
  readonly languageCode?: string;
  readonly voiceSettings?: VoiceSettingsInput;
  readonly dryRun?: boolean;
  readonly baseDir: string;
  readonly signal?: AbortSignal;
  readonly assertCurrentAuthority?: () => void;
}

export interface VoiceoverDeps {
  fetchFn: typeof fetch;
  getKey(def: MediaProviderDef): string | undefined;
  /** Main-owned chunk cache; null disables caching (tests, no userData). */
  cacheDir: string | null;
  isNexusClone(voiceId: string): boolean;
}

export interface VoiceoverFiles {
  readonly audio: string;
  readonly timeline: string;
  readonly srt: string;
  readonly vtt: string;
}

export interface VoiceoverResult {
  readonly ok: true;
  readonly dryRun: boolean;
  readonly provider: 'elevenlabs';
  readonly model: string;
  readonly voiceId: string | null;
  readonly voice?: { readonly name: string | null; readonly origin: VoiceOrigin };
  readonly chars: number;
  readonly chunks: number;
  readonly cachedChunks: number;
  /** What THIS call pays: zero when every chunk came from the cache. */
  readonly estimatedCostUsd: number | null;
  readonly durationMs?: number;
  readonly words?: number;
  readonly captions?: number;
  readonly files?: VoiceoverFiles;
}

export class VoiceoverAbortError extends Error {
  constructor() {
    super('narração cancelada');
    this.name = 'VoiceoverAbortError';
  }
}

function assertCurrent(req: VoiceoverRequest): void {
  req.assertCurrentAuthority?.();
  if (req.signal?.aborted) throw new VoiceoverAbortError();
}

/** Split one paragraph into pieces of at most `max` chars: sentences first, then words. */
export function splitLongParagraph(paragraph: string, max = CHUNK_MAX_CHARS): string[] {
  if (paragraph.length <= max) return [paragraph];
  const sentences = paragraph.match(/[^.!?…]+[.!?…]+["'”’»)\]]*\s*|[^.!?…]+$/gu) ?? [paragraph];
  const pieces: string[] = [];
  let current = '';
  const push = (value: string) => {
    const trimmed = value.trim();
    if (trimmed) pieces.push(trimmed);
  };
  for (const sentence of sentences) {
    if (sentence.length > max) {
      push(current);
      current = '';
      let words = '';
      for (const word of sentence.split(/\s+/u)) {
        if (words && words.length + 1 + word.length > max) {
          push(words);
          words = '';
        }
        words = words ? `${words} ${word}` : word;
      }
      push(words);
      continue;
    }
    if (current && current.length + sentence.length > max) {
      push(current);
      current = '';
    }
    current += sentence;
  }
  push(current);
  return pieces;
}

export function planVoiceoverChunks(script: string): { paragraphs: string[]; chunks: string[] } {
  const paragraphs = splitParagraphs(script);
  return { paragraphs, chunks: paragraphs.flatMap((paragraph) => splitLongParagraph(paragraph)) };
}

function voiceSettingsBody(settings: VoiceSettingsInput | undefined): Record<string, number> | undefined {
  if (!settings) return undefined;
  const body: Record<string, number> = {};
  const unit = (value: number | undefined, key: string, field: string) => {
    if (value === undefined) return;
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`voiceSettings.${key} precisa estar entre 0 e 1`);
    }
    body[field] = value;
  };
  unit(settings.stability, 'stability', 'stability');
  unit(settings.similarityBoost, 'similarityBoost', 'similarity_boost');
  unit(settings.style, 'style', 'style');
  if (settings.speed !== undefined) {
    if (!Number.isFinite(settings.speed) || settings.speed < 0.7 || settings.speed > 1.2) {
      throw new Error('voiceSettings.speed precisa estar entre 0.7 e 1.2');
    }
    body.speed = settings.speed;
  }
  return Object.keys(body).length > 0 ? body : undefined;
}

export function voiceoverChunkKey(input: {
  text: string;
  voiceId: string;
  model: string;
  settings?: Record<string, number>;
  languageCode?: string;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        CACHE_SCHEMA,
        OUTPUT_FORMAT,
        input.model,
        input.voiceId,
        input.settings ?? null,
        input.languageCode ?? null,
        input.text,
      ]),
    )
    .digest('hex');
}

interface CachedChunk {
  readonly audio: Buffer;
  readonly alignment: CharacterAlignment;
}

function isAlignment(value: unknown): value is CharacterAlignment {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    Array.isArray(record.characters) &&
    Array.isArray(record.character_start_times_seconds) &&
    Array.isArray(record.character_end_times_seconds)
  );
}

function readCachedChunk(cacheDir: string | null, key: string): CachedChunk | null {
  if (!cacheDir) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(cacheDir, `${key}.json`), 'utf8')) as {
      schema?: unknown;
      alignment?: unknown;
    };
    if (meta.schema !== CACHE_SCHEMA || !isAlignment(meta.alignment)) return null;
    const audio = fs.readFileSync(path.join(cacheDir, `${key}.mp3`));
    return audio.length > 0 ? { audio, alignment: meta.alignment } : null;
  } catch {
    return null;
  }
}

function writePrivateAtomic(file: string, data: Buffer | string): void {
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, data, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function writeCachedChunk(
  cacheDir: string | null,
  key: string,
  voiceId: string,
  chunk: CachedChunk,
): void {
  if (!cacheDir) return;
  try {
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    // Audio first: a meta file without its audio would be a miss anyway.
    writePrivateAtomic(path.join(cacheDir, `${key}.mp3`), chunk.audio);
    writePrivateAtomic(
      path.join(cacheDir, `${key}.json`),
      JSON.stringify({ schema: CACHE_SCHEMA, voiceId, alignment: chunk.alignment }),
    );
    pruneVoiceoverCache(cacheDir);
  } catch {
    // Cache is an optimization: a failed write only costs a future request.
  }
}

/** Keep the newest entries; an entry is its `.json` + `.mp3` pair. */
export function pruneVoiceoverCache(cacheDir: string, maxEntries = CACHE_MAX_ENTRIES): void {
  const metas = fs
    .readdirSync(cacheDir)
    .filter((name) => /^[0-9a-f]{64}\.json$/u.test(name))
    .map((name) => ({ name, mtime: fs.statSync(path.join(cacheDir, name)).mtimeMs }))
    .sort((left, right) => right.mtime - left.mtime);
  for (const stale of metas.slice(maxEntries)) {
    const stem = stale.name.slice(0, -'.json'.length);
    fs.rmSync(path.join(cacheDir, `${stem}.json`), { force: true });
    fs.rmSync(path.join(cacheDir, `${stem}.mp3`), { force: true });
  }
}

/** Delete every cached chunk spoken by `voiceId` (called when the user deletes a cloned voice). */
export function purgeVoiceoverCacheForVoice(cacheDir: string, voiceId: string): number {
  let removed = 0;
  let names: string[];
  try {
    names = fs.readdirSync(cacheDir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!/^[0-9a-f]{64}\.json$/u.test(name)) continue;
    const meta = path.join(cacheDir, name);
    try {
      const parsed = JSON.parse(fs.readFileSync(meta, 'utf8')) as { voiceId?: unknown };
      if (parsed.voiceId !== voiceId) continue;
    } catch {
      continue;
    }
    const stem = name.slice(0, -'.json'.length);
    fs.rmSync(meta, { force: true });
    fs.rmSync(path.join(cacheDir, `${stem}.mp3`), { force: true });
    removed += 1;
  }
  return removed;
}

async function providerError(res: Response, model: string): Promise<Error> {
  let message = '';
  try {
    const body = (await res.json()) as { detail?: unknown };
    const detail = body.detail;
    if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
      const raw = (detail as { message?: unknown }).message;
      if (typeof raw === 'string') message = raw;
    } else if (Array.isArray(detail) && detail[0] && typeof detail[0] === 'object') {
      const raw = (detail[0] as { msg?: unknown }).msg;
      if (typeof raw === 'string') message = raw;
    }
  } catch {
    // corpo ilegível
  }
  message = message.replace(/[\u0000-\u001f]+/gu, ' ').slice(0, 240);
  if (res.status === 401) {
    return new Error('A ElevenLabs recusou a chave (HTTP 401). Confira a chave em Ajustes → Serviços de mídia.');
  }
  if (res.status === 404) {
    return new Error('A ElevenLabs não achou essa voz na conta (HTTP 404). Liste as vozes com nexus_voice_list.');
  }
  return new Error(
    `A ElevenLabs recusou a narração com ${model} (HTTP ${res.status})${message ? `: ${message}` : ''}`,
  );
}

async function synthesizeChunk(input: {
  key: string;
  voiceId: string;
  model: string;
  text: string;
  previousText?: string;
  nextText?: string;
  settings?: Record<string, number>;
  languageCode?: string;
  req: VoiceoverRequest;
  deps: VoiceoverDeps;
}): Promise<CachedChunk> {
  const url = new URL(
    `/v1/text-to-speech/${encodeURIComponent(input.voiceId)}/with-timestamps`,
    ELEVENLABS_API,
  );
  url.searchParams.set('output_format', OUTPUT_FORMAT);
  const body: Record<string, unknown> = { text: input.text, model_id: input.model };
  if (input.previousText) body.previous_text = input.previousText;
  if (input.nextText) body.next_text = input.nextText;
  if (input.settings) body.voice_settings = input.settings;
  if (input.languageCode) body.language_code = input.languageCode;
  assertCurrent(input.req);
  const res = await input.deps.fetchFn(url, {
    method: 'POST',
    headers: { 'xi-api-key': input.key, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: input.req.signal,
  });
  assertCurrent(input.req);
  if (!res.ok) throw await providerError(res, input.model);
  const json = (await res.json()) as { audio_base64?: unknown; alignment?: unknown };
  if (!isAlignment(json.alignment)) {
    throw new Error(
      `O modelo ${input.model} não devolveu o tempo de cada caractere. ` +
        'Use eleven_multilingual_v2 para narração com legenda.',
    );
  }
  if (typeof json.audio_base64 !== 'string' || json.audio_base64.length === 0) {
    throw new Error('A ElevenLabs devolveu a narração sem áudio.');
  }
  const audio = Buffer.from(json.audio_base64, 'base64');
  if (audio.length === 0 || audio.length > MAX_CHUNK_AUDIO_BYTES) {
    throw new Error('Áudio da narração vazio ou grande demais.');
  }
  return { audio, alignment: json.alignment };
}

function costOf(def: MediaProviderDef, model: string, chars: number): number | null {
  return chars === 0 ? 0 : def.estimateCost({ model, chars });
}

function relativeForFile(from: string, to: string): string {
  return path.relative(path.dirname(from), to).split(path.sep).join('/');
}

export async function generateVoiceover(
  req: VoiceoverRequest,
  deps: VoiceoverDeps = defaultVoiceoverDeps(),
): Promise<VoiceoverResult> {
  assertCurrent(req);
  const def = findMediaProvider('elevenlabs');
  if (!def) throw new Error('provedor elevenlabs ausente');
  const model = resolveMediaModel(def, req.model);
  const script = req.script.replace(/^﻿/u, '');
  const { paragraphs, chunks } = planVoiceoverChunks(script);
  const chars = chunks.reduce((total, chunk) => total + chunk.length, 0);
  if (chars === 0) throw new Error('roteiro vazio');
  if (chars > VOICEOVER_MAX_CHARS) {
    throw new Error(`roteiro com ${chars} caracteres; o limite por narração é ${VOICEOVER_MAX_CHARS}`);
  }
  const baseName = req.baseName ?? 'narration';
  if (!BASE_NAME_RE.test(baseName)) {
    throw new Error('baseName aceita só letras minúsculas, números, - e _ (até 48)');
  }
  const settings = voiceSettingsBody(req.voiceSettings);
  const languageCode = req.languageCode?.trim() || undefined;
  if (languageCode && !/^[a-z]{2,3}$/u.test(languageCode)) {
    throw new Error('languageCode precisa ser um código ISO 639-1, como "pt"');
  }
  const voiceId = req.voiceId?.trim() || null;
  if (voiceId !== null && !/^[A-Za-z0-9_-]{1,64}$/u.test(voiceId)) {
    throw new Error('voiceId inválido');
  }
  const keys = voiceId
    ? chunks.map((text) => voiceoverChunkKey({ text, voiceId, model, settings, languageCode }))
    : [];
  const cached = keys.map((key) => readCachedChunk(deps.cacheDir, key));
  const cachedChunks = cached.filter(Boolean).length;
  const uncachedChars = voiceId
    ? chunks.reduce((total, chunk, index) => total + (cached[index] ? 0 : chunk.length), 0)
    : chars;

  // Paths are validated before any money is spent.
  const outDir = req.outDir?.trim() || 'narration';
  const files: VoiceoverFiles = {
    audio: resolveMediaOutputPath(path.join(outDir, `${baseName}.mp3`), req.baseDir),
    timeline: resolveMediaOutputPath(path.join(outDir, `${baseName}.timeline.json`), req.baseDir),
    srt: resolveMediaOutputPath(path.join(outDir, `${baseName}.srt`), req.baseDir),
    vtt: resolveMediaOutputPath(path.join(outDir, `${baseName}.vtt`), req.baseDir),
  };

  if (req.dryRun) {
    return {
      ok: true,
      dryRun: true,
      provider: 'elevenlabs',
      model,
      voiceId,
      chars,
      chunks: chunks.length,
      cachedChunks,
      estimatedCostUsd: costOf(def, model, uncachedChars),
    };
  }
  if (!voiceId) {
    throw new Error('voiceId é obrigatório: liste as vozes com nexus_voice_list e use a que o operador indicou');
  }
  const key = deps.getKey(def);
  if (!key) {
    throw new Error('ElevenLabs sem chave — configure em Ajustes → Serviços de mídia');
  }

  const spoken: CachedChunk[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const hit = cached[index];
    if (hit) {
      spoken.push(hit);
      continue;
    }
    const chunk = await synthesizeChunk({
      key,
      voiceId,
      model,
      text: chunks[index],
      previousText: chunks[index - 1],
      nextText: chunks[index + 1],
      settings,
      languageCode,
      req,
      deps,
    });
    writeCachedChunk(deps.cacheDir, keys[index], voiceId, chunk);
    spoken.push(chunk);
  }

  const parsed: Mp3Audio[] = spoken.map((chunk) => parseMp3(chunk.audio));
  const joined = joinMp3(parsed);
  const timed: TimedWord[] = spoken.flatMap((chunk, index) =>
    wordsFromAlignment(chunk.alignment, joined.startsMs[index] + parsed[index].leadingMs),
  );
  const body = buildNarrationTimeline(paragraphs, timed, joined.durationMs);
  const cues = buildCaptionCues(body.words);

  let voice: { name: string | null; origin: VoiceOrigin } = { name: null, origin: 'unknown' };
  try {
    const info = await getElevenLabsVoice({
      key,
      voiceId,
      fetchFn: deps.fetchFn,
      isNexusClone: deps.isNexusClone,
      signal: req.signal,
    });
    if (info) voice = { name: info.name, origin: info.origin };
  } catch {
    // Unknown origin is safe: the export labels an unknown voice as synthetic.
  }
  assertCurrent(req);

  const timeline = {
    version: 1,
    generator: 'nexus_voiceover_generate',
    audio: relativeForFile(files.timeline, files.audio),
    captions: {
      srt: relativeForFile(files.timeline, files.srt),
      vtt: relativeForFile(files.timeline, files.vtt),
    },
    provider: 'elevenlabs',
    model,
    voice: { id: voiceId, ...voice },
    synthetic: {
      digitalSourceType: SYNTHETIC_VOICE_SOURCE_TYPE,
      label: SYNTHETIC_VOICE_LABEL,
    },
    ...body,
  };
  writeMediaOutput(files.audio, req.baseDir, joined.frames);
  writeMediaOutput(files.timeline, req.baseDir, Buffer.from(`${JSON.stringify(timeline, null, 2)}\n`, 'utf8'));
  writeMediaOutput(files.srt, req.baseDir, Buffer.from(cuesToSrt(cues), 'utf8'));
  writeMediaOutput(files.vtt, req.baseDir, Buffer.from(cuesToVtt(cues), 'utf8'));

  return {
    ok: true,
    dryRun: false,
    provider: 'elevenlabs',
    model,
    voiceId,
    voice,
    chars,
    chunks: chunks.length,
    cachedChunks,
    estimatedCostUsd: costOf(def, model, uncachedChars),
    durationMs: body.durationMs,
    words: body.words.length,
    captions: cues.length,
    files,
  };
}

function defaultVoiceoverDeps(): VoiceoverDeps {
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- media-keys arrasta o cofre (Electron); o teste importa este módulo sem ele
  const { resolveMediaKey } = require('./media-keys') as typeof import('./media-keys');
  let cacheDir: string | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- sem Electron (teste) o cache fica desligado
    const { app } = require('electron') as typeof import('electron');
    cacheDir = path.join(app.getPath('userData'), 'media', 'voiceover-cache');
  } catch {
    cacheDir = null;
  }
  return {
    fetchFn: fetch,
    getKey: (def) => resolveMediaKey(def),
    cacheDir,
    isNexusClone: isNexusClonedVoice,
  };
}
