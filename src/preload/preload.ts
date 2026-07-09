import { contextBridge, ipcRenderer, webUtils } from 'electron';
import {
  PTY_CHANNELS,
  BROWSER_CHANNELS,
  PERF_CHANNELS,
  MCP_CHANNELS,
  LAYOUT_CHANNELS,
  ADAPTER_CHANNELS,
  WINDOW_CHANNELS,
  TEAM_CHANNELS,
} from '../shared/channels';
import { OPS_CHANNELS } from '../shared/ops-ipc';
import { VOICE_CHANNELS } from '../shared/voice-channels';
import { VISION_CHANNELS } from '../shared/vision-ipc';
import type { ScreenCaptureMetadata } from '../shared/vision-ipc';
import { getAxTree } from './ax-tree';
import { UPDATE_CHANNELS } from '../shared/update-ipc';
import type { UpdateState } from '../shared/update-ipc';
import { ORCH_CHANNELS } from '../shared/orch-channels';
import { REMOTE_CHANNELS } from '../shared/remote-channels';
import { SETTINGS_CHANNELS } from '../shared/settings-types';
import type { TerminalSettings, UiSettings } from '../shared/settings-types';
import { WORKSPACE_CHANNELS } from '../shared/workspace-types';
import type { WorkspaceState } from '../shared/workspace-types';
import { PROVIDER_CHANNELS } from '../shared/provider-settings-types';
import type { ProviderSettingsInfo } from '../shared/provider-settings-types';
import { FILES_CHANNELS } from '../shared/files-types';
import { ACCOUNT_CHANNELS } from '../shared/account-types';
import type { AccountInfo, FailoverEvent } from '../shared/account-types';
import { COST_CHANNELS } from '../shared/cost-types';
import { USAGE_CHANNELS } from '../shared/usage-types';
import type { UsageSnapshot } from '../shared/usage-types';
import { MEDIA_CHANNELS } from '../shared/media-types';
import type { MediaProviderId } from '../shared/media-types';
import { GAMIFICATION_CHANNELS } from '../shared/gamification-types';
import type { GamificationSnapshot } from '../shared/gamification-types';
import { BILLING_CHANNELS } from '../shared/billing-types';
import type { CheckoutRequest, PlanId } from '../shared/billing-types';
import type { CostSnapshot } from '../shared/cost-types';
import { NOTE_CHANNELS } from '../shared/note-types';
import type { Note, NotesChangedEvent } from '../shared/note-types';
import { PIPE_CHANNELS } from '../shared/pipe-types';
import type { Pipe, PipeMode } from '../shared/pipe-types';
import { ONBOARDING_CHANNELS } from '../shared/onboarding-types';
import type { OnboardingPatch } from '../shared/onboarding-types';
import type {
  NexusApi,
  BrowserPaneState,
  SpawnRequest,
  SpawnResult,
  WorkspaceLayout,
  PtyDataEvent,
  PtyExitEvent,
  PtyStateChangeEvent,
  PaneSessionState,
  AdapterInfo,
} from '../shared/types';
import type {
  JarvisLiveInterruptEvent,
  JarvisLiveState,
  JarvisTranscriptAppendEvent,
  JarvisLiveToolEvent,
  JarvisLiveToolResultEvent,
  JarvisLiveTranscriptEvent,
  VoiceRuntimeInfo,
} from '../shared/voice-ipc';
import type {
  Handoff,
  BrowserPaneOpenRequest,
  Mission,
  MissionPatch,
  OrchPaneSpawnRequest,
  Squad,
  TodoList,
  TodoStatus,
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
const browserStateListeners = new Set<(state: BrowserPaneState) => void>();
const deepOpenListeners = new Set<(payload: { path: string; isDir: boolean }) => void>();
ipcRenderer.on(
  WINDOW_CHANNELS.deepOpenPath,
  (_event, payload: { path: string; isDir: boolean }) =>
    deepOpenListeners.forEach((cb) => cb(payload)),
);

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

ipcRenderer.on(BROWSER_CHANNELS.state, (_event, payload: BrowserPaneState) => {
  browserStateListeners.forEach((cb) => cb(payload));
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
const pttToggleListeners = new Set<() => void>();
ipcRenderer.on(VOICE_CHANNELS.pttToggle, () =>
  pttToggleListeners.forEach((cb) => cb()),
);

const wakeDetectedListeners = new Set<() => void>();
ipcRenderer.on(VOICE_CHANNELS.wakeDetected, () =>
  wakeDetectedListeners.forEach((cb) => cb()),
);
const narrateListeners = new Set<(event: { text: string }) => void>();
ipcRenderer.on(VOICE_CHANNELS.narrate, (_e, event: { text: string }) =>
  narrateListeners.forEach((cb) => cb(event)),
);

const voiceInfoListeners = new Set<(info: VoiceRuntimeInfo) => void>();
const liveStateListeners = new Set<(state: JarvisLiveState) => void>();
const liveTranscriptListeners = new Set<(event: JarvisLiveTranscriptEvent) => void>();
const transcriptAppendListeners = new Set<(event: JarvisTranscriptAppendEvent) => void>();
const liveToolCallListeners = new Set<(event: JarvisLiveToolEvent) => void>();
const liveToolResultListeners = new Set<(event: JarvisLiveToolResultEvent) => void>();
const liveInterruptedListeners = new Set<(event: JarvisLiveInterruptEvent) => void>();
const liveAudioOutListeners = new Set<(b64: string) => void>();
const updateStateListeners = new Set<(state: UpdateState) => void>();

ipcRenderer.on(VOICE_CHANNELS.liveAudioOut, (_event, b64: string) =>
  liveAudioOutListeners.forEach((cb) => cb(b64)),
);
ipcRenderer.on(UPDATE_CHANNELS.state, (_event, state: UpdateState) =>
  updateStateListeners.forEach((cb) => cb(state)),
);
ipcRenderer.on(VOICE_CHANNELS.pttStart, () => pttStartListeners.forEach((cb) => cb()));
ipcRenderer.on(VOICE_CHANNELS.pttStop, () => pttStopListeners.forEach((cb) => cb()));
ipcRenderer.on(VOICE_CHANNELS.infoChanged, (_event, info: VoiceRuntimeInfo) =>
  voiceInfoListeners.forEach((cb) => cb(info)),
);
ipcRenderer.on(VOICE_CHANNELS.liveState, (_event, state: JarvisLiveState) =>
  liveStateListeners.forEach((cb) => cb(state)),
);
ipcRenderer.on(
  VOICE_CHANNELS.liveTranscript,
  (_event, event: JarvisLiveTranscriptEvent) =>
    liveTranscriptListeners.forEach((cb) => cb(event)),
);
ipcRenderer.on(
  VOICE_CHANNELS.jarvisTranscriptAppend,
  (_event, event: JarvisTranscriptAppendEvent) =>
    transcriptAppendListeners.forEach((cb) => cb(event)),
);
ipcRenderer.on(VOICE_CHANNELS.liveToolCall, (_event, event: JarvisLiveToolEvent) =>
  liveToolCallListeners.forEach((cb) => cb(event)),
);
ipcRenderer.on(
  VOICE_CHANNELS.liveToolResult,
  (_event, event: JarvisLiveToolResultEvent) =>
    liveToolResultListeners.forEach((cb) => cb(event)),
);
ipcRenderer.on(
  VOICE_CHANNELS.liveInterrupted,
  (_event, event: JarvisLiveInterruptEvent) =>
    liveInterruptedListeners.forEach((cb) => cb(event)),
);

function addListener<T>(set: Set<T>, cb: T): () => void {
  set.add(cb);
  return () => set.delete(cb);
}

// Orchestration event fan-out (same pattern as voice above).
const paneSpawnRequestListeners = new Set<(req: OrchPaneSpawnRequest) => void>();
const browserOpenRequestListeners = new Set<(req: BrowserPaneOpenRequest) => void>();
const paneCloseRequestListeners = new Set<(paneId: string) => void>();
const missionsChangedListeners = new Set<(missions: Mission[]) => void>();
const handoffsChangedListeners = new Set<(handoffs: Handoff[]) => void>();
const todosChangedListeners = new Set<(lists: TodoList[]) => void>();
const squadsChangedListeners = new Set<(squads: Squad[]) => void>();

ipcRenderer.on(ORCH_CHANNELS.paneSpawnRequest, (_e, req: OrchPaneSpawnRequest) =>
  paneSpawnRequestListeners.forEach((cb) => cb(req)),
);
ipcRenderer.on(ORCH_CHANNELS.browserOpenRequest, (_e, req: BrowserPaneOpenRequest) =>
  browserOpenRequestListeners.forEach((cb) => cb(req)),
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

const uiSettingsChangedListeners = new Set<(ui: UiSettings) => void>();
ipcRenderer.on(SETTINGS_CHANNELS.uiChanged, (_e, ui: UiSettings) =>
  uiSettingsChangedListeners.forEach((cb) => cb(ui)),
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
const costChangedListeners = new Set<(snapshot: CostSnapshot) => void>();
ipcRenderer.on(ACCOUNT_CHANNELS.changed, (_e, list: AccountInfo[]) =>
  accountsChangedListeners.forEach((cb) => cb(list)),
);
ipcRenderer.on(ACCOUNT_CHANNELS.failover, (_e, event: FailoverEvent) =>
  failoverListeners.forEach((cb) => cb(event)),
);
ipcRenderer.on(COST_CHANNELS.changed, (_e, snapshot: CostSnapshot) =>
  costChangedListeners.forEach((cb) => cb(snapshot)),
);
const usageChangedListeners = new Set<(snapshot: UsageSnapshot) => void>();
ipcRenderer.on(USAGE_CHANNELS.changed, (_e, snapshot: UsageSnapshot) =>
  usageChangedListeners.forEach((cb) => cb(snapshot)),
);
const gamificationChangedListeners = new Set<
  (snapshot: GamificationSnapshot) => void
>();
ipcRenderer.on(
  GAMIFICATION_CHANNELS.changed,
  (_e, snapshot: GamificationSnapshot) =>
    gamificationChangedListeners.forEach((cb) => cb(snapshot)),
);

const notesChangedListeners = new Set<(event: NotesChangedEvent) => void>();
ipcRenderer.on(NOTE_CHANNELS.changed, (_e, event: NotesChangedEvent) =>
  notesChangedListeners.forEach((cb) => cb(event)),
);
const pipesChangedListeners = new Set<(pipes: Pipe[]) => void>();
ipcRenderer.on(PIPE_CHANNELS.changed, (_e, pipes: Pipe[]) =>
  pipesChangedListeners.forEach((cb) => cb(pipes)),
);

const api: NexusApi = {
  app: {
    signalMounted: () => ipcRenderer.send(WINDOW_CHANNELS.mounted),
    openExternal: (url: string) =>
      ipcRenderer.invoke(WINDOW_CHANNELS.openExternal, url),
    authLogin: (provider: 'github' | 'google') =>
      ipcRenderer.invoke(WINDOW_CHANNELS.authLogin, provider),
    onDeepOpenPath: (cb: (payload: { path: string; isDir: boolean }) => void) =>
      addListener(deepOpenListeners, cb),
  },
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
  browser: {
    create: (paneId: string, url?: string) =>
      ipcRenderer.invoke(BROWSER_CHANNELS.create, { paneId, url }),
    destroy: (paneId: string) =>
      ipcRenderer.send(BROWSER_CHANNELS.destroy, { paneId }),
    setBounds: (paneId, bounds) =>
      ipcRenderer.send(BROWSER_CHANNELS.bounds, { paneId, bounds }),
    load: (paneId, url) =>
      ipcRenderer.invoke(BROWSER_CHANNELS.load, { paneId, url }),
    back: (paneId) => ipcRenderer.invoke(BROWSER_CHANNELS.back, { paneId }),
    forward: (paneId) =>
      ipcRenderer.invoke(BROWSER_CHANNELS.forward, { paneId }),
    reload: (paneId) =>
      ipcRenderer.invoke(BROWSER_CHANNELS.reload, { paneId }),
    stop: (paneId) => ipcRenderer.invoke(BROWSER_CHANNELS.stop, { paneId }),
    onState: (cb) => addListener(browserStateListeners, cb),
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
  onboarding: {
    get: () => ipcRenderer.invoke(ONBOARDING_CHANNELS.get),
    set: (patch: OnboardingPatch) =>
      ipcRenderer.invoke(ONBOARDING_CHANNELS.set, patch),
  },
  update: {
    getState: () => ipcRenderer.invoke(UPDATE_CHANNELS.getState),
    check: () => ipcRenderer.invoke(UPDATE_CHANNELS.check),
    install: () => ipcRenderer.invoke(UPDATE_CHANNELS.install),
    restart: () => ipcRenderer.invoke(UPDATE_CHANNELS.restart),
    onState: (cb: (state: UpdateState) => void) =>
      addListener(updateStateListeners, cb),
  },
  voice: {
    getInfo: () => ipcRenderer.invoke(VOICE_CHANNELS.getInfo),
    setConfig: (patch) => ipcRenderer.invoke(VOICE_CHANNELS.setConfig, patch),
    setKey: (req) => ipcRenderer.invoke(VOICE_CHANNELS.setKey, req),
    transcribe: (req) => ipcRenderer.invoke(VOICE_CHANNELS.transcribe, req),
    speak: (req) => ipcRenderer.invoke(VOICE_CHANNELS.speak, req),
    recordEcho: (text: string) => ipcRenderer.invoke(VOICE_CHANNELS.recordEcho, { text }),
    stopSpeak: () => ipcRenderer.invoke(VOICE_CHANNELS.speakStop),
    sendWakeAudio: (chunk: ArrayBuffer) =>
      ipcRenderer.send(VOICE_CHANNELS.wakeAudio, chunk),
    logVoice: (payload) => ipcRenderer.send(VOICE_CHANNELS.logEvent, payload),
    openMicSettings: () => ipcRenderer.send(VOICE_CHANNELS.openMicSettings),
    openSoundSettings: () => ipcRenderer.send(VOICE_CHANNELS.openSoundSettings),
    resetMicPermission: () => ipcRenderer.invoke(VOICE_CHANNELS.micResetTcc),
    jarvis: (req) => ipcRenderer.invoke(VOICE_CHANNELS.jarvis, req),
    confirmCommand: (command: string) =>
      ipcRenderer.invoke(VOICE_CHANNELS.confirmCommand, command),
    liveStart: (req) => ipcRenderer.invoke(VOICE_CHANNELS.liveStart, req ?? {}),
    liveStop: () => ipcRenderer.invoke(VOICE_CHANNELS.liveStop),
    liveHardRebuild: () => ipcRenderer.invoke(VOICE_CHANNELS.liveHardRebuild),
    liveHardTeardown: () => ipcRenderer.invoke(VOICE_CHANNELS.liveHardTeardown),
    liveEndTurn: () => ipcRenderer.invoke(VOICE_CHANNELS.liveEndTurn),
    liveSmokeTest: (req) => ipcRenderer.invoke(VOICE_CHANNELS.liveSmokeTest, req),
    liveSay: (req) => ipcRenderer.invoke(VOICE_CHANNELS.liveSay, req),
    liveStatus: (patch) => ipcRenderer.invoke(VOICE_CHANNELS.liveStatus, patch),
    liveTranscript: (event) =>
      ipcRenderer.send(VOICE_CHANNELS.liveTranscriptIn, event),
    liveToolResult: (event) =>
      ipcRenderer.send(VOICE_CHANNELS.liveToolResultIn, event),
    liveInterrupt: (reason) =>
      ipcRenderer.invoke(VOICE_CHANNELS.liveInterrupt, { reason }),
    liveMicIn: (b64: string) => ipcRenderer.send(VOICE_CHANNELS.liveMicIn, b64),
    liveContextIn: (text: string) =>
      ipcRenderer.send(VOICE_CHANNELS.liveContextIn, text),
    onLiveAudioOut: (cb: (b64: string) => void) =>
      addListener(liveAudioOutListeners, cb),
    onPttToggle: (cb: () => void) => addListener(pttToggleListeners, cb),
    onWakeDetected: (cb: () => void) => addListener(wakeDetectedListeners, cb),
    onPttStart: (cb) => addListener(pttStartListeners, cb),
    onPttStop: (cb) => addListener(pttStopListeners, cb),
    onInfoChanged: (cb) => addListener(voiceInfoListeners, cb),
    onNarrate: (cb: (event: { text: string }) => void) =>
      addListener(narrateListeners, cb),
    onLiveState: (cb) => addListener(liveStateListeners, cb),
    onLiveTranscript: (cb) => addListener(liveTranscriptListeners, cb),
    onTranscriptAppend: (cb) => addListener(transcriptAppendListeners, cb),
    onLiveToolCall: (cb) => addListener(liveToolCallListeners, cb),
    onLiveToolResult: (cb) => addListener(liveToolResultListeners, cb),
    onLiveInterrupted: (cb) => addListener(liveInterruptedListeners, cb),
  },
  orch: {
    syncPanes: (entries) => ipcRenderer.send(ORCH_CHANNELS.panesSync, entries),
    sendPaneSpawnResult: (result) =>
      ipcRenderer.send(ORCH_CHANNELS.paneSpawnResult, result),
    onBrowserOpenRequest: (cb) =>
      addListener(browserOpenRequestListeners, cb),
    sendBrowserOpenResult: (result) =>
      ipcRenderer.send(ORCH_CHANNELS.browserOpenResult, result),
    onPaneSpawnRequest: (cb) => addListener(paneSpawnRequestListeners, cb),
    onPaneCloseRequest: (cb) => addListener(paneCloseRequestListeners, cb),
    listMissions: () => ipcRenderer.invoke(ORCH_CHANNELS.missionsList),
    listMissionPanes: (missionId: string) =>
      ipcRenderer.invoke(ORCH_CHANNELS.missionPanesList, missionId),
    createMission: (input: {
      title: string;
      squadId?: string;
      orchestratorPane?: {
        paneId: string;
        adapterId: string;
        model?: string;
        cwd?: string;
        title?: string;
        agentName?: string;
      };
    }) => ipcRenderer.invoke(ORCH_CHANNELS.missionCreate, input),
    rebindMissionOrchestrator: (missionId: string, sessionId: string) =>
      ipcRenderer.invoke(ORCH_CHANNELS.missionRebind, { missionId, sessionId }),
    updateMission: (missionId: string, patch: MissionPatch) =>
      ipcRenderer.invoke(ORCH_CHANNELS.missionUpdate, { missionId, patch }),
    removeMission: (missionId: string) =>
      ipcRenderer.invoke(ORCH_CHANNELS.missionRemove, missionId),
    listHandoffs: () => ipcRenderer.invoke(ORCH_CHANNELS.handoffsList),
    getTodos: () => ipcRenderer.invoke(ORCH_CHANNELS.todosGet),
    setTodoStatus: (listId: string, itemId: string, status: TodoStatus) =>
      ipcRenderer.invoke(ORCH_CHANNELS.todoSetStatus, { listId, itemId, status }),
    listSquads: () => ipcRenderer.invoke(ORCH_CHANNELS.squadsList),
    designSquad: (workspacePath: string, intent?: string) =>
      ipcRenderer.invoke(
        ORCH_CHANNELS.squadDesign,
        intent ? { workspacePath, intent } : workspacePath,
      ),
    saveSquad: (squad) => ipcRenderer.invoke(ORCH_CHANNELS.squadSave, squad),
    deleteSquad: (id) => ipcRenderer.invoke(ORCH_CHANNELS.squadDelete, id),
    exportSquads: () => ipcRenderer.invoke(ORCH_CHANNELS.squadExport),
    importSquads: () => ipcRenderer.invoke(ORCH_CHANNELS.squadImport),
    getMcpInfo: () => ipcRenderer.invoke(ORCH_CHANNELS.mcpInfo),
    getCatalogIndex: (refresh?: boolean) =>
      ipcRenderer.invoke(ORCH_CHANNELS.catalogIndex, { refresh }),
    installCatalogItem: (req) =>
      ipcRenderer.invoke(ORCH_CHANNELS.catalogInstall, req),
    getRecipeOverlay: (workspacePath?: string) =>
      ipcRenderer.invoke(ORCH_CHANNELS.recipeOverlay, { workspacePath }),
    saveCatalogOverlay: (patch) =>
      ipcRenderer.invoke(ORCH_CHANNELS.catalogOverlaySave, patch),
    proposeRecipes: (workspacePath?: string) =>
      ipcRenderer.invoke(ORCH_CHANNELS.recipePropose, { workspacePath }),
    writeAgentSpec: (req) =>
      ipcRenderer.invoke(ORCH_CHANNELS.agentSpecWrite, req),
    listInstalledCatalog: () =>
      ipcRenderer.invoke(ORCH_CHANNELS.catalogInstalled),
    harnessEnriched: () => ipcRenderer.invoke(ORCH_CHANNELS.harnessEnriched),
    harnessEnrich: () => ipcRenderer.invoke(ORCH_CHANNELS.harnessEnrich),
    listNativeTools: () => ipcRenderer.invoke(ORCH_CHANNELS.toolsList),
    listPluginFiles: () => ipcRenderer.invoke(ORCH_CHANNELS.pluginsList),
    listHookHomes: () => ipcRenderer.invoke(ORCH_CHANNELS.hooksList),
    onMissionsChanged: (cb) => addListener(missionsChangedListeners, cb),
    onHandoffsChanged: (cb) => addListener(handoffsChangedListeners, cb),
    onTodosChanged: (cb) => addListener(todosChangedListeners, cb),
    onSquadsChanged: (cb) => addListener(squadsChangedListeners, cb),
  },
  remote: {
    bridgeStatus: () => ipcRenderer.invoke(REMOTE_CHANNELS.bridgeStatus),
    bridgeStart: (req) => ipcRenderer.invoke(REMOTE_CHANNELS.bridgeStart, req ?? {}),
    bridgeStop: () => ipcRenderer.invoke(REMOTE_CHANNELS.bridgeStop),
    bridgeRotatePairing: () =>
      ipcRenderer.invoke(REMOTE_CHANNELS.bridgeRotatePairing),
    bridgeRevokeTokens: () =>
      ipcRenderer.invoke(REMOTE_CHANNELS.bridgeRevokeTokens),
    detectClis: (target) =>
      ipcRenderer.invoke(REMOTE_CHANNELS.remoteSpawnDetect, { target }),
    listTmux: (target) =>
      ipcRenderer.invoke(REMOTE_CHANNELS.remoteSpawnList, { target }),
    createTmux: (req) =>
      ipcRenderer.invoke(REMOTE_CHANNELS.remoteSpawnCreate, req),
  },
  settings: {
    get: () => ipcRenderer.invoke(SETTINGS_CHANNELS.get),
    set: (patch) => ipcRenderer.invoke(SETTINGS_CHANNELS.set, patch),
    onChanged: (cb) => addListener(settingsChangedListeners, cb),
    orchGet: () => ipcRenderer.invoke(SETTINGS_CHANNELS.orchGet),
    orchSet: (patch) => ipcRenderer.invoke(SETTINGS_CHANNELS.orchSet, patch),
    uiGet: () => ipcRenderer.invoke(SETTINGS_CHANNELS.uiGet),
    uiSet: (patch) => ipcRenderer.invoke(SETTINGS_CHANNELS.uiSet, patch),
    onUiChanged: (cb) => addListener(uiSettingsChangedListeners, cb),
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
    authStatus: () => ipcRenderer.invoke(PROVIDER_CHANNELS.authStatus),
    addModel: (adapterId: string, model: string) =>
      ipcRenderer.invoke(PROVIDER_CHANNELS.addModel, { adapterId, model }),
    removeModel: (adapterId: string, model: string) =>
      ipcRenderer.invoke(PROVIDER_CHANNELS.removeModel, { adapterId, model }),
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
      } catch (err) {
        // Sem o path real o drop cai no fallback (salvar blob) — deixa rastro
        // no console em vez de falhar 100% silencioso.
        console.warn('[preload] pathForFile falhou para', file.name, err);
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
  cost: {
    snapshot: () => ipcRenderer.invoke(COST_CHANNELS.snapshot),
    setCap: (paneId: string, capUsd: number | null) =>
      ipcRenderer.invoke(COST_CHANNELS.setCap, { paneId, capUsd }),
    onChanged: (cb: (snapshot: CostSnapshot) => void) =>
      addListener(costChangedListeners, cb),
  },
  usage: {
    snapshot: () => ipcRenderer.invoke(USAGE_CHANNELS.snapshot),
    onChanged: (cb: (snapshot: UsageSnapshot) => void) =>
      addListener(usageChangedListeners, cb),
  },
  gamification: {
    snapshot: () => ipcRenderer.invoke(GAMIFICATION_CHANNELS.snapshot),
    selectSkin: (skin: string | null) =>
      ipcRenderer.invoke(GAMIFICATION_CHANNELS.selectSkin, { skin }),
    exportProfile: () =>
      ipcRenderer.invoke(GAMIFICATION_CHANNELS.exportProfile),
    importProfile: () =>
      ipcRenderer.invoke(GAMIFICATION_CHANNELS.importProfile),
    prestige: () => ipcRenderer.invoke(GAMIFICATION_CHANNELS.prestige),
    recordJarvisAction: (input: { actionType: string; ok: boolean }) =>
      ipcRenderer.invoke(GAMIFICATION_CHANNELS.recordJarvisAction, input),
    onChanged: (cb: (snapshot: GamificationSnapshot) => void) =>
      addListener(gamificationChangedListeners, cb),
  },
  perf: {
    snapshot: () => ipcRenderer.invoke(PERF_CHANNELS.snapshot),
  },
  mcp: {
    invoke: (tool: string, args: Record<string, unknown> = {}) =>
      ipcRenderer.invoke(MCP_CHANNELS.invoke, { tool, args }),
    confirm: (tool: string, args: Record<string, unknown> = {}) =>
      ipcRenderer.invoke(MCP_CHANNELS.confirm, { tool, args }),
    clearSession: () => ipcRenderer.invoke(MCP_CHANNELS.clearSession),
  },
  ops: {
    auditLog: (limit?: number) => ipcRenderer.invoke(OPS_CHANNELS.auditLog, limit),
    releaseReadiness: () => ipcRenderer.invoke(OPS_CHANNELS.releaseReadiness),
  },
  media: {
    listProviders: () => ipcRenderer.invoke(MEDIA_CHANNELS.listProviders),
    setKey: (providerId: MediaProviderId, key: string) =>
      ipcRenderer.invoke(MEDIA_CHANNELS.setKey, { providerId, key }),
    usageTotals: () => ipcRenderer.invoke(MEDIA_CHANNELS.usageTotals),
  },
  notes: {
    list: (workspacePath: string) =>
      ipcRenderer.invoke(NOTE_CHANNELS.list, { workspacePath }),
    save: (workspacePath: string, note: Note) =>
      ipcRenderer.invoke(NOTE_CHANNELS.save, { workspacePath, note }),
    remove: (id: string) => ipcRenderer.invoke(NOTE_CHANNELS.remove, { id }),
    onChanged: (cb) => addListener(notesChangedListeners, cb),
  },
  pipes: {
    list: () => ipcRenderer.invoke(PIPE_CHANNELS.list),
    add: (sourcePaneId: string, targetPaneId: string, mode: PipeMode) =>
      ipcRenderer.invoke(PIPE_CHANNELS.add, { sourcePaneId, targetPaneId, mode }),
    remove: (id: string) => ipcRenderer.invoke(PIPE_CHANNELS.remove, { id }),
    onChanged: (cb) => addListener(pipesChangedListeners, cb),
  },
  billing: {
    get: () => ipcRenderer.invoke(BILLING_CHANNELS.get),
    openCheckout: (request: PlanId | CheckoutRequest) =>
      ipcRenderer.invoke(BILLING_CHANNELS.checkout, request),
    openPortal: () => ipcRenderer.invoke(BILLING_CHANNELS.portal),
  },
  team: {
    get: () => ipcRenderer.invoke(TEAM_CHANNELS.get),
    join: (code: string) => ipcRenderer.invoke(TEAM_CHANNELS.join, code),
    invite: () => ipcRenderer.invoke(TEAM_CHANNELS.invite),
    removeMember: (accountId: string) =>
      ipcRenderer.invoke(TEAM_CHANNELS.remove, accountId),
    leave: () => ipcRenderer.invoke(TEAM_CHANNELS.leave),
  },
  // Fase 5 — Jarvis Vision: screen capture + AX tree + OCR
  vision: {
    capture: () => ipcRenderer.invoke(VISION_CHANNELS.capture),
    getImage: (request) => ipcRenderer.invoke(VISION_CHANNELS.getImage, request),
    setImageConsent: (allowCloudImage: boolean) =>
      ipcRenderer.invoke(VISION_CHANNELS.setImageConsent, { allowCloudImage }),
    context: (options) => ipcRenderer.invoke(VISION_CHANNELS.context, options),
    getAxTree: () => getAxTree(),
    ocr: (imageBase64: string) => ipcRenderer.invoke(VISION_CHANNELS.ocr, imageBase64),
    checkPermission: () => ipcRenderer.invoke(VISION_CHANNELS.permission),
    onCaptured: (cb: (result: ScreenCaptureMetadata) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, result: ScreenCaptureMetadata) => cb(result);
      ipcRenderer.on(VISION_CHANNELS.captured, handler);
      return () => ipcRenderer.removeListener(VISION_CHANNELS.captured, handler);
    },
  },
  platform: process.platform,
};

contextBridge.exposeInMainWorld('nexus', api);
