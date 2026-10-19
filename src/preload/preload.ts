import { contextBridge, ipcRenderer, webUtils } from 'electron';
import {
  ARMS_CHANNELS,
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
  TERMINAL_BLOCK_CHANNELS,
  SEARCH_MIXER_CHANNELS,
  PRODUCT_WAVE_CHANNELS,
  DISCOVERY_CHANNELS,
  MEMORY_CHANNELS,
  MODEL_CHANNELS,
} from '../shared/channels';
import { COMPANION_RELAY_CHANNELS } from '../shared/companion-relay-types';
import { OPS_CHANNELS } from '../shared/ops-ipc';
import type { ProductFlagResolutionRow } from '../shared/product-api';
import { PET_CHANNELS } from '../shared/pet-types';
import { REDLINE_IPC } from '../shared/redline-types';
import type { PetPrefs } from '../shared/pet-types';
import { VOICE_CHANNELS } from '../shared/voice-channels';
import { JEV_CHANNELS } from '../shared/jev-channels';
import { BUG_REPORT_CHANNELS } from '../shared/bug-report-channels';
import { ACCOUNT_CHOICE_CHANNELS } from '../shared/account-choice-channels';
import { APPROVAL_CHANNELS } from '../shared/approval-channels';
import type { ApprovalRequestView } from '../shared/approval-decision';
import { DECISION_MODEL_CHANNELS } from '../shared/decision-model-channels';
import { VISION_CHANNELS } from '../shared/vision-ipc';
import type { ScreenCaptureMetadata } from '../shared/vision-ipc';
import { getAxTree, performAxAction } from './ax-tree';
import { PTY_GAP_NOTICE, PtyGapBuffer } from './pty-gap-buffer';
import { runFunctionalSmokeProbes } from './functional-smoke';
import { installSoakPreload } from './soak-smoke';
import { installRuntimeGatePreload } from './runtime-gates';
import { observeBusyBannerForSmoke } from './busy-banner-smoke';
import { BUSY_BANNER_SMOKE_CHANNELS, isBusyBannerSmokeNonce } from '../shared/busy-banner-smoke';
import { UPDATE_CHANNELS } from '../shared/update-ipc';
import type { UpdateState } from '../shared/update-ipc';
import { ORCH_CHANNELS } from '../shared/orch-channels';
import type { MissionSummarySnapshot } from '../shared/mission-engine-contract';
import { REMOTE_CHANNELS } from '../shared/remote-channels';
import { SETTINGS_CHANNELS } from '../shared/settings-types';
import type {
  AudioSettings,
  SpendSettings,
  TerminalSettings,
  UiSettings,
} from '../shared/settings-types';
import { WORKSPACE_CHANNELS } from '../shared/workspace-types';
import type {
  WorkspaceLivenessEvent,
  WorkspaceState,
} from '../shared/workspace-types';
import { ORIENTATION_CHANNELS } from '../shared/orientation-types';
import type { OrientationSnapshot } from '../shared/orientation-types';
import { CONTEXT_DRAFT_CHANNELS } from '../shared/context-draft-types';
import type {
  ApproveContextDraftInput,
  ApproveContextDraftResult,
  PendingContextDraft,
} from '../shared/context-draft-types';
import { PROVIDER_CHANNELS } from '../shared/provider-settings-types';
import type { ProviderSettingsInfo } from '../shared/provider-settings-types';
import { FILES_CHANNELS } from '../shared/files-types';
import { createIntegrationsBridge } from './integrations-bridge';
import { createVoiceCloneBridge } from './video-studio-bridge';
import { ACCOUNT_CHANNELS } from '../shared/account-types';
import type {
  AccountActivatedEvent,
  AccountInfo,
  AccountQuotaInfo,
  FailoverEvent,
} from '../shared/account-types';
import { COST_CHANNELS } from '../shared/cost-types';
import { TOKEN_SPEED_CHANNELS } from '../shared/token-speed-types';
import { USAGE_CHANNELS } from '../shared/usage-types';
import type { UsageSnapshot } from '../shared/usage-types';
import { QUOTA_CHANNELS } from '../shared/quota-types';
import type { QuotaFleetSnapshot } from '../shared/quota-types';
import { EVAL_RANKING_CHANNELS } from '../shared/eval-ranking-types';
import { MEDIA_CHANNELS } from '../shared/media-types';
import type {
  MediaProviderId,
  MediaStudioRequest,
} from '../shared/media-types';
import { GAMIFICATION_CHANNELS } from '../shared/gamification-types';
import type { GamificationSnapshot } from '../shared/gamification-types';
import { BILLING_CHANNELS } from '../shared/billing-types';
import type { LoginResultEvent } from '../shared/auth-login';
import type { CheckoutRequest } from '../shared/billing-types';
import type { CostSnapshot } from '../shared/cost-types';
import type { TokenSpeedSnapshot } from '../shared/token-speed-types';
import { PIPE_CHANNELS } from '../shared/pipe-types';
import type { Pipe, PipeMode } from '../shared/pipe-types';
import {
  SHOT_BRIDGE_CHANNELS,
  type ShotFilesReceivedPayload,
} from '../shared/shot-bridge';
import type {
  NexusApi,
  BrowserDesignEventPayload,
  BrowserPaneState,
  DevServerDetectedPayload,
  SpawnRequest,
  SpawnResult,
  WorkspaceLayout,
  PtyDataEvent,
  PtyDataMeta,
  PtyExitEvent,
  PtyStateChangeEvent,
  PaneSessionState,
  AdapterInfo,
  AgentWaitingEvent,
  BgTaskEventPayload,
  PaneFootprintBroadcast,
  PaneLoginStuckEvent,
  PaneWorkerSpawnFailedEvent,
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
  PaneCloseRequest,
  PaneParkRequest,
  Mission,
  MissionPatch,
  MissionPanePresentationRequest,
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

/**
 * Entrega isolada por listener: um subscriber que lança NÃO aborta os demais
 * nem propaga para dentro do handler IPC — antes, o primeiro throw no
 * `forEach` calava todos os listeners seguintes. Itera sobre cópia para
 * unsubscribe durante a entrega não pular ninguém.
 */
function emitToListeners<TArgs extends unknown[]>(
  listeners: Iterable<(...args: TArgs) => void> | undefined,
  label: string,
  ...args: TArgs
): void {
  if (!listeners) return;
  for (const cb of Array.from(listeners)) {
    try {
      cb(...args);
    } catch (error) {
      console.error(`[preload] listener "${label}" falhou`, error);
    }
  }
}

type DataCb = (data: string, meta?: PtyDataMeta) => void;
/** DSK-01: marca o que um pull de `pty.replay()` entregou (fita retida). */
const REPLAYED_PTY_DATA: PtyDataMeta = Object.freeze({ replayed: true });
type ExitCb = (event: { exitCode: number; signal?: number; terminationOrigin?: string }) => void;
type StateCb = (state: PaneSessionState) => void;
type AdapterChangedCb = (adapters: AdapterInfo[]) => void;

const dataSubs = new Map<string, Set<DataCb>>();
/**
 * Per-session contiguous delivery with a BOUNDED gap buffer. An unrecoverable
 * hole (evicted from main's replay window) is accepted instead of buffering —
 * and re-recovering — forever.
 */
const ptyGapBuffers = new Map<string, PtyGapBuffer>();
/** Single in-flight recover pull per session: a gap must not spawn a storm. */
const ptyRecoverFlights = new Set<string>();
const ptyGapWarnAt = new Map<string, number>();
const PTY_GAP_WARN_INTERVAL_MS = 30_000;
const exitSubs = new Map<string, Set<ExitCb>>();
// F-1368: one-shot PTYs can exit before spawn resolves and the host subscribes.
// Keep only recent exits, bounded independently of pane/host lifetime.
const recentPtyExits = new Map<string, { event: Parameters<ExitCb>[0]; at: number }>();
const PTY_EXIT_REPLAY_TTL_MS = 60_000;
const PTY_EXIT_REPLAY_LIMIT = 256;
function prunePtyExits(): void {
  for (const [sessionId, exit] of recentPtyExits) {
    if (Date.now() - exit.at >= PTY_EXIT_REPLAY_TTL_MS) recentPtyExits.delete(sessionId);
  }
  while (recentPtyExits.size > PTY_EXIT_REPLAY_LIMIT) {
    recentPtyExits.delete(recentPtyExits.keys().next().value!);
  }
}
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
    emitToListeners(deepOpenListeners, 'deepOpenListeners', payload),
);
const authLoginResultListeners = new Set<(result: LoginResultEvent) => void>();
ipcRenderer.on(WINDOW_CHANNELS.authLoginResult, (_event, result: LoginResultEvent) =>
  emitToListeners(authLoginResultListeners, 'authLoginResultListeners', result),
);
const deepOpenQuotaListeners = new Set<() => void>();
ipcRenderer.on(WINDOW_CHANNELS.deepOpenQuota, () =>
  emitToListeners(deepOpenQuotaListeners, 'deepOpenQuotaListeners'),
);
const deepOpenNewListeners = new Set<(payload: { prompt: string | null }) => void>();
ipcRenderer.on(
  WINDOW_CHANNELS.deepOpenNew,
  (_event, payload: { prompt: string | null }) =>
    emitToListeners(deepOpenNewListeners, 'deepOpenNewListeners', payload),
);
const bugReportOpenListeners = new Set<() => void>();
ipcRenderer.on(BUG_REPORT_CHANNELS.open, () =>
  emitToListeners(bugReportOpenListeners, 'bugReportOpenListeners'),
);
const approvalsChangedListeners = new Set<(requests: ApprovalRequestView[]) => void>();
ipcRenderer.on(APPROVAL_CHANNELS.changed, (_event, requests: ApprovalRequestView[]) =>
  emitToListeners(approvalsChangedListeners, 'approvalsChangedListeners', requests),
);

