import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  VoiceConfig,
  VoicePersona,
  VoicePlugin,
} from '../../shared/voice-config';
import type { SpeakRequest, SpeakResult } from '../../shared/voice-ipc';
import { toSpeakable } from './speakable';
import { echoSuppressor } from './echo-suppress';
import { classifyKind, flattenChain, type ProviderProbes } from './provider-select';
import { resolveVoiceApiKey } from './voice-secrets';
import { logVoice } from './voice-log';
import { getRuntimeOutputDeviceId } from './audio-output-runtime';

/**
 * Text-to-speech — the Jarvis "talk back" step. Condenses the agent's output to
 * a speakable summary, then routes it through the TTS fallback chain:
 *   OpenAI tts-1 (cloud, returns audio bytes → renderer plays)
 *   → Piper (local, returns wav bytes)
 *   → macOS `say` (system, plays directly on the main process — always available).
 *
 * Fallback is error-driven, mirroring the STT chain: we don't just pick the first
 * available link, we walk the whole chain and move to the NEXT provider whenever
 * one fails at runtime — a throttled/quota'd/failing cloud provider (429, 401/402/
 * 403, 5xx, network error) or a broken local binary. That preserves the core
 * guarantee: because the chain ends in keyless `say`, the pipeline can always
 * speak even when the cloud provider is strangled. Network / subprocess
 * boundaries are injected via `deps` for testability.
 */

const SAY_BIN = '/usr/bin/say';

/** Provedor TTS que funcionou por último — evita trocar de voz no meio da conversa. */
let stickyTtsProvider: string | null = null;
let stickyTtsPinnedAt = 0;

/**
 * Fallback de voz não pode virar permanente: se a OpenAI falhar uma vez por
 * quota/rede, seguramos a mesma voz por alguns turnos, mas tentamos voltar para
 * a voz principal logo depois. Isso preserva estabilidade sem "prender" a
 * Jarvis no `say`/Piper até reiniciar o app.
 */
export const TTS_STICKY_FALLBACK_RETRY_MS = 60_000;

function reorderTtsChain(chain: VoicePlugin[]): VoicePlugin[] {
  if (!stickyTtsProvider) return chain;
  const configuredHeadProvider = chain[0]?.provider;
  const isPinnedFallback = stickyTtsProvider !== configuredHeadProvider;
  const pinAgeMs = Date.now() - stickyTtsPinnedAt;
  if (isPinnedFallback && pinAgeMs >= TTS_STICKY_FALLBACK_RETRY_MS) {
    stickyTtsProvider = null;
    stickyTtsPinnedAt = 0;
    return chain;
  }
  const hit = chain.find((p) => p.provider === stickyTtsProvider);
  if (!hit) return chain;
  if (chain[0]?.provider === stickyTtsProvider) return chain;
  return [hit, ...chain.filter((p) => p.provider !== stickyTtsProvider)];
}

/** Testes: limpa voz sticky entre casos. */
export function resetStickyTtsProvider(): void {
  stickyTtsProvider = null;
  stickyTtsPinnedAt = 0;
}

/**
 * Deadlines duros da borda TTS: um POST pendurado ou um piper travado nunca
 * podem segurar o turno de voz (busy preso = "JARVIS morreu").
 */
export const TTS_CLOUD_TIMEOUT_MS = 15_000;
export const TTS_LOCAL_TIMEOUT_MS = 20_000;

export interface TtsDeps {
  fetchImpl: typeof fetch;
  /** Speak text via macOS `say`; resolves when playback finishes. */
  speakViaSay: (text: string, voice?: string) => Promise<void>;
  /** Render macOS `say` to AIFF so the renderer can route it to a sink. */
  renderViaSay?: (text: string, voice?: string) => Promise<Buffer>;
  getOutputDeviceId?: () => string;
  /** Run Piper over text, return wav bytes. */
  runPiper: (plugin: VoicePlugin, text: string) => Buffer | Promise<Buffer>;
  getEnv: (name: string) => string | undefined;
}

const defaultDeps: TtsDeps = {
  fetchImpl: (...args) => fetch(...args),
  speakViaSay,
  renderViaSay,
  getOutputDeviceId: getRuntimeOutputDeviceId,
  runPiper: runPiperLocal,
  getEnv: resolveVoiceApiKey,
};

