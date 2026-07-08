import { useEffect, useRef } from 'react';
import { useVoiceStore } from './voice-store';
import { markVictory, useOnboardingStore } from '../state/onboarding-store';
import { useLayoutStore } from '../state/layout-store';
import { useSessionStateStore } from '../state/session-state-store';
import { VoiceCapture } from './voice-capture';
import { WakeMic } from './wake-mic';
import { hasUsableLocalSpeech, shouldDiscardBeforeRealtime } from './capture-gate';
import { classifyMicHealth, type MicHealth } from './wake-health';
import { LiveAudioPlayer, micFrameToBase64 } from './live-audio';
import { stripPromptEcho } from './response-echo';
import {
  isDiscardableTranscript,
  isWakeAckOnlyTranscript,
  stripWakeAckEcho,
} from './transcript-filter';
import { onJarvisWakeRequest } from './manual-wake';
import {
  delay,
  noteAutoReplyOpened,
  resetAutoReplyLoopForCapture,
  REPLY_LISTEN_DELAY_MS,
  type JarvisCaptureReason,
  shouldReopenJarvisListening,
} from './jarvis-reply-loop';
import {
  bindWakeSuppressor,
  playAudioBase64,
  playSpeakResult,
  stopAllPlayback,
} from './voice-playback';
import {
  getThinkFillerCache,
  invalidateAckCacheIfPersonaChanged,
  playCachedWakeAck,
  playWakePrompt,
  THINK_FILLERS,
  warmAckCache,
  wakeGreetingText,
} from './voice-wake-ack';
import { getPaneSessionId, writeToPane } from '../terminal/terminal-host';
import { listPanes } from '../lib/split-tree';
import { useWorkspaceStore } from '../state/workspace-store';
import { useOrchStore } from '../state/orch-store';
import { useMissionWizardStore } from '../state/mission-wizard-store';
import { useHomeStore } from '../state/home-store';
import { useFilesStore } from '../state/files-store';
import { useSettingsStore } from '../state/settings-store';
import { useGamificationStore } from '../state/gamification-store';
import { listBlockingOverlayLabels, readUiVisibilityState } from './terminal-visibility';
import { useCloseWorkspaceStore } from '../components/CloseWorkspaceDialog';
import { executeJarvisAction } from './jarvis-action-executor';
import { mcpClearSession } from '../services/mcp-bridge';
import { splitForPipelinedSpeech } from './speech-segments';
import {
  buildReplyAutoStop,
  discardSpokenEchoIfNeeded,
  REPLY_MIN_LISTEN_MS,
  transcriptInConversation,
} from './voice-echo-guard';
import { realtimeToolEventToJarvisAction } from './realtime-action';
import { TurnExecutionOwner } from './turn-execution-owner';
import { buildScreenSnapshot, type ScreenSnapshot } from './screen-context';
import { voiceHudStatusFromLiveState } from './live-hud-state';
import {
  shouldLetRealtimeProviderAnswer,
  shouldUseClassicActionBridge,
} from './realtime-bridge-policy';
import {
  REALTIME_TRANSCRIPT_WAIT_MS,
  realtimeTranscriptWaitMs,
} from './realtime-transcript-wait';
import type { AutoStopOptions } from './voice-capture';
import type {
  JarvisAction,
  JarvisContext,
  JarvisLiveToolEvent,
  JarvisLiveTranscriptEvent,
  JarvisTurn,
  SpeakResult,
  VoiceRuntimeInfo,
} from '../../shared/voice-ipc';

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
// Realtime ATIVO (paridade completa — decisão aprovada 2026-07-08): o mic
// streama de verdade ao transporte realtime e o áudio/tool-calls do provider
// fluem. A degradação em runtime para Classic segue valendo (sem key →
// canAttemptRealtime false; socket em erro → liveState.status==='error' →
// shouldStreamToRealtime false).
const REALTIME_ACTION_BRIDGE_ENABLED = true;
const REALTIME_PROVIDER_AUDIO_ENABLED = true;
const WAKE_ACK_SUPPRESS_MS = 8_000;
const WAKE_PREROLL_MS = 2_500;
const WAKE_SILENCE_MS = 700; // wake-word capture: quiet time that ends the utterance
const WAKE_MIN_LISTEN_MS = 1_500; // pre-roll + parallel ack; silence can close once min elapsed
const CLICK_WAKE_SILENCE_MS = 1_050; // click wake: proportional to voice thresholds
const CLICK_WAKE_MIN_LISTEN_MS = 1_125; // mouse wake starts after ack; close quickly once speech ends
const WAKE_MAX_MS = 15_000; // wake-word capture: hard cap
const CLICK_WAKE_MAX_MS = 22_000; // click wake is intentional, so allow a slower follow-up
const PTT_HOLD_MAX_MS = 60_000; // hold-to-talk sem keyup (tap morto) fecha aqui
const JARVIS_MEMORY_MS = 300_000; // 5 min: janela de continuidade (paridade com IDLE_TIMEOUT do Overclock)
const PENDING_REALTIME_AUDIO_MAX_CHUNKS = 160;