// shot-bridge: arquivos entregues pelo Nexus Shot (contrato em
// shared/shot-bridge.ts). Somente leitura: o renderer recebe metadados já
// validados no main (realpath sob as raízes permitidas).
const shotFilesListeners = new Set<(payload: ShotFilesReceivedPayload) => void>();
ipcRenderer.on(
  SHOT_BRIDGE_CHANNELS.filesReceived,
  (_event, payload: ShotFilesReceivedPayload) =>
    emitToListeners(shotFilesListeners, 'shotFilesListeners', payload),
);

function clearPtySequenceState(sessionId: string): void {
  ptyGapBuffers.delete(sessionId);
  ptyRecoverFlights.delete(sessionId);
  ptyGapWarnAt.delete(sessionId);
}

function ptyGapBuffer(sessionId: string): PtyGapBuffer {
  let buffer = ptyGapBuffers.get(sessionId);
  if (!buffer) {
    buffer = new PtyGapBuffer();
    ptyGapBuffers.set(sessionId, buffer);
  }
  return buffer;
}

function warnPtyGapThrottled(sessionId: string, detail: string): void {
  const now = Date.now();
  if (now - (ptyGapWarnAt.get(sessionId) ?? 0) < PTY_GAP_WARN_INTERVAL_MS) {
    return;
  }
  ptyGapWarnAt.set(sessionId, now);
  console.warn(`[preload] pty output gap accepted for ${sessionId}: ${detail}`);
}

function emitContiguousPtyData(
  sessionId: string,
  sequence: number,
  data: string,
  meta?: PtyDataMeta,
): void {
  if (meta) emitToListeners(dataSubs.get(sessionId), 'dataSubs', data, meta);
  else emitToListeners(dataSubs.get(sessionId), 'dataSubs', data);
  ipcRenderer.send(PTY_CHANNELS.acknowledge, { sessionId, sequence });
}

/** Single-flighted pull from the contiguous high-water mark. */
function requestPtyRecover(sessionId: string): void {
  if (ptyRecoverFlights.has(sessionId)) return;
  ptyRecoverFlights.add(sessionId);
  void ipcRenderer
    .invoke(PTY_CHANNELS.recover, {
      sessionId,
      afterSequence: ptyGapBuffer(sessionId).highWater,
    })
    .then((events: PtyDataEvent[]) => deliverRecoveredPtyData(sessionId, events))
    .catch(() => {})
    .finally(() => ptyRecoverFlights.delete(sessionId));
}

function deliverRecoveredPtyData(
  sessionId: string,
  events: PtyDataEvent[],
  meta?: PtyDataMeta,
): void {
  if (events.length === 0) return;
  const buffer = ptyGapBuffers.get(sessionId);
  if (!buffer) return; // session exited while the pull was in flight
  const first = events[0];
  if (first.sequence > buffer.highWater + 1) {
    // The hole was evicted from main's replay window and will never heal —
    // accept it, notice the terminal once, and resume from what is available.
    warnPtyGapThrottled(
      sessionId,
      `recover resumed at sequence ${first.sequence} past the high-water mark`,
    );
    emitToListeners(dataSubs.get(sessionId), 'dataSubs', PTY_GAP_NOTICE);
    for (const chunk of buffer.acceptHole(first.sequence)) {
      emitContiguousPtyData(sessionId, chunk.sequence, chunk.data);
    }
  }
  for (const event of events) deliverPtyData(event, meta);
}

/**
 * Deliver PTY data only in contiguous sequence order. Gaps are buffered
 * (bounded) and recovered; holes that prove unrecoverable are accepted once
 * so delivery always resumes instead of storming recover invokes.
 */
function deliverPtyData(payload: PtyDataEvent, meta?: PtyDataMeta): void {
  const sessionId = payload.sessionId;
  const buffer = ptyGapBuffer(sessionId);
  const result = buffer.push(payload.sequence, payload.data, payload.firstSequence);
  if (result.gapHealed) {
    warnPtyGapThrottled(
      sessionId,
      `gap buffer over budget; resumed at sequence ${buffer.highWater}`,
    );
    emitToListeners(dataSubs.get(sessionId), 'dataSubs', PTY_GAP_NOTICE);
  } else if (result.chunks.length === 0 && payload.sequence > buffer.highWater) {
    // Buffered behind a hole: pull it immediately (quiet cadence is a
    // backstop only). Single-flighted — one recover per session at a time.
    requestPtyRecover(sessionId);
  }
  for (const chunk of result.chunks) {
    // Só o chunk que veio DESTE evento leva a marca: sucessores destravados
    // do buffer chegaram por push ao vivo e seguem crus.
    emitContiguousPtyData(
      sessionId,
      chunk.sequence,
      chunk.data,
      chunk.sequence === payload.sequence ? meta : undefined,
    );
  }
}

ipcRenderer.on(PTY_CHANNELS.data, (_event, payload: PtyDataEvent) => {
  deliverPtyData(payload);
});

// Invoke remains operational when main→renderer push wedges. Pull from the
// contiguous high-water so recover never skips a hole.
setInterval(() => {
  for (const sessionId of dataSubs.keys()) {
    requestPtyRecover(sessionId);
  }
}, 15_000);

ipcRenderer.on(PTY_CHANNELS.exit, (_event, payload: PtyExitEvent) => {
  clearPtySequenceState(payload.sessionId);
  const event = {
    exitCode: payload.exitCode,
    signal: payload.signal,
    ...(payload.terminationOrigin ? { terminationOrigin: payload.terminationOrigin } : {}),
  };
  recentPtyExits.set(payload.sessionId, { event, at: Date.now() });
  prunePtyExits();
  emitToListeners(exitSubs.get(payload.sessionId), 'exitSubs', event);
});

ipcRenderer.on(PTY_CHANNELS.stateChange, (_event, payload: PtyStateChangeEvent) => {
  emitToListeners(stateSubs.get(payload.sessionId), 'stateSubs', payload.state);
});

ipcRenderer.on(BROWSER_CHANNELS.state, (_event, payload: BrowserPaneState) => {
  emitToListeners(browserStateListeners, 'browserStateListeners', payload);
});

ipcRenderer.on(
  BROWSER_CHANNELS.designEvent,
  (_event, payload: BrowserDesignEventPayload) => {
    emitToListeners(browserDesignListeners, 'browserDesignListeners', payload);
  },
);

ipcRenderer.on(
  DEV_SERVER_CHANNELS.detected,
  (_event, payload: DevServerDetectedPayload) => {
    emitToListeners(devServerListeners, 'devServerListeners', payload);
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
  emitToListeners(adapterChangedListeners, 'adapterChangedListeners', payload);
});

// Voice event fan-out. Kept as plain listener sets so callbacks stay scoped and
// unsubscribe cleanly — no raw ipcRenderer ever reaches the renderer.
const pttStartListeners = new Set<() => void>();
const pttStopListeners = new Set<() => void>();
const pttToggleListeners = new Set<() => void>();
ipcRenderer.on(VOICE_CHANNELS.pttToggle, () =>
  emitToListeners(pttToggleListeners, 'pttToggleListeners'),
);