// O `say` toca DIRETO no main (mode 'played') — sem uma referência viva ao
// processo, o barge-in do renderer não tem como calar a voz do fallback.
let activeSay: ChildProcess | null = null;

/** Mata a fala em andamento do fallback `say` (barge-in / nova fala). */
export function stopSystemSpeech(): void {
  if (activeSay) {
    try {
      activeSay.kill('SIGKILL');
    } catch {
      // já morreu
    }
    activeSay = null;
  }
}

/**
 * Speak via macOS `say`. Text is passed as a single argv arg (no shell), so
 * user/agent content can never be interpreted as a command. Resolves on exit.
 */
export function speakViaSay(text: string, voice?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stopSystemSpeech(); // uma voz por vez — nunca duas falas sobrepostas
    const args = voice ? ['-v', voice, text] : [text];
    const proc = spawn(SAY_BIN, args, { stdio: 'ignore' });
    activeSay = proc;
    const clear = () => {
      if (activeSay === proc) activeSay = null;
    };
    proc.on('error', (err) => {
      clear();
      reject(err);
    });
    proc.on('close', (code, signal) => {
      clear();
      // Morto pelo barge-in (SIGKILL) conta como fala concluída, não erro.
      if (code === 0 || signal) resolve();
      else reject(new Error(`say exited ${code}`));
    });
  });
}

/** Render keyless macOS speech without playing it in the main process. */
export async function renderViaSay(text: string, voice?: string): Promise<Buffer> {
  const outputFile = path.join(
    os.tmpdir(),
    `nexus-say-${randomUUID()}.aiff`,
  );
  try {
    await new Promise<void>((resolve, reject) => {
      stopSystemSpeech();
      const args = [
        ...(voice ? ['-v', voice] : []),
        '-o',
        outputFile,
        text,
      ];
      const proc = spawn(SAY_BIN, args, { stdio: 'ignore' });
      activeSay = proc;
      const clear = () => {
        if (activeSay === proc) activeSay = null;
      };
      proc.on('error', (error) => {
        clear();
        reject(error);
      });
      proc.on('close', (code, signal) => {
        clear();
        if (code === 0) resolve();
        else if (signal) reject(new Error('say interrupted'));
        else reject(new Error(`say exited ${code}`));
      });
    });
    return await readFile(outputFile);
  } finally {
    await unlink(outputFile).catch(() => {});
  }
}

function runPiperLocal(plugin: VoicePlugin, text: string): Promise<Buffer> {
  // Assíncrono + deadline: o execFileSync antigo congelava o event loop do
  // main durante a síntese inteira (todo o IPC do app parado).
  return new Promise<Buffer>((resolve, reject) => {
    const bin = plugin.localBin ?? 'piper';
    const args: string[] = ['--output_file', '-'];
    if (plugin.modelPath) args.push('--model', plugin.modelPath);
    const proc = spawn(bin, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        // já morreu
      }
      reject(new Error(`piper timeout (${TTS_LOCAL_TIMEOUT_MS / 1000}s)`));
    }, TTS_LOCAL_TIMEOUT_MS);
    proc.stdout?.on('data', (c: Buffer) => chunks.push(c));
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`piper exited ${code}`));
    });
    proc.stdin?.write(text);
    proc.stdin?.end();
  });
}

function ttsInstructions(persona: VoicePersona): string {
  const assistant = persona.assistantName?.trim() || 'Jarvis';
  const user = persona.userName?.trim();
  return [
    `Você é a voz de ${assistant} no NexusIDE.`,
    'Fale sempre em português brasileiro, com pronúncia brasileira.',
    'Use tom calmo, firme, próximo e útil; mantenha ritmo e energia constantes.',
    'Não dramatize, não acelere no meio da frase e não mude de atuação entre respostas.',
    user
      ? `Quando o texto contiver o nome do usuário, pronuncie exatamente "${user}".`
      : '',
    persona.customInstructions?.trim()
      ? `Preferência do usuário: ${persona.customInstructions.trim()}`
      : '',
  ]
    .filter(Boolean)
    .join(' ');
}

