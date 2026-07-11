import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import type { VoiceConfig, VoicePlugin } from '../../shared/voice-config';
import type {
  TranscribeRequest,
  TranscribeResult,
  SttAttempt,
} from '../../shared/voice-ipc';
import { classifyKind, flattenChain, type ProviderProbes } from './provider-select';
import { resolveVoiceApiKey } from './voice-secrets';

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
  runLocal: (bin: string, args: string[]) => void | Promise<void>;
  readText: (file: string) => string;
  writeFile: (file: string, data: Buffer) => void;
  removeFile: (file: string) => void;
  fileExists: (file: string) => boolean;
  findBin: (candidates: string[]) => string | null;
  getEnv: (name: string) => string | undefined;
  /** Injectable clock for the wake-path budget (ITEM 7); defaults to Date.now. */
  now?: () => number;
}

/**
 * Deadlines duros da borda STT. Sem eles um socket pendurado (wifi caiu,
 * laptop acordou do sleep) segura o await do turno por minutos e a JARVIS
 * "morre" com busy travado — o sintoma nº 1 de "não responde".
 */
export const STT_CLOUD_TIMEOUT_MS = 12_000;
export const STT_LOCAL_TIMEOUT_MS = 30_000;
/**
 * ITEM 7 (STT stall bound on the WAKE path): 12s/cloud is too long for a
 * conversational wake turn — a hung Whisper cloud held the turn ~16s and the HUD
 * lapsed. On the wake path we tighten the per-cloud deadline AND cap the total
 * wall-clock: after one cloud attempt (or once the budget is spent) we jump
 * straight to keyless local whisper.cpp instead of burning a second cloud
 * round-trip. Logged as stt.stall so the stall is visible, never silent.
 */
export const STT_WAKE_CLOUD_TIMEOUT_MS = 6_000;
export const STT_WAKE_BUDGET_MS = 8_000;
/**
 * Passive wake is a recovery path for an acoustic-model miss, not a normal
 * command transcription. It must decide quickly or get out of the way so the
 * always-on acoustic detector can keep listening.
 */
export const STT_PASSIVE_WAKE_CLOUD_TIMEOUT_MS = 2_000;
const PASSIVE_WAKE_MIN_REMAINING_MS = 250;
const PASSIVE_WAKE_FAST_PROVIDER = 'groq';

function passiveWakeTranscriptionPrompt(wakeWord: string | undefined): string {
  const word = wakeWord?.trim().replace(/\s+/g, ' ').slice(0, 48) || 'Jarvis';
  return (
    'Português do Brasil. Frase curta de ativação de assistente. ' +
    `A palavra-chave é "${word}" (também: Ei ${word}, Oi ${word}, Hey ${word}, ` +
    `acorda ${word}, cheguei ${word}). ` +
    `Se ouvir algo parecido com ${word}/jarbas/javis/jarves, escreva exatamente "${word}". ` +
    'Não invente outras palavras. Transcreva só o que foi falado.'
  );
}

