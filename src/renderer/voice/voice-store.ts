import { create } from 'zustand';
import {
  DEFAULT_HUD_PREFS,
  clampHudWidth,
  loadHudPrefs,
  saveHudPrefs,
  type HudCorner,
  type HudMode,
  type HudPrefs,
} from './hud-prefs';
import type {
  JarvisLiveInterruptEvent,
  JarvisLiveState,
  JarvisLiveToolEvent,
  JarvisLiveToolResultEvent,
  JarvisLiveTranscriptEvent,
  JarvisTranscriptAppendEvent,
  VoiceRuntimeInfo,
} from '../../shared/voice-ipc';
import type { MicHealth } from './wake-health';

const RESPONSE_MUTED_KEY = 'nexus.voice.responseMuted';

function loadResponseMutedFlag(
  store: Pick<Storage, 'getItem' | 'setItem'> | null,
): boolean {
  if (!store) return false;
  try {
    return store.getItem(RESPONSE_MUTED_KEY) === '1';
  } catch {
    return false;
  }
}

function saveResponseMutedFlag(
  muted: boolean,
  store: Pick<Storage, 'getItem' | 'setItem'> | null,
): void {
  if (!store) return;
  try {
    store.setItem(RESPONSE_MUTED_KEY, muted ? '1' : '0');
  } catch {
    // ignore
  }
}

/**
 * Renderer-side voice UI state: the current pipeline phase (for the HUD), the
 * secret-free runtime info from main, the last transcript/spoken line, and any
 * error. Purely presentational — the actual pipeline lives in voice-controller.
 */

export type VoiceUiStatus =
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'routing'
  | 'speaking'
  | 'error';

interface VoiceStore {
  status: VoiceUiStatus;
  info: VoiceRuntimeInfo | null;
  /** Nível de mic ao vivo [0,1] — visualizador de amplitude do orb. */
  level: number;
  lastTranscript: string;
  lastSpoken: string;
  /** Transient fallback note, e.g. "groq throttled (429) → openai". */
  note: string | null;
  error: string | null;
  /** Saúde do mic: 'ok' | 'needsPermission' | 'silent'. */
  micHealth: MicHealth;
  settingsOpen: boolean;
  liveState: JarvisLiveState | null;
  liveTranscript: JarvisLiveTranscriptEvent[];
  transcriptAppend: JarvisTranscriptAppendEvent[];
  liveTool: JarvisLiveToolEvent | JarvisLiveToolResultEvent | null;
  liveInterrupted: JarvisLiveInterruptEvent | null;
  /** HUD da JARVIS: modo (expandida/mini/só-áudio), âncora e largura. */
  hud: HudPrefs;
  /**
   * When true: Jarvis still listens and runs commands, but response audio
   * (Classic TTS + Live PCM) is suppressed.
   */
  responseMuted: boolean;

  setStatus: (status: VoiceUiStatus) => void;
  setInfo: (info: VoiceRuntimeInfo) => void;
  setLevel: (level: number) => void;
  setTranscript: (text: string) => void;
  setSpoken: (text: string) => void;
  setNote: (note: string | null) => void;
  setError: (error: string | null) => void;
  setMicHealth: (micHealth: MicHealth) => void;
  setLiveState: (state: JarvisLiveState) => void;
  addLiveTranscript: (event: JarvisLiveTranscriptEvent) => void;
  addTranscriptAppend: (event: JarvisTranscriptAppendEvent) => void;
  setLiveTool: (event: JarvisLiveToolEvent | JarvisLiveToolResultEvent) => void;
  setLiveInterrupted: (event: JarvisLiveInterruptEvent) => void;
  setHudMode: (mode: HudMode) => void;
  setHudAnchor: (anchor: { corner: HudCorner; dx: number; dy: number }) => void;
  setHudWidth: (width: number) => void;
  setResponseMuted: (responseMuted: boolean) => void;
  openSettings: () => void;
  closeSettings: () => void;
}

// localStorage não existe no ambiente de teste node — degrade para defaults.
const hudStorage: Pick<Storage, 'getItem' | 'setItem'> | null =
  typeof localStorage === 'undefined' ? null : localStorage;

function persistHud(prefs: HudPrefs): HudPrefs {
  if (hudStorage) saveHudPrefs(hudStorage, prefs);
  return prefs;
}

export const useVoiceStore = create<VoiceStore>((set) => ({
  status: 'idle',
  info: null,
  level: 0,
  lastTranscript: '',
  lastSpoken: '',
  note: null,
  error: null,
  micHealth: 'ok',
  settingsOpen: false,
  liveState: null,
  liveTranscript: [],
  transcriptAppend: [],
  liveTool: null,
  liveInterrupted: null,
  hud: hudStorage ? loadHudPrefs(hudStorage) : { ...DEFAULT_HUD_PREFS },
  responseMuted: loadResponseMutedFlag(hudStorage),

  setStatus: (status) => set({ status, ...(status !== 'error' ? { error: null } : {}) }),
  setInfo: (info) => set({ info }),
  setLevel: (level) => set({ level }),
  setTranscript: (lastTranscript) => set({ lastTranscript }),
  setSpoken: (lastSpoken) => set({ lastSpoken }),
  setNote: (note) => set({ note }),
  setError: (error) => set({ error, status: error ? 'error' : 'idle' }),
  setMicHealth: (micHealth) => set({ micHealth }),
  setLiveState: (liveState) => set({ liveState }),
  addLiveTranscript: (event) =>
    set((state) => ({
      liveTranscript: [...state.liveTranscript, event].slice(-12),
    })),
  addTranscriptAppend: (event) =>
    set((state) => ({
      transcriptAppend: [...state.transcriptAppend, event].slice(-20),
    })),
  setLiveTool: (liveTool) => set({ liveTool }),
  setLiveInterrupted: (liveInterrupted) => set({ liveInterrupted }),
  setHudMode: (mode) =>
    set((state) => ({ hud: persistHud({ ...state.hud, mode }) })),
  setHudAnchor: (anchor) =>
    set((state) => ({ hud: persistHud({ ...state.hud, ...anchor }) })),
  setHudWidth: (width) =>
    set((state) => ({
      hud: persistHud({ ...state.hud, width: clampHudWidth(width) }),
    })),
  setResponseMuted: (responseMuted) => {
    saveResponseMutedFlag(responseMuted, hudStorage);
    set({ responseMuted });
  },
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
}));