async function speakCloud(
  plugin: VoicePlugin,
  text: string,
  deps: TtsDeps,
  persona: VoicePersona,
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
    // Deadline duro: um POST pendurado nunca pode segurar o turno de fala.
    signal: AbortSignal.timeout(TTS_CLOUD_TIMEOUT_MS),
    body: JSON.stringify({
      model: plugin.model ?? 'tts-1',
      voice: plugin.voice ?? 'marin',
      // Persona JARVIS — só o gpt-4o-mini-tts aceita instructions.
      ...((plugin.model ?? 'gpt-4o-mini-tts').startsWith('gpt-4o-mini-tts')
        ? { instructions: ttsInstructions(persona) }
        : {}),
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
      if (
        deps.getOutputDeviceId?.() !== 'default' &&
        deps.renderViaSay
      ) {
        const audio = await deps.renderViaSay(text, plugin.voice);
        return {
          ok: true,
          provider: plugin.provider,
          mode: 'audio',
          format: 'aiff',
          audioBase64: audio.toString('base64'),
        };
      }
      await deps.speakViaSay(text, plugin.voice);
      return { ok: true, provider: plugin.provider, mode: 'played' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `say failed: ${message}` };
    }
  }
  // Piper (local): produce wav bytes for the renderer to play.
  try {
    const wav = await deps.runPiper(plugin, text);
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

/** Attempt a single provider, dispatching to the cloud or local/system path. */
function speakVia(
  plugin: VoicePlugin,
  text: string,
  deps: TtsDeps,
  persona: VoicePersona,
): Promise<SpeakResult> {
  return classifyKind(plugin) === 'cloud'
    ? speakCloud(plugin, text, deps, persona)
    : speakLocalOrSystem(plugin, text, deps);
}

/**
 * Speak a request against the configured TTS chain. Walks the whole chain and
 * falls through to the next provider on any runtime failure, so a throttled or
 * failing cloud provider (429/401/402/403/5xx/network) still lands on Piper or
 * macOS `say`. `probes` is unused here — availability is decided by actually
 * attempting each provider (a missing key / binary fails and falls through),
 * mirroring the STT chain.
 */
export async function speak(
  req: SpeakRequest,
  config: VoiceConfig,
  _probes: ProviderProbes,
  deps: TtsDeps = defaultDeps,
): Promise<SpeakResult> {
  const mode = req.speakMode ?? config.speakMode;
  const text = toSpeakable(req.text, mode);
  if (!text) return { ok: true, provider: '-', mode: 'silent' };

  const configuredHeadProvider = flattenChain(config.tts)[0]?.provider;
  const chain = reorderTtsChain(flattenChain(config.tts));
  const failures: string[] = [];

  for (const plugin of chain) {
    const result = await speakVia(plugin, text, deps, config.persona);
    if (result.ok) {
      const pinnedFallback =
        failures.length === 0 &&
        plugin.provider === stickyTtsProvider &&
        plugin.provider !== configuredHeadProvider;
      const fallbackNote =
        failures.length > 0
          ? `TTS fallback: ${failures.join(' · ')} → ${plugin.provider}`
          : pinnedFallback
            ? `TTS fallback temporário: ${plugin.provider}; a voz principal será tentada automaticamente.`
          : undefined;
      stickyTtsProvider = plugin.provider;
      stickyTtsPinnedAt = Date.now();
      logVoice('info', 'tts.provider', `${plugin.provider} (${plugin.voice ?? plugin.model ?? 'default'})`, {
        fallback: failures.length > 0 || pinnedFallback,
      });
      if (fallbackNote) {
        logVoice('warn', 'tts.fallback', fallbackNote);
      }
      // Janela de eco: registra o que foi falado para o fluxo de STT poder
      // descartar transcrições que são o alto-falante vazando no microfone.
      // Acks/fillers curtos ("Sim?", "Deixa comigo.") pedem echoRecord:false —
      // registrá-los poluía a janela e censurava respostas legítimas do
      // usuário ("sim", "deixa") logo depois.
      if (req.echoRecord !== false) echoSuppressor.record(text);
      return fallbackNote ? { ...result, fallbackNote } : result;
    }
    failures.push(`${plugin.provider}: ${result.error}`);
  }

  return {
    ok: false,
    error:
      failures.length > 0
        ? `No text-to-speech provider succeeded. Tried — ${failures.join(' · ')}.`
        : 'No text-to-speech provider available.',
  };
}