const wakeDetectedListeners = new Set<() => void>();
ipcRenderer.on(VOICE_CHANNELS.wakeDetected, () =>
  emitToListeners(wakeDetectedListeners, 'wakeDetectedListeners'),
);
const narrateListeners = new Set<(event: import('../shared/voice-ipc').VoiceNarrationEvent) => void>();
ipcRenderer.on(VOICE_CHANNELS.narrate, (_e, event: import('../shared/voice-ipc').VoiceNarrationEvent) =>
  emitToListeners(narrateListeners, 'narrateListeners', event),
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
const jevPaneHintListeners = new Set<
  (event: import('../shared/jev-ipc').JevPaneHintEvent) => void
>();
ipcRenderer.on(
  JEV_CHANNELS.paneHint,
  (_event, payload: import('../shared/jev-ipc').JevPaneHintEvent) =>
    emitToListeners(jevPaneHintListeners, 'jevPaneHintListeners', payload),
);

ipcRenderer.on(VOICE_CHANNELS.liveAudioOut, (_event, payload: JarvisLiveAudioOutEvent) =>
  emitToListeners(liveAudioOutListeners, 'liveAudioOutListeners', payload),
);
ipcRenderer.on(UPDATE_CHANNELS.state, (_event, state: UpdateState) =>
  emitToListeners(updateStateListeners, 'updateStateListeners', state),
);
ipcRenderer.on(VOICE_CHANNELS.pttStart, () => emitToListeners(pttStartListeners, 'pttStartListeners'));
ipcRenderer.on(VOICE_CHANNELS.pttStop, () => emitToListeners(pttStopListeners, 'pttStopListeners'));
ipcRenderer.on(VOICE_CHANNELS.infoChanged, (_event, info: VoiceRuntimeInfo) =>
  emitToListeners(voiceInfoListeners, 'voiceInfoListeners', info),
);
ipcRenderer.on(VOICE_CHANNELS.liveState, (_event, state: JarvisLiveState) =>
  emitToListeners(liveStateListeners, 'liveStateListeners', state),
);
ipcRenderer.on(
  VOICE_CHANNELS.liveTranscript,
  (_event, event: JarvisLiveTranscriptEvent) =>
    emitToListeners(liveTranscriptListeners, 'liveTranscriptListeners', event),
);
ipcRenderer.on(
  VOICE_CHANNELS.jarvisTranscriptAppend,
  (_event, event: JarvisTranscriptAppendEvent) =>
    emitToListeners(transcriptAppendListeners, 'transcriptAppendListeners', event),
);
ipcRenderer.on(VOICE_CHANNELS.liveToolCall, (_event, event: JarvisLiveToolEvent) =>
  emitToListeners(liveToolCallListeners, 'liveToolCallListeners', event),
);
ipcRenderer.on(
  VOICE_CHANNELS.liveToolCancelled,
  (_event, event: JarvisLiveToolCancellationEvent) =>
    emitToListeners(liveToolCancelledListeners, 'liveToolCancelledListeners', event),
);
ipcRenderer.on(
  VOICE_CHANNELS.liveToolResult,
  (_event, event: JarvisLiveToolResultEvent) =>
    emitToListeners(liveToolResultListeners, 'liveToolResultListeners', event),
);
ipcRenderer.on(
  VOICE_CHANNELS.liveToolTurnComplete,
  (_event, event: JarvisLiveToolTurnCompleteEvent) =>
    emitToListeners(liveToolTurnCompleteListeners, 'liveToolTurnCompleteListeners', event),
);
ipcRenderer.on(
  VOICE_CHANNELS.liveInterrupted,
  (_event, event: JarvisLiveInterruptEvent) =>
    emitToListeners(liveInterruptedListeners, 'liveInterruptedListeners', event),
);

function addListener<T>(set: Set<T>, cb: T): () => void {
  set.add(cb);
  return () => set.delete(cb);
}

// Orchestration event fan-out (same pattern as voice above).
// This identifies one renderer document lifecycle only; Main never treats it
// as authorization. A fresh preload after Cmd+R/HMR receives a fresh id.
const paneSyncGenerationId =
  globalThis.crypto?.randomUUID?.() ??
  `renderer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const paneSpawnRequestListeners = new Set<(req: OrchPaneSpawnRequest) => void>();
const panePresentationRequestListeners = new Set<
  (req: MissionPanePresentationRequest) => void
>();
const paneRecoveryRequestListeners = new Set<
  (req: MissionPaneRecoveryRequest) => void
>();
const browserOpenRequestListeners = new Set<(req: BrowserPaneOpenRequest) => void>();
const paneCloseRequestListeners = new Set<(request: PaneCloseRequest) => void>();
const paneParkRequestListeners = new Set<(request: PaneParkRequest) => void>();
const missionChangedListeners = new Set<
  (items: MissionSummarySnapshot[]) => void
>();
const missionsChangedListeners = new Set<(missions: Mission[]) => void>();
const handoffsChangedListeners = new Set<(handoffs: Handoff[]) => void>();
const todosChangedListeners = new Set<(lists: TodoList[]) => void>();
const squadsChangedListeners = new Set<(squads: Squad[]) => void>();
const bgTaskEventListeners = new Set<(event: BgTaskEventPayload) => void>();
const paneLoginStuckListeners = new Set<(event: PaneLoginStuckEvent) => void>();
const agentWaitingListeners = new Set<(event: AgentWaitingEvent) => void>();
const workerSpawnFailedListeners = new Set<
  (event: PaneWorkerSpawnFailedEvent) => void
>();
const paneFootprintsListeners = new Set<
  (event: PaneFootprintBroadcast) => void
>();

ipcRenderer.on(ORCH_CHANNELS.paneSpawnRequest, (_e, req: OrchPaneSpawnRequest) =>
  emitToListeners(paneSpawnRequestListeners, 'paneSpawnRequestListeners', req),
);
ipcRenderer.on(
  ORCH_CHANNELS.panePresentationRequest,
  (_e, req: MissionPanePresentationRequest) =>
    emitToListeners(panePresentationRequestListeners, 'panePresentationRequestListeners', req),
);
ipcRenderer.on(
  ORCH_CHANNELS.paneRecoveryRequest,
  (_e, req: MissionPaneRecoveryRequest) =>
    emitToListeners(paneRecoveryRequestListeners, 'paneRecoveryRequestListeners', req),
);
ipcRenderer.on(ORCH_CHANNELS.browserOpenRequest, (_e, req: BrowserPaneOpenRequest) =>
  emitToListeners(browserOpenRequestListeners, 'browserOpenRequestListeners', req),
);
ipcRenderer.on(ORCH_CHANNELS.paneCloseRequest, (_e, request: PaneCloseRequest) =>
  emitToListeners(paneCloseRequestListeners, 'paneCloseRequestListeners', request),
);
ipcRenderer.on(ORCH_CHANNELS.paneParkRequest, (_e, request: PaneParkRequest) =>
  emitToListeners(paneParkRequestListeners, 'paneParkRequestListeners', request),
);
ipcRenderer.on(
  ORCH_CHANNELS.missionChanged,
  (_e, items: MissionSummarySnapshot[]) =>
    emitToListeners(missionChangedListeners, 'missionChangedListeners', items),
);
ipcRenderer.on(ORCH_CHANNELS.missionsChanged, (_e, missions: Mission[]) =>
  emitToListeners(missionsChangedListeners, 'missionsChangedListeners', missions),
);
ipcRenderer.on(ORCH_CHANNELS.handoffsChanged, (_e, handoffs: Handoff[]) =>
  emitToListeners(handoffsChangedListeners, 'handoffsChangedListeners', handoffs),
);
ipcRenderer.on(ORCH_CHANNELS.todosChanged, (_e, lists: TodoList[]) =>
  emitToListeners(todosChangedListeners, 'todosChangedListeners', lists),
);
ipcRenderer.on(ORCH_CHANNELS.squadsChanged, (_e, squads: Squad[]) =>
  emitToListeners(squadsChangedListeners, 'squadsChangedListeners', squads),
);
ipcRenderer.on(ORCH_CHANNELS.bgTaskEvent, (_e, event: BgTaskEventPayload) =>
  emitToListeners(bgTaskEventListeners, 'bgTaskEventListeners', event),
);
ipcRenderer.on(ORCH_CHANNELS.paneLoginStuck, (_e, event: PaneLoginStuckEvent) =>
  emitToListeners(paneLoginStuckListeners, 'paneLoginStuckListeners', event),
);
ipcRenderer.on(ORCH_CHANNELS.agentWaiting, (_e, event: AgentWaitingEvent) =>
  emitToListeners(agentWaitingListeners, 'agentWaitingListeners', event),
);
ipcRenderer.on(
  ORCH_CHANNELS.workerSpawnFailed,
  (_e, event: PaneWorkerSpawnFailedEvent) =>
    emitToListeners(
      workerSpawnFailedListeners,
      'workerSpawnFailedListeners',
      event,
    ),
);
ipcRenderer.on(PERF_CHANNELS.paneFootprints, (_e, event: PaneFootprintBroadcast) =>
  emitToListeners(paneFootprintsListeners, 'paneFootprintsListeners', event),
);

const settingsChangedListeners = new Set<(settings: TerminalSettings) => void>();
ipcRenderer.on(SETTINGS_CHANNELS.changed, (_e, settings: TerminalSettings) =>
  emitToListeners(settingsChangedListeners, 'settingsChangedListeners', settings),
);

const audioSettingsChangedListeners = new Set<(audio: AudioSettings) => void>();
ipcRenderer.on(SETTINGS_CHANNELS.audioChanged, (_e, audio: AudioSettings) =>
  emitToListeners(audioSettingsChangedListeners, 'audioSettingsChangedListeners', audio),
);

const uiSettingsChangedListeners = new Set<(ui: UiSettings) => void>();
ipcRenderer.on(SETTINGS_CHANNELS.uiChanged, (_e, ui: UiSettings) =>
  emitToListeners(uiSettingsChangedListeners, 'uiSettingsChangedListeners', ui),
);

const spendSettingsChangedListeners = new Set<(spend: SpendSettings) => void>();
ipcRenderer.on(SETTINGS_CHANNELS.spendChanged, (_e, spend: SpendSettings) =>
  emitToListeners(spendSettingsChangedListeners, 'spendSettingsChangedListeners', spend),
);

const workspaceChangedListeners = new Set<(state: WorkspaceState) => void>();
ipcRenderer.on(WORKSPACE_CHANNELS.changed, (_e, state: WorkspaceState) =>
  emitToListeners(workspaceChangedListeners, 'workspaceChangedListeners', state),
);

const workspaceLivenessListeners = new Set<
  (event: WorkspaceLivenessEvent) => void
>();
ipcRenderer.on(
  WORKSPACE_CHANNELS.liveness,
  (_e, event: WorkspaceLivenessEvent) =>
    emitToListeners(
      workspaceLivenessListeners,
      'workspaceLivenessListeners',
      event,
    ),
);

const providersChangedListeners = new Set<
  (list: ProviderSettingsInfo[]) => void
>();
ipcRenderer.on(PROVIDER_CHANNELS.changed, (_e, list: ProviderSettingsInfo[]) =>
  emitToListeners(providersChangedListeners, 'providersChangedListeners', list),
);

const productFlagsChangedListeners = new Set<
  (list: ProductFlagResolutionRow[]) => void
>();
ipcRenderer.on(
  PRODUCT_WAVE_CHANNELS.flagsChanged,
  (_e, list: ProductFlagResolutionRow[]) =>
    emitToListeners(productFlagsChangedListeners, 'productFlagsChangedListeners', list),
);

const accountsChangedListeners = new Set<(list: AccountInfo[]) => void>();
const failoverListeners = new Set<(event: FailoverEvent) => void>();
const accountActivatedListeners = new Set<(event: AccountActivatedEvent) => void>();
const costChangedListeners = new Set<(snapshot: CostSnapshot) => void>();
ipcRenderer.on(ACCOUNT_CHANNELS.changed, (_e, list: AccountInfo[]) =>
  emitToListeners(accountsChangedListeners, 'accountsChangedListeners', list),
);
ipcRenderer.on(ACCOUNT_CHANNELS.failover, (_e, event: FailoverEvent) =>
  emitToListeners(failoverListeners, 'failoverListeners', event),
);
ipcRenderer.on(ACCOUNT_CHANNELS.activated, (_e, event: AccountActivatedEvent) =>
  emitToListeners(accountActivatedListeners, 'accountActivatedListeners', event),
);
ipcRenderer.on(COST_CHANNELS.changed, (_e, snapshot: CostSnapshot) =>
  emitToListeners(costChangedListeners, 'costChangedListeners', snapshot),
);
const tokenSpeedChangedListeners = new Set<
  (snapshot: TokenSpeedSnapshot) => void
>();
ipcRenderer.on(
  TOKEN_SPEED_CHANNELS.changed,
  (_e, snapshot: TokenSpeedSnapshot) =>
    emitToListeners(
      tokenSpeedChangedListeners,
      'tokenSpeedChangedListeners',
      snapshot,
    ),
);
const usageChangedListeners = new Set<(snapshot: UsageSnapshot) => void>();
ipcRenderer.on(USAGE_CHANNELS.changed, (_e, snapshot: UsageSnapshot) =>
  emitToListeners(usageChangedListeners, 'usageChangedListeners', snapshot),
);
const quotaChangedListeners = new Set<(snapshot: QuotaFleetSnapshot) => void>();
ipcRenderer.on(QUOTA_CHANNELS.changed, (_e, snapshot: QuotaFleetSnapshot) =>
  emitToListeners(quotaChangedListeners, 'quotaChangedListeners', snapshot),
);
const gamificationChangedListeners = new Set<
  (snapshot: GamificationSnapshot) => void
>();
ipcRenderer.on(
  GAMIFICATION_CHANNELS.changed,
  (_e, snapshot: GamificationSnapshot) =>
    emitToListeners(gamificationChangedListeners, 'gamificationChangedListeners', snapshot),
);

const pipesChangedListeners = new Set<(pipes: Pipe[]) => void>();
ipcRenderer.on(PIPE_CHANNELS.changed, (_e, pipes: Pipe[]) =>
  emitToListeners(pipesChangedListeners, 'pipesChangedListeners', pipes),
);

/** F-673: "10.0.26200" -> 26200 (só no Windows; o xterm precisa dele para o ConPTY). */
function windowsBuildNumber(): number | null {
  if (process.platform !== 'win32') return null;
  try {
    const build = Number(process.getSystemVersion().split('.')[2]);
    return Number.isSafeInteger(build) && build > 0 ? build : null;
  } catch {
    return null;
  }
}

/** F-1167: o mesmo canal calibra ou cancela; o payload é fixo aqui e validado (strict) no Main. */
function invokeCalibration(payload: { confirm: true } | { cancel: true }) {
  return ipcRenderer.invoke(DECISION_MODEL_CHANNELS.calibrate, payload);
}

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
    onOpenTerminal: (cb: () => void) => {
      const listener = () => cb();
      ipcRenderer.on(PET_CHANNELS.openTerminal, listener);
      return () =>
        ipcRenderer.removeListener(PET_CHANNELS.openTerminal, listener);
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
    ready: () => ipcRenderer.invoke(WINDOW_CHANNELS.bootReady),
    heartbeat: () => ipcRenderer.invoke(WINDOW_CHANNELS.heartbeat),
    openExternal: (url: string) =>
      ipcRenderer.invoke(WINDOW_CHANNELS.openExternal, url),
    authLogin: (provider: 'github' | 'google') =>
      ipcRenderer.invoke(WINDOW_CHANNELS.authLogin, provider),
    openLegalNotices: () => ipcRenderer.invoke(WINDOW_CHANNELS.openLegalNotices),
    openTerminalPath: (path: string) =>
      ipcRenderer.invoke(WINDOW_CHANNELS.openTerminalPath, path),
    onDeepOpenPath: (cb: (payload: { path: string; isDir: boolean }) => void) =>
      addListener(deepOpenListeners, cb),
    onAuthLoginResult: (cb: (result: LoginResultEvent) => void) =>
      addListener(authLoginResultListeners, cb),
    onDeepOpenQuota: (cb: () => void) => addListener(deepOpenQuotaListeners, cb),
    onDeepOpenNew: (cb: (payload: { prompt: string | null }) => void) =>
      addListener(deepOpenNewListeners, cb),
    onShotFilesReceived: (cb: (payload: ShotFilesReceivedPayload) => void) =>
      addListener(shotFilesListeners, cb),
  },
  arms: {
    status: () => ipcRenderer.invoke(ARMS_CHANNELS.status),
    generate: () => ipcRenderer.invoke(ARMS_CHANNELS.generate),
    rotate: () => ipcRenderer.invoke(ARMS_CHANNELS.rotate),
    revoke: () => ipcRenderer.invoke(ARMS_CHANNELS.revoke),
  },
  pty: {
    spawn: (req: SpawnRequest): Promise<SpawnResult> =>
      ipcRenderer.invoke(PTY_CHANNELS.spawn, req),
    replay: async (sessionId: string): Promise<void> => {
      // Buffer criado ANTES do pull: sem ele a entrega descartava a janela
      // retida de uma sessão adotada que ainda não mandou chunk ao vivo, e a
      // fita antiga só chegava no recover de 15 s — depois do reset da
      // adoção e sem a marca de replay (DSK-01).
      const afterSequence = ptyGapBuffer(sessionId).highWater;
      const events = (await ipcRenderer.invoke(PTY_CHANNELS.recover, {
        sessionId,
        afterSequence,
      })) as PtyDataEvent[];
      // Marca o que ESTE pull entregou: o renderer tira as queries só disso;
      // a saída ao vivo (inclusive a que chega durante o pull) segue crua.
      deliverRecoveredPtyData(sessionId, events, REPLAYED_PTY_DATA);
    },
    write: (sessionId, data) =>
      ipcRenderer.send(PTY_CHANNELS.write, { sessionId, data }),
    submitPromptEnter: (sessionId, turnStartSequence, retry) => ipcRenderer.invoke(PTY_CHANNELS.promptEnter, { sessionId, turnStartSequence, retry }),
    promptState: (sessionId) => ipcRenderer.invoke(PTY_CHANNELS.promptState, { sessionId }),
    writeConfirmed: (sessionId, data) =>
      ipcRenderer.invoke(PTY_CHANNELS.writeConfirmed, { sessionId, data }),
    resize: (sessionId, cols, rows, options) =>
      ipcRenderer.send(PTY_CHANNELS.resize, {
        sessionId,
        cols,
        rows,
        ...(options?.assert === true ? { assert: true } : {}),
        ...(options?.reported ? { reported: options.reported } : {}),
      }),
    kill: (sessionId) => ipcRenderer.send(PTY_CHANNELS.kill, { sessionId }),
    onData: (sessionId, cb) => {
      const unsub = subscribe(dataSubs, sessionId, cb);
      return () => {
        unsub();
        if (!dataSubs.has(sessionId)) clearPtySequenceState(sessionId);
      };
    },
    onExit: (sessionId, cb) => {
      const unsubscribe = subscribe(exitSubs, sessionId, cb);
      prunePtyExits();
      const exit = recentPtyExits.get(sessionId);
      let active = true;
      // Complete host attachment first (including adopted state publication).
      if (exit) queueMicrotask(() => {
        if (active) emitToListeners(new Set([cb]), 'exitSubs', exit.event);
      });
      return () => { active = false; unsubscribe(); };
    },
    onStateChange: (sessionId, cb) => subscribe(stateSubs, sessionId, cb),
  },
  browser: {
    profileStatus: (paneId) => ipcRenderer.invoke(BROWSER_CHANNELS.profileStatus, { paneId }),
    profileChange: (paneId, change) => ipcRenderer.invoke(BROWSER_CHANNELS.profileChange, { paneId, ...change }),
    importProfiles: (paneId) => ipcRenderer.invoke(BROWSER_CHANNELS.importProfiles, { paneId }),
    importSites: (paneId, profileId) => ipcRenderer.invoke(BROWSER_CHANNELS.importSites, { paneId, profileId }),
    importCookies: (paneId, profileId, domains) => ipcRenderer.invoke(BROWSER_CHANNELS.importCookies, { paneId, profileId, domains }),
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
    setDeviceEmulation: (paneId: string, width: number | null) =>
      ipcRenderer.invoke(BROWSER_CHANNELS.deviceEmulation, { paneId, width }),
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
    designAnnotate: (paneId, payload) =>
      ipcRenderer.invoke(BROWSER_CHANNELS.designAnnotate, {
        paneId,
        ...payload,
      }),
    listDesignAnnotations: (paneId) =>
      ipcRenderer.invoke(BROWSER_CHANNELS.designAnnotations, { paneId }),
    deleteDesignAnnotation: (paneId, annotationId) =>
      ipcRenderer.invoke(BROWSER_CHANNELS.designAnnotationDelete, {
        paneId,
        annotationId,
      }),
    clearDesignAnnotations: (paneId) =>
      ipcRenderer.invoke(BROWSER_CHANNELS.designAnnotationsClear, { paneId }),
    sendDesignAnnotations: (paneId, payload) =>
      ipcRenderer.invoke(BROWSER_CHANNELS.designAnnotationsSend, {
        paneId,
        ...payload,
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
    rescan: () => ipcRenderer.invoke(ADAPTER_CHANNELS.rescan),
    onChanged: (cb) => {
      adapterChangedListeners.add(cb);
      return () => adapterChangedListeners.delete(cb);
    },
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
    stopWake: () => ipcRenderer.send(VOICE_CHANNELS.wakeStop),
    logVoice: (payload) => ipcRenderer.send(VOICE_CHANNELS.logEvent, payload),
    openMicSettings: () => ipcRenderer.send(VOICE_CHANNELS.openMicSettings),
    openSoundSettings: () => ipcRenderer.send(VOICE_CHANNELS.openSoundSettings),
    resetMicPermission: () => ipcRenderer.invoke(VOICE_CHANNELS.micResetTcc),
    jarvis: (req) => ipcRenderer.invoke(VOICE_CHANNELS.jarvis, req),
    jarvisSmokeTest: (req) =>
      ipcRenderer.invoke(VOICE_CHANNELS.jarvisSmokeTest, req),
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
  decisionModels: {
    status: () => ipcRenderer.invoke(DECISION_MODEL_CHANNELS.status),
    setKey: (req) => ipcRenderer.invoke(DECISION_MODEL_CHANNELS.setKey, req),
    test: (req) => ipcRenderer.invoke(DECISION_MODEL_CHANNELS.test, req),
    calibrationPlan: () => ipcRenderer.invoke(DECISION_MODEL_CHANNELS.calibrationPlan),
    calibrate: () => invokeCalibration({ confirm: true }),
    cancelCalibration: () => invokeCalibration({ cancel: true }),
    missionPanel: (missionId) => ipcRenderer.invoke(DECISION_MODEL_CHANNELS.missionPanel, { missionId }),
  },
  jev: {
    status: () => ipcRenderer.invoke(JEV_CHANNELS.status),
    setKey: (req) => ipcRenderer.invoke(JEV_CHANNELS.setKey, req),
    test: () => ipcRenderer.invoke(JEV_CHANNELS.test),
    decisionsList: (req) =>
      ipcRenderer.invoke(JEV_CHANNELS.decisionsList, req),
    decisionsFeedback: (req) =>
      ipcRenderer.invoke(JEV_CHANNELS.decisionsFeedback, req),
    decisionsStats: () => ipcRenderer.invoke(JEV_CHANNELS.decisionsStats),
    missionPick: (req) => ipcRenderer.invoke(JEV_CHANNELS.missionPick, req),
    onPaneHint: (cb) => addListener(jevPaneHintListeners, cb),
  },
  mission: {
    prepare: (request) =>
      ipcRenderer.invoke(ORCH_CHANNELS.missionPrepare, request),
    start: (input) => ipcRenderer.invoke(ORCH_CHANNELS.missionStart, input),
    routeIntent: (objective: string) =>
      ipcRenderer.invoke(ORCH_CHANNELS.intentRoute, objective),
    answerDirect: (question: string) =>
      ipcRenderer.invoke(ORCH_CHANNELS.intentAnswer, question),
    command: (command) =>
      ipcRenderer.invoke(ORCH_CHANNELS.missionCommand, command),
    snapshot: (missionId) =>
      ipcRenderer.invoke(ORCH_CHANNELS.missionSnapshot, missionId),
    list: () => ipcRenderer.invoke(ORCH_CHANNELS.missionList),
    listForWorkspace: (rootPath: string) =>
      ipcRenderer.invoke(ORCH_CHANNELS.workspaceMissionList, { rootPath }),
    onChanged: (listener) => addListener(missionChangedListeners, listener),
  },
  orch: {
    syncPanes: (entries) =>
      ipcRenderer.send(ORCH_CHANNELS.panesSync, {
        generationId: paneSyncGenerationId,
        entries,
      }),
    sendPaneSpawnResult: (result) =>
      ipcRenderer.send(ORCH_CHANNELS.paneSpawnResult, result),
    sendPaneRecoveryResult: (result: MissionPaneRecoveryResult) =>
      ipcRenderer.send(ORCH_CHANNELS.paneRecoveryResult, result),
    onPaneRecoveryRequest: (cb) =>
      addListener(paneRecoveryRequestListeners, cb),
    onPanePresentationRequest: (cb) =>
      addListener(panePresentationRequestListeners, cb),
    onBrowserOpenRequest: (cb) =>
      addListener(browserOpenRequestListeners, cb),
    sendBrowserOpenResult: (result) =>
      ipcRenderer.send(ORCH_CHANNELS.browserOpenResult, result),
    onPaneSpawnRequest: (cb) => addListener(paneSpawnRequestListeners, cb),
    onPaneCloseRequest: (cb) => addListener(paneCloseRequestListeners, cb),
    onPaneParkRequest: (cb) => addListener(paneParkRequestListeners, cb),
    sendPaneOperatorInput: (input: { sessionId: string; data: string }) =>
      ipcRenderer.invoke(ORCH_CHANNELS.paneOperatorInput, input),
    listMissions: () => ipcRenderer.invoke(ORCH_CHANNELS.missionsList),
    listMissionPanes: (missionId: string) =>
      ipcRenderer.invoke(ORCH_CHANNELS.missionPanesList, missionId),
    missionControlPlane: (missionId: string) =>
      ipcRenderer.invoke(ORCH_CHANNELS.missionControlPlane, { missionId }),
    canRestoreMissionPane: (input: {
      missionId: string;
      paneId: string;
    }) =>
      ipcRenderer.invoke(ORCH_CHANNELS.missionPaneRestoreAuthority, input),
    resumeMissionBootstrap: (input: { missionId: string }) =>
      ipcRenderer.invoke(ORCH_CHANNELS.missionResumeBootstrap, input),
    // F-1173: só missionId (+ ref) atravessam; nenhum campo extra do
    // renderer (caminho, cwd) chega ao Main.
    listMissionCheckpoints: (input: { missionId: string }) =>
      ipcRenderer.invoke(ORCH_CHANNELS.missionCheckpointsList, {
        missionId: input.missionId,
      }),
    previewMissionCheckpoint: (input: { missionId: string; ref: string }) =>
      ipcRenderer.invoke(ORCH_CHANNELS.missionCheckpointPreview, {
        missionId: input.missionId,
        ref: input.ref,
      }),
    restoreMissionCheckpoint: (input: {
      missionId: string;
      ref: string;
      fingerprint: string;
    }) =>
      ipcRenderer.invoke(ORCH_CHANNELS.missionCheckpointRestore, {
        missionId: input.missionId,
        ref: input.ref,
        fingerprint: input.fingerprint,
      }),
    missionEventsRecent: (input) =>
      ipcRenderer.invoke(ORCH_CHANNELS.missionEventsRecent, input),
    missionEventsReplay: (input) =>
      ipcRenderer.invoke(ORCH_CHANNELS.missionEventsReplay, input),
    missionEventsAck: (input) =>
      ipcRenderer.invoke(ORCH_CHANNELS.missionEventsAck, input),
    missionEventsCursor: (input) =>
      ipcRenderer.invoke(ORCH_CHANNELS.missionEventsCursor, input),
    rebindMissionOrchestrator: (missionId: string, sessionId: string) =>
      ipcRenderer.invoke(ORCH_CHANNELS.missionRebind, { missionId, sessionId }),
    promoteMissionOrchestrator: (input: {
      missionId: string;
      paneId?: string;
      sessionId?: string;
    }) => ipcRenderer.invoke(ORCH_CHANNELS.missionPromoteOrchestrator, input),
    createPaneMission: (input: {
      paneId: string;
      title: string;
      tabKey?: string;
      ownGroup?: boolean;
    }) =>
      ipcRenderer.invoke(ORCH_CHANNELS.missionCreateForPane, input),
    renameTabMission: (input: {
      missionId: string;
      tabKey?: string;
      spaceId?: string;
      fromTitle: string;
      title: string;
    }) => ipcRenderer.invoke(ORCH_CHANNELS.missionRenameForTab, input),
    // F-231: "+ Pane" → "Nesta missão" — worker `operatorOpened` via Main.
    spawnOperatorPane: (input: {
      missionId: string;
      adapterId: string;
      model?: string;
      /** Id do cofre, inclusive conta sem e-mail; nunca fingerprint. */
      accountId?: string;
      prompt?: string;
      tabKey?: string;
    }) =>
      ipcRenderer.invoke(ORCH_CHANNELS.missionSpawnOperatorPane, input),
    updateMission: (missionId: string, patch: MissionPatch) =>
      ipcRenderer.invoke(ORCH_CHANNELS.missionUpdate, { missionId, patch }),
    closeMissionRuntime: (missionId: string) =>
      ipcRenderer.invoke(ORCH_CHANNELS.missionCloseRuntime, { missionId }),
    completeMissionByOperator: (missionId: string) =>
      ipcRenderer.invoke(ORCH_CHANNELS.missionCompleteByOperator, {
        missionId,
      }),
    removeMission: (missionId: string) =>
      ipcRenderer.invoke(ORCH_CHANNELS.missionRemove, { missionId }),
    listHandoffs: () => ipcRenderer.invoke(ORCH_CHANNELS.handoffsList),
    answerClarify: (input) =>
      ipcRenderer.invoke(ORCH_CHANNELS.clarifyAnswerSubmit, input),
    submitOperatorReview: (input) =>
      ipcRenderer.invoke(ORCH_CHANNELS.operatorReviewSubmit, input),
    getTodos: () => ipcRenderer.invoke(ORCH_CHANNELS.todosGet),
    setTodoStatus: (listId: string, itemId: string, status: TodoStatus) =>
      ipcRenderer.invoke(ORCH_CHANNELS.todoSetStatus, { listId, itemId, status }),
    clearTodoBoard: () =>
      ipcRenderer.invoke(ORCH_CHANNELS.todosClearBoard),
    listSquads: () => ipcRenderer.invoke(ORCH_CHANNELS.squadsList),
    designSquad: (workspacePath: string, intent?: string) =>
      ipcRenderer.invoke(
        ORCH_CHANNELS.squadDesign,
        intent ? { workspacePath, intent } : workspacePath,
      ),
    saveSquad: (squad, options) =>
      ipcRenderer.invoke(
        ORCH_CHANNELS.squadSave,
        options?.purpose === 'mission-runtime'
          ? {
              squad,
              purpose: 'mission-runtime',
              guided: options.guided === true,
              sourceSquadId: options.sourceSquadId,
              designDraftToken: options.designDraftToken,
            }
          : squad,
      ),
    deleteSquad: (id) => ipcRenderer.invoke(ORCH_CHANNELS.squadDelete, id),
    exportSquads: () => ipcRenderer.invoke(ORCH_CHANNELS.squadExport),
    importSquads: () => ipcRenderer.invoke(ORCH_CHANNELS.squadImport),
    getMcpInfo: () => ipcRenderer.invoke(ORCH_CHANNELS.mcpInfo),
    getCatalogIndex: (refresh?: boolean) =>
      ipcRenderer.invoke(ORCH_CHANNELS.catalogIndex, { refresh }),
    installCatalogItem: (req) =>
      ipcRenderer.invoke(ORCH_CHANNELS.catalogInstall, req),
    recommendCatalog: (refresh?: boolean) =>
      ipcRenderer.invoke(ORCH_CHANNELS.catalogRecommend, { refresh: refresh === true }),
    getRecipeOverlay: () =>
      ipcRenderer.invoke(ORCH_CHANNELS.recipeOverlay, {}),
    saveCatalogOverlay: (patch) =>
      ipcRenderer.invoke(ORCH_CHANNELS.catalogOverlaySave, patch),
    proposeRecipes: () =>
      ipcRenderer.invoke(ORCH_CHANNELS.recipePropose, {}),
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
    onBgTaskEvent: (cb: (event: BgTaskEventPayload) => void) =>
      addListener(bgTaskEventListeners, cb),
    onPaneLoginStuck: (cb: (event: PaneLoginStuckEvent) => void) =>
      addListener(paneLoginStuckListeners, cb),
    onAgentWaiting: (cb: (event: AgentWaitingEvent) => void) =>
      addListener(agentWaitingListeners, cb),
    onWorkerSpawnFailed: (cb: (event: PaneWorkerSpawnFailedEvent) => void) =>
      addListener(workerSpawnFailedListeners, cb),
  },
  remote: {
    bridgeStatus: () => ipcRenderer.invoke(REMOTE_CHANNELS.bridgeStatus),
    bridgeStart: (req) => ipcRenderer.invoke(REMOTE_CHANNELS.bridgeStart, req ?? {}),
    bridgeStop: () => ipcRenderer.invoke(REMOTE_CHANNELS.bridgeStop),
    bridgeRotatePairing: (req) =>
      ipcRenderer.invoke(REMOTE_CHANNELS.bridgeRotatePairing, req ?? {}),
    bridgeRevokeTokens: () =>
      ipcRenderer.invoke(REMOTE_CHANNELS.bridgeRevokeTokens),
    bridgeSetDeviceScopes: (req) =>
      ipcRenderer.invoke(REMOTE_CHANNELS.bridgeSetDeviceScopes, req),
    detectClis: (target) =>
      ipcRenderer.invoke(REMOTE_CHANNELS.remoteSpawnDetect, { target }),
    listTmux: (target) =>
      ipcRenderer.invoke(REMOTE_CHANNELS.remoteSpawnList, { target }),
    createTmux: (req) =>
      ipcRenderer.invoke(REMOTE_CHANNELS.remoteSpawnCreate, req),
    listSshHosts: () => ipcRenderer.invoke(REMOTE_CHANNELS.sshList),
    connectSshHost: (req) => ipcRenderer.invoke(REMOTE_CHANNELS.sshConnect, req),
    importSshConfig: () => ipcRenderer.invoke(REMOTE_CHANNELS.sshImportConfig),
    removeSshHost: (alias) =>
      ipcRenderer.invoke(REMOTE_CHANNELS.sshRemove, { alias }),
    relay: {
      status: () => ipcRenderer.invoke(COMPANION_RELAY_CHANNELS.status),
      start: (req) => ipcRenderer.invoke(COMPANION_RELAY_CHANNELS.start, req),
      stop: () => ipcRenderer.invoke(COMPANION_RELAY_CHANNELS.stop),
    },
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
    spendGet: () => ipcRenderer.invoke(SETTINGS_CHANNELS.spendGet),
    spendSet: (patch) => ipcRenderer.invoke(SETTINGS_CHANNELS.spendSet, patch),
    onSpendChanged: (cb) => addListener(spendSettingsChangedListeners, cb),
  },
  workspace: {
    get: () => ipcRenderer.invoke(WORKSPACE_CHANNELS.get),
    pick: () => ipcRenderer.invoke(WORKSPACE_CHANNELS.pick),
    pickPath: () => ipcRenderer.invoke(WORKSPACE_CHANNELS.pickPath),
    open: (path) => ipcRenderer.invoke(WORKSPACE_CHANNELS.open, { path }),
    close: () => ipcRenderer.invoke(WORKSPACE_CHANNELS.close),
    remove: (path) => ipcRenderer.invoke(WORKSPACE_CHANNELS.remove, { path }),
    onChanged: (cb) => addListener(workspaceChangedListeners, cb),
    onLiveness: (cb) => addListener(workspaceLivenessListeners, cb),
  },
  orientation: {
    get: (): Promise<OrientationSnapshot | null> =>
      ipcRenderer.invoke(ORIENTATION_CHANNELS.get),
    ensure: (): Promise<OrientationSnapshot | null> =>
      ipcRenderer.invoke(ORIENTATION_CHANNELS.ensure),
    refresh: (): Promise<OrientationSnapshot | null> =>
      ipcRenderer.invoke(ORIENTATION_CHANNELS.refresh),
  },
  contextDrafts: {
    listProposed: (): Promise<PendingContextDraft[]> =>
      ipcRenderer.invoke(CONTEXT_DRAFT_CHANNELS.listProposed),
    approve: (
      input: ApproveContextDraftInput,
    ): Promise<ApproveContextDraftResult> =>
      ipcRenderer.invoke(CONTEXT_DRAFT_CHANNELS.approve, input),
  },
  providers: {
    list: () => ipcRenderer.invoke(PROVIDER_CHANNELS.list),
    setConfig: (patch) => ipcRenderer.invoke(PROVIDER_CHANNELS.setConfig, patch),
    setKey: (req) => ipcRenderer.invoke(PROVIDER_CHANNELS.setKey, req),
    testKey: (adapterId) =>
      ipcRenderer.invoke(PROVIDER_CHANNELS.testKey, { adapterId }),
    authStatus: (options?: { freshClaudeCredential?: boolean }) =>
      ipcRenderer.invoke(PROVIDER_CHANNELS.authStatus, options),
    installCli: (adapterId: string, mode?: 'install' | 'update') =>
      ipcRenderer.invoke(PROVIDER_CHANNELS.installCli, { adapterId, mode }),
    getCliAutoUpdates: () =>
      ipcRenderer.invoke(PROVIDER_CHANNELS.autoCliUpdates, { action: 'get' }),
    setCliAutoUpdates: (enabled: boolean) =>
      ipcRenderer.invoke(PROVIDER_CHANNELS.autoCliUpdates, { action: 'set', enabled }),
    addModel: (adapterId: string, model: string) =>
      ipcRenderer.invoke(PROVIDER_CHANNELS.addModel, { adapterId, model }),
    removeModel: (adapterId: string, model: string) =>
      ipcRenderer.invoke(PROVIDER_CHANNELS.removeModel, { adapterId, model }),
    vaultState: () => ipcRenderer.invoke(PROVIDER_CHANNELS.vaultState),
    exportSecrets: (passphrase: string) =>
      ipcRenderer.invoke(PROVIDER_CHANNELS.exportSecrets, { passphrase }),
    importSecrets: (bundle: string, passphrase: string) =>
      ipcRenderer.invoke(PROVIDER_CHANNELS.importSecrets, { bundle, passphrase }),
    onChanged: (cb) => addListener(providersChangedListeners, cb),
  },
  files: {
    list: (relPath: string) => ipcRenderer.invoke(FILES_CHANNELS.list, { relPath }),
    read: (relPath: string) => ipcRenderer.invoke(FILES_CHANNELS.read, { relPath }),
    search: (query: string) => ipcRenderer.invoke(FILES_CHANNELS.search, { query }),
    write: (relPath: string, content: string) =>
      ipcRenderer.invoke(FILES_CHANNELS.write, { relPath, content }),
    saveDropped: (name: string, base64: string) =>
      ipcRenderer.invoke(FILES_CHANNELS.saveDropped, { name, base64 }),
    importMissionAttachment: (name: string, base64: string) =>
      ipcRenderer.invoke(FILES_CHANNELS.importMissionAttachment, {
        name,
        base64,
      }),
    importDroppedUri: (uri: string) =>
      ipcRenderer.invoke(FILES_CHANNELS.importDroppedUri, { uri }),
    clipboardFileUris: () =>
      ipcRenderer.invoke(FILES_CHANNELS.clipboardFileUris),
    convertHeicToJpeg: (bytes: Uint8Array) =>
      ipcRenderer.invoke(FILES_CHANNELS.convertHeicToJpeg, { bytes }),
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
  terminalBlock: {
    action: (req: unknown) =>
      ipcRenderer.invoke(TERMINAL_BLOCK_CHANNELS.action, req),
    list: (req) => ipcRenderer.invoke(TERMINAL_BLOCK_CHANNELS.list, req),
    suggest: (req) =>
      ipcRenderer.invoke(TERMINAL_BLOCK_CHANNELS.suggest, req),
    dismiss: (req) =>
      ipcRenderer.invoke(TERMINAL_BLOCK_CHANNELS.dismiss, req),
    runSuggestion: (req) =>
      ipcRenderer.invoke(TERMINAL_BLOCK_CHANNELS.runSuggestion, req),
    importCliHistory: (req) =>
      ipcRenderer.invoke(TERMINAL_BLOCK_CHANNELS.importCliHistory, req),
    searchHistory: (req) =>
      ipcRenderer.invoke(TERMINAL_BLOCK_CHANNELS.searchHistory, req),
  },
  searchMixer: {
    search: (query: unknown) =>
      ipcRenderer.invoke(SEARCH_MIXER_CHANNELS.search, query),
  },
  product: {
    flagsList: () => ipcRenderer.invoke(PRODUCT_WAVE_CHANNELS.flagsList),
    flagsSetOverride: (input: { id: string; enabled: boolean | null }) =>
      ipcRenderer.invoke(PRODUCT_WAVE_CHANNELS.flagsSetOverride, input),
    onFlagsChanged: (cb) => addListener(productFlagsChangedListeners, cb),
    memoryList: () => ipcRenderer.invoke(PRODUCT_WAVE_CHANNELS.memoryList),
    memoryRemember: (input) =>
      ipcRenderer.invoke(PRODUCT_WAVE_CHANNELS.memoryRemember, input),
    memorySearch: (query: string) =>
      ipcRenderer.invoke(PRODUCT_WAVE_CHANNELS.memorySearch, { query }),
    memoryBacklinks: (title: string) =>
      ipcRenderer.invoke(PRODUCT_WAVE_CHANNELS.memoryBacklinks, { title }),
    memoryComplete: (prefix: string) =>
      ipcRenderer.invoke(PRODUCT_WAVE_CHANNELS.memoryComplete, { prefix }),
    skillsList: () => ipcRenderer.invoke(PRODUCT_WAVE_CHANNELS.skillsList),
    skillsLockRead: () =>
      ipcRenderer.invoke(PRODUCT_WAVE_CHANNELS.skillsLockRead),
    skillsLockWrite: (lock: unknown) =>
      ipcRenderer.invoke(PRODUCT_WAVE_CHANNELS.skillsLockWrite, lock),
    mcpHubLoad: () => ipcRenderer.invoke(PRODUCT_WAVE_CHANNELS.mcpHubLoad),
    mcpHubSave: (input) =>
      ipcRenderer.invoke(PRODUCT_WAVE_CHANNELS.mcpHubSave, input),
    mcpHubDrift: (observed: unknown) =>
      ipcRenderer.invoke(PRODUCT_WAVE_CHANNELS.mcpHubDrift, { observed }),
    mcpHubHealth: () => ipcRenderer.invoke(PRODUCT_WAVE_CHANNELS.mcpHubHealth),
    mcpHubRollback: (input: { backupPath: string }) =>
      ipcRenderer.invoke(PRODUCT_WAVE_CHANNELS.mcpHubRollback, input),
    mcpHubObserve: () =>
      ipcRenderer.invoke(PRODUCT_WAVE_CHANNELS.mcpHubObserve),
    mcpHubSyncPlan: () =>
      ipcRenderer.invoke(PRODUCT_WAVE_CHANNELS.mcpHubSyncPlan),
    mcpHubSyncApply: (input) =>
      ipcRenderer.invoke(PRODUCT_WAVE_CHANNELS.mcpHubSyncApply, input ?? {}),
    autonomyDecide: (input: unknown) =>
      ipcRenderer.invoke(PRODUCT_WAVE_CHANNELS.autonomyDecide, input),
    searchQuery: (input) =>
      ipcRenderer.invoke(PRODUCT_WAVE_CHANNELS.searchQuery, input),
    editorOpen: (relativePath: string) =>
      ipcRenderer.invoke(PRODUCT_WAVE_CHANNELS.editorOpen, { relativePath }),
    editorApply: (input) =>
      ipcRenderer.invoke(PRODUCT_WAVE_CHANNELS.editorApply, input),
  },
  discovery: {
    workspaceConfigs: () =>
      ipcRenderer.invoke(DISCOVERY_CHANNELS.workspaceConfigs),
  },
  memory: {
    stats: () => ipcRenderer.invoke(MEMORY_CHANNELS.stats),
    recall: (input) => ipcRenderer.invoke(MEMORY_CHANNELS.recall, input),
    forget: (id) => ipcRenderer.invoke(MEMORY_CHANNELS.forget, { id }),
    promote: (id) => ipcRenderer.invoke(MEMORY_CHANNELS.promote, { id }),
    attest: (input) => ipcRenderer.invoke(MEMORY_CHANNELS.attest, input),
    importNative: () => ipcRenderer.invoke(MEMORY_CHANNELS.importNative),
  },
  model: {
    richMetadata: (adapterId, modelId) =>
      ipcRenderer.invoke(MODEL_CHANNELS.richMetadata, { adapterId, modelId }),
  },
  integrations: createIntegrationsBridge(ipcRenderer),
  voiceClone: createVoiceCloneBridge(ipcRenderer),
  accounts: {
    list: () => ipcRenderer.invoke(ACCOUNT_CHANNELS.list),
    quota: () => ipcRenderer.invoke(ACCOUNT_CHANNELS.quota) as Promise<AccountQuotaInfo[]>,
    add: (req) => ipcRenderer.invoke(ACCOUNT_CHANNELS.add, req),
    addActiveClaude: (label: string) =>
      ipcRenderer.invoke(ACCOUNT_CHANNELS.addActiveClaude, { label }),
    addActiveSession: (
      adapterId: string,
      label: string,
      accountId?: string,
    ) =>
      ipcRenderer.invoke(ACCOUNT_CHANNELS.addActiveSession, {
        adapterId,
        label,
        ...(accountId ? { accountId } : {}),
      }),
    supportsSnapshot: (adapterId: string) =>
      ipcRenderer.invoke(ACCOUNT_CHANNELS.supportsSnapshot, { adapterId }),
    prepareAgyLogin: () => ipcRenderer.invoke(ACCOUNT_CHANNELS.prepareAgyLogin),
    restoreAgyLogin: () => ipcRenderer.invoke(ACCOUNT_CHANNELS.restoreAgyLogin),
    prepareCodexLogin: () => ipcRenderer.invoke(ACCOUNT_CHANNELS.prepareCodexLogin),
    restoreCodexLogin: () => ipcRenderer.invoke(ACCOUNT_CHANNELS.restoreCodexLogin),
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
  tokenSpeed: {
    snapshot: () => ipcRenderer.invoke(TOKEN_SPEED_CHANNELS.snapshot),
    onChanged: (cb: (snapshot: TokenSpeedSnapshot) => void) =>
      addListener(tokenSpeedChangedListeners, cb),
  },
  usage: {
    snapshot: () => ipcRenderer.invoke(USAGE_CHANNELS.snapshot),
    lifetime: () =>
      ipcRenderer.invoke(USAGE_CHANNELS.lifetime) as Promise<
        import('../shared/pet-types').PetLifetimeStats
      >,
    history: () =>
      ipcRenderer.invoke(USAGE_CHANNELS.history) as Promise<
        import('../shared/usage-types').UsageHistory
      >,
    onChanged: (cb: (snapshot: UsageSnapshot) => void) =>
      addListener(usageChangedListeners, cb),
  },
  quota: {
    connectMimo: (accountId?: string) => ipcRenderer.invoke(QUOTA_CHANNELS.connectMimo, accountId) as Promise<{ ok: boolean; message: string }>,
    snapshot: () =>
      ipcRenderer.invoke(QUOTA_CHANNELS.snapshot) as Promise<QuotaFleetSnapshot>,
    refresh: () =>
      ipcRenderer.invoke(QUOTA_CHANNELS.refresh) as Promise<QuotaFleetSnapshot>,
    onChanged: (cb: (snapshot: QuotaFleetSnapshot) => void) =>
      addListener(quotaChangedListeners, cb),
  },
  redline: {
    status: () => ipcRenderer.invoke(REDLINE_IPC.status),
    install: () => ipcRenderer.invoke(REDLINE_IPC.install),
    open: () => ipcRenderer.invoke(REDLINE_IPC.open),
    hide: () => ipcRenderer.invoke(REDLINE_IPC.hide),
  },
  gamification: {
    snapshot: (options?: { rescan?: boolean }) =>
      ipcRenderer.invoke(GAMIFICATION_CHANNELS.snapshot, options ?? {}),
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
    onPaneFootprints: (cb) => {
      // QLT-11: o primeiro ouvinte liga a coleta no main; o último a desliga.
      if (paneFootprintsListeners.size === 0) {
        ipcRenderer.send(PERF_CHANNELS.paneFootprintsWatch, true);
      }
      paneFootprintsListeners.add(cb);
      return () => {
        if (paneFootprintsListeners.delete(cb) && paneFootprintsListeners.size === 0) {
          ipcRenderer.send(PERF_CHANNELS.paneFootprintsWatch, false);
        }
      };
    },
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
    generate: (req: MediaStudioRequest) =>
      ipcRenderer.invoke(MEDIA_CHANNELS.generate, req),
    cancelGenerate: (clientJobId: string) =>
      ipcRenderer.invoke(MEDIA_CHANNELS.cancelGenerate, { clientJobId }),
    listArtifacts: () => ipcRenderer.invoke(MEDIA_CHANNELS.listArtifacts),
    revealArtifact: (storageKey: string) =>
      ipcRenderer.invoke(MEDIA_CHANNELS.revealArtifact, { storageKey }),
    readArtifactDataUrl: (storageKey: string) =>
      ipcRenderer.invoke(MEDIA_CHANNELS.readArtifactDataUrl, { storageKey }),
  },
  pipes: {
    list: () => ipcRenderer.invoke(PIPE_CHANNELS.list),
    add: (sourcePaneId: string, targetPaneId: string, mode: PipeMode) =>
      ipcRenderer.invoke(PIPE_CHANNELS.add, { sourcePaneId, targetPaneId, mode }),
    remove: (id: string) => ipcRenderer.invoke(PIPE_CHANNELS.remove, { id }),
    onChanged: (cb) => addListener(pipesChangedListeners, cb),
  },
  billing: {
    logout: () => ipcRenderer.invoke(BILLING_CHANNELS.logout),
    onChanged: (callback) => {
      const listener = (): void => callback();
      ipcRenderer.on(BILLING_CHANNELS.changed, listener);
      return () => { ipcRenderer.removeListener(BILLING_CHANNELS.changed, listener); };
    },
    get: () => ipcRenderer.invoke(BILLING_CHANNELS.get),
    openCheckout: (request: CheckoutRequest['plan'] | CheckoutRequest) =>
      ipcRenderer.invoke(BILLING_CHANNELS.checkout, request),
    openPortal: () => ipcRenderer.invoke(BILLING_CHANNELS.portal),
    redeemCode: (code: string) => ipcRenderer.invoke(BILLING_CHANNELS.redeem, code),
  },
  team: {
    get: () => ipcRenderer.invoke(TEAM_CHANNELS.get),
    join: (code: string) => ipcRenderer.invoke(TEAM_CHANNELS.join, code),
    invite: () => ipcRenderer.invoke(TEAM_CHANNELS.invite),
    removeMember: (accountId: string) =>
      ipcRenderer.invoke(TEAM_CHANNELS.remove, accountId),
    leave: () => ipcRenderer.invoke(TEAM_CHANNELS.leave),
  },
  bugReport: {
    preview: (request) => ipcRenderer.invoke(BUG_REPORT_CHANNELS.preview, request),
    submit: (request) => ipcRenderer.invoke(BUG_REPORT_CHANNELS.submit, request),
    onOpenRequest: (cb) => addListener(bugReportOpenListeners, cb),
  },
  // Só leitura: o Main devolve o recibo já mascarado; o preload repassa apenas
  // o id da sessão (nada mais do chamador chega ao canal).
  accountChoice: {
    get: (sessionId) => ipcRenderer.invoke(ACCOUNT_CHOICE_CHANNELS.get, { sessionId }),
  },
  // PRV-02: só decisão estruturada e ids — nada do chamador vira tecla no PTY.
  approvals: {
    list: () => ipcRenderer.invoke(APPROVAL_CHANNELS.list),
    respond: ({ requestId, expectedRevision, optionId }) =>
      ipcRenderer.invoke(APPROVAL_CHANNELS.respond, { requestId, expectedRevision, optionId }),
    setVisibleSurfaces: (sessionIds) =>
      ipcRenderer.invoke(APPROVAL_CHANNELS.surfaces, { sessionIds }),
    onChanged: (cb) => addListener(approvalsChangedListeners, cb),
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
    openScreenSettings: () =>
      ipcRenderer.invoke(VISION_CHANNELS.openScreenSettings),
    requestPermission: () =>
      ipcRenderer.invoke(VISION_CHANNELS.requestPermission),
    onCaptured: (cb: (result: ScreenCaptureMetadata) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, result: ScreenCaptureMetadata) => cb(result);
      ipcRenderer.on(VISION_CHANNELS.captured, handler);
      return () => ipcRenderer.removeListener(VISION_CHANNELS.captured, handler);
    },
  },
  platform: process.platform,
  windowsBuild: windowsBuildNumber(),
};

// Main alone emits this test-only event, after React mounts in a private smoke
// launch. There is deliberately no renderer-callable method on window.nexus.
let busyBannerSmokeStarted = false;
ipcRenderer.on(BUSY_BANNER_SMOKE_CHANNELS.run, (_event, payload: unknown) => {
  if (busyBannerSmokeStarted || typeof payload !== 'object' || payload === null ||
      Object.keys(payload).length !== 1 || !isBusyBannerSmokeNonce((payload as { nonce?: unknown }).nonce)) return;
  busyBannerSmokeStarted = true;
  const nonce = (payload as { nonce: string }).nonce;
  void observeBusyBannerForSmoke(nonce, ready => ipcRenderer.send(BUSY_BANNER_SMOKE_CHANNELS.ready, ready))
    .then(result => ipcRenderer.send(BUSY_BANNER_SMOKE_CHANNELS.result, result))
    .catch(() => ipcRenderer.send(BUSY_BANNER_SMOKE_CHANNELS.result, { nonce, failed: true }));
});

let functionalSmokeStarted = false;
installSoakPreload(ipcRenderer, api, process);
installRuntimeGatePreload(ipcRenderer, api, process);
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
