import path from 'node:path';
import { findMediaProvider, type MediaProviderDef } from './media-providers';
import { resolveMediaOutputPath, writeMediaOutput } from './media-path-policy';
import { ELEVENLABS_API } from './elevenlabs-voices';

/**
 * Background music for presentation videos (F-1592), Eleven Music
 * (`POST /v1/music`) with the user's own ElevenLabs key. Instrumental by
 * default, MP3 signed with C2PA by the provider (`sign_with_c2pa`), and a
 * provenance file next to the track so the export can label it.
 *
 * Kept out of media-generation.ts on purpose: that file is being reworked on
 * another branch (feat/model-compare-media) and this feature only needs the
 * shared key lookup.
 */

export const MUSIC_MODELS = ['music_v2_5', 'music_v2', 'music_v1'] as const;
export type MusicModel = (typeof MUSIC_MODELS)[number];
/** Newest first: the operator's rule is the newest model of the line. */
export const DEFAULT_MUSIC_MODEL: MusicModel = 'music_v2_5';
export const MUSIC_MIN_MS = 3_000;
export const MUSIC_MAX_MS = 600_000;
/** Public API list price, 19/10/2026 (elevenlabs.io/pricing/api): US$ 0.15 per minute. */
const MUSIC_USD_PER_MINUTE = 0.15;
const OUTPUT_FORMAT = 'mp3_44100_128';
const MAX_MUSIC_BYTES = 64 * 1024 * 1024;

export const MUSIC_LICENSE_NOTICE =
  'Eleven Music: vídeo comercial online só com plano pago; nos planos Starter a Pro a licença é ' +
  'individual, empresa com 10 pessoas ou mais precisa do Scale/Business/Enterprise. Nada de nome ' +
  'de artista no prompt nem de montar biblioteca de faixas para terceiros. ' +
  'Termos: https://elevenlabs.io/music-terms';

export interface MusicRequest {
  readonly prompt: string;
  readonly lengthMs: number;
  /** Default true: background music under narration. */
  readonly instrumental?: boolean;
  readonly model?: string;
  /** Workspace path of the mp3 (default `music/music-<timestamp>.mp3`). */
  readonly outPath?: string;
  readonly dryRun?: boolean;
  readonly baseDir: string;
  readonly signal?: AbortSignal;
  readonly assertCurrentAuthority?: () => void;
}

export interface MusicDeps {
  fetchFn: typeof fetch;
  getKey(def: MediaProviderDef): string | undefined;
  now(): number;
}

export type MusicResult =
  | {
      readonly ok: true;
      readonly dryRun: boolean;
      readonly provider: 'elevenlabs';
      readonly model: MusicModel;
      readonly lengthMs: number;
      readonly instrumental: boolean;
      readonly estimatedCostUsd: number;
      readonly path?: string;
      readonly provenancePath?: string;
      readonly songId?: string;
      readonly license: string;
    }
  | {
      readonly ok: false;
      readonly error: string;
      /** ElevenLabs' own rewrite when the prompt names an artist or copyrighted work. */
      readonly promptSuggestion?: string;
    };

export class MusicAbortError extends Error {
  constructor() {
    super('música cancelada');
    this.name = 'MusicAbortError';
  }
}

function assertCurrent(req: MusicRequest): void {
  req.assertCurrentAuthority?.();
  if (req.signal?.aborted) throw new MusicAbortError();
}

export function musicCostUsd(lengthMs: number): number {
  return Number(((lengthMs / 60_000) * MUSIC_USD_PER_MINUTE).toFixed(4));
}

function resolveMusicModel(requested: string | undefined): MusicModel {
  if (!requested) return DEFAULT_MUSIC_MODEL;
  const trimmed = requested.trim();
  if ((MUSIC_MODELS as readonly string[]).includes(trimmed)) return trimmed as MusicModel;
  throw new Error(`modelo de música ${requested} não habilitado (disponíveis: ${MUSIC_MODELS.join(', ')})`);
}

function clean(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim();
  return text ? text.slice(0, max) : undefined;
}

