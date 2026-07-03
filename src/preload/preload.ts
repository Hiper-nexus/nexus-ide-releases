import { contextBridge, ipcRenderer } from 'electron';
import { PTY_CHANNELS, LAYOUT_CHANNELS } from '../shared/channels';
import type {
  NexusApi,
  SpawnRequest,
  SpawnResult,
  WorkspaceLayout,
  PtyDataEvent,
  PtyExitEvent,
} from '../shared/types';

/**
 * Preload bridge. The renderer NEVER receives raw ipcRenderer — only the typed
 * `window.nexus` surface below. PTY output arrives on shared channels and is
 * fanned out to per-session subscribers so callbacks stay scoped to one pane.
 */

type DataCb = (data: string) => void;
type ExitCb = (event: { exitCode: number; signal?: number }) => void;

const dataSubs = new Map<string, Set<DataCb>>();
const exitSubs = new Map<string, Set<ExitCb>>();

ipcRenderer.on(PTY_CHANNELS.data, (_event, payload: PtyDataEvent) => {
  dataSubs.get(payload.sessionId)?.forEach((cb) => cb(payload.data));
});

ipcRenderer.on(PTY_CHANNELS.exit, (_event, payload: PtyExitEvent) => {
  exitSubs.get(payload.sessionId)?.forEach((cb) =>
    cb({ exitCode: payload.exitCode, signal: payload.signal }),
  );
});

function subscribe<T>(
  map: Map<string, Set<T>>,
  sessionId: string,
  cb: T,
): () => void {
  let set = map.get(sessionId);
  if (!set) {
    set = new Set<T>();
    map.set(sessionId, set);
  }
  set.add(cb);
  return () => {
    const current = map.get(sessionId);
    if (!current) return;
    current.delete(cb);
    if (current.size === 0) map.delete(sessionId);
  };
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
  },
  layout: {
    save: (layout: WorkspaceLayout) =>
      ipcRenderer.invoke(LAYOUT_CHANNELS.save, layout),
    load: () => ipcRenderer.invoke(LAYOUT_CHANNELS.load),
  },
  platform: process.platform,
};

contextBridge.exposeInMainWorld('nexus', api);
