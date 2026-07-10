/**
 * Shared mutable session state for the Jarvis voice pipeline.
 * Kept in one module so voice-controller stays under the 800-line Akita limit.
 */
import { LiveAudioPlayer } from './live-audio';
import { WakeMic } from './wake-mic';
import { RealtimeTranscriptWaiter } from './realtime-transcript-waiter';
import { TurnExecutionOwner } from './turn-execution-owner';
import { ThrottledCounter } from '../../shared/live-flow-counter';
import type { JarvisCaptureReason } from './jarvis-reply-loop';
import type { JarvisLiveAudioOutEvent, JarvisTurn } from '../../shared/voice-ipc';
import { bindWakeSuppressor } from './voice-playback';
import { subscribeAudioDevicePreferences } from './audio-device-preferences';

export const PENDING_REALTIME_AUDIO_MAX_CHUNKS = 160;
export const REALTIME_ACTION_BRIDGE_ENABLED = true;
export const REALTIME_PROVIDER_AUDIO_ENABLED = true;

export let jarvisHistory: JarvisTurn[] = [];
export const wakeMic = new WakeMic();
bindWakeSuppressor((ms) => wakeMic.suppressWakeDetection(ms));

export let livePlayer: LiveAudioPlayer | null = null;
export function ensureLivePlayer(): LiveAudioPlayer {
  return (livePlayer ??= new LiveAudioPlayer());
}

subscribeAudioDevicePreferences((next, previous) => {
  if (next.inputDeviceId !== previous.inputDeviceId) {
    void wakeMic.restartForDeviceChange().catch((error) => {
      window.nexus.voice.logVoice({
        level: 'error',
        event: 'mic.deviceSwitchFailed',
        msg: error instanceof Error ? error.message : String(error),
      });
    });
  }
  if (next.outputDeviceId !== previous.outputDeviceId) {
    void livePlayer?.setOutputDevice(next.outputDeviceId).catch((error) => {
      window.nexus.voice.logVoice({
        level: 'error',
        event: 'audio.outputDeviceSwitchFailed',
        msg: error instanceof Error ? error.message : String(error),
      });
    });
  }
});

export let realtimeTurnActive = false;
export let suppressRealtimeAudioOut = false;
export const realtimeTranscriptWaiter = new RealtimeTranscriptWaiter();
export let pendingLiveStartSettle: Promise<void> | null = null;
export let finishRealtimeCapture: (() => void) | null = null;
export let pendingRealtimeAudioOut: JarvisLiveAudioOutEvent[] = [];
export const realtimeAudioPlayedCounter = new ThrottledCounter(20, 2_000);
export const realtimeAudioSuppressedCounter = new ThrottledCounter(20, 2_000);
export let jarvisLastTurnAt = 0;
export let wakeOpenInProgress = false;
export let activeCaptureReason: JarvisCaptureReason = 'manual';
export let realtimeNativeToolInFlight = 0;
export let lastRealtimeNativeToolAt = 0;
export let lastRealtimeNativeToolCallId: string | null = null;
export const turnExecution = new TurnExecutionOwner();

export function setRealtimeTurnActive(v: boolean): void {
  realtimeTurnActive = v;
}
export function setSuppressRealtimeAudioOut(v: boolean): void {
  suppressRealtimeAudioOut = v;
}
export function setPendingLiveStartSettle(p: Promise<void> | null): void {
  pendingLiveStartSettle = p;
}
export function setFinishRealtimeCapture(fn: (() => void) | null): void {
  finishRealtimeCapture = fn;
}
export function setActiveCaptureReason(r: JarvisCaptureReason): void {
  activeCaptureReason = r;
}
export function setWakeOpenInProgress(v: boolean): void {
  wakeOpenInProgress = v;
}
export function setJarvisHistory(h: JarvisTurn[]): void {
  jarvisHistory = h;
}
export function setJarvisLastTurnAt(t: number): void {
  jarvisLastTurnAt = t;
}
export function setLivePlayer(p: LiveAudioPlayer | null): void {
  livePlayer = p;
}
export function bumpRealtimeNativeToolInFlight(delta: number): void {
  realtimeNativeToolInFlight = Math.max(0, realtimeNativeToolInFlight + delta);
}
export function setLastRealtimeNativeToolAt(t: number): void {
  lastRealtimeNativeToolAt = t;
}
export function setLastRealtimeNativeToolCallId(callId: string | null): void {
  lastRealtimeNativeToolCallId = callId;
}
export function resetPendingRealtimeAudioOut(): void {
  pendingRealtimeAudioOut = [];
}
export function pushPendingRealtimeAudioOut(event: JarvisLiveAudioOutEvent): void {
  if (pendingRealtimeAudioOut.length >= PENDING_REALTIME_AUDIO_MAX_CHUNKS) {
    pendingRealtimeAudioOut.shift();
  }
  pendingRealtimeAudioOut.push(event);
}
export function takePendingRealtimeAudioOut(): JarvisLiveAudioOutEvent[] {
  const chunks = pendingRealtimeAudioOut;
  pendingRealtimeAudioOut = [];
  return chunks;
}