const defaultDeps: SttDeps = {
  fetchImpl: (...args) => fetch(...args),
  // Assíncrono + timeout: o whisper.cpp local levava SEGUNDOS rodando em
  // execFileSync, congelando o event loop do main (todo IPC parado).
  runLocal: (bin, args) =>
    new Promise<void>((resolve, reject) => {
      execFile(
        bin,
        args,
        { timeout: STT_LOCAL_TIMEOUT_MS, killSignal: 'SIGKILL' },
        (err) => (err ? reject(err) : resolve()),
      );
    }),
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
  getEnv: resolveVoiceApiKey,
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
  cloudTimeoutMs: number = STT_CLOUD_TIMEOUT_MS,
): Promise<Attempt> {
  const envVar = plugin.auth?.envVar;
  const authRequired = (plugin.auth?.type ?? 'api_key') !== 'none';
  const key = envVar ? deps.getEnv(envVar)?.trim() : undefined;
  if (authRequired && !key) {
    return { ok: false, needsKey: true, reason: `${envVar ?? 'API key'} not set` };
  }

  const translate = req.translate ?? plugin.translate ?? false;
  const endpoint = resolveEndpoint(plugin, translate);
  const audio = base64ToBuffer(req.audioBase64);

  // Groq's /audio/translations endpoint rejects the turbo model (400) — only
  // whisper-large-v3 supports translation. Swap it transparently when the
  // request is a translate call.
  let model = plugin.model ?? 'whisper-large-v3-turbo';
  if (translate && model === 'whisper-large-v3-turbo') {
    model = 'whisper-large-v3';
  }

  const form = new FormData();
  form.append('model', model);
  form.append('response_format', 'json');
  if (req.purpose === 'passive-wake') {
    // Whisper-compatible APIs use this as vocabulary bias; it improves a
    // two-word wake without changing the user's normal STT configuration.
    form.append('prompt', passiveWakeTranscriptionPrompt(req.passiveWakeWord));
  }
  const language = req.language ?? plugin.language;
  if (!translate && language) form.append('language', language);
  const ext = req.mime === 'audio/webm' ? 'webm' : 'wav';
  form.append('file', new Blob([new Uint8Array(audio)], { type: req.mime }), `audio.${ext}`);

  let res: Response;
  try {
    res = await deps.fetchImpl(endpoint, {
      method: 'POST',
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      body: form,
      // Deadline duro: requisição pendurada nunca pode segurar o turno. Na wake
      // path este teto é apertado (STT_WAKE_CLOUD_TIMEOUT_MS) para o turno de
      // conversa não pendurar 12s+ num provider cloud lento.
      signal: AbortSignal.timeout(cloudTimeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      return {
        ok: false,
        needsKey: false,
        reason: `timeout (${(cloudTimeoutMs / 1000).toFixed(1)}s sem resposta)`,
      };
    }
    // Network failure (offline, DNS, TLS) — treat as unavailable, fall through.
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, needsKey: false, reason: `network error (${message})` };
  }

  if (!res.ok) {
    const { reason, needsKey } = describeHttpFailure(res.status);
    // Surface the provider's own message — a bare "error (400)" is undebuggable.
    const body = await res.text().catch(() => '');
    const detail = body.replace(/\s+/g, ' ').trim().slice(0, 160);
    return {
      ok: false,
      needsKey,
      reason: detail ? `${reason}: ${detail}` : reason,
    };
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
    // GUI-launched Electron apps do not reliably inherit the user's shell PATH.
    // Probe common Homebrew locations explicitly before falling back to `which`.
    '/opt/homebrew/bin/whisper-cli',
    '/usr/local/bin/whisper-cli',
    '/opt/homebrew/bin/whisper-cpp',
    '/usr/local/bin/whisper-cpp',
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

async function attemptLocal(
  plugin: VoicePlugin,
  req: TranscribeRequest,
  deps: SttDeps,
): Promise<Attempt> {
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
    const translate = req.translate ?? plugin.translate ?? false;
    const language = req.language ?? plugin.language ?? plugin.translateFrom;
    if (language) args.push('-l', language);
    if (translate) args.push('-tr');
    await deps.runLocal(bin, args);
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
  cloudTimeoutMs?: number,
): Promise<Attempt> {
  return classifyKind(plugin) === 'cloud'
    ? attemptCloud(plugin, req, deps, cloudTimeoutMs)
    : attemptLocal(plugin, req, deps);
}

/**
 * Groq's Whisper Turbo is normally the shortest cloud hop for a tiny PT-BR
 * wake sample. This reorders only the ephemeral passive-wake request; it
 * never changes the user's persisted STT preference for normal commands.
 */
function prioritizePassiveWakeChain(chain: readonly VoicePlugin[]): VoicePlugin[] {
  return [
    ...chain.filter((plugin) => plugin.provider === PASSIVE_WAKE_FAST_PROVIDER),
    ...chain.filter((plugin) => plugin.provider !== PASSIVE_WAKE_FAST_PROVIDER),
  ];
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
  const passiveWake = req.purpose === 'passive-wake';
  const chain = passiveWake
    ? prioritizePassiveWakeChain(flattenChain(config.stt))
    : flattenChain(config.stt);
  const attempts: SttAttempt[] = [];
  let anyNeedsKey = false;

  // ITEM 7: wake-path budget. When set, the cloud chain is bounded — one cloud
  // attempt on a tight deadline, then straight to keyless local whisper.cpp.
  const budgetMs = req.budgetMs;
  const now = deps.now ?? Date.now;
  const tStart = now();
  let cloudTried = false;
  let stalled = false;

  for (const plugin of chain) {
    const isCloud = classifyKind(plugin) === 'cloud';
    // Local whisper is a useful durable fallback for a normal command, but it
    // can take many seconds to load/infer. A passive wake must never surface
    // 14 seconds late and steal the next user turn, so only bounded clouds
    // participate here.
    if (passiveWake && !isCloud) {
      attempts.push({
        provider: plugin.provider,
        reason: 'passive wake skips local fallback to keep wake realtime',
      });
      continue;
    }
    let cloudTimeoutMs: number | undefined;
    if (budgetMs !== undefined && isCloud) {
      const remaining = budgetMs - (now() - tStart);
      if (passiveWake) {
        if (remaining <= PASSIVE_WAKE_MIN_REMAINING_MS) {
          stalled = true;
          attempts.push({
            provider: plugin.provider,
            reason: `passive wake budget ${budgetMs}ms spent`,
          });
          break;
        }
        cloudTimeoutMs = Math.min(STT_PASSIVE_WAKE_CLOUD_TIMEOUT_MS, remaining);
      } else {
      // No time (or budget) left for a second cloud round-trip → skip to local.
        if (cloudTried || remaining <= 1_000) {
          stalled = true;
          attempts.push({
            provider: plugin.provider,
            reason: cloudTried
              ? 'wake budget: 1 cloud tried, skipped to local'
              : `wake budget ${budgetMs}ms spent, skipped to local`,
          });
          continue;
        }
        cloudTimeoutMs = Math.min(STT_WAKE_CLOUD_TIMEOUT_MS, remaining);
      }
    } else if (passiveWake && isCloud) {
      cloudTimeoutMs = STT_PASSIVE_WAKE_CLOUD_TIMEOUT_MS;
    }

    const outcome = await attemptProvider(plugin, req, deps, cloudTimeoutMs);
    if (isCloud) cloudTried = true;
    if (outcome.ok) {
      const note =
        attempts.length > 0
          ? `${attempts.map((a) => `${a.provider} ${a.reason}`).join('; ')} → ${plugin.provider}`
          : undefined;
      return {
        ok: true,
        text: outcome.text,
        provider: plugin.provider,
        fallbackNote: note,
        attempts,
        ...(stalled ? { stalled: true } : {}),
      };
    }
    anyNeedsKey = anyNeedsKey || outcome.needsKey;
    attempts.push({ provider: plugin.provider, reason: outcome.reason });
  }

  const tried = attempts.map((a) => `${a.provider}: ${a.reason}`).join(' · ');
  const recoveryHint = passiveWake
    ? 'Passive wake ended before a realtime STT provider confirmed the name. The acoustic wake detector remains active.'
    : 'Set GROQ_API_KEY or OPENAI_API_KEY, or install whisper.cpp for a keyless local fallback.';
  return {
    ok: false,
    needsKey: anyNeedsKey,
    attempts,
    ...(stalled ? { stalled: true } : {}),
    error:
      `No speech-to-text provider succeeded. Tried — ${tried}. ` +
      recoveryHint,
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
