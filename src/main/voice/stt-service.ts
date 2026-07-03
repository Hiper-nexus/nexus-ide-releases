import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { VoiceConfig, VoicePlugin } from '../../shared/voice-config';
import type {
  TranscribeRequest,
  TranscribeResult,
  SttAttempt,
} from '../../shared/voice-ipc';
import { classifyKind, flattenChain, type ProviderProbes } from './provider-select';

/**
 * Speech-to-text with resilient, error-driven fallback. Walks the whole STT
 * chain (Groq → OpenAI → whisper.cpp local) and moves to the NEXT provider not
 * only when a key is missing, but whenever a cloud provider is throttled or
 * failing — HTTP 429 (rate limit), 401/402/403 (auth/billing/quota), 5xx, or a
 * network error. On a free-tier Groq account that regularly 429s, transcription
 * still succeeds via OpenAI or the keyless local whisper.cpp.
 *
 * API keys are read from process.env HERE (main only). Network + subprocess
 * boundaries are injected via `deps` for unit tests.
 */

export interface SttDeps {
  fetchImpl: typeof fetch;
  /** Runs the local whisper binary over a wav file, returns transcript text. */
  runLocal: (bin: string, args: string[]) => void;
  readText: (file: string) => string;
  writeFile: (file: string, data: Buffer) => void;
  removeFile: (file: string) => void;
  fileExists: (file: string) => boolean;
  findBin: (candidates: string[]) => string | null;
  getEnv: (name: string) => string | undefined;
}

const defaultDeps: SttDeps = {
  fetchImpl: (...args) => fetch(...args),
  runLocal: (bin, args) => {
    execFileSync(bin, args, { stdio: 'pipe' });
  },
  readText: (file) => fs.readFileSync(file, 'utf-8'),
  writeFile: (file, data) => fs.writeFileSync(file, data),
  removeFile: (file) => {
    try {
      fs.unlinkSync(file);
    } catch {
      /* best-effort */
    }
  },
  fileExists: (file) => fs.existsSync(file),
  findBin: findBinDefault,
  getEnv: (name) => process.env[name],
};

// ── Outcome of a single provider attempt ─────────────────────────────────────

type Attempt =
  | { ok: true; text: string }
  | { ok: false; reason: string; needsKey: boolean };

/**
 * OpenAI/Groq whisper translate lives at `/audio/translations` (always → English),
 * transcribe at `/audio/transcriptions`. Swap the path when translating so the
 * config can carry a single canonical endpoint.
 */
export function resolveEndpoint(plugin: VoicePlugin, translate: boolean): string {
  const base = plugin.endpoint ?? 'https://api.groq.com/openai/v1/audio/transcriptions';
  if (translate && base.endsWith('/audio/transcriptions')) {
    return base.replace(/\/audio\/transcriptions$/, '/audio/translations');
  }
  return base;
}

/**
 * Classify a cloud STT HTTP status. Rate limit, auth, billing/quota, and server
 * errors all mean "this provider is unusable right now → fall through". Anything
 * else (e.g. a 400 malformed request) is also non-fatal for the chain — we still
 * try the next provider — but we tag it distinctly for the final message.
 */
export function describeHttpFailure(status: number): { reason: string; needsKey: boolean } {
  if (status === 429) return { reason: 'throttled (429 rate limit)', needsKey: false };
  if (status === 402) return { reason: 'quota/billing (402)', needsKey: false };
  if (status === 403) return { reason: 'forbidden/quota (403)', needsKey: false };
  if (status === 401) return { reason: 'invalid key (401)', needsKey: true };
  if (status >= 500) return { reason: `server error (${status})`, needsKey: false };
  return { reason: `error (${status})`, needsKey: false };
}

function base64ToBuffer(b64: string): Buffer {
  return Buffer.from(b64, 'base64');
}

async function attemptCloud(
  plugin: VoicePlugin,
  req: TranscribeRequest,
  deps: SttDeps,
): Promise<Attempt> {
  const envVar = plugin.auth?.envVar;
  const authRequired = (plugin.auth?.type ?? 'api_key') !== 'none';
  const key = envVar ? deps.getEnv(envVar)?.trim() : undefined;
  if (authRequired && !key) {
    return { ok: false, needsKey: true, reason: `${envVar ?? 'API key'} not set` };
  }

  const translate = plugin.translate ?? false;
  const endpoint = resolveEndpoint(plugin, translate);
  const audio = base64ToBuffer(req.audioBase64);

  const form = new FormData();
  form.append('model', plugin.model ?? 'whisper-large-v3-turbo');
  form.append('response_format', 'json');
  if (!translate && plugin.language) form.append('language', plugin.language);
  const ext = req.mime === 'audio/webm' ? 'webm' : 'wav';
  form.append('file', new Blob([new Uint8Array(audio)], { type: req.mime }), `audio.${ext}`);

  let res: Response;
  try {
    res = await deps.fetchImpl(endpoint, {
      method: 'POST',
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      body: form,
    });
  } catch (err) {
    // Network failure (offline, DNS, TLS) — treat as unavailable, fall through.
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, needsKey: false, reason: `network error (${message})` };
  }

  if (!res.ok) {
    const { reason, needsKey } = describeHttpFailure(res.status);
    return { ok: false, needsKey, reason };
  }
  const json = (await res.json().catch(() => ({}))) as { text?: string };
  const text = (json.text ?? '').trim();
  if (!text) return { ok: false, needsKey: false, reason: 'empty transcript' };
  return { ok: true, text };
}