// Deadlines das invocações renderer→main (cinto E suspensório sobre os
// timeouts do main): se QUALQUER etapa pendurar além disto, o turno morre com
// erro falável em vez de deixar busy travado — "JARVIS não responde nunca
// mais" era exatamente um await sem deadline segurando o busy para sempre.
export const TRANSCRIBE_DEADLINE_MS = 60_000;
export const BRAIN_DEADLINE_MS = 35_000;
const SPEAK_DEADLINE_MS = 40_000;
// Turno preso além disto + novo "Hey Jarvis" = derruba o turno e atende.
// granted mas mudo além disso → "silent" (dispositivo morto/mudo, ex.: fifine)
const MIC_SILENT_THRESHOLD_MS = 12_000;
// re-avalia permissão + silêncio do mic a cada 5s (banner de saúde reage)
const MIC_HEALTH_CHECK_MS = 5_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} demorou demais (${Math.round(ms / 1000)}s)`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// Memória curta da conversa com a JARVIS (renderer-local, por janela).
let jarvisHistory: JarvisTurn[] = [];
const wakeMic = new WakeMic();
bindWakeSuppressor((ms) => wakeMic.suppressWakeDetection(ms));
// Player do áudio realtime (OpenAI Realtime / Gemini Live): só instanciado sob demanda.
let livePlayer: LiveAudioPlayer | null = null;
function ensureLivePlayer(): LiveAudioPlayer {
  return (livePlayer ??= new LiveAudioPlayer());
}
// Decision is per utterance. Realtime provides fast duplex audio/transcript,
// but app actions still flow through the audited Classic Jarvis/MCP executor.
let realtimeTurnActive = false;
let suppressRealtimeAudioOut = false;
let pendingRealtimeTranscript:
  | {
      resolve: (text: string | null) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  | null = null;
let queuedRealtimeTranscript: string | null = null;
let finishRealtimeCapture: (() => void) | null = null;
let pendingRealtimeAudioOut: string[] = [];
let jarvisLastTurnAt = 0;
let wakeOpenInProgress = false;
let activeCaptureReason: JarvisCaptureReason = 'manual';
let realtimeNativeToolInFlight = 0;
let lastRealtimeNativeToolAt = 0;
// NEW-A: single execution owner per conversational turn. The realtime toolCall
// (fire-and-forget onLiveToolCall IPC) and Classic runJarvisTurn (driven off the
// transcript) can both target the SAME utterance; IPC ordering is not guaranteed,
// so whichever path CLAIMS the turn first wins and the loser no-ops. This is the
// authoritative race-closer — hasRealtimeNativeToolSince stays only as a cheap
// fast-path that avoids interrupting the provider when a tool clearly already fired.
const turnExecution = new TurnExecutionOwner();
type WakeSource = 'voice' | 'click';
// Início do turno em processamento (0 = nenhum) — o wake usa para detectar
// turno PRESO (fetch pendurado etc.) e retomar o controle.


function isJarvisLiveEnabled(): boolean {
  const info = useVoiceStore.getState().info;
  return Boolean(info?.jarvisLive.enabled && info.routing === 'jarvis');
}

/** Transporte realtime (áudio full-duplex OpenAI/Gemini) ligado? */
function isRealtimeLive(): boolean {
  const info = useVoiceStore.getState().info;
  const liveState = useVoiceStore.getState().liveState;
  return Boolean(
    isJarvisLiveEnabled() &&
      info?.jarvisLive.transport !== 'classic' &&
      liveState?.realtimeReady === true &&
      liveState.status !== 'error',
  );
}

function hasCredential(info: VoiceRuntimeInfo | null | undefined, envVar: string): boolean {
  return Boolean(
    info?.keys.some((key) => key.envVar === envVar && (key.hasEnv || key.hasStoredKey)),
  );
}

function canAttemptRealtime(info: VoiceRuntimeInfo | null | undefined): boolean {
  if (!info?.jarvisLive.enabled || info.jarvisLive.transport === 'classic') return false;
  // Realtime engages with EITHER key regardless of the configured transport:
  // gemini-live prefers GEMINI but the main-side resolution now falls back to
  // OpenAI Realtime (gemini→openai→classic), and openai-realtime prefers OPENAI
  // but can fall back to Gemini. `hasCredential` reflects the same source union
  // (stored key OR env) that the main-side voice-secrets chain resolves — so a
  // key that only lives in the encrypted secrets store still satisfies the gate.
  return hasCredential(info, 'OPENAI_API_KEY') || hasCredential(info, 'GEMINI_API_KEY');
}

function shouldStreamToRealtime(): boolean {
  // Classic mode: STT bridge off — evita +1,2–1,8s de espera por transcript realtime.
  if (!REALTIME_PROVIDER_AUDIO_ENABLED || !REALTIME_ACTION_BRIDGE_ENABLED) return false;
  // Wake/click/reply: só Classic STT — evita 1,2s de espera + fallback e eco.
  if (isAckGatedCapture() || activeCaptureReason === 'reply') return false;
  const info = useVoiceStore.getState().info;
  const liveState = useVoiceStore.getState().liveState;
  return Boolean(
    realtimeTurnActive &&
      isJarvisLiveEnabled() &&
      info?.jarvisLive.transport !== 'classic' &&
      canAttemptRealtime(info) &&
      liveState?.status !== 'error',
  );
}

function resolvePendingRealtimeTranscript(text: string | null): void {
  const pending = pendingRealtimeTranscript;
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingRealtimeTranscript = null;
  pending.resolve(text);
}

function resetPendingRealtimeAudioOut(): void {
  pendingRealtimeAudioOut = [];
}

function playRealtimeAudioOut(b64: string): void {
  useVoiceStore.getState().setStatus('speaking');
  wakeMic.suppressWakeDetection(1_200);
  ensureLivePlayer().play(b64);
}

function flushPendingRealtimeAudioOut(): void {
  if (suppressRealtimeAudioOut || pendingRealtimeAudioOut.length === 0) return;
  const chunks = pendingRealtimeAudioOut;
  pendingRealtimeAudioOut = [];
  for (const chunk of chunks) playRealtimeAudioOut(chunk);
}

function queuePendingRealtimeAudioOut(b64: string): void {
  if (!realtimeTurnActive) return;
  if (pendingRealtimeAudioOut.length >= PENDING_REALTIME_AUDIO_MAX_CHUNKS) {
    pendingRealtimeAudioOut.shift();
  }
  pendingRealtimeAudioOut.push(b64);
}

function waitForRealtimeTranscript(timeoutMs = REALTIME_TRANSCRIPT_WAIT_MS): Promise<string | null> {
  if (queuedRealtimeTranscript) {
    const text = queuedRealtimeTranscript;
    queuedRealtimeTranscript = null;
    return Promise.resolve(text);
  }
  if (pendingRealtimeTranscript) resolvePendingRealtimeTranscript(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingRealtimeTranscript?.resolve === resolve) {
        pendingRealtimeTranscript = null;
      }
      resolve(null);
    }, timeoutMs);
    pendingRealtimeTranscript = { resolve, timer };
  });
}

function isAckGatedCapture(reason: JarvisCaptureReason = activeCaptureReason): boolean {
  return reason === 'wake' || reason === 'click';
}

function commandFromRealtimeTranscript(text: string): string | null {
  const raw = text.trim();
  if (!raw) return null;
  if (isAckGatedCapture() && isWakeAckOnlyTranscript(raw, personaUserName())) {
    return null;
  }
  const transcript =
    isAckGatedCapture() ? stripWakeAckEcho(raw, personaUserName()) : raw;
  return transcript.trim() || null;
}

function hasRealtimeNativeToolSince(since: number): boolean {
  return realtimeNativeToolInFlight > 0 || lastRealtimeNativeToolAt >= since;
}

function onRealtimeTranscriptForActionBridge(event: JarvisLiveTranscriptEvent): void {
  if (!realtimeTurnActive || event.role !== 'user' || !event.final) return;
  const text = commandFromRealtimeTranscript(event.text);
  if (!text) {
    if (isAckGatedCapture()) {
      console.log(`[voice] realtime wake/click só ack/eco: "${event.text.trim()}"`);
    }
    return;
  }
  queuedRealtimeTranscript = text;
  if (pendingRealtimeTranscript) {
    queuedRealtimeTranscript = null;
    resolvePendingRealtimeTranscript(text);
    return;
  }
  window.setTimeout(() => finishRealtimeCapture?.(), 80);
}

function liveStatus(
  status: 'dormant' | 'listening' | 'thinking' | 'speaking' | 'interrupted' | 'error',
  error?: string,
): void {
  if (!isJarvisLiveEnabled()) return;
  void window.nexus.voice.liveStatus({ status, ...(error ? { error } : {}) });
}

function liveEndTurn(): void {
  if (!isJarvisLiveEnabled()) return;
  void window.nexus.voice
    .liveEndTurn()
    .then((state) => useVoiceStore.getState().setLiveState(state))
    .catch(() => {})
    .finally(() => {
      void clearJarvisMcpSession();
    });
}

function liveContextText(): string {
  const screen = currentScreenSnapshot().context;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
  const now = new Date().toLocaleString('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
  });
  return `${screen} Local time: ${now} (${timeZone}).`;
}

function sendLiveContextSnapshot(): void {
  if (!isJarvisLiveEnabled()) return;
  window.nexus.voice.liveContextIn(liveContextText());
}

function queueLiveContextRefresh(): void {
  sendLiveContextSnapshot();
  window.setTimeout(sendLiveContextSnapshot, 120);
}

function logVoiceEvent(
  level: 'info' | 'warn' | 'error',
  event: string,
  msg?: string,
  data?: Record<string, unknown>,
): void {
  window.nexus.voice.logVoice({
    level,
    event,
    ...(msg ? { msg: msg.slice(0, 500) } : {}),
    ...(data ? { data } : {}),
  });
}

async function clearJarvisMcpSession(): Promise<void> {
  try {
    const result = await mcpClearSession();
    if (!result.ok) {
      console.warn('[voice] não consegui limpar sessão MCP da Jarvis');
    }
  } catch (err) {
    console.warn('[voice] falha limpando sessão MCP da Jarvis:', errMsg(err));
  }
}

async function executeJarvisActionForTurn(
  ...args: Parameters<typeof executeJarvisAction>
): ReturnType<typeof executeJarvisAction> {
  try {
    return await executeJarvisAction(...args);
  } finally {
    await clearJarvisMcpSession();
  }
}

function personaUserName(): string {
  return useVoiceStore.getState().info?.persona.userName?.trim() ?? '';
}

function currentScreenSnapshot(): ScreenSnapshot {
  const workspace = useWorkspaceStore.getState().current;
  const { root, focusedPaneId, viewKind } = useLayoutStore.getState();
  const panes = listPanes(root);
  const orchPaneId = findOrchestratorPane(root);
  const orch = useOrchStore.getState();
  const wizard = useMissionWizardStore.getState();
  const files = useFilesStore.getState();
  const settings = useSettingsStore.getState();
  const homeVisible = useHomeStore.getState().visible;
  const voiceSettingsOpen = useVoiceStore.getState().settingsOpen;
  const operatorProfileOpen = useGamificationStore.getState().profileOpen;
  const closeWorkspaceOpen = useCloseWorkspaceStore.getState().open;
  const onboarding = useOnboardingStore.getState();
  const onboardingVisible =
    onboarding.loaded && !onboarding.state.completed && !onboarding.state.skipped;
  const hiddenShellCount = panes.filter((pane) => pane.kind === 'shell').length;
  const activeMissions = orch.missions
    .filter((m) => m.status !== 'done')
    .map((m) => `${m.title} (${m.status})`);
  const baseScreenInput = {
    workspaceName: workspace?.name ?? null,
    viewKind,
    panes,
    focusedPaneId,
    orchestratorPaneId: orchPaneId,
    activeMissions,
  };

  if (voiceSettingsOpen) {
    return buildScreenSnapshot({
      ...baseScreenInput,
      surface: { kind: 'voice-settings' },
    });
  }
  if (operatorProfileOpen) {
    return buildScreenSnapshot({
      ...baseScreenInput,
      surface: { kind: 'operator-profile' },
    });
  }
  if (onboardingVisible) {
    return buildScreenSnapshot({
      ...baseScreenInput,
      surface: { kind: 'onboarding' },
    });
  }
  if (closeWorkspaceOpen) {
    return buildScreenSnapshot({
      ...baseScreenInput,
      surface: { kind: 'close-workspace' },
    });
  }
  if (settings.drawerOpen) {
    return buildScreenSnapshot({
      ...baseScreenInput,
      surface: { kind: 'settings' },
    });
  }
  if (wizard.open) {
    const mode = wizard.presetSquadId
      ? 'revisão de squad pronto'
      : wizard.variant === 'workspace'
        ? 'novo workspace'
        : 'nova missão';
    return buildScreenSnapshot({
      ...baseScreenInput,
      surface: { kind: 'wizard', mode },
    });
  }
  if (homeVisible) {
    return buildScreenSnapshot({
      ...baseScreenInput,
      surface: {
        kind: 'home',
        readySquads: orch.squads.slice(0, 3).map((s) => s.name),
        hiddenShellCount,
      },
    });
  }
  if (files.open) {
    return buildScreenSnapshot({
      ...baseScreenInput,
      surface: {
        kind: 'files',
        file: files.openFile?.relPath ?? null,
        dirty: files.openFile?.dirty ?? false,
      },
    });
  }
  if (orch.boardOpen) {
    return buildScreenSnapshot({
      ...baseScreenInput,
      surface: { kind: 'ops-board', missionCount: orch.missions.length },
    });
  }
  if (orch.panelOpen) {
    return buildScreenSnapshot({
      ...baseScreenInput,
      surface: { kind: 'orch-panel', tab: orch.panelTab },
    });
  }

  const ui = readUiVisibilityState();
  const blockingOverlays = listBlockingOverlayLabels(ui.overlays);

  return buildScreenSnapshot({
    ...baseScreenInput,
    surface: { kind: 'workspace', blockingOverlays },
  });
}

function buildJarvisContext(): JarvisContext {
  const { root, focusedPaneId } = useLayoutStore.getState();
  const panes = listPanes(root);
  const orchPaneId = findOrchestratorPane(root);
  const orchPane = panes.find((p) => p.id === orchPaneId) ?? null;
  const focusedPane = panes.find((p) => p.id === focusedPaneId) ?? null;
  const screen = currentScreenSnapshot();
  return {
    workspace: useWorkspaceStore.getState().current?.name ?? null,
    userName: personaUserName() || null,
    screen: screen.context,
    recents: useWorkspaceStore.getState().recents.map((r) => r.name).slice(0, 10),
    squads: useOrchStore.getState().squads.map((s) => s.name),
    panes: panes
      .map((p) => {
        const tag =
          p.id === orchPaneId
            ? '[orquestrador] '
            : p.kind === 'shell'
              ? '[shell] '
              : p.kind === 'browser'
                ? '[browser] '
                : '[agente] ';
        return `${tag}${p.title}`;
      })
      .slice(0, 20),
    focusedPane: focusedPane?.title ?? null,
    focusedPaneKind: focusedPane?.kind ?? null,
    focusedPaneUrl: focusedPane?.browserUrl ?? null,
    orchestrator: orchPane?.title ?? null,
    missions: useOrchStore
      .getState()
      .missions.filter((m) => m.status !== 'done')
      .map((m) => `${m.title} (${m.status})`)
      .slice(0, 10),
  };
}

function actionFromRealtimeToolEvent(event: JarvisLiveToolEvent): JarvisAction | null {
  return realtimeToolEventToJarvisAction(event);
}

async function speakRealtimeToolResult(text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;
  const store = useVoiceStore.getState();
  stopAllPlayback();
  store.setStatus('speaking');
  liveStatus('speaking');
  const spoken = await speakAndPlayPipelined(trimmed);
  if (!spoken.ok) {
    store.setError(spoken.error);
    return;
  }
  store.setSpoken(trimmed);
  void window.nexus.voice.recordEcho(trimmed);
  wakeMic.suppressWakeDetection(
    Math.min(12_000, Math.max(3_500, trimmed.length * 70 + 2_000)),
  );
}

async function speakViaLiveProvider(text: string): Promise<boolean> {
  const trimmed = text.trim();
  if (!trimmed || !REALTIME_PROVIDER_AUDIO_ENABLED || !isRealtimeLive()) return false;
  suppressRealtimeAudioOut = false;
  resetPendingRealtimeAudioOut();
  livePlayer?.stop();
  stopAllPlayback();
  wakeMic.suppressWakeDetection(
    Math.min(12_000, Math.max(3_500, trimmed.length * 70 + 2_000)),
  );
  try {
    const state = await window.nexus.voice.liveSay({ text: trimmed });
    useVoiceStore.getState().setLiveState(state);
    if (!state.realtimeReady || state.status === 'error') {
      suppressRealtimeAudioOut = true;
      return false;
    }
    useVoiceStore.getState().setStatus('speaking');
    return true;
  } catch (err) {
    suppressRealtimeAudioOut = true;
    console.warn('[voice] liveSay falhou; TTS Classic assume:', errMsg(err));
    return false;
  }
}

async function executeRealtimeToolCall(event: JarvisLiveToolEvent): Promise<void> {
  if (!event.callId || !event.name || event.source !== 'realtime') return;
  if (event.name !== 'nexus_action') return;
  const action = actionFromRealtimeToolEvent(event);
  lastRealtimeNativeToolAt = Date.now();
  realtimeNativeToolInFlight += 1;
  const store = useVoiceStore.getState();
  try {
    if (!action) {
      window.nexus.voice.liveToolResult({
        source: 'realtime',
        callId: event.callId,
        name: event.name,
        tool: 'none',
        ok: false,
        summary: 'ação realtime inválida',
        args: event.args,
        output: { error: 'invalid_action' },
      });
      return;
    }

    // NEW-A: claim the current turn. If the Classic brain already claimed it
    // (transcript path won the IPC race), do NOT execute again — just ack the
    // provider so its function call does not self-starve on the result timeout.
    if (!turnExecution.claim('realtime-tool', turnExecution.currentToken)) {
      console.log('[voice] tool-call realtime ignorado; turno já reivindicado pelo Classic');
      logVoiceEvent('info', 'jarvis.realtimeActionSkipped', 'turno já reivindicado pelo Classic', {
        callId: event.callId,
        tool: action.type,
      });
      window.nexus.voice.liveToolResult({
        source: 'realtime',
        callId: event.callId,
        name: event.name,
        tool: action.type,
        ok: true,
        summary: 'já processado',
        args: event.args,
        output: { ok: true, summary: 'já processado pelo Classic', tool: action.type },
      });
      return;
    }

    store.setStatus('routing');
    liveStatus('thinking');
    const context = buildJarvisContext();
    const reply = { say: '', action };
    const exec = await executeJarvisActionForTurn(reply, context);
    const toolResult = exec.toolResult ?? {
      tool: action.type,
      ok: true,
      summary: exec.sayText.trim() || 'executado',
    };
    logVoiceEvent(
      toolResult.ok ? 'info' : 'warn',
      'jarvis.realtimeActionResult',
      toolResult.summary,
      {
        tool: toolResult.tool,
        ok: toolResult.ok,
        callId: event.callId,
      },
    );
    window.nexus.voice.liveToolResult({
      source: 'realtime',
      callId: event.callId,
      name: event.name,
      tool: toolResult.tool,
      ok: toolResult.ok,
      summary: toolResult.summary,
      args: event.args,
      output: {
        ok: toolResult.ok,
        summary: toolResult.summary,
        tool: toolResult.tool,
      },
    });
    queueLiveContextRefresh();

    if (toolResult.ok) {
      void window.nexus.gamification
        .recordJarvisAction({ actionType: toolResult.tool, ok: true })
        .then((snap) => useGamificationStore.getState().receive(snap))
        .catch(() => {});
    }

    if (!REALTIME_PROVIDER_AUDIO_ENABLED) {
      const sayText =
        exec.sayText.trim() ||
        (toolResult.ok ? 'Feito, patrão.' : `Não consegui: ${toolResult.summary}.`);
      await speakRealtimeToolResult(sayText);
    } else {
      suppressRealtimeAudioOut = false;
      flushPendingRealtimeAudioOut();
    }
  } catch (err) {
    const message = errMsg(err);
    logVoiceEvent('error', 'jarvis.realtimeActionError', message, {
      callId: event.callId,
      tool: event.tool,
    });
    window.nexus.voice.liveToolResult({
      source: 'realtime',
      callId: event.callId,
      name: event.name,
      tool: action?.type ?? 'none',
      ok: false,
      summary: message,
      args: event.args,
      output: { error: message },
    });
    store.setError(message);
  } finally {
    realtimeNativeToolInFlight = Math.max(0, realtimeNativeToolInFlight - 1);
    const currentStatus = useVoiceStore.getState().status;
    if (currentStatus === 'speaking' || currentStatus === 'routing') {
      useVoiceStore.getState().setStatus('idle');
    }
  }
}

async function speakSegment(text: string, label: string): Promise<SpeakResult> {
  return withTimeout(
    window.nexus.voice.speak({ text, speakMode: 'full' }),
    SPEAK_DEADLINE_MS,
    label,
  );
}

async function speakAndPlayPipelined(
  text: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { first, rest } = splitForPipelinedSpeech(text);
  if (!first) return { ok: true };
  const firstSpoken = await speakSegment(first, 'TTS');
  if (!firstSpoken.ok) return { ok: false, error: firstSpoken.error };
  surfaceTtsFallback(firstSpoken);

  const restPromise =
    rest && firstSpoken.mode === 'audio' ? speakSegment(rest, 'TTS continuação') : null;
  await playSpeakResult(firstSpoken);

  if (!rest) return { ok: true };
  const restSpoken = restPromise ? await restPromise : await speakSegment(rest, 'TTS continuação');
  if (!restSpoken.ok) return { ok: false, error: restSpoken.error };
  surfaceTtsFallback(restSpoken);
  await playSpeakResult(restSpoken);
  return { ok: true };
}


/** Auto-stop padrão das capturas iniciadas por voz (sem tecla de soltar). */
function wakeAutoStop(
  capture: VoiceCapture,
  busy: React.MutableRefObject<boolean>,
  reason: 'wake' | 'click' = 'wake',
): AutoStopOptions {
  return {
    silenceMs: reason === 'click' ? CLICK_WAKE_SILENCE_MS : WAKE_SILENCE_MS,
    minListenMs: reason === 'click' ? CLICK_WAKE_MIN_LISTEN_MS : WAKE_MIN_LISTEN_MS,
    maxMs: reason === 'click' ? CLICK_WAKE_MAX_MS : WAKE_MAX_MS,
    onAutoStop: () => {
      if (isListening(capture)) void finishAndProcess(capture, busy);
    },
  };
}

export function useVoiceController(): void {
  const capture = useRef<VoiceCapture | null>(null);
  const busy = useRef(false);
  // Trava de narração proativa: garante uma fala ambiente por vez (anti-eco de
  // duas vozes sobrepostas).
  const narratingRef = useRef(false);

  useEffect(() => {
    capture.current = new VoiceCapture();
    // Nível de mic ao vivo → orb como visualizador REAL de amplitude.
    capture.current.onLevel = (level) => useVoiceStore.getState().setLevel(level);
    wakeMic.onLevel = (level) => useVoiceStore.getState().setLevel(level);
    const store = useVoiceStore.getState();

    // Wake word ("Jarvis"): detection → ela RESPONDE ao chamado ("Pois não?")
    // e então abre a escuta hands-free (auto-stop por silêncio).
    const handleWake = async (source: WakeSource) => {
      if (wakeOpenInProgress) return;
      wakeOpenInProgress = true;
      try {
        markVictory('voiceEnabled');
        // BARGE-IN total: novo "Hey Jarvis" sempre retoma — turno preso deixava surda.
        stopAllPlayback();
        if (wakeMic.isUtteranceActive()) wakeMic.cancelUtterance();
        if (capture.current?.isCapturing()) {
          try {
            await capture.current.stop();
          } catch {
            // segue — o wake mic quente é o caminho principal
          }
        }
        busy.current = true;
        useVoiceStore.getState().setStatus('idle');
        useVoiceStore.getState().setError(null);

        // Wake usa transcript live quando disponível, mas áudio/resposta ficam no executor clássico.
        suppressRealtimeAudioOut = true;
        realtimeTurnActive = false;
        queuedRealtimeTranscript = null;
        resolvePendingRealtimeTranscript(null);
        livePlayer?.stop();
        void window.nexus.voice.liveInterrupt('wake-ack').catch(() => {});

        let wakePreRoll =
          source === 'voice' ? wakeMic.snapshotPreRoll(WAKE_PREROLL_MS) : [];
        const ack = wakeGreetingText(personaUserName());
        wakeMic.suppressWakeDetection(WAKE_ACK_SUPPRESS_MS);
        if (source === 'click') {
          // Mouse wake is user-paced: play the audible ACK first, then start
          // the command window. Starting capture before a cold TTS ACK made the
          // listen timer expire while Jarvis was still saying "Pois não".
          await playWakePrompt(ack).catch(() => playCachedWakeAck(personaUserName()));
          wakeMic.suppressWakeDetection(WAKE_ACK_SUPPRESS_MS);
          await beginListening(
            capture.current!,
            wakeAutoStop(capture.current!, busy, 'click'),
            'click',
            [],
            busy,
          );
          return;
        }
        // Wake por voz: mic abre em paralelo com o ack — o usuário pode falar
        // durante "Pois não?"; echoCancellation + stripWakeAckEcho filtram o eco.
        wakeMic.suppressWakeDetection(WAKE_ACK_SUPPRESS_MS);
        const listenPromise = beginListening(
          capture.current!,
          wakeAutoStop(capture.current!, busy, 'wake'),
          'wake',
          wakePreRoll,
          busy,
        );
        await playWakePrompt(ack).catch(() => playCachedWakeAck(personaUserName()));
        wakeMic.suppressWakeDetection(WAKE_ACK_SUPPRESS_MS);
        await listenPromise;
      } catch (err) {
        busy.current = false;
        useVoiceStore.getState().setError(`Wake falhou: ${errMsg(err)}`);
      } finally {
        wakeOpenInProgress = false;
      }
    };
    const onWake = (source: WakeSource = 'voice') => {
      if (wakeOpenInProgress) {
        console.log('[voice] wake ignorado (turno em andamento)');
        return;
      }
      const voiceStatus = useVoiceStore.getState().status;
      // Barge-in: speaking/transcribing/routing são interrompidos pelo novo wake.
      if (
        busy.current &&
        !['idle', 'listening', 'speaking', 'transcribing', 'routing'].includes(voiceStatus)
      ) {
        console.log('[voice] wake ignorado (pipeline ocupado)');
        return;
      }
      void handleWake(source);
    };
    // Morte do stream do mic (AirPods trocados, sleep/wake): o WakeMic
    // reconstrói sozinho; se esgotar, a UI avisa em vez de ficar surda muda.
    // Auto-rearme: onDied NÃO é mais estado terminal — o WakeMic continua
    // tentando a cada 30s até o dispositivo voltar. Avisamos como nota
    // transitória, não como erro vermelho exigindo toggle manual.
    wakeMic.onDied = (reason) => {
      useVoiceStore
        .getState()
        .setNote(`Mic do wake rearmarando (${reason}) a cada 30s…`);
    };
    wakeMic.onRecovered = () => {
      useVoiceStore.getState().setNote('mic do wake reconectado');
    };

    // ── Saúde do mic: detecta permissão faltando / captura muda e avisa a UI ──
    // macOS entrega áudio mudo (zeros) sem erro quando falta permissão; sem isto
    // a JARVIS fica "surda" em silêncio. classifications → banner acionável.
    let lastMicHealth: MicHealth | null = null;
    const checkMicHealth = async (): Promise<void> => {
      if (!wakeMic.isRunning()) {
        if (lastMicHealth && lastMicHealth !== 'ok') {
          useVoiceStore.getState().setMicHealth('ok');
          lastMicHealth = 'ok';
        }
        return;
      }
      const perm = await wakeMic.checkPermission();
      const health = classifyMicHealth(
        perm,
        wakeMic.getSilentMs(),
        MIC_SILENT_THRESHOLD_MS,
      );
      if (health !== lastMicHealth) {
        useVoiceStore.getState().setMicHealth(health);
        lastMicHealth = health;
        if (health !== 'ok') {
          window.nexus.voice.logVoice({
            level: 'warn',
            event: 'mic.health',
            msg: health,
            data: { permission: perm },
          });
        }
      }
    };
    const micHealthTimer = setInterval(checkMicHealth, MIC_HEALTH_CHECK_MS);
    void checkMicHealth();
    const syncWakeWord = (info: VoiceRuntimeInfo) => {
      if (info.enabled && info.wakeWordEnabled) {
        invalidateAckCacheIfPersonaChanged(info);
        warmAckCache(info.persona.userName ?? '');
        void wakeMic.start().catch((err) => {
          useVoiceStore
            .getState()
            .setError(`Wake word indisponível: ${errMsg(err)}`);
        });
      } else {
        wakeMic.stop();
      }
    };

    void window.nexus.voice.getInfo().then((info) => {
      store.setInfo(info);
      syncWakeWord(info);
    });
    const unsubInfo = window.nexus.voice.onInfoChanged((info: VoiceRuntimeInfo) => {
      useVoiceStore.getState().setInfo(info);
      syncWakeWord(info);
    });
    const unsubLiveState = window.nexus.voice.onLiveState((state) => {
      useVoiceStore.getState().setLiveState(state);
      const hudStatus = voiceHudStatusFromLiveState(
        state,
        isListening(capture.current),
      );
      if (hudStatus) useVoiceStore.getState().setStatus(hudStatus);
      if (state.status === 'error' && state.error) {
        useVoiceStore.getState().setNote(state.error);
      }
    });
    const unsubLiveTranscript = window.nexus.voice.onLiveTranscript((event) => {
      useVoiceStore.getState().addLiveTranscript(event);
      if (
        event.role === 'assistant' &&
        event.final &&
        event.text.trim() &&
        !suppressRealtimeAudioOut
      ) {
        useVoiceStore.getState().setSpoken(event.text.trim());
        void window.nexus.voice.recordEcho(event.text).catch(() => {});
      }
      onRealtimeTranscriptForActionBridge(event);
    });
    const unsubTranscriptAppend = window.nexus.voice.onTranscriptAppend((event) => {
      useVoiceStore.getState().addTranscriptAppend(event);
    });
    const unsubLiveToolCall = window.nexus.voice.onLiveToolCall((event) => {
      useVoiceStore.getState().setLiveTool(event);
      if (event.source === 'realtime') {
        void executeRealtimeToolCall(event);
      }
    });
    const unsubLiveToolResult = window.nexus.voice.onLiveToolResult((event) => {
      useVoiceStore.getState().setLiveTool(event);
    });
    const unsubLiveInterrupted = window.nexus.voice.onLiveInterrupted((event) => {
      useVoiceStore.getState().setLiveInterrupted(event);
      // barge-in do servidor realtime: corta o áudio que está tocando.
      livePlayer?.stop();
    });
    // Áudio realtime (provider TTS PCM 24 kHz) → toca em fila contínua.
    const unsubLiveAudio = window.nexus.voice.onLiveAudioOut((b64) => {
      if (suppressRealtimeAudioOut) {
        queuePendingRealtimeAudioOut(b64);
        return;
      }
      playRealtimeAudioOut(b64);
    });
    // Espelha o mic para o transporte realtime enquanto o comando é falado.
    wakeMic.setUtteranceFrameTap((frame, sampleRate) => {
      if (shouldStreamToRealtime()) {
        window.nexus.voice.liveMicIn(micFrameToBase64(frame, sampleRate));
      }
    });

    const onStart = () => {
      if (busy.current) return;
      // Hold-to-talk com guarda: se o keyup nunca chegar (event tap do uiohook
      // morto — o macOS desliga taps em silêncio), o deadline fecha o turno.
      const holdGuard: AutoStopOptions = {
        silenceMs: PTT_HOLD_MAX_MS, // nunca fecha por silêncio no hold
        maxMs: PTT_HOLD_MAX_MS,
        onAutoStop: () => {
          if (isListening(capture.current)) void finishAndProcess(capture.current!, busy);
        },
      };
      void beginListening(capture.current!, holdGuard, 'ptt', undefined, busy);
    };
    const onStop = () => {
      if (!isListening(capture.current)) return;
      void finishAndProcess(capture.current!, busy);
    };

    // Toggle: o renderer decide — capturando? envia. Senão, começa a ouvir.
    const onToggle = () => {
      if (isListening(capture.current)) {
        onStop();
      } else {
        stopAllPlayback();
        if (busy.current && useVoiceStore.getState().status === 'speaking') {
          busy.current = false;
        }
        void beginListening(capture.current!, undefined, 'manual', undefined, busy);
      }
    };

    const unsubStart = window.nexus.voice.onPttStart(onStart);
    const unsubStop = window.nexus.voice.onPttStop(onStop);
    const unsubToggle = window.nexus.voice.onPttToggle(onToggle);
    const unsubWake = window.nexus.voice.onWakeDetected(() => onWake('voice'));
    const unsubClickWake = onJarvisWakeRequest(() => onWake('click'));
    // Narração proativa (handoff entregue/travado): fala só quando não há
    // turno de voz em andamento — aviso ambiente nunca atropela a conversa. É
    // SERIALIZADA (narratingRef): uma narração por vez, nunca duas vozes
    // sobrepostas. Marca 'speaking' enquanto fala para bloquear turnos e
    // narrações concorrentes; cancela qualquer playback pendente antes.
    const unsubNarrate = window.nexus.voice.onNarrate(({ text }) => {
      const status = useVoiceStore.getState().status;
      if (status !== 'idle' || narratingRef.current) {
        console.log('[voice] narração pulada (ocupado):', text.slice(0, 60));
        return;
      }
      narratingRef.current = true;
      const store = useVoiceStore.getState();
      store.setStatus('speaking');
      stopAllPlayback();
      void (async () => {
        try {
          const spoken = await window.nexus.voice.speak({ text, speakMode: 'full' });
          if (spoken.ok && spoken.mode === 'audio') {
            await playAudioBase64(spoken.audioBase64, spoken.format);
          }
        } catch (err) {
          console.warn('[voice] narração falhou:', err);
        } finally {
          narratingRef.current = false;
          if (useVoiceStore.getState().status === 'speaking') {
            useVoiceStore.getState().setStatus('idle');
          }
        }
      })();
    });

    return () => {
      clearInterval(micHealthTimer);
      unsubInfo();
      unsubStart();
      unsubStop();
      unsubToggle();
      unsubWake();
      unsubClickWake();
      unsubNarrate();
      unsubLiveState();
      unsubLiveTranscript();
      unsubTranscriptAppend();
      unsubLiveToolCall();
      unsubLiveToolResult();
      unsubLiveInterrupted();
      unsubLiveAudio();
      wakeMic.setUtteranceFrameTap(null);
      livePlayer?.dispose();
      livePlayer = null;
      wakeMic.stop();
    };
  }, []);
}

async function beginListening(
  capture: VoiceCapture,
  autoStop?: import('./voice-capture').AutoStopOptions,
  reason: JarvisCaptureReason = 'manual',
  preRollSeed?: Float32Array[],
  busy?: React.MutableRefObject<boolean>,
): Promise<void> {
  const store = useVoiceStore.getState();
  try {
    store.setNote(null);
    queuedRealtimeTranscript = null;
    resetPendingRealtimeAudioOut();
    realtimeTurnActive = false;
    // NEW-A: open a fresh turn — both the realtime tool path and the Classic
    // brain path claim THIS token; first claimant executes, the loser no-ops.
    turnExecution.beginTurn();
    activeCaptureReason = reason;
    finishRealtimeCapture = busy
      ? () => {
          if (isListening(capture)) void finishAndProcess(capture, busy);
        }
      : null;
    if (isAckGatedCapture(reason)) {
      suppressRealtimeAudioOut = true;
      void window.nexus.voice.liveInterrupt('wake-listen').catch(() => {});
    } else {
      suppressRealtimeAudioOut = !REALTIME_PROVIDER_AUDIO_ENABLED;
    }
    const allowRealtimeBridge =
      REALTIME_PROVIDER_AUDIO_ENABLED &&
      REALTIME_ACTION_BRIDGE_ENABLED &&
      isJarvisLiveEnabled() &&
      !isAckGatedCapture(reason) &&
      reason !== 'reply';
    if (allowRealtimeBridge) {
      const info = useVoiceStore.getState().info;
      realtimeTurnActive = canAttemptRealtime(info);
      const liveContext = liveContextText();
      void window.nexus.voice.liveStart({ reason }).then((state) => {
        store.setLiveState(state);
        if (!state.realtimeReady) realtimeTurnActive = false;
        if (state.realtimeReady) {
          window.nexus.voice.liveContextIn(liveContext);
          window.setTimeout(sendLiveContextSnapshot, 120);
        }
      }).catch((err) => {
        realtimeTurnActive = false;
        console.warn('[voice] liveStart falhou (classic segue):', errMsg(err));
      });
    }
    // Padrao pendingMic: mic ANTES da sessao live ficar pronta — liveStart
    // nao pode bloquear a captura ou a fala inicial some do WAV.
    if (wakeMic.isRunning()) {
      wakeMic.beginUtterance(
        autoStop,
        reason === 'wake' ? WAKE_PREROLL_MS : 0,
        preRollSeed,
      );
    } else {
      await capture.start(autoStop);
    }
    store.setStatus('listening');
    liveStatus('listening');
  } catch (err) {
    store.setError(`Mic unavailable: ${errMsg(err)}`);
    liveStatus('error', errMsg(err));
  }
}

/** Está escutando por QUALQUER backend (mic quente do wake ou captura própria)? */
function isListening(capture: VoiceCapture | null): boolean {
  return Boolean(capture?.isCapturing() || wakeMic.isUtteranceActive());
}

async function finishAndProcess(
  capture: VoiceCapture,
  busy: React.MutableRefObject<boolean>,
): Promise<void> {
  const store = useVoiceStore.getState();
  busy.current = true;
  // NEW-A: the turn token minted at beginListening for THIS capture. The Classic
  // brain claims it before running; if a realtime tool-call already claimed it,
  // Classic no-ops (single execution regardless of IPC ordering).
  const turnToken = turnExecution.currentToken;
  try {
    const result = wakeMic.isUtteranceActive()
      ? wakeMic.finishUtterance()
      : await capture.stop();
    const routing = store.info?.routing ?? 'focused-pane';
    const shouldTryRealtimeTranscript = routing === 'jarvis' && shouldStreamToRealtime();
    const captureGate = {
      wavBase64: result.wavBase64,
      durationSec: result.durationSec,
      heardSpeech: result.heardSpeech,
      maxRms: result.maxRms,
      maxPeak: result.maxPeak,
      minSpeechSec: MIN_SPEECH_SEC,
    };
    const allowWeakSpeech = isAckGatedCapture();
    const localSpeechUsable = hasUsableLocalSpeech(captureGate, { allowWeakSpeech });
    if (
      shouldDiscardBeforeRealtime(
        captureGate,
        {
          shouldTryRealtime: shouldTryRealtimeTranscript,
          hasQueuedRealtimeTranscript: Boolean(queuedRealtimeTranscript),
          allowWeakSpeech,
        },
      )
    ) {
      if (result.heardSpeech === false) {
        console.log('[voice] captura sem fala real (silêncio/ruído) — descartada');
      }
      store.setStatus('idle');
      liveEndTurn();
      return;
    }
    if (allowWeakSpeech && result.heardSpeech === false && localSpeechUsable) {
      logVoiceEvent('info', 'jarvis.weakSpeechAccepted', 'wake/click enviado ao STT por sinal fraco', {
        reason: activeCaptureReason,
        durationSec: Number(result.durationSec.toFixed(2)),
        maxRms: Number((result.maxRms ?? 0).toFixed(5)),
        maxPeak: Number((result.maxPeak ?? 0).toFixed(5)),
      });
    }

    if (shouldTryRealtimeTranscript) {
      const tRealtime = Date.now();
      const transcriptWaitMs = realtimeTranscriptWaitMs(activeCaptureReason, {
        localSpeechUsable,
      });
      store.setStatus('transcribing');
      liveStatus('thinking');
      suppressRealtimeAudioOut = true;
      // Keep the live FSM open while the provider finalizes transcript/tool calls.
      // Ending here makes the HUD go dormant right after the wake ack/click wake.
      const liveTranscript = await waitForRealtimeTranscript(transcriptWaitMs);
      if (hasRealtimeNativeToolSince(tRealtime)) {
        realtimeTurnActive = false;
        store.setStatus('idle');
        console.log('[voice] realtime tool-call resolveu o turno; Classic pulado');
        return;
      }
      if (liveTranscript) {
        const rawTranscript = liveTranscript.trim();
        if (
          isAckGatedCapture() &&
          isWakeAckOnlyTranscript(rawTranscript, personaUserName())
        ) {
          console.log(`[voice] realtime wake/click só ack/eco: "${liveTranscript}"`);
          store.setStatus('idle');
          resetPendingRealtimeAudioOut();
          void window.nexus.voice.liveInterrupt('ack-only-transcript').catch(() => {});
          liveEndTurn();
          return;
        }
        const transcript =
          isAckGatedCapture()
            ? stripWakeAckEcho(rawTranscript, personaUserName())
            : rawTranscript;
        if (!transcript) {
          console.log(`[voice] realtime transcript descartado como eco wake: "${liveTranscript}"`);
          store.setStatus('idle');
          resetPendingRealtimeAudioOut();
          void window.nexus.voice.liveInterrupt('empty-transcript').catch(() => {});
          return;
        }
        if (
          discardSpokenEchoIfNeeded(transcript, activeCaptureReason, {
            log: (source, t, reason) => {
              console.log(`[voice] eco do TTS descartado (${source}): "${t}"`);
              logVoiceEvent('info', 'stt.echoDiscarded', 'eco do TTS descartado', {
                source,
                text: t.slice(0, 120),
                reason,
              });
            },
            endTurn: liveEndTurn,
          }, 'realtime')
        ) {
          resetPendingRealtimeAudioOut();
          void window.nexus.voice.liveInterrupt('spoken-echo').catch(() => {});
          return;
        }
        const inConversation = transcriptInConversation(
          activeCaptureReason,
          jarvisHistory.length,
          jarvisLastTurnAt,
          JARVIS_MEMORY_MS,
        );
        if (isDiscardableTranscript(transcript, { inConversation })) {
          console.log(`[voice] realtime transcript lixo descartado: "${transcript}"`);
          store.setStatus('idle');
          resetPendingRealtimeAudioOut();
          void window.nexus.voice.liveInterrupt('discarded-transcript').catch(() => {});
          return;
        }
        store.setTranscript(transcript);
        store.setNote(null);
        resetAutoReplyLoopForCapture(activeCaptureReason);
        const realtimeMs = Date.now() - tRealtime;
        console.log(`[voice] realtime transcript (${realtimeMs}ms): "${transcript}"`);
        logVoiceEvent('info', 'jarvis.realtimeTranscript', transcript, {
          latencyMs: realtimeMs,
          reason: activeCaptureReason,
        });

        if (
          REALTIME_PROVIDER_AUDIO_ENABLED &&
          shouldLetRealtimeProviderAnswer(transcript) &&
          isRealtimeLive()
        ) {
          suppressRealtimeAudioOut = false;
          flushPendingRealtimeAudioOut();
          logVoiceEvent('info', 'jarvis.liveProviderAnswer', 'provider realtime', {
            reason: activeCaptureReason,
            transcript: transcript.slice(0, 180),
          });
          realtimeTurnActive = false;
          return;
        }

        suppressRealtimeAudioOut = true;
        resetPendingRealtimeAudioOut();
        livePlayer?.stop();
        stopAllPlayback();
        liveStatus('thinking');
        void window.nexus.voice.liveInterrupt('classic-live-bridge').catch(() => {});
        if (shouldUseClassicActionBridge(transcript)) {
          logVoiceEvent('info', 'jarvis.actionBridge', 'classic executor', {
            reason: 'app_action',
            transcript: transcript.slice(0, 180),
          });
        } else {
          logVoiceEvent('info', 'jarvis.liveBridge', 'classic executor', {
            reason: 'conversation',
            transcript: transcript.slice(0, 180),
          });
        }
        realtimeTurnActive = false;
        if (!turnExecution.claim('classic-brain', turnToken)) {
          console.log('[voice] turno já reivindicado por tool-call realtime; Classic pulado');
          store.setStatus('idle');
          return;
        }
        await runJarvisTurn(transcript, capture, busy);
        return;
      }
      if (!localSpeechUsable) {
        console.log(
          `[voice] realtime sem transcript final em ${Date.now() - tRealtime}ms (janela ${transcriptWaitMs}ms) e captura local sem fala — descartada`,
        );
        store.setStatus('idle');
        liveEndTurn();
        return;
      }
      console.log(
        `[voice] realtime sem transcript final em ${Date.now() - tRealtime}ms (janela ${transcriptWaitMs}ms) — fallback Classic STT`,
      );
      suppressRealtimeAudioOut = true;
      resetPendingRealtimeAudioOut();
      void window.nexus.voice.liveInterrupt('classic-action-bridge-timeout').catch(() => {});
      realtimeTurnActive = false;
    }

    // Feedback INSTANTÂNEO: um micro-filler do cache cobre o tempo de
    // STT+cérebro entre o fim da fala e a resposta do cérebro — SEM ele, o wake
    // ("Hey Jarvis") ouvia silêncio morto após o comando (Gap 3). Toca em todos
    // os turnos jarvis, inclusive wake. O filler é cacheado com echoRecord:false,
    // então não censura a próxima resposta curta do usuário (echo-suppress).
    if (routing === 'jarvis') {
      const filler = THINK_FILLERS[Math.floor(Math.random() * THINK_FILLERS.length)];
      const cached = getThinkFillerCache().get(filler);
      if (cached) void playAudioBase64(cached.audioBase64, cached.format).catch(() => {});
    }

    const tTurn = Date.now();
    store.setStatus('transcribing');
    if (routing === 'jarvis' && isJarvisLiveEnabled()) {
      liveStatus('thinking');
    }
    const stt = await withTimeout(
      window.nexus.voice.transcribe({
        audioBase64: result.wavBase64,
        mime: 'audio/wav',
        sampleRate: result.sampleRate,
        // Modo JARVIS conversa em PT — transcreve cru, sem traduzir para EN.
        ...(routing === 'jarvis' ? { translate: false, language: 'pt' } : {}),
      }),
      TRANSCRIBE_DEADLINE_MS,
      'transcrição',
    );
    if (!stt.ok) {
      store.setError(stt.error);
      liveStatus('error', stt.error);
      return;
    }
    // Eco do próprio TTS captado pelo mic (detectado no main via janela do que
    // acabou de ser falado) — descarte silencioso, mesmo tratamento do ghost.
    if (stt.discarded === 'echo') {
      console.log(`[voice] eco do TTS descartado: "${stt.text}"`);
      logVoiceEvent('info', 'stt.echoDiscarded', 'eco do TTS descartado', {
        source: 'classic',
        text: stt.text.slice(0, 120),
        reason: activeCaptureReason,
      });
      store.setStatus('idle');
      liveEndTurn();
      return;
    }
    const tStt = Date.now() - tTurn;
    if (
      isAckGatedCapture() &&
      isWakeAckOnlyTranscript(stt.text, personaUserName())
    ) {
      console.log(`[voice] turno wake/click só ack/eco descartado: "${stt.text}"`);
      store.setStatus('idle');
      liveEndTurn();
      return;
    }
    const transcript =
      isAckGatedCapture()
        ? stripWakeAckEcho(stt.text, personaUserName())
        : stt.text.trim();
    if (!transcript) {
      const reason =
        isAckGatedCapture() ? 'eco do wake/click/ack' : 'transcrição vazia';
      console.log(`[voice] ${reason} descartado: "${stt.text}"`);
      store.setStatus('idle');
      liveEndTurn();
      return;
    }
    // Whisper ALUCINA frases fixas em silêncio/ruído ("you", "thank you",
    // "obrigado por assistir"…). Elas passam o gate de RMS quando há um
    // sussurro — descarta antes de virar turno (a JARVIS falando sozinha).
    if (
      discardSpokenEchoIfNeeded(transcript, activeCaptureReason, {
        log: (source, t, reason) => {
          console.log(`[voice] eco do TTS descartado (${source}): "${t}"`);
          logVoiceEvent('info', 'stt.echoDiscarded', 'eco do TTS descartado', {
            source,
            text: t.slice(0, 120),
            reason,
          });
        },
        endTurn: liveEndTurn,
      }, 'classic')
    ) {
      return;
    }
    const inConversation = transcriptInConversation(
      activeCaptureReason,
      jarvisHistory.length,
      jarvisLastTurnAt,
      JARVIS_MEMORY_MS,
    );
    if (isDiscardableTranscript(transcript, { inConversation })) {
      console.log(`[voice] transcrição-lixo do Whisper descartada: "${transcript}"`);
      store.setStatus('idle');
      liveEndTurn();
      return;
    }
    store.setTranscript(transcript);
    console.log(`[voice] transcrito (${tStt}ms): "${transcript}"`);
    logVoiceEvent('info', 'jarvis.classicTranscript', transcript, {
      latencyMs: tStt,
      reason: activeCaptureReason,
    });
    resetAutoReplyLoopForCapture(activeCaptureReason);
    // Surface throttle/quota fallbacks instead of failing silently.
    store.setNote(stt.fallbackNote ?? null);

    if (routing === 'jarvis') {
      if (!turnExecution.claim('classic-brain', turnToken)) {
        console.log('[voice] turno já reivindicado por tool-call realtime; Classic pulado');
        store.setStatus('idle');
        return;
      }
      await runJarvisTurn(transcript, capture, busy);
      return;
    }

    store.setStatus('routing');
    const paneId = routePrompt(transcript);
    if (!paneId) {
      store.setError('No focused pane to route the prompt into.');
      return;
    }

    // Jarvis: capture the agent's reply, then speak a condensed summary. The
    // transcribed prompt is passed so its PTY echo is stripped before speaking.
    const reply = await captureResponse(paneId, transcript);
    if (reply.trim()) {
      store.setStatus('speaking');
      const spoken = await withTimeout(
        window.nexus.voice.speak({ text: reply }),
        SPEAK_DEADLINE_MS,
        'TTS',
      );
      if (spoken.ok) {
        surfaceTtsFallback(spoken);
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
    liveStatus('error', errMsg(err));
  } finally {
    // Barge-in wake já reabriu escuta — não soltar busy por turno obsoleto.
    if (useVoiceStore.getState().status !== 'listening') {
      busy.current = false;
    }
  }
}

/**
 * Um turno da conversa com a JARVIS: fala transcrita → cérebro (main) →
 * executa a ação no app → fala a resposta → se ela terminou perguntando,
 * reabre a escuta sozinha (o loop "viva").
 */
async function runJarvisTurn(
  transcript: string,
  capture: VoiceCapture,
  busy: React.MutableRefObject<boolean>,
): Promise<void> {
  const store = useVoiceStore.getState();
  const now = Date.now();
  if (now - jarvisLastTurnAt > JARVIS_MEMORY_MS) jarvisHistory = [];
  jarvisLastTurnAt = now;

  const context = buildJarvisContext();

  store.setStatus('routing');
  const tBrain = Date.now();
  const reply = await withTimeout(
    window.nexus.voice.jarvis({
      transcript,
      context,
      history: jarvisHistory,
    }),
    BRAIN_DEADLINE_MS,
    'cérebro',
  );
  const brainMs = Date.now() - tBrain;
  console.log(`[voice] cérebro: ${brainMs}ms`);
  logVoiceEvent('info', 'jarvis.brainReply', reply.say, {
    latencyMs: brainMs,
    action: reply.action.type,
    expectReply: reply.expectReply === true,
  });
  jarvisHistory.push({ role: 'user', content: transcript });
  jarvisHistory.push({ role: 'assistant', content: reply.say });
  const maxTurns = isJarvisLiveEnabled()
    ? (useVoiceStore.getState().info?.jarvisLive.maxWindowTurns ?? 12)
    : 10;
  if (jarvisHistory.length > maxTurns * 2) {
    jarvisHistory = jarvisHistory.slice(-(maxTurns * 2));
  }

  const exec = await executeJarvisActionForTurn(reply, context);
  let sayText = exec.sayText;
  if (exec.expectReply !== undefined) reply.expectReply = exec.expectReply;
  const toolResult = exec.toolResult;
  if (toolResult) {
    logVoiceEvent(toolResult.ok ? 'info' : 'warn', 'jarvis.actionResult', toolResult.summary, {
      tool: toolResult.tool,
      ok: toolResult.ok,
    });
  }

  if (reply.action.type !== 'none' && toolResult?.ok) {
    useVoiceStore.getState().setNote(null);
    void window.nexus.gamification
      .recordJarvisAction({ actionType: reply.action.type, ok: true })
      .then((snap) => useGamificationStore.getState().receive(snap))
      .catch(() => {});
  }

  if (toolResult && isJarvisLiveEnabled()) {
    window.nexus.voice.liveToolResult(toolResult);
    queueLiveContextRefresh();
  }

  if (!sayText.trim()) {
    store.setSpoken('');
    store.setStatus('idle');
    liveEndTurn();
    return;
  }

  const wantsReply = shouldReopenJarvisListening({
    expectReply: reply.expectReply === true,
    sayText,
    realtimeTurnActive,
    isRealtimeLive: isRealtimeLive(),
    captureReason: activeCaptureReason,
  });
  if (!wantsReply && (await speakViaLiveProvider(sayText))) {
    store.setSpoken(sayText);
    return;
  }

  // Classic TTS é a única voz — corta qualquer áudio realtime pendente.
  suppressRealtimeAudioOut = true;
  livePlayer?.stop();
  void window.nexus.voice.liveInterrupt('classic-tts').catch(() => {});

  store.setStatus('speaking');
  liveStatus('speaking');
  const tTts = Date.now();
  const spoken = await speakAndPlayPipelined(sayText);
  console.log(`[voice] tts: ${Date.now() - tTts}ms`);
  if (!spoken.ok) {
    store.setError(spoken.error);
    return;
  }
  store.setSpoken(sayText);
  store.setStatus('idle');
  void window.nexus.voice.recordEcho(sayText);

  // Classic: só reabre escuta quando o cérebro pediu resposta de verdade.
  // jarvisLive.enabled no painel NÃO é full-duplex — reabrir sempre gerava loop
  // (TTS ecoando no mic → "não entendi" → TTS → …).
  wakeMic.suppressWakeDetection(
    Math.min(15_000, Math.max(4_500, sayText.length * 70 + REPLY_LISTEN_DELAY_MS + 2_500)),
  );
  if (wantsReply) {
    busy.current = false;
    wakeMic.suppressWakeDetection(REPLY_LISTEN_DELAY_MS + REPLY_MIN_LISTEN_MS);
    await delay(REPLY_LISTEN_DELAY_MS);
    noteAutoReplyOpened({ sayText });
    void beginListening(
      capture,
      buildReplyAutoStop(() => {
        if (isListening(capture)) void finishAndProcess(capture, busy);
      }),
      'reply',
      undefined,
      busy,
    );
  } else {
    liveEndTurn();
  }
}

/**
 * Inject the transcribed prompt into the target pane's PTY (same path as typing).
 * Returns the pane id used, or null when nothing is focused. Routing modes other
 * than 'focused-pane' currently resolve to the focused pane (orchestrator routing
 * arrives with the MCP squad work in a later phase).
 */
function routePrompt(text: string): string | null {
  const { focusedPaneId, root } = useLayoutStore.getState();
  const routing = useVoiceStore.getState().info?.routing ?? 'focused-pane';
  const targetPaneId =
    routing === 'orchestrator'
      ? findOrchestratorPane(root) ?? focusedPaneId
      : focusedPaneId;
  if (!targetPaneId) return null;
  const ok = writeToPane(targetPaneId, `${text}\n`);
  return ok ? targetPaneId : null;
}

function findOrchestratorPane(root: ReturnType<typeof useLayoutStore.getState>['root']): string | null {
  const panes = listPanes(root);
  const pane = panes.find(
    (p) => p.orchRequestId?.startsWith('squad-') || /(^|[ ·])orq\b/i.test(p.title),
  );
  return pane?.id ?? null;
}

/**
 * Accumulate the pane's PTY output after injection and resolve with the agent's
 * reply. End-of-turn is detected by three signals, strongest first:
 *   1. The pane returns from 'busy' → 'idle' (tracked by phase 2b via
 *      useSessionStateStore). This is the reliable signal for TUI agents like
 *      Claude Code / Codex that continuously redraw a spinner and so never fall
 *      quiet — pure silence detection would always hit the hard cap and speak a
 *      truncated dump.
 *   2. The PTY has been quiet for RESPONSE_QUIET_MS (non-agent panes that emit no
 *      idle/busy state events).
 *   3. RESPONSE_MAX_MS hard cap.
 * The captured buffer starts with the PTY echo of the injected prompt (plus
 * spinner); `promptEcho` is stripped so we speak the RESPONSE, not the command.
 */
function captureResponse(paneId: string, promptEcho: string): Promise<string> {
  return new Promise((resolve) => {
    const sessionId = getPaneSessionId(paneId);
    if (!sessionId) {
      resolve('');
      return;
    }
    let buffer = '';
    let quietTimer: ReturnType<typeof setTimeout> | null = null;
    let sawBusy = false;
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      if (quietTimer) clearTimeout(quietTimer);
      clearTimeout(hardCap);
      unsubData();
      unsubState();
      resolve(stripPromptEcho(buffer, promptEcho));
    };

    const armQuiet = () => {
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, RESPONSE_QUIET_MS);
    };

    const unsubData = window.nexus.pty.onData(sessionId, (data) => {
      buffer += data;
      armQuiet();
    });
    // Strong end-of-turn signal: finish as soon as the pane goes back to 'idle'
    // after having been 'busy'. Falls back to the quiet timer for panes that
    // never report state (no cli-agent adapter tracking them).
    const unsubState = useSessionStateStore.subscribe((s) => {
      const state = s.paneStates.get(paneId);
      if (state === 'busy') sawBusy = true;
      else if (state === 'idle' && sawBusy) finish();
    });
    const hardCap = setTimeout(finish, RESPONSE_MAX_MS);
    armQuiet();
  });
}

/** Decode + play TTS audio bytes via Web Audio. */

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function surfaceTtsFallback(result: Extract<SpeakResult, { ok: true }>): void {
  if (result.fallbackNote) useVoiceStore.getState().setNote(result.fallbackNote);
}
