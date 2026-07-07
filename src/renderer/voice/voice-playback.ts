import { useVoiceStore } from './voice-store';
import type { SpeakResult } from '../../shared/voice-ipc';

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
export function stopAllPlayback(): void {
  if (isJarvisLiveEnabled() && useVoiceStore.getState().status === 'speaking') {
    void window.nexus.voice.liveInterrupt('barge-in');
  }
  void window.nexus.voice.stopSpeak().catch(() => {});
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

export async function playAudioBase64(base64: string, _format: string): Promise<void> {
  const gen = playbackGen;
  const bytes = base64ToBytes(base64);
  const ctx = new AudioContext();
  try {
    const arrayBuffer = bytes.buffer.slice(0) as ArrayBuffer;
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    if (gen !== playbackGen) return;
    suppressWake?.(Math.ceil(audioBuffer.duration * 1000) + 500);
    const source = ctx.createBufferSource();
    liveSources.push(source);
    source.buffer = audioBuffer;
    source.connect(ctx.destination);
    await new Promise<void>((resolve) => {
      source.onended = () => resolve();
      source.start();
    });
    liveSources = liveSources.filter((s) => s !== source);
  } finally {
    void ctx.close();
  }
}

export async function playSpeakResult(result: SpeakResult): Promise<void> {
  if (result.ok && result.mode === 'audio') {
    await playAudioBase64(result.audioBase64, result.format);
  }
}
