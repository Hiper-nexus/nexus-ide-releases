import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { PTY_CHANNELS, LAYOUT_CHANNELS, ADAPTER_CHANNELS } from '../shared/channels';
import { VOICE_CHANNELS } from '../shared/voice-channels';
import { ORCH_CHANNELS } from '../shared/orch-channels';
import { SETTINGS_CHANNELS } from '../shared/settings-types';
import type { TerminalSettings } from '../shared/settings-types';
import { WORKSPACE_CHANNELS } from '../shared/workspace-types';
import type { WorkspaceState } from '../shared/workspace-types';
import { PROVIDER_CHANNELS } from '../shared/provider-settings-types';
import type { ProviderSettingsInfo } from '../shared/provider-settings-types';
import { FILES_CHANNELS } from '../shared/files-types';
import { ACCOUNT_CHANNELS } from '../shared/account-types';
import type { AccountInfo, FailoverEvent } from '../shared/account-types';
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
import type {
  Handoff,
  Mission,
  OrchPaneSpawnRequest,
  Squad,
  TodoList,
} from '../shared/orch-types';

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

// Orchestration event fan-out (same pattern as voice above).
const paneSpawnRequestListeners = new Set<(req: OrchPaneSpawnRequest) => void>();
const paneCloseRequestListeners = new Set<(paneId: string) => void>();
const missionsChangedListeners = new Set<(missions: Mission[]) => void>();
const handoffsChangedListeners = new Set<(handoffs: Handoff[]) => void>();
const todosChangedListeners = new Set<(lists: TodoList[]) => void>();
const squadsChangedListeners = new Set<(squads: Squad[]) => void>();

ipcRenderer.on(ORCH_CHANNELS.paneSpawnRequest, (_e, req: OrchPaneSpawnRequest) =>
  paneSpawnRequestListeners.forEach((cb) => cb(req)),
);
ipcRenderer.on(ORCH_CHANNELS.paneCloseRequest, (_e, paneId: string) =>
  paneCloseRequestListeners.forEach((cb) => cb(paneId)),
);
ipcRenderer.on(ORCH_CHANNELS.missionsChanged, (_e, missions: Mission[]) =>
  missionsChangedListeners.forEach((cb) => cb(missions)),
);
ipcRenderer.on(ORCH_CHANNELS.handoffsChanged, (_e, handoffs: Handoff[]) =>
  handoffsChangedListeners.forEach((cb) => cb(handoffs)),
);
ipcRenderer.on(ORCH_CHANNELS.todosChanged, (_e, lists: TodoList[]) =>
  todosChangedListeners.forEach((cb) => cb(lists)),
);
ipcRenderer.on(ORCH_CHANNELS.squadsChanged, (_e, squads: Squad[]) =>
  squadsChangedListeners.forEach((cb) => cb(squads)),
);

const settingsChangedListeners = new Set<(settings: TerminalSettings) => void>();
ipcRenderer.on(SETTINGS_CHANNELS.changed, (_e, settings: TerminalSettings) =>
  settingsChangedListeners.forEach((cb) => cb(settings)),
);

const workspaceChangedListeners = new Set<(state: WorkspaceState) => void>();
ipcRenderer.on(WORKSPACE_CHANNELS.changed, (_e, state: WorkspaceState) =>
  workspaceChangedListeners.forEach((cb) => cb(state)),
);

const providersChangedListeners = new Set<
  (list: ProviderSettingsInfo[]) => void
>();
ipcRenderer.on(PROVIDER_CHANNELS.changed, (_e, list: ProviderSettingsInfo[]) =>
  providersChangedListeners.forEach((cb) => cb(list)),
);

