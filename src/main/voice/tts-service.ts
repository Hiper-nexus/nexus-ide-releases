import { spawn, execFileSync } from 'node:child_process';
import type { VoiceConfig, VoicePlugin } from '../../shared/voice-config';
import type { SpeakRequest, SpeakResult } from '../../shared/voice-ipc';
import { toSpeakable } from './speakable';
import { selectPlugin, classifyKind, type ProviderProbes } from './provider-select';

/**
 * Text-to-speech — the Jarvis "talk back" step. Condenses the agent's output to
 * a speakable summary, then routes it through the TTS fallback chain:
 *   OpenAI tts-1 (cloud, returns audio bytes → renderer plays)
 *   → Piper (local, returns wav bytes)
 *   → macOS `say` (system, plays directly on the main process — always available).
 *
 * `say` needs no key and no install, so the pipeline can always speak. Network /
 * subprocess boundaries are injected via `deps` for testability.
 */

const SAY_BIN = '/usr/bin/say';

export interface TtsDeps {
  fetchImpl: typeof fetch;
  /** Speak text via macOS `say`; resolves when playback finishes. */
  speakViaSay: (text: string, voice?: string) => Promise<void>;
  /** Run Piper over text, return wav bytes. */
  runPiper: (plugin: VoicePlugin, text: string) => Buffer;
  getEnv: (name: string) => string | undefined;
}

const defaultDeps: TtsDeps = {
  fetchImpl: (...args) => fetch(...args),
  speakViaSay,
  runPiper: runPiperLocal,
  getEnv: (name) => process.env[name],
};

/**
 * Speak via macOS `say`. Text is passed as a single argv arg (no shell), so
 * user/agent content can never be interpreted as a command. Resolves on exit.
 */
export function speakViaSay(text: string, voice?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = voice ? ['-v', voice, text] : [text];
    const proc = spawn(SAY_BIN, args, { stdio: 'ignore' });
    proc.on('error', reject);
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`say exited ${code}`)),
    );
  });
}

function runPiperLocal(plugin: VoicePlugin, text: string): Buffer {
  const bin = plugin.localBin ?? 'piper';
  const args: string[] = ['--output_file', '-'];
  if (plugin.modelPath) args.push('--model', plugin.modelPath);
  return execFileSync(bin, args, { input: text, maxBuffer: 64 * 1024 * 1024 });
}

async function speakCloud(
  plugin: VoicePlugin,
  text: string,
  deps: TtsDeps,
): Promise<SpeakResult> {
  const envVar = plugin.auth?.envVar;
  const key = envVar ? deps.getEnv(envVar)?.trim() : undefined;
  if ((plugin.auth?.type ?? 'api_key') !== 'none' && !key) {
    return { ok: false, error: `${plugin.provider} needs ${envVar ?? 'an API key'}` };
  }
  const endpoint = plugin.endpoint ?? 'https://api.openai.com/v1/audio/speech';
  const format = plugin.format ?? 'mp3';
  const res = await deps.fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({
      model: plugin.model ?? 'tts-1',
      voice: plugin.voice ?? 'onyx',
      input: text,
      response_format: format,
      speed: plugin.speed ?? 1.0,
    }),
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.text()).slice(0, 400);
    } catch {
      // ignore
    }
    return { ok: false, error: `TTS ${res.status}: ${detail}` };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    ok: true,
    provider: plugin.provider,
    mode: 'audio',
    format,
    audioBase64: buf.toString('base64'),
  };
}

async function speakLocalOrSystem(
  plugin: VoicePlugin,
  text: string,
  deps: TtsDeps,
): Promise<SpeakResult> {
  if (plugin.provider === 'macos-say') {
    try {
      await deps.speakViaSay(text, plugin.voice);
      return { ok: true, provider: plugin.provider, mode: 'played' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `say failed: ${message}` };
    }
  }
  // Piper (local): produce wav bytes for the renderer to play.
  try {
    const wav = deps.runPiper(plugin, text);
    return {
      ok: true,
      provider: plugin.provider,
      mode: 'audio',
      format: 'wav',
      audioBase64: wav.toString('base64'),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `piper failed: ${message}` };
  }
}

/** Speak a request against the configured TTS chain. */
export async function speak(
  req: SpeakRequest,
  config: VoiceConfig,
  probes: ProviderProbes,
  deps: TtsDeps = defaultDeps,
): Promise<SpeakResult> {
  const mode = req.speakMode ?? config.speakMode;
  const text = toSpeakable(req.text, mode);
  if (!text) return { ok: true, provider: '-', mode: 'silent' };

  const plugin = selectPlugin(config.tts, probes);
  if (!plugin) {
    return { ok: false, error: 'No text-to-speech provider available.' };
  }
  const kind = classifyKind(plugin);
  if (kind === 'cloud') return speakCloud(plugin, text, deps);
  return speakLocalOrSystem(plugin, text, deps);
}
