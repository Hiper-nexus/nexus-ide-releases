import { useVoiceStore } from './voice-store';
import { playbackWakeSuppressionMs } from './voice-suppression-window';
import {
  clearLocalAudioGate,
  markLocalAudioPlaying,
} from './live-local-audio-gate';
import type { SpeakResult } from '../../shared/voice-ipc';
import { requirePreferredOutputDevice } from './audio-device-preferences';

/** Silencia detecção de wake word durante reprodução de TTS. */
export type WakeSuppressor = (ms: number) => void;

let playbackGen = 0;
let liveSources: AudioBufferSourceNode[] = [];
let suppressWake: WakeSuppressor | null = null;

export function bindWakeSuppressor(fn: WakeSuppressor): void {
  suppressWake = fn;
}

function isJarvisLiveEnabled(): boolean {
  const info = useVoiceStore.getState().info;
  return Boolean(info?.jarvisLive.enabled && info.routing === 'jarvis');
}

/** Corta áudio atual e invalida reproduções pendentes (barge-in). */
export function stopAllPlayback(interruptReason = 'barge-in'): void {
  if (isJarvisLiveEnabled() && useVoiceStore.getState().status === 'speaking') {
    void window.nexus.voice.liveInterrupt(interruptReason);
  }
  void window.nexus.voice.stopSpeak().catch(() => {});
  // Barge-in: o áudio local foi cortado — libera a retenção do mic realtime
  // para o socket voltar a receber os frames do usuário imediatamente.
  clearLocalAudioGate();
  playbackGen += 1;
  for (const src of liveSources) {
    try {
      src.stop();
    } catch {
      // já parado
    }
  }
  liveSources = [];
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Plays the TTS bytes and returns the actual playback duration in ms (0 if a
 *  newer playback superseded it). The returned duration lets callers tie the
 *  post-TTS wake-suppression window to the REAL length of what was spoken. */
export async function playAudioBase64(base64: string, _format: string): Promise<number> {
  const gen = playbackGen;
  const bytes = base64ToBytes(base64);
  const ctx = new AudioContext();
  try {
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    await requirePreferredOutputDevice(ctx);
    const arrayBuffer = bytes.buffer.slice(0) as ArrayBuffer;
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    if (gen !== playbackGen) return 0;
    const durationMs = Math.ceil(audioBuffer.duration * 1000);
    // Atribuição de "duas vozes": todo áudio local audível fica no voice.log;
    // voz ouvida sem linha correspondente = veio de OUTRO app.
    window.nexus.voice.logVoice({
      level: 'info',
      event: 'audio.playbackStart',
      msg: 'playback local iniciado',
      data: { durationMs },
    });
    // Suppress wake for the ACTUAL playback duration + acoustic tail (clamped).
    // With APM/AEC off the speaker bleeds straight into the hot mic, so a fixed
    // short window let "Hey Jarvis" self-fire mid-reply — the self-talk seed.
    suppressWake?.(playbackWakeSuppressionMs(durationMs));
    // FIX 1: withhold realtime mic frames from the socket for the SAME real
    // playback duration + tail. Every LOCAL audio (wake ack, think-filler,
    // classic/marin TTS) flows through here, so this single choke point stops
    // her own voice from streaming to the provider as "user speech".
    markLocalAudioPlaying(durationMs, Date.now());
    const source = ctx.createBufferSource();
    liveSources.push(source);
    source.buffer = audioBuffer;
    source.connect(ctx.destination);
    await new Promise<void>((resolve) => {
      source.onended = () => resolve();
      source.start();
    });
    liveSources = liveSources.filter((s) => s !== source);
    return durationMs;
  } finally {
    void ctx.close();
  }
}

/** Plays a SpeakResult (audio mode) and returns the playback duration in ms. */
export async function playSpeakResult(result: SpeakResult): Promise<number> {
  if (result.ok && result.mode === 'audio') {
    return playAudioBase64(result.audioBase64, result.format);
  }
  return 0;
}
