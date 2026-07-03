import { contextBridge, ipcRenderer } from 'electron';
import { PTY_CHANNELS, LAYOUT_CHANNELS, ADAPTER_CHANNELS } from '../shared/channels';
import { VOICE_CHANNELS } from '../shared/voice-channels';
import type {
  NexusApi,
  SpawnRequest,
  SpawnResult,
  WorkspaceLayout,
  PtyDataEvent,
  PtyExitEvent,
  PtyStateChangeEvent,
  PaneSessionState,
  AdapterInfo,
} from '../shared/types';
import type { VoiceRuntimeInfo } from '../shared/voice-ipc';

/**
 * Preload bridge. The renderer NEVER receives raw ipcRenderer — only the typed
 * `window.nexus` surface below. PTY output arrives on shared channels and is
 * fanned out to per-session subscribers so callbacks stay scoped to one pane.
 */

type DataCb = (data: string) => void;
type ExitCb = (event: { exitCode: number; signal?: number }) => void;
type StateCb = (state: PaneSessionState) => void;
type AdapterChangedCb = (adapters: AdapterInfo[]) => void;

const dataSubs = new Map<string, Set<DataCb>>();
const exitSubs = new Map<string, Set<ExitCb>>();
const stateSubs = new Map<string, Set<StateCb>>();

ipcRenderer.on(PTY_CHANNELS.data, (_event, payload: PtyDataEvent) => {
  dataSubs.get(payload.sessionId)?.forEach((cb) => cb(payload.data));
});

ipcRenderer.on(PTY_CHANNELS.exit, (_event, payload: PtyExitEvent) => {
  exitSubs.get(payload.sessionId)?.forEach((cb) =>
    cb({ exitCode: payload.exitCode, signal: payload.signal }),
  );
});

ipcRenderer.on(PTY_CHANNELS.stateChange, (_event, payload: PtyStateChangeEvent) => {
  stateSubs.get(payload.sessionId)?.forEach((cb) => cb(payload.state));
});

function subscribe<T>(
  map: Map<string, Set<T>>,
  key: string,
  cb: T,
): () => void {
  let set = map.get(key);
  if (!set) {
    set = new Set<T>();
    map.set(key, set);
  }
  set.add(cb);
  return () => {
    const current = map.get(key);
    if (!current) return;
    current.delete(cb);
    if (current.size === 0) map.delete(key);
  };
}

const adapterChangedListeners = new Set<AdapterChangedCb>();

ipcRenderer.on(ADAPTER_CHANNELS.changed, (_event, payload: AdapterInfo[]) => {
  adapterChangedListeners.forEach((cb) => cb(payload));
});

// Voice event fan-out. Kept as plain listener sets so callbacks stay scoped and
// unsubscribe cleanly — no raw ipcRenderer ever reaches the renderer.
const pttStartListeners = new Set<() => void>();
const pttStopListeners = new Set<() => void>();
const voiceInfoListeners = new Set<(info: VoiceRuntimeInfo) => void>();

ipcRenderer.on(VOICE_CHANNELS.pttStart, () => pttStartListeners.forEach((cb) => cb()));
ipcRenderer.on(VOICE_CHANNELS.pttStop, () => pttStopListeners.forEach((cb) => cb()));
ipcRenderer.on(VOICE_CHANNELS.infoChanged, (_event, info: VoiceRuntimeInfo) =>
  voiceInfoListeners.forEach((cb) => cb(info)),
);

function addListener<T>(set: Set<T>, cb: T): () => void {
  set.add(cb);
  return () => set.delete(cb);
}

const api: NexusApi = {
  pty: {
    spawn: (req: SpawnRequest): Promise<SpawnResult> =>
      ipcRenderer.invoke(PTY_CHANNELS.spawn, req),
    write: (sessionId, data) =>
      ipcRenderer.send(PTY_CHANNELS.write, { sessionId, data }),
    resize: (sessionId, cols, rows) =>
      ipcRenderer.send(PTY_CHANNELS.resize, { sessionId, cols, rows }),
    kill: (sessionId) => ipcRenderer.send(PTY_CHANNELS.kill, { sessionId }),
    onData: (sessionId, cb) => subscribe(dataSubs, sessionId, cb),
    onExit: (sessionId, cb) => subscribe(exitSubs, sessionId, cb),
    onStateChange: (sessionId, cb) => subscribe(stateSubs, sessionId, cb),
  },
  layout: {
    save: (layout: WorkspaceLayout) =>
      ipcRenderer.invoke(LAYOUT_CHANNELS.save, layout),
    load: () => ipcRenderer.invoke(LAYOUT_CHANNELS.load),
  },
  adapters: {
    list: () => ipcRenderer.invoke(ADAPTER_CHANNELS.list),
    onChanged: (cb) => {
      adapterChangedListeners.add(cb);
      return () => adapterChangedListeners.delete(cb);
    },
  },
  voice: {
    getInfo: () => ipcRenderer.invoke(VOICE_CHANNELS.getInfo),
    setConfig: (patch) => ipcRenderer.invoke(VOICE_CHANNELS.setConfig, patch),
    transcribe: (req) => ipcRenderer.invoke(VOICE_CHANNELS.transcribe, req),
    speak: (req) => ipcRenderer.invoke(VOICE_CHANNELS.speak, req),
    onPttStart: (cb) => addListener(pttStartListeners, cb),
    onPttStop: (cb) => addListener(pttStopListeners, cb),
    onInfoChanged: (cb) => addListener(voiceInfoListeners, cb),
  },
  platform: process.platform,
};

contextBridge.exposeInMainWorld('nexus', api);