/** Read the provider refusal; `bad_prompt` carries a suggested prompt. */
async function musicFailure(res: Response): Promise<{ error: string; promptSuggestion?: string }> {
  let status: string | undefined;
  let message: string | undefined;
  let suggestion: string | undefined;
  try {
    const body = (await res.json()) as { detail?: unknown };
    const detail = body.detail;
    if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
      const record = detail as Record<string, unknown>;
      status = clean(record.status, 40);
      message = clean(record.message, 240);
      const data = record.data;
      if (data && typeof data === 'object') {
        suggestion = clean((data as Record<string, unknown>).prompt_suggestion, 1_000);
      }
    } else if (Array.isArray(detail) && detail[0] && typeof detail[0] === 'object') {
      message = clean((detail[0] as Record<string, unknown>).msg, 240);
    }
  } catch {
    // corpo ilegível
  }
  if (res.status === 401) {
    return { error: 'A ElevenLabs recusou a chave (HTTP 401). Confira a chave em Ajustes → Serviços de mídia.' };
  }
  if (status === 'bad_prompt') {
    return {
      error:
        'A ElevenLabs recusou o prompt porque ele cita artista, música ou letra protegida. ' +
        'Descreva gênero, época, instrumentos, andamento e clima.' +
        (suggestion ? ' Ela sugeriu um prompt (promptSuggestion); mostre ao operador antes de usar.' : ''),
      ...(suggestion ? { promptSuggestion: suggestion } : {}),
    };
  }
  return {
    error: `A ElevenLabs recusou a música (HTTP ${res.status})${message ? `: ${message}` : ''}`,
  };
}

export async function generateMusic(
  req: MusicRequest,
  deps: MusicDeps = defaultMusicDeps(),
): Promise<MusicResult> {
  assertCurrent(req);
  const prompt = req.prompt.trim();
  if (!prompt) throw new Error('prompt vazio');
  if (prompt.length > 2_000) throw new Error('prompt de música com mais de 2.000 caracteres');
  if (!Number.isInteger(req.lengthMs) || req.lengthMs < MUSIC_MIN_MS || req.lengthMs > MUSIC_MAX_MS) {
    throw new Error(`lengthMs precisa ser inteiro entre ${MUSIC_MIN_MS} e ${MUSIC_MAX_MS}`);
  }
  const model = resolveMusicModel(req.model);
  const instrumental = req.instrumental !== false;
  const outPath = resolveMediaOutputPath(
    req.outPath ?? path.join('music', `music-${deps.now()}.mp3`),
    req.baseDir,
  );
  if (path.extname(outPath).toLowerCase() !== '.mp3') throw new Error('outPath da música precisa terminar em .mp3');
  const provenancePath = resolveMediaOutputPath(
    outPath.replace(/\.mp3$/iu, '.provenance.json'),
    req.baseDir,
  );
  const estimatedCostUsd = musicCostUsd(req.lengthMs);
  const base = {
    ok: true as const,
    provider: 'elevenlabs' as const,
    model,
    lengthMs: req.lengthMs,
    instrumental,
    estimatedCostUsd,
    license: MUSIC_LICENSE_NOTICE,
  };
  if (req.dryRun) return { ...base, dryRun: true };

  const def = findMediaProvider('elevenlabs');
  const key = def ? deps.getKey(def) : undefined;
  if (!key) throw new Error('ElevenLabs sem chave — configure em Ajustes → Serviços de mídia');

  const url = new URL('/v1/music', ELEVENLABS_API);
  url.searchParams.set('output_format', OUTPUT_FORMAT);
  assertCurrent(req);
  const res = await deps.fetchFn(url, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt,
      music_length_ms: req.lengthMs,
      model_id: model,
      force_instrumental: instrumental,
      // The provider signs the MP3 with a C2PA manifest (AI Act art. 50(2)).
      sign_with_c2pa: true,
    }),
    signal: req.signal,
  });
  assertCurrent(req);
  if (!res.ok) return { ok: false, ...(await musicFailure(res)) };
  const audio = Buffer.from(await res.arrayBuffer());
  assertCurrent(req);
  if (audio.length === 0 || audio.length > MAX_MUSIC_BYTES) {
    throw new Error('A ElevenLabs devolveu a música vazia ou grande demais.');
  }
  const songId = clean(res.headers.get('song-id') ?? res.headers.get('x-song-id'), 80);
  writeMediaOutput(outPath, req.baseDir, audio);
  writeMediaOutput(
    provenancePath,
    req.baseDir,
    Buffer.from(
      `${JSON.stringify(
        {
          version: 1,
          generator: 'nexus_music_generate',
          kind: 'music',
          audio: path.basename(outPath),
          provider: 'elevenlabs',
          model,
          lengthMs: req.lengthMs,
          instrumental,
          c2paSignedByProvider: true,
          digitalSourceType: 'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia',
          ...(songId ? { songId } : {}),
        },
        null,
        2,
      )}\n`,
      'utf8',
    ),
  );
  return { ...base, dryRun: false, path: outPath, provenancePath, ...(songId ? { songId } : {}) };
}

function defaultMusicDeps(): MusicDeps {
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- media-keys arrasta o cofre (Electron); o teste importa este módulo sem ele
  const { resolveMediaKey } = require('./media-keys') as typeof import('./media-keys');
  return { fetchFn: fetch, getKey: (def) => resolveMediaKey(def), now: Date.now };
}
