import { create } from 'zustand';
import type { VoiceRuntimeInfo } from '../../shared/voice-ipc';

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
  lastTranscript: string;
  lastSpoken: string;
  /** Transient fallback note, e.g. "groq throttled (429) → openai". */
  note: string | null;
  error: string | null;
  settingsOpen: boolean;

  setStatus: (status: VoiceUiStatus) => void;
  setInfo: (info: VoiceRuntimeInfo) => void;
  setTranscript: (text: string) => void;
  setSpoken: (text: string) => void;
  setNote: (note: string | null) => void;
  setError: (error: string | null) => void;
  openSettings: () => void;
  closeSettings: () => void;
}

export const useVoiceStore = create<VoiceStore>((set) => ({
  status: 'idle',
  info: null,
  lastTranscript: '',
  lastSpoken: '',
  note: null,
  error: null,
  settingsOpen: false,

  setStatus: (status) => set({ status, ...(status !== 'error' ? { error: null } : {}) }),
  setInfo: (info) => set({ info }),
  setTranscript: (lastTranscript) => set({ lastTranscript }),
  setSpoken: (lastSpoken) => set({ lastSpoken }),
  setNote: (note) => set({ note }),
  setError: (error) => set({ error, status: error ? 'error' : 'idle' }),
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
}));