// ── Local whisper.cpp (keyless, offline, no rate limit) ──────────────────────

/** Candidate binary names/paths for whisper.cpp, in preference order. */
function whisperBinCandidates(plugin: VoicePlugin): string[] {
  const nexusBin = path.join(os.homedir(), '.nexus', 'bin');
  return [
    plugin.localBin,
    'whisper-cli',
    'whisper-cpp',
    'main',
    path.join(nexusBin, 'whisper-cli'),
    path.join(nexusBin, 'main'),
  ].filter((c): c is string => typeof c === 'string' && c.length > 0);
}

/** Candidate ggml model files, in preference order. */
function whisperModelCandidates(plugin: VoicePlugin): string[] {
  const dir = path.join(os.homedir(), '.nexus', 'models', 'whisper');
  const named = plugin.model && !plugin.model.includes('/') ? `ggml-${plugin.model}.bin` : null;
  return [
    plugin.modelPath,
    named ? path.join(dir, named) : null,
    path.join(dir, 'ggml-base.bin'),
    path.join(dir, 'ggml-small.bin'),
    path.join(dir, 'ggml-base.en.bin'),
  ].filter((c): c is string => typeof c === 'string' && c.length > 0);
}

const WHISPER_INSTALL_HINT =
  'install whisper.cpp (brew install whisper-cpp) and a model ' +
  '(~/.nexus/models/whisper/ggml-base.bin)';

function attemptLocal(plugin: VoicePlugin, req: TranscribeRequest, deps: SttDeps): Attempt {
  const bin = deps.findBin(whisperBinCandidates(plugin));
  if (!bin) {
    return { ok: false, needsKey: false, reason: `whisper.cpp not found — ${WHISPER_INSTALL_HINT}` };
  }
  const model = whisperModelCandidates(plugin).find((m) => deps.fileExists(m)) ?? null;
  if (!model) {
    return { ok: false, needsKey: false, reason: `whisper model missing — ${WHISPER_INSTALL_HINT}` };
  }

  const wav = path.join(os.tmpdir(), `nexus-stt-${Date.now()}.wav`);
  const txt = `${wav}.txt`;
  try {
    deps.writeFile(wav, base64ToBuffer(req.audioBase64));
    const args = ['-f', wav, '-m', model, '-otxt', '-nt'];
    if (plugin.translate ?? false) args.push('-tr');
    deps.runLocal(bin, args);
    const text = deps.readText(txt).trim();
    if (!text) return { ok: false, needsKey: false, reason: 'local whisper returned empty text' };
    return { ok: true, text };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, needsKey: false, reason: `local whisper failed (${message})` };
  } finally {
    deps.removeFile(wav);
    deps.removeFile(txt);
  }
}

async function attemptProvider(
  plugin: VoicePlugin,
  req: TranscribeRequest,
  deps: SttDeps,
): Promise<Attempt> {
  return classifyKind(plugin) === 'cloud'
    ? attemptCloud(plugin, req, deps)
    : attemptLocal(plugin, req, deps);
}

/**
 * Walk the STT chain, returning the first success. Every failure (missing key,
 * throttle, quota, server error, missing local binary) is recorded and the loop
 * continues to the next provider, so no single provider's failure aborts the
 * transcription while a fallback remains.
 */
export async function transcribe(
  req: TranscribeRequest,
  config: VoiceConfig,
  _probes: ProviderProbes,
  deps: SttDeps = defaultDeps,
): Promise<TranscribeResult> {
  const chain = flattenChain(config.stt);
  const attempts: SttAttempt[] = [];
  let anyNeedsKey = false;

  for (const plugin of chain) {
    const outcome = await attemptProvider(plugin, req, deps);
    if (outcome.ok) {
      const note =
        attempts.length > 0
          ? `${attempts.map((a) => `${a.provider} ${a.reason}`).join('; ')} → ${plugin.provider}`
          : undefined;
      return { ok: true, text: outcome.text, provider: plugin.provider, fallbackNote: note, attempts };
    }
    anyNeedsKey = anyNeedsKey || outcome.needsKey;
    attempts.push({ provider: plugin.provider, reason: outcome.reason });
  }

  const tried = attempts.map((a) => `${a.provider}: ${a.reason}`).join(' · ');
  return {
    ok: false,
    needsKey: anyNeedsKey,
    attempts,
    error:
      `No speech-to-text provider succeeded. Tried — ${tried}. ` +
      'Set GROQ_API_KEY or OPENAI_API_KEY, or install whisper.cpp for a keyless local fallback.',
  };
}

// ── default bin finder ───────────────────────────────────────────────────────

function findBinDefault(candidates: string[]): string | null {
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate)) {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        continue;
      }
    }
    try {
      execFileSync(lookup, [candidate], { stdio: 'pipe' });
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}
