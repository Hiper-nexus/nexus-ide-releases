import { contextBridge, ipcRenderer, webUtils } from 'electron';
import {
  PTY_CHANNELS,
  BROWSER_CHANNELS,
  DESIGN_WRITEBACK_CHANNELS,
  DEV_SERVER_CHANNELS,
  PERF_CHANNELS,
  MCP_CHANNELS,
  LAYOUT_CHANNELS,
  ADAPTER_CHANNELS,
  WINDOW_CHANNELS,
  TEAM_CHANNELS,
} from '../shared/channels';
import { OPS_CHANNELS } from '../shared/ops-ipc';
import { PET_CHANNELS } from '../shared/pet-types';
import type { PetPrefs } from '../shared/pet-types';
import { VOICE_CHANNELS } from '../shared/voice-channels';
import { VISION_CHANNELS } from '../shared/vision-ipc';
import type { ScreenCaptureMetadata } from '../shared/vision-ipc';
import { getAxTree, performAxAction } from './ax-tree';
import { runFunctionalSmokeProbes } from './functional-smoke';
import { UPDATE_CHANNELS } from '../shared/update-ipc';
import type { UpdateState } from '../shared/update-ipc';
import { ORCH_CHANNELS } from '../shared/orch-channels';
import { REMOTE_CHANNELS } from '../shared/remote-channels';
import { SETTINGS_CHANNELS } from '../shared/settings-types';
import type {
  AudioSettings,
  TerminalSettings,
  UiSettings,
} from '../shared/settings-types';
import { WORKSPACE_CHANNELS } from '../shared/workspace-types';
import type { WorkspaceState } from '../shared/workspace-types';
import { ORIENTATION_CHANNELS } from '../shared/orientation-types';
import type { OrientationSnapshot } from '../shared/orientation-types';
import { PROVIDER_CHANNELS } from '../shared/provider-settings-types';
import type { ProviderSettingsInfo } from '../shared/provider-settings-types';
import { FILES_CHANNELS } from '../shared/files-types';
import { INTEGRATIONS_CHANNELS } from '../shared/integrations-types';
import { ACCOUNT_CHANNELS } from '../shared/account-types';
import type {
  AccountActivatedEvent,
  AccountInfo,
  AccountQuotaInfo,
  FailoverEvent,
} from '../shared/account-types';
import { COST_CHANNELS } from '../shared/cost-types';
import { USAGE_CHANNELS } from '../shared/usage-types';
import type { UsageSnapshot } from '../shared/usage-types';
import { QUOTA_CHANNELS } from '../shared/quota-types';
import type { QuotaFleetSnapshot } from '../shared/quota-types';
import { EVAL_RANKING_CHANNELS } from '../shared/eval-ranking-types';
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
  BrowserDesignEventPayload,
  BrowserPaneState,
  DevServerDetectedPayload,
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
  JarvisLiveAudioOutEvent,
  JarvisLiveAudioPlaybackEvent,
  JarvisLiveState,
  JarvisTranscriptAppendEvent,
  JarvisLiveToolEvent,
  JarvisLiveToolCancellationEvent,
  JarvisLiveToolResultEvent,
  JarvisLiveToolTurnCompleteEvent,
  JarvisLiveTranscriptEvent,
  VoiceRuntimeInfo,
} from '../shared/voice-ipc';
import type {
  Handoff,
  BrowserPaneOpenRequest,
  Mission,
  MissionPatch,
  MissionPaneRecoveryRequest,
  MissionPaneRecoveryResult,
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
/** Contiguous high-water: only advances for in-order sequences. */
const lastPtySequence = new Map<string, number>();
/** Out-of-order chunks waiting for the gap to fill (seq → data). */
const pendingPtyChunks = new Map<string, Map<number, string>>();
const exitSubs = new Map<string, Set<ExitCb>>();
const stateSubs = new Map<string, Set<StateCb>>();
const browserStateListeners = new Set<(state: BrowserPaneState) => void>();
const browserDesignListeners = new Set<
  (payload: BrowserDesignEventPayload) => void
>();
const devServerListeners = new Set<(payload: DevServerDetectedPayload) => void>();
const deepOpenListeners = new Set<(payload: { path: string; isDir: boolean }) => void>();
ipcRenderer.on(
  WINDOW_CHANNELS.deepOpenPath,
  (_event, payload: { path: string; isDir: boolean }) =>
    deepOpenListeners.forEach((cb) => cb(payload)),
);

function clearPtySequenceState(sessionId: string): void {
  lastPtySequence.delete(sessionId);
  pendingPtyChunks.delete(sessionId);
}

function emitContiguousPtyData(sessionId: string, sequence: number, data: string): void {
  lastPtySequence.set(sessionId, sequence);
  dataSubs.get(sessionId)?.forEach((cb) => cb(data));
  ipcRenderer.send(PTY_CHANNELS.acknowledge, { sessionId, sequence });
}

/**
 * Deliver PTY data only in contiguous sequence order. Gaps are buffered and
 * recovered; reordered chunks are never permanently dropped by advancing the
 * high-water mark past a hole.
 */
function deliverPtyData(payload: PtyDataEvent): void {
  const sessionId = payload.sessionId;
  const previous = lastPtySequence.get(sessionId) ?? 0;
  const expected = previous + 1;
  if (payload.sequence <= previous) return; // duplicate / already acked
  if (payload.sequence > expected) {
    let pending = pendingPtyChunks.get(sessionId);
    if (!pending) {
      pending = new Map();
      pendingPtyChunks.set(sessionId, pending);
    }
    pending.set(payload.sequence, payload.data);
    // Pull the gap immediately (quiet cadence is a backstop only).
    void ipcRenderer
      .invoke(PTY_CHANNELS.recover, {
        sessionId,
        afterSequence: previous,
      })
      .then((events: PtyDataEvent[]) => events.forEach(deliverPtyData))
      .catch(() => {});
    return;
  }
  // Contiguous: emit this chunk then any buffered successors.
  emitContiguousPtyData(sessionId, payload.sequence, payload.data);
  const pending = pendingPtyChunks.get(sessionId);
  if (!pending || pending.size === 0) return;
  let next = payload.sequence + 1;
  while (pending.has(next)) {
    const chunk = pending.get(next)!;
    pending.delete(next);
    emitContiguousPtyData(sessionId, next, chunk);
    next += 1;
  }
  if (pending.size === 0) pendingPtyChunks.delete(sessionId);
}

ipcRenderer.on(PTY_CHANNELS.data, (_event, payload: PtyDataEvent) => {
  deliverPtyData(payload);
});

// Invoke remains operational when main→renderer push wedges. Pull from the
// contiguous high-water so recover never skips a hole.
setInterval(() => {
  for (const sessionId of dataSubs.keys()) {
    const afterSequence = lastPtySequence.get(sessionId) ?? 0;
    void ipcRenderer
      .invoke(PTY_CHANNELS.recover, { sessionId, afterSequence })
      .then((events: PtyDataEvent[]) => events.forEach(deliverPtyData))
      .catch(() => {});
  }
}, 15_000);

ipcRenderer.on(PTY_CHANNELS.exit, (_event, payload: PtyExitEvent) => {
  clearPtySequenceState(payload.sessionId);
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

ipcRenderer.on(
  BROWSER_CHANNELS.designEvent,
  (_event, payload: BrowserDesignEventPayload) => {
    browserDesignListeners.forEach((cb) => cb(payload));
  },
);

ipcRenderer.on(
  DEV_SERVER_CHANNELS.detected,
  (_event, payload: DevServerDetectedPayload) => {
    devServerListeners.forEach((cb) => cb(payload));
  },
);

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
const narrateListeners = new Set<(event: import('../shared/voice-ipc').VoiceNarrationEvent) => void>();
ipcRenderer.on(VOICE_CHANNELS.narrate, (_e, event: import('../shared/voice-ipc').VoiceNarrationEvent) =>
  narrateListeners.forEach((cb) => cb(event)),
);

const voiceInfoListeners = new Set<(info: VoiceRuntimeInfo) => void>();
const liveStateListeners = new Set<(state: JarvisLiveState) => void>();
const liveTranscriptListeners = new Set<(event: JarvisLiveTranscriptEvent) => void>();
const transcriptAppendListeners = new Set<(event: JarvisTranscriptAppendEvent) => void>();
const liveToolCallListeners = new Set<(event: JarvisLiveToolEvent) => void>();
const liveToolCancelledListeners = new Set<
  (event: JarvisLiveToolCancellationEvent) => void
>();
const liveToolResultListeners = new Set<(event: JarvisLiveToolResultEvent) => void>();
const liveToolTurnCompleteListeners = new Set<
  (event: JarvisLiveToolTurnCompleteEvent) => void
>();
const liveInterruptedListeners = new Set<(event: JarvisLiveInterruptEvent) => void>();
const liveAudioOutListeners = new Set<(event: JarvisLiveAudioOutEvent) => void>();
const updateStateListeners = new Set<(state: UpdateState) => void>();

ipcRenderer.on(VOICE_CHANNELS.liveAudioOut, (_event, payload: JarvisLiveAudioOutEvent) =>
  liveAudioOutListeners.forEach((cb) => cb(payload)),
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
  VOICE_CHANNELS.liveToolCancelled,
  (_event, event: JarvisLiveToolCancellationEvent) =>
    liveToolCancelledListeners.forEach((cb) => cb(event)),
);
ipcRenderer.on(
  VOICE_CHANNELS.liveToolResult,
  (_event, event: JarvisLiveToolResultEvent) =>
    liveToolResultListeners.forEach((cb) => cb(event)),
);
ipcRenderer.on(
  VOICE_CHANNELS.liveToolTurnComplete,
  (_event, event: JarvisLiveToolTurnCompleteEvent) =>
    liveToolTurnCompleteListeners.forEach((cb) => cb(event)),
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
const paneRecoveryRequestListeners = new Set<
  (req: MissionPaneRecoveryRequest) => void
>();
const browserOpenRequestListeners = new Set<(req: BrowserPaneOpenRequest) => void>();
const paneCloseRequestListeners = new Set<(paneId: string) => void>();
const missionsChangedListeners = new Set<(missions: Mission[]) => void>();
const handoffsChangedListeners = new Set<(handoffs: Handoff[]) => void>();
const todosChangedListeners = new Set<(lists: TodoList[]) => void>();
const squadsChangedListeners = new Set<(squads: Squad[]) => void>();

ipcRenderer.on(ORCH_CHANNELS.paneSpawnRequest, (_e, req: OrchPaneSpawnRequest) =>
  paneSpawnRequestListeners.forEach((cb) => cb(req)),
);
ipcRenderer.on(
  ORCH_CHANNELS.paneRecoveryRequest,
  (_e, req: MissionPaneRecoveryRequest) =>
    paneRecoveryRequestListeners.forEach((cb) => cb(req)),
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

const audioSettingsChangedListeners = new Set<(audio: AudioSettings) => void>();
ipcRenderer.on(SETTINGS_CHANNELS.audioChanged, (_e, audio: AudioSettings) =>
  audioSettingsChangedListeners.forEach((cb) => cb(audio)),
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
const accountActivatedListeners = new Set<(event: AccountActivatedEvent) => void>();
const costChangedListeners = new Set<(snapshot: CostSnapshot) => void>();
ipcRenderer.on(ACCOUNT_CHANNELS.changed, (_e, list: AccountInfo[]) =>
  accountsChangedListeners.forEach((cb) => cb(list)),
);
ipcRenderer.on(ACCOUNT_CHANNELS.failover, (_e, event: FailoverEvent) =>
  failoverListeners.forEach((cb) => cb(event)),
);
ipcRenderer.on(ACCOUNT_CHANNELS.activated, (_e, event: AccountActivatedEvent) =>
  accountActivatedListeners.forEach((cb) => cb(event)),
);
ipcRenderer.on(COST_CHANNELS.changed, (_e, snapshot: CostSnapshot) =>
  costChangedListeners.forEach((cb) => cb(snapshot)),
);
const usageChangedListeners = new Set<(snapshot: UsageSnapshot) => void>();
ipcRenderer.on(USAGE_CHANNELS.changed, (_e, snapshot: UsageSnapshot) =>
  usageChangedListeners.forEach((cb) => cb(snapshot)),
);
const quotaChangedListeners = new Set<(snapshot: QuotaFleetSnapshot) => void>();
ipcRenderer.on(QUOTA_CHANNELS.changed, (_e, snapshot: QuotaFleetSnapshot) =>
  quotaChangedListeners.forEach((cb) => cb(snapshot)),
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
  pet: {
    getPrefs: () => ipcRenderer.invoke(PET_CHANNELS.getPrefs),
    setPrefs: (patch: Partial<PetPrefs>) =>
      ipcRenderer.invoke(PET_CHANNELS.setPrefs, patch),
    onPrefsChanged: (cb: (prefs: PetPrefs) => void) => {
      const listener = (_e: unknown, prefs: PetPrefs) => cb(prefs);
      ipcRenderer.on(PET_CHANNELS.prefsChanged, listener);
      return () =>
        ipcRenderer.removeListener(PET_CHANNELS.prefsChanged, listener);
    },
    onOpenSettings: (cb: () => void) => {
      const listener = () => cb();
      ipcRenderer.on(PET_CHANNELS.openSettings, listener);
      return () =>
        ipcRenderer.removeListener(PET_CHANNELS.openSettings, listener);
    },
    onOpenOps: (cb: () => void) => {
      const listener = () => cb();
      ipcRenderer.on(PET_CHANNELS.openOps, listener);
      return () => ipcRenderer.removeListener(PET_CHANNELS.openOps, listener);
    },
    onAttention: (cb: (event: import('../shared/pet-types').PetEvent) => void) => {
      const listener = (_e: unknown, event: import('../shared/pet-types').PetEvent) =>
        cb(event);
      ipcRenderer.on(PET_CHANNELS.attention, listener);
      return () =>
        ipcRenderer.removeListener(PET_CHANNELS.attention, listener);
    },
    galleryImport: (slugOrUrl: string) =>
      ipcRenderer.invoke(PET_CHANNELS.galleryImport, slugOrUrl),
    galleryList: () => ipcRenderer.invoke(PET_CHANNELS.galleryList),
    libraryList: () => ipcRenderer.invoke(PET_CHANNELS.libraryList),
    libraryApply: (id: string) =>
      ipcRenderer.invoke(PET_CHANNELS.libraryApply, id),
    libraryPreview: (id: string) =>
      ipcRenderer.invoke(PET_CHANNELS.libraryPreview, id),
    installedList: () => ipcRenderer.invoke(PET_CHANNELS.installedList),
    installedApply: (id: string) =>
      ipcRenderer.invoke(PET_CHANNELS.installedApply, id),
    installedPreview: (id: string) =>
      ipcRenderer.invoke(PET_CHANNELS.installedPreview, id),
    installedDelete: (id: string) =>
      ipcRenderer.invoke(PET_CHANNELS.installedDelete, id),
    pickSheet: () => ipcRenderer.invoke(PET_CHANNELS.pickSheet),
    pickImage: () => ipcRenderer.invoke(PET_CHANNELS.pickImage),
  },
  app: {
    signalMounted: (report) => ipcRenderer.send(WINDOW_CHANNELS.mounted, report),
    openExternal: (url: string) =>
      ipcRenderer.invoke(WINDOW_CHANNELS.openExternal, url),
    authLogin: (provider: 'github' | 'google') =>
      ipcRenderer.invoke(WINDOW_CHANNELS.authLogin, provider),
    openLegalNotices: () => ipcRenderer.invoke(WINDOW_CHANNELS.openLegalNotices),
    onDeepOpenPath: (cb: (payload: { path: string; isDir: boolean }) => void) =>
      addListener(deepOpenListeners, cb),
  },
  pty: {
    spawn: (req: SpawnRequest): Promise<SpawnResult> =>
      ipcRenderer.invoke(PTY_CHANNELS.spawn, req),
    write: (sessionId, data) =>
      ipcRenderer.send(PTY_CHANNELS.write, { sessionId, data }),
    writeConfirmed: (sessionId, data) =>
      ipcRenderer.invoke(PTY_CHANNELS.writeConfirmed, { sessionId, data }),
    resize: (sessionId, cols, rows) =>
      ipcRenderer.send(PTY_CHANNELS.resize, { sessionId, cols, rows }),
    kill: (sessionId) => ipcRenderer.send(PTY_CHANNELS.kill, { sessionId }),
    onData: (sessionId, cb) => {
      const unsub = subscribe(dataSubs, sessionId, cb);
      return () => {
        unsub();
        if (!dataSubs.has(sessionId)) clearPtySequenceState(sessionId);
      };
    },
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
    setDesignMode: (paneId: string, active: boolean) =>
      ipcRenderer.invoke(BROWSER_CHANNELS.designMode, { paneId, active }),
    sendDesignSelection: (paneId, payload) =>
      ipcRenderer.invoke(BROWSER_CHANNELS.designSend, { paneId, ...payload }),
    onDesignEvent: (cb) => addListener(browserDesignListeners, cb),
    setStylePreview: (paneId, selector, styles) =>
      ipcRenderer.invoke(BROWSER_CHANNELS.designPreview, {
        paneId,
        selector,
        styles,
      }),
    clearStylePreview: (paneId, selector) =>
      ipcRenderer.invoke(BROWSER_CHANNELS.designPreviewClear, {
        paneId,
        ...(selector ? { selector } : {}),
      }),
  },
  devServer: {
    onDetected: (cb) => addListener(devServerListeners, cb),
  },
  design: {
    status: (binding) => ipcRenderer.invoke(DESIGN_WRITEBACK_CHANNELS.status, binding),
    start: (binding) => ipcRenderer.invoke(DESIGN_WRITEBACK_CHANNELS.start, binding),
    stop: (binding) => ipcRenderer.invoke(DESIGN_WRITEBACK_CHANNELS.stop, binding),
    apply: (binding, action) =>
      ipcRenderer.invoke(DESIGN_WRITEBACK_CHANNELS.action, { binding, action }),
    undo: (binding) => ipcRenderer.invoke(DESIGN_WRITEBACK_CHANNELS.undo, binding),
    redo: (binding) => ipcRenderer.invoke(DESIGN_WRITEBACK_CHANNELS.redo, binding),
  },
  layout: {
    save: (workspacePath: string, layout: WorkspaceLayout) =>
      ipcRenderer.invoke(LAYOUT_CHANNELS.save, { workspacePath, layout }),
    saveSync: (workspacePath: string, layout: WorkspaceLayout) =>
      ipcRenderer.sendSync(LAYOUT_CHANNELS.saveSync, { workspacePath, layout }) === true,
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
    livePrewarm: (enabled) =>
      ipcRenderer.invoke(VOICE_CHANNELS.livePrewarm, { enabled }),
    liveStop: () => ipcRenderer.invoke(VOICE_CHANNELS.liveStop),
    liveHardRebuild: () => ipcRenderer.invoke(VOICE_CHANNELS.liveHardRebuild),
    liveHardTeardown: () => ipcRenderer.invoke(VOICE_CHANNELS.liveHardTeardown),
    liveQuiesce: (reason) =>
      ipcRenderer.invoke(VOICE_CHANNELS.liveQuiesce, { reason }),
    liveEndTurn: () => ipcRenderer.invoke(VOICE_CHANNELS.liveEndTurn),
    liveEndUserAudio: () => ipcRenderer.invoke(VOICE_CHANNELS.liveEndUserAudio),
    liveTurnBegin: (turnId) =>
      ipcRenderer.send(VOICE_CHANNELS.liveTurnBegin, turnId),
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
    liveRescueIn: (req) =>
      ipcRenderer.invoke(VOICE_CHANNELS.liveRescueIn, req),
    liveContextIn: (text: string) =>
      ipcRenderer.send(VOICE_CHANNELS.liveContextIn, text),
    liveAudioPlayback: (event: JarvisLiveAudioPlaybackEvent) =>
      ipcRenderer.send(VOICE_CHANNELS.liveAudioPlayback, event),
    onLiveAudioOut: (cb: (event: JarvisLiveAudioOutEvent) => void) =>
      addListener(liveAudioOutListeners, cb),
    onPttToggle: (cb: () => void) => addListener(pttToggleListeners, cb),
    onWakeDetected: (cb: () => void) => addListener(wakeDetectedListeners, cb),
    onPttStart: (cb) => addListener(pttStartListeners, cb),
    onPttStop: (cb) => addListener(pttStopListeners, cb),
    onInfoChanged: (cb) => addListener(voiceInfoListeners, cb),
    onNarrate: (cb: (event: import('../shared/voice-ipc').VoiceNarrationEvent) => void) =>
      addListener(narrateListeners, cb),
    onLiveState: (cb) => addListener(liveStateListeners, cb),
    onLiveTranscript: (cb) => addListener(liveTranscriptListeners, cb),
    onTranscriptAppend: (cb) => addListener(transcriptAppendListeners, cb),
    onLiveToolCall: (cb) => addListener(liveToolCallListeners, cb),
    onLiveToolCancelled: (cb) => addListener(liveToolCancelledListeners, cb),
    onLiveToolResult: (cb) => addListener(liveToolResultListeners, cb),
    onLiveToolTurnComplete: (cb) => addListener(liveToolTurnCompleteListeners, cb),
    onLiveInterrupted: (cb) => addListener(liveInterruptedListeners, cb),
  },
  orch: {
    syncPanes: (entries) => ipcRenderer.send(ORCH_CHANNELS.panesSync, entries),
    sendPaneSpawnResult: (result) =>
      ipcRenderer.send(ORCH_CHANNELS.paneSpawnResult, result),
    sendPaneRecoveryResult: (result: MissionPaneRecoveryResult) =>
      ipcRenderer.send(ORCH_CHANNELS.paneRecoveryResult, result),
    onPaneRecoveryRequest: (cb) =>
      addListener(paneRecoveryRequestListeners, cb),
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
        accountId?: string;
        cwd?: string;
        title?: string;
        agentName?: string;
      };
    }) => ipcRenderer.invoke(ORCH_CHANNELS.missionCreate, input),
    armMission: (input: { title: string; squadId: string }) =>
      ipcRenderer.invoke(ORCH_CHANNELS.missionArm, input),
    submitMissionIntent: (input: {
      missionId: string;
      goal: string;
      source?: 'typed' | 'voice' | 'imported-issue' | 'automation';
      /** prepare-project is NOT accepted — use prepareMissionProject. */
      contextPolicy?: 'none' | 'minimal' | 'on-demand';
      acceptanceCriteria?: string[];
    }) => ipcRenderer.invoke(ORCH_CHANNELS.missionSubmitIntent, input),
    approveMissionIntent: (input: { missionId: string }) =>
      ipcRenderer.invoke(ORCH_CHANNELS.missionApproveIntent, input),
    prepareMissionProject: (input: { missionId: string }) =>
      ipcRenderer.invoke(ORCH_CHANNELS.missionPrepareProject, input),
    getMissionPromptQueue: (input: { missionId: string }) =>
      ipcRenderer.invoke(ORCH_CHANNELS.missionPromptQueue, input),
    bindMissionOrchestrator: (input: {
      missionId: string;
      title: string;
      squadId: string;
      orchestratorPane: {
        paneId: string;
        adapterId?: string;
        model?: string;
        accountId?: string;
        cwd?: string;
        title?: string;
        agentName?: string;
      };
    }) => ipcRenderer.invoke(ORCH_CHANNELS.missionBindOrchestrator, input),
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
    searchDesignSystems: (req) =>
      ipcRenderer.invoke(ORCH_CHANNELS.designSystemsSearch, req),
    importDesignSystem: (req) =>
      ipcRenderer.invoke(ORCH_CHANNELS.designSystemsImport, req),
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
    audioGet: () => ipcRenderer.invoke(SETTINGS_CHANNELS.audioGet),
    audioSet: (patch) => ipcRenderer.invoke(SETTINGS_CHANNELS.audioSet, patch),
    onAudioChanged: (cb) => addListener(audioSettingsChangedListeners, cb),
    listShells: () => ipcRenderer.invoke(SETTINGS_CHANNELS.shellsList),
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
  orientation: {
    get: (): Promise<OrientationSnapshot | null> =>
      ipcRenderer.invoke(ORIENTATION_CHANNELS.get),
    ensure: (): Promise<OrientationSnapshot | null> =>
      ipcRenderer.invoke(ORIENTATION_CHANNELS.ensure),
    refresh: (): Promise<OrientationSnapshot | null> =>
      ipcRenderer.invoke(ORIENTATION_CHANNELS.refresh),
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
  integrations: {
    hasGithubToken: () => ipcRenderer.invoke(INTEGRATIONS_CHANNELS.hasGithubToken),
    hasLinearKey: () => ipcRenderer.invoke(INTEGRATIONS_CHANNELS.hasLinearKey),
    setGithubToken: (token: string) =>
      ipcRenderer.invoke(INTEGRATIONS_CHANNELS.setGithubToken, { token }),
    setLinearKey: (token: string) =>
      ipcRenderer.invoke(INTEGRATIONS_CHANNELS.linearSetKey, { token }),
    gitDiff: () => ipcRenderer.invoke(INTEGRATIONS_CHANNELS.gitDiff),
    gitStatus: () => ipcRenderer.invoke(INTEGRATIONS_CHANNELS.gitStatus),
    createPr: (req) => ipcRenderer.invoke(INTEGRATIONS_CHANNELS.forgeCreatePr, req),
    listPrs: () => ipcRenderer.invoke(INTEGRATIONS_CHANNELS.forgeListPrs),
    listGithubIssues: (opts) =>
      ipcRenderer.invoke(INTEGRATIONS_CHANNELS.githubListIssues, opts ?? {}),
    listLinearIssues: (opts) =>
      ipcRenderer.invoke(INTEGRATIONS_CHANNELS.linearListIssues, opts ?? {}),
    startPortForward: (req) =>
      ipcRenderer.invoke(INTEGRATIONS_CHANNELS.sshPortForward, req),
    listPortForwards: () => ipcRenderer.invoke(INTEGRATIONS_CHANNELS.sshPortForwardList),
    closePortForward: (id: string) =>
      ipcRenderer.invoke(INTEGRATIONS_CHANNELS.sshPortForwardClose, id),
    remoteWorktreeCreate: (req) =>
      ipcRenderer.invoke(INTEGRATIONS_CHANNELS.remoteWorktreeCreate, req),
  },
  accounts: {
    list: () => ipcRenderer.invoke(ACCOUNT_CHANNELS.list),
    quota: () => ipcRenderer.invoke(ACCOUNT_CHANNELS.quota) as Promise<AccountQuotaInfo[]>,
    add: (req) => ipcRenderer.invoke(ACCOUNT_CHANNELS.add, req),
    addActiveClaude: (label: string) =>
      ipcRenderer.invoke(ACCOUNT_CHANNELS.addActiveClaude, { label }),
    addActiveSession: (adapterId: string, label: string) =>
      ipcRenderer.invoke(ACCOUNT_CHANNELS.addActiveSession, { adapterId, label }),
    supportsSnapshot: (adapterId: string) =>
      ipcRenderer.invoke(ACCOUNT_CHANNELS.supportsSnapshot, { adapterId }),
    rename: (id: string, label: string) =>
      ipcRenderer.invoke(ACCOUNT_CHANNELS.rename, { id, label }),
    remove: (id: string) => ipcRenderer.invoke(ACCOUNT_CHANNELS.remove, { id }),
    activate: (id: string) => ipcRenderer.invoke(ACCOUNT_CHANNELS.activate, { id }),
    onChanged: (cb) => addListener(accountsChangedListeners, cb),
    onFailover: (cb) => addListener(failoverListeners, cb),
    onActivated: (cb) => addListener(accountActivatedListeners, cb),
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
  quota: {
    snapshot: () =>
      ipcRenderer.invoke(QUOTA_CHANNELS.snapshot) as Promise<QuotaFleetSnapshot>,
    refresh: () =>
      ipcRenderer.invoke(QUOTA_CHANNELS.refresh) as Promise<QuotaFleetSnapshot>,
    onChanged: (cb: (snapshot: QuotaFleetSnapshot) => void) =>
      addListener(quotaChangedListeners, cb),
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
  ranking: {
    public: () => ipcRenderer.invoke(EVAL_RANKING_CHANNELS.publicRanking),
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
    performAxAction: (request) => performAxAction(request),
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

let functionalSmokeStarted = false;
ipcRenderer.on(WINDOW_CHANNELS.functionalSmokeRun, (_event, payload: unknown) => {
  if (functionalSmokeStarted) return;
  functionalSmokeStarted = true;
  const workspacePath =
    typeof payload === 'object' &&
    payload !== null &&
    Object.keys(payload).length === 1 &&
    typeof (payload as { workspacePath?: unknown }).workspacePath === 'string' &&
    (payload as { workspacePath: string }).workspacePath.length <= 4096
      ? (payload as { workspacePath: string }).workspacePath
      : null;
  if (!workspacePath) {
    ipcRenderer.send(WINDOW_CHANNELS.functionalSmokeResult, {
      ok: false,
      probes: [],
      failedProbe: 'workspace-open',
    });
    return;
  }
  void runFunctionalSmokeProbes(api, workspacePath)
    .then((result) => {
      ipcRenderer.send(WINDOW_CHANNELS.functionalSmokeResult, result);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[smoke] functional probe runner failed: ${message.replace(/[\r\n]+/gu, ' ').slice(0, 512)}`,
      );
      ipcRenderer.send(WINDOW_CHANNELS.functionalSmokeResult, {
        ok: false,
        probes: [],
        failedProbe: 'workspace-open',
      });
    });
});

contextBridge.exposeInMainWorld('nexus', api);
