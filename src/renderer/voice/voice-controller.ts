import { useEffect, useRef } from 'react';
import { useVoiceStore } from './voice-store';
import { useLayoutStore } from '../state/layout-store';
import { VoiceCapture } from './voice-capture';
import { getPaneSessionId, writeToPane } from '../terminal/terminal-host';
import type { VoiceRuntimeInfo } from '../../shared/voice-ipc';

/**
 * The Jarvis pipeline, renderer side. Wires the global PTT edges to:
 *   capture mic → transcribe+translate (main) → inject into focused pane →
 *   capture the agent's reply → speak it back (main TTS).
 *
 * Mounted once from App. All work is guarded so a missing mic / key / pane
 * surfaces a clear status instead of throwing.
 */

const RESPONSE_QUIET_MS = 1_500; // speak once the pane has been quiet this long
const RESPONSE_MAX_MS = 20_000; // hard cap on how long we wait for a reply
const MIN_SPEECH_SEC = 0.25; // ignore accidental taps shorter than this

export function useVoiceController(): void {
  const capture = useRef<VoiceCapture | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    capture.current = new VoiceCapture();
    const store = useVoiceStore.getState();

    void window.nexus.voice.getInfo().then((info) => store.setInfo(info));
    const unsubInfo = window.nexus.voice.onInfoChanged((info: VoiceRuntimeInfo) =>
      useVoiceStore.getState().setInfo(info),
    );

    const onStart = () => {
      if (busy.current) return;
      void beginListening(capture.current!);
    };
    const onStop = () => {
      if (!capture.current?.isCapturing()) return;
      void finishAndProcess(capture.current, busy);
    };

    const unsubStart = window.nexus.voice.onPttStart(onStart);
    const unsubStop = window.nexus.voice.onPttStop(onStop);

    return () => {
      unsubInfo();
      unsubStart();
      unsubStop();
    };
  }, []);
}

async function beginListening(capture: VoiceCapture): Promise<void> {
  const store = useVoiceStore.getState();
  try {
    store.setNote(null);
    await capture.start();
    store.setStatus('listening');
  } catch (err) {
    store.setError(`Mic unavailable: ${errMsg(err)}`);
  }
}

async function finishAndProcess(
  capture: VoiceCapture,
  busy: React.MutableRefObject<boolean>,
): Promise<void> {
  const store = useVoiceStore.getState();
  busy.current = true;
  try {
    const result = await capture.stop();
    if (!result.wavBase64 || result.durationSec < MIN_SPEECH_SEC) {
      store.setStatus('idle');
      return;
    }

    store.setStatus('transcribing');
    const stt = await window.nexus.voice.transcribe({
      audioBase64: result.wavBase64,
      mime: 'audio/wav',
      sampleRate: result.sampleRate,
    });
    if (!stt.ok) {
      store.setError(stt.error);
      return;
    }
    store.setTranscript(stt.text);
    // Surface throttle/quota fallbacks instead of failing silently.
    store.setNote(stt.fallbackNote ?? null);

    store.setStatus('routing');
    const paneId = routePrompt(stt.text);
    if (!paneId) {
      store.setError('No focused pane to route the prompt into.');
      return;
    }

    // Jarvis: capture the agent's reply, then speak a condensed summary.
    const reply = await captureResponse(paneId);
    if (reply.trim()) {
      store.setStatus('speaking');
      const spoken = await window.nexus.voice.speak({ text: reply });
      if (spoken.ok) {
        if (spoken.mode === 'audio') await playAudioBase64(spoken.audioBase64, spoken.format);
        store.setSpoken(reply);
      } else {
        store.setError(spoken.error);
        return;
      }
    }
    store.setStatus('idle');
  } catch (err) {
    store.setError(errMsg(err));
  } finally {
    busy.current = false;
  }
}

/**
 * Inject the transcribed prompt into the target pane's PTY (same path as typing).
 * Returns the pane id used, or null when nothing is focused. Routing modes other
 * than 'focused-pane' currently resolve to the focused pane (orchestrator routing
 * arrives with the MCP squad work in a later phase).
 */
function routePrompt(text: string): string | null {
  const { focusedPaneId } = useLayoutStore.getState();
  if (!focusedPaneId) return null;
  const ok = writeToPane(focusedPaneId, `${text}\n`);
  return ok ? focusedPaneId : null;
}

/**
 * Accumulate the pane's PTY output after injection and resolve once it has been
 * quiet for RESPONSE_QUIET_MS (agent finished) or RESPONSE_MAX_MS elapses.
 */
function captureResponse(paneId: string): Promise<string> {
  return new Promise((resolve) => {
    const sessionId = getPaneSessionId(paneId);
    if (!sessionId) {
      resolve('');
      return;
    }
    let buffer = '';
    let quietTimer: ReturnType<typeof setTimeout> | null = null;
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      if (quietTimer) clearTimeout(quietTimer);
      clearTimeout(hardCap);
      unsub();
      resolve(buffer);
    };

    const armQuiet = () => {
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, RESPONSE_QUIET_MS);
    };

    const unsub = window.nexus.pty.onData(sessionId, (data) => {
      buffer += data;
      armQuiet();
    });
    const hardCap = setTimeout(finish, RESPONSE_MAX_MS);
    armQuiet();
  });
}

/** Decode + play TTS audio bytes via Web Audio. */
async function playAudioBase64(base64: string, _format: string): Promise<void> {
  const bytes = base64ToBytes(base64);
  const ctx = new AudioContext();
  try {
    // Fresh Uint8Array → its buffer is a plain ArrayBuffer (not shared).
    const arrayBuffer = bytes.buffer.slice(0) as ArrayBuffer;
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);
    await new Promise<void>((resolve) => {
      source.onended = () => resolve();
      source.start();
    });
  } finally {
    void ctx.close();
  }
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