const accountsChangedListeners = new Set<(list: AccountInfo[]) => void>();
const failoverListeners = new Set<(event: FailoverEvent) => void>();
ipcRenderer.on(ACCOUNT_CHANNELS.changed, (_e, list: AccountInfo[]) =>
  accountsChangedListeners.forEach((cb) => cb(list)),
);
ipcRenderer.on(ACCOUNT_CHANNELS.failover, (_e, event: FailoverEvent) =>
  failoverListeners.forEach((cb) => cb(event)),
);

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
    save: (workspacePath: string, layout: WorkspaceLayout) =>
      ipcRenderer.invoke(LAYOUT_CHANNELS.save, { workspacePath, layout }),
    load: (workspacePath: string) =>
      ipcRenderer.invoke(LAYOUT_CHANNELS.load, { workspacePath }),
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
  orch: {
    syncPanes: (entries) => ipcRenderer.send(ORCH_CHANNELS.panesSync, entries),
    sendPaneSpawnResult: (result) =>
      ipcRenderer.send(ORCH_CHANNELS.paneSpawnResult, result),
    onPaneSpawnRequest: (cb) => addListener(paneSpawnRequestListeners, cb),
    onPaneCloseRequest: (cb) => addListener(paneCloseRequestListeners, cb),
    listMissions: () => ipcRenderer.invoke(ORCH_CHANNELS.missionsList),
    listHandoffs: () => ipcRenderer.invoke(ORCH_CHANNELS.handoffsList),
    getTodos: () => ipcRenderer.invoke(ORCH_CHANNELS.todosGet),
    listSquads: () => ipcRenderer.invoke(ORCH_CHANNELS.squadsList),
    saveSquad: (squad) => ipcRenderer.invoke(ORCH_CHANNELS.squadSave, squad),
    deleteSquad: (id) => ipcRenderer.invoke(ORCH_CHANNELS.squadDelete, id),
    exportSquads: () => ipcRenderer.invoke(ORCH_CHANNELS.squadExport),
    importSquads: () => ipcRenderer.invoke(ORCH_CHANNELS.squadImport),
    getMcpInfo: () => ipcRenderer.invoke(ORCH_CHANNELS.mcpInfo),
    getCatalogIndex: (refresh?: boolean) =>
      ipcRenderer.invoke(ORCH_CHANNELS.catalogIndex, { refresh }),
    installCatalogItem: (req) =>
      ipcRenderer.invoke(ORCH_CHANNELS.catalogInstall, req),
    listInstalledCatalog: () =>
      ipcRenderer.invoke(ORCH_CHANNELS.catalogInstalled),
    listNativeTools: () => ipcRenderer.invoke(ORCH_CHANNELS.toolsList),
    listPluginFiles: () => ipcRenderer.invoke(ORCH_CHANNELS.pluginsList),
    listHookHomes: () => ipcRenderer.invoke(ORCH_CHANNELS.hooksList),
    onMissionsChanged: (cb) => addListener(missionsChangedListeners, cb),
    onHandoffsChanged: (cb) => addListener(handoffsChangedListeners, cb),
    onTodosChanged: (cb) => addListener(todosChangedListeners, cb),
    onSquadsChanged: (cb) => addListener(squadsChangedListeners, cb),
  },
  settings: {
    get: () => ipcRenderer.invoke(SETTINGS_CHANNELS.get),
    set: (patch) => ipcRenderer.invoke(SETTINGS_CHANNELS.set, patch),
    onChanged: (cb) => addListener(settingsChangedListeners, cb),
  },
  workspace: {
    get: () => ipcRenderer.invoke(WORKSPACE_CHANNELS.get),
    pick: () => ipcRenderer.invoke(WORKSPACE_CHANNELS.pick),
    pickPath: () => ipcRenderer.invoke(WORKSPACE_CHANNELS.pickPath),
    open: (path) => ipcRenderer.invoke(WORKSPACE_CHANNELS.open, { path }),
    close: () => ipcRenderer.invoke(WORKSPACE_CHANNELS.close),
    remove: (path) => ipcRenderer.invoke(WORKSPACE_CHANNELS.remove, { path }),
    onChanged: (cb) => addListener(workspaceChangedListeners, cb),
  },
  providers: {
    list: () => ipcRenderer.invoke(PROVIDER_CHANNELS.list),
    setConfig: (patch) => ipcRenderer.invoke(PROVIDER_CHANNELS.setConfig, patch),
    setKey: (req) => ipcRenderer.invoke(PROVIDER_CHANNELS.setKey, req),
    testKey: (adapterId) =>
      ipcRenderer.invoke(PROVIDER_CHANNELS.testKey, { adapterId }),
    onChanged: (cb) => addListener(providersChangedListeners, cb),
  },
  files: {
    list: (relPath: string) => ipcRenderer.invoke(FILES_CHANNELS.list, { relPath }),
    read: (relPath: string) => ipcRenderer.invoke(FILES_CHANNELS.read, { relPath }),
    write: (relPath: string, content: string) =>
      ipcRenderer.invoke(FILES_CHANNELS.write, { relPath, content }),
    saveDropped: (name: string, base64: string) =>
      ipcRenderer.invoke(FILES_CHANNELS.saveDropped, { name, base64 }),
    // webUtils resolves a dragged File to its real filesystem path — the only
    // sandbox-safe way to get it (File.path was removed).
    pathForFile: (file: File): string => {
      try {
        return webUtils.getPathForFile(file);
      } catch {
        return '';
      }
    },
  },
  accounts: {
    list: () => ipcRenderer.invoke(ACCOUNT_CHANNELS.list),
    add: (req) => ipcRenderer.invoke(ACCOUNT_CHANNELS.add, req),
    addActiveClaude: (label: string) =>
      ipcRenderer.invoke(ACCOUNT_CHANNELS.addActiveClaude, { label }),
    rename: (id: string, label: string) =>
      ipcRenderer.invoke(ACCOUNT_CHANNELS.rename, { id, label }),
    remove: (id: string) => ipcRenderer.invoke(ACCOUNT_CHANNELS.remove, { id }),
    activate: (id: string) => ipcRenderer.invoke(ACCOUNT_CHANNELS.activate, { id }),
    onChanged: (cb) => addListener(accountsChangedListeners, cb),
    onFailover: (cb) => addListener(failoverListeners, cb),
  },
  platform: process.platform,
};

contextBridge.exposeInMainWorld('nexus', api);
