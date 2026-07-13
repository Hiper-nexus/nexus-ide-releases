import { randomUUID } from 'node:crypto';
import { getVoiceConfig } from './voice-config-store';
import { resolveActiveJarvisBrain } from '../../shared/voice-config';
import { resolveVoiceApiKey, voiceApiKeySource } from './voice-secrets';
import { logVoice } from './voice-log';
import { VOICE_CHANNELS } from '../../shared/voice-channels';
import {
  buildRealtimeEngageDecision,
  type EngageCandidate,
} from '../jarvis/realtime/engage-decision';
import { shouldWithholdLiveMicFrame } from '../jarvis/realtime/live-mic-gate';
import type { JarvisLiveSession } from './jarvis-live';
import type {
  JarvisLiveAudioPlaybackEvent,
  JarvisLiveSmokeTestResult,
  JarvisLiveToolEvent,
  JarvisLiveToolResultEvent,
} from '../../shared/voice-ipc';
import {
  createRealtimeProviderCandidates,
  resolveRealtimeProviderIds,
  type RealtimeProviderCandidate,
} from '../jarvis/realtime/factory';
import {
  base64ToInt16Array,
  int16ArrayToBase64,
  type RealtimeToolCallEvent,
  type TurnManagedRealtimeProvider,
} from '../jarvis/realtime/provider';
import { jarvisLatencyTracker } from '../jarvis/realtime/metrics';
import {
  NEXUS_REALTIME_ACTION_TOOL,
} from '../jarvis/realtime/nexus-realtime-tools';
import {
  PendingQuestionRouter,
} from '../jarvis/realtime/pending-question-router';
import { ThrottledCounter } from '../../shared/live-flow-counter';
import {
  dispatchNexusAction,
  handleRealtimeToolCall,
  isExplicitEngineeringWorkIntent,
  type ToolDispatchHost,
} from './live-tool-dispatch';
import {
  isLocalToolCallId,
  isScreenContext,
  localToolCallId,
  buildResumeContext,
  trimLiveHistory,
} from './live-transport-helpers';
import {
  buildSystemInstruction as buildLiveSystemInstruction,
  sendProviderContext as sendLiveProviderContext,
} from './live-transport-context';
import type { JarvisMemoryAccess } from './jarvis-memory';
import { LiveToolCallCoordinator } from './live-tool-call-registry';
import {
  connectFirstLiveProvider,
  type LiveProviderRuntimeHost,
} from './live-provider-runtime';
import { LiveSmokeProbe } from './live-smoke-probe';
import {
  LiveQuestionPoller,
  type PendingQuestionSource,
} from './live-question-poller';
import type { LiveAecProcessor } from './aec-live-processor';

export type {
  NarratedQuestion,
  PendingQuestionSource,
} from './live-question-poller';

export { isIgnorableRealtimeError, isLocalToolCallId } from './live-transport-helpers';

type Emit = (channel: string, payload?: unknown) => void;

const RUNTIME_RECONNECT_BASE_MS = 750;
const RUNTIME_RECONNECT_MAX_ATTEMPTS = 3;
// Must be longer than provider-level progress watchdogs (Gemini: 30s).
// Otherwise a socket that dies exactly on that watchdog is misclassified as
// healthy and the reconnect counter resets forever.
const RUNTIME_RECONNECT_STABLE_MS = 60_000;
const PENDING_MIC_MAX_BYTES = 512 * 1024;
const LIVE_SAY_MAX_CHARS = 1_000;
const ACCEPTED_RESCUE_TURN_IDS_MAX = 32;
const PENDING_RENDERER_AUDIO_MAX = 256;
const PENDING_RENDERER_AUDIO_TTL_MS = 30_000;
export const TOOL_FOLLOW_UP_COMPLETION_DEADLINE_MS = 3_000;

interface RealtimeStartOptions {
  greeting?: string;
  /** ClockVoice parity: connect without creating audible/user activity. */
  prewarm?: boolean;
  /** A renderer-proven new wake/PTT turn must not reuse a stale Live socket. */
  freshTurn?: boolean;
}

interface PendingRendererAudioDelivery {
  sentAt: number;
  /** Far-end reference is released to AEC only after renderer playback starts. */
  aecPcm16?: Int16Array;
  /** Only this renderer can prove the active smoke delivery. */
  smokeOwnerWebContentsId?: number;
}

interface PendingToolFollowUp {
  sessionId: string;
  turnId: string;
  callId: string;
  sentAt: number;
}

interface ToolTurnOrigin {
  sessionId: string;
  turnId: string;
}

const MAX_TOOL_TURN_ORIGINS = 64;

export class LiveTransportController {
  private _provider: TurnManagedRealtimeProvider | null = null;
  private connecting: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectStableTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private reconnectGeneration = 0;
  private _latestContext = '';
  private _recentToolResults: string[] = [];
  private pendingMic: Int16Array[] = [];
  private pendingMicBytes = 0;
  /** User released PTT while the provider was still connecting. */
  private pendingEndUserTurn = false;
  /** Controller-level identity survives provider/transport reconnects. */
  private readonly toolCalls: LiveToolCallCoordinator;
  private readonly pendingQuestionRouter: PendingQuestionRouter;
  private readonly questionPoller: LiveQuestionPoller;
  private readonly smokeProbe: LiveSmokeProbe;
  private localCallSeq = 0;
  private _lastUserTranscript = '';
  /** Explicit work that Gemini has not yet handed to an agent pane. */
  private pendingWorkDelegation: { text: string; turnId: string } | null = null;
  private providerSpeaking = false;
  private geminiResumeHandle: string | undefined;
  private activeTurnId: string | undefined;
  /** P4: bounded recent final transcripts surviving transport stop. */
  private _liveHistory: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  /** P4: grace/idle timers. */
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private _inGrace = false;
  /** Passive wake owns a silent, permanently warm socket (ClockVoice model). */
  private keepWarmForWake = false;
  private readonly now: () => number;
  private micFramesCounter = new ThrottledCounter(25, 2_000);
  private serverAudioCounter = new ThrottledCounter(25, 2_000);
  private acceptedRescueTurnIds: string[] = [];
  /** Main-owned delivery ids prevent stale renderer events proving a newer delivery. */
  private pendingRendererAudio = new Map<string, PendingRendererAudioDelivery>();
  private activeSmokeOwnerWebContentsId: number | undefined;
  /** Tool result sent to Gemini; completion reopens the renderer reply mic. */
  private pendingToolFollowUp: PendingToolFollowUp | null = null;
  private toolFollowUpCompletionTimer: ReturnType<typeof setTimeout> | null = null;
  /** Captures a tool's originating user turn before the renderer action can outlive it. */
  private readonly toolTurnOrigins = new Map<string, ToolTurnOrigin>();

  constructor(
    private emit: Emit,
    private _fsm: JarvisLiveSession,
    now: () => number = Date.now,
    questionSource?: PendingQuestionSource,
    private readonly memory?: JarvisMemoryAccess,
    private readonly aec?: LiveAecProcessor,
  ) {
    this.now = now;
    this.pendingQuestionRouter = new PendingQuestionRouter({ now });
    this.questionPoller = new LiveQuestionPoller(questionSource, (question) => {
      this.noteNarratedQuestion(question.paneId, question.questionHash);
    });
    this.smokeProbe = new LiveSmokeProbe(this._fsm, now);
    this.toolCalls = new LiveToolCallCoordinator({
      fsm: this._fsm,
      getProvider: () => this._provider,
      onResultContext: (tool, status, summary) =>
        this.recordToolResultContext(tool, status, summary),
      onResultSending: (event) => this.noteToolResultSending(event),
      onResultSendFailed: (event) => this.clearPendingToolFollowUp(event),
    });
  }

  // ── ToolDispatchHost interface ─────────────────────────────────────────────
  get provider(): TurnManagedRealtimeProvider | null { return this._provider; }
  set provider(p: TurnManagedRealtimeProvider | null) { this._provider = p; }
  get fsm(): JarvisLiveSession { return this._fsm; }
  get lastUserTranscript(): string { return this._lastUserTranscript; }
  get latestContext(): string { return this._latestContext; }
  set latestContext(v: string) { this._latestContext = v; }
  get recentToolResults(): string[] { return this._recentToolResults; }
  set recentToolResults(v: string[]) { this._recentToolResults = v; }

  markDelegationAttempt(): void {
    this.pendingWorkDelegation = null;
  }

  /** P4: bounded live history (last N final user/assistant transcripts). */
  get liveHistory(): ReadonlyArray<{ role: 'user' | 'assistant'; text: string }> {
    return this._liveHistory;
  }

  get inGrace(): boolean { return this._inGrace; }
  get currentTurnId(): string | undefined { return this.activeTurnId; }

  private resetFlowCounters(): void {
    this.micFramesCounter.reset();
    this.serverAudioCounter.reset();
  }

  noteNarratedQuestion(paneId: string, questionHash: string): void {
    this.pendingQuestionRouter.noteNarratedQuestion(paneId, questionHash);
  }

  /**
   * C3 defesa (follow-up 2): o pane tem pergunta pendente narrada no router?
   * Usa hasLiveQuestion (com TTL) em vez de questionFor — uma pergunta
   * narrada velha (além do NARRATED_QUESTION_TTL_MS) não autoriza escrita
   * direta no pane.
   */
  hasPendingQuestion(paneId: string): boolean {
    return this.pendingQuestionRouter.hasLiveQuestion(paneId);
  }

  isRealtimeConfigured(): boolean {
    return resolveRealtimeProviderIds(getVoiceConfig()).some((providerId) => {
      const envVar = providerId === 'openai' ? 'OPENAI_API_KEY' : 'GEMINI_API_KEY';
      return resolveVoiceApiKey(envVar) !== undefined;
    });
  }

  beginTurn(turnId: string): void {
    const normalized = turnId.trim().slice(0, 128);
    if (!normalized) return;
    const sessionId = this._fsm.getState().sessionId;
    if (sessionId && this.activeTurnId && this.activeTurnId !== normalized) {
      jarvisLatencyTracker.discard(sessionId, this.activeTurnId);
    }
    if (this.activeTurnId !== normalized) this.pendingWorkDelegation = null;
    this.activeTurnId = normalized;
    if (this.pendingToolFollowUp?.turnId !== normalized) {
      this.discardPendingToolFollowUp();
    }
    this._provider?.beginUserTurn?.(normalized);
  }

  private logEngageDecision(): void {
    const config = getVoiceConfig();
    const candidates: EngageCandidate[] = resolveRealtimeProviderIds(config).map(
      (id) => {
        const envVar = id === 'openai' ? 'OPENAI_API_KEY' : 'GEMINI_API_KEY';
        return { id, envVar, source: voiceApiKeySource(envVar) };
      },
    );
    const decision = buildRealtimeEngageDecision({
      transport: config.jarvisLive.transport,
      candidates,
    });
    const brain = resolveActiveJarvisBrain(config.jarvisBrain, (envVar) =>
      resolveVoiceApiKey(envVar) !== undefined,
    );
    const brainPart = brain ? `${brain.provider}:${brain.model}` : 'none';
    const line = `${decision.line} | brain=${brainPart}`;
    logVoice(
      decision.degraded ? 'warn' : 'info',
      'jarvis.engageDecision',
      line,
      {
        engaged: decision.engaged ?? 'classic',
        degraded: decision.degraded,
        brainProvider: brain?.provider ?? null,
        brainModel: brain?.model ?? null,
      },
    );
  }

  onStart(options: RealtimeStartOptions = {}): Promise<void> {
    if (options.prewarm) this.keepWarmForWake = true;
    this.clearReconnectTimer();
    if (
      this._fsm.getState().status === 'error' &&
      this.reconnectAttempt >= RUNTIME_RECONNECT_MAX_ATTEMPTS
    ) {
      // A new explicit wake after circuit-breaker exhaustion may try again.
      this.reconnectAttempt = 0;
    }
    this.logEngageDecision();
    this.resetFlowCounters();
    if (!this.isRealtimeConfigured()) {
      // A configuration change is an explicit lifecycle boundary. It is safe to
      // close here; ordinary wake silence is not.
      if (this._provider || this.connecting) this.hardStop();
      this.clearPendingMic();
      this._fsm.patchStatus({ status: 'dormant', realtimeReady: false });
      return Promise.resolve();
    }

    // A locally-open Live socket can already be a server-side zombie. Actual
    // wake/click turns reconnect and pendingMic bridges the setup latency;
    // prewarm may still keep its idle socket.
    if (this._provider?.isReady && options.freshTurn) {
      logVoice('warn', 'live.hotReuseDisabled', 'descartando socket quente antes do wake', {
        inGrace: this._inGrace,
      });
      this.hardStop();
      this._fsm.start({ reason: 'wake' });
    } else if (this._provider?.isReady) {
      if (this._inGrace) this.promoteGrace();
      else this.touchIdle();
      this.sendGreetingIfSafe(this._provider, options.greeting);
      this.flushPendingMic(this._provider);
      this._fsm.patchStatus({
        status: 'dormant',
        realtimeReady: true,
      });
      return Promise.resolve();
    }

    this.clearGraceTimer();
    this._inGrace = false;
    this.touchIdle();
    if (this.connecting) return this.connecting;
    const candidates = createRealtimeProviderCandidates({
      config: getVoiceConfig(),
      instructions: this.buildSystemInstruction(),
      geminiResumeHandle: this.geminiResumeHandle,
      onGeminiResumeHandle: (handle) => {
        this.geminiResumeHandle = handle;
      },
    });
    if (candidates.length === 0) {
      this.clearPendingMic();
      this.patchRealtimeReady(false);
      return Promise.resolve();
    }
    this._fsm.patchStatus({ status: 'listening', realtimeReady: false });
    const connecting = this.connectFirstAvailable(
      candidates,
      options.prewarm ? undefined : options.greeting,
    )
      .then(() => {
        if (options.prewarm && this._provider?.isReady) {
          this.clearIdleTimer();
          this._fsm.patchStatus({ status: 'dormant', realtimeReady: true });
          logVoice('info', 'live.prewarmReady', 'Gemini Live pronto antes do wake', {});
        }
      })
      .finally(() => {
        if (this.connecting === connecting) this.connecting = null;
      });
    this.connecting = connecting;
    return connecting;
  }

  async smokeTest(
    text: string,
    ownerWebContentsId?: number,
  ): Promise<JarvisLiveSmokeTestResult> {
    if (this.smokeProbe.isActive) return this.smokeProbe.failure('busy');
    // A diagnostic must not accept an audio chunk from an older answer. Rebuild
    // the provider before it sends the probe prompt; normal conversations still
    // retain their warm-socket grace behavior.
    this.hardStop();
    this._fsm.start({ reason: 'manual' });
    await this.onStart();
    const provider = this._provider;
    if (!provider?.isReady) {
      return this.smokeProbe.failure('realtime_unavailable');
    }
    this.activeSmokeOwnerWebContentsId = ownerWebContentsId;
    try {
      return await this.smokeProbe.run(provider, text);
    } finally {
      this.activeSmokeOwnerWebContentsId = undefined;
    }
  }

  /**
   * Receives renderer proof for one main-generated audio delivery. Unknown,
   * expired and duplicate reports are ignored so an old render cannot satisfy a
   * later diagnostic.
   */
  reportAudioPlayback(
    event: JarvisLiveAudioPlaybackEvent,
    senderWebContentsId?: number,
  ): void {
    this.prunePendingRendererAudio();
    const delivery = this.pendingRendererAudio.get(event.id);
    if (!delivery) return;
    if (
      delivery.smokeOwnerWebContentsId !== undefined &&
      delivery.smokeOwnerWebContentsId !== senderWebContentsId
    ) {
      return;
    }
    this.pendingRendererAudio.delete(event.id);

    if (event.outcome === 'started') {
      if (delivery.aecPcm16) this.aec?.render24k(delivery.aecPcm16);
      this.smokeProbe.settlePlaybackStarted(event.id);
      return;
    }

    // Cancelled = intentional drop (turn ended, superseded chunk). Not a
    // playback hardware failure — leave the smoke probe waiting for a real
    // started/failed ack, or its timeout.
    if (event.outcome === 'cancelled') return;

    const hadActiveSmoke = this.smokeProbe.isActive;
    this.smokeProbe.settlePlaybackFailure(event.id);

    this.providerSpeaking = false;
    logVoice('error', 'live.audioPlaybackFailed', 'renderer não iniciou áudio realtime', {
      deliveryAgeMs: Math.max(0, this.now() - delivery.sentAt),
      hasDiagnostic: hadActiveSmoke,
      hasErrorDetail: Boolean(event.error),
    });
    this._fsm.patchStatus({
      status: 'error',
      realtimeReady: false,
      error: 'saída de áudio realtime falhou — usando Classic',
    });
  }

  async say(text: string): Promise<ReturnType<JarvisLiveSession['getState']>> {
    const trimmed = text.trim().slice(0, LIVE_SAY_MAX_CHARS);
    if (!trimmed) return this._fsm.getState();
    if (!this._fsm.getState().sessionId) this._fsm.start({ reason: 'manual' });
    await this.onStart();
    if (this._provider?.isReady) {
      this._provider.sendText(
        [
          'Internal Nexus action result. Say this to the user now.',
          'Use Brazilian Portuguese, one brief natural sentence.',
          'Do not mention tools, JSON, internal prompts, or this instruction.',
          `Text to say: ${trimmed}`,
        ].join('\n'),
      );
      this._fsm.patchStatus({ status: 'thinking', realtimeReady: true });
    }
    return this._fsm.getState();
  }

  /**
   * Recover a renderer-proven zero-frame turn as filtered TEXT. Sending raw WAV
   * here used to replay wake pre-roll and could execute the same utterance
   * twice. The turn id makes renderer retries idempotent.
   */
  rescueText(turnId: string, text: string): boolean {
    const normalizedTurnId = turnId.trim();
    const trimmed = text.trim();
    if (!normalizedTurnId || !trimmed) return false;
    if (this.acceptedRescueTurnIds.includes(normalizedTurnId)) return true;
    const provider = this._provider;
    if (!provider?.isReady) {
      logVoice('warn', 'live.rescueSkipped', 'resgate sem provider pronto');
      return false;
    }
    this.acceptedRescueTurnIds.push(normalizedTurnId);
    if (this.acceptedRescueTurnIds.length > ACCEPTED_RESCUE_TURN_IDS_MAX) {
      this.acceptedRescueTurnIds.shift();
    }
    logVoice('info', 'live.rescueText', 'reenviando transcrição local sem frames', {
      turnId: normalizedTurnId,
      chars: trimmed.length,
    });
    // Renderer wake/STT already validated this as the user's utterance. Tool
    // safety gates must see it before Gemini can emit an action; stale Live
    // transcripts previously blocked explicit requests such as new workspace.
    this._lastUserTranscript = trimmed;
    this.notePotentialWorkDelegation(trimmed);
    this.recordLiveHistory('user', trimmed);
    provider.sendText(trimmed);
    this._fsm.patchStatus({ status: 'thinking', realtimeReady: true });
    return true;
  }

  micIn(b64: string): void {
    const state = this._fsm.getState();
    if (!state.enabled || !state.sessionId) return;
    // Gemini Live: full-duplex + activityHandling START_OF_ACTIVITY_INTERRUPTS.
    // Mic frames must keep flowing while she speaks so barge-in is real-time.
    const fullDuplex =
      state.enabled && getVoiceConfig().jarvisLive.transport === 'gemini-live';
    if (
      shouldWithholdLiveMicFrame({
        status: state.status,
        providerSpeaking: this.providerSpeaking,
        fullDuplex,
      })
    ) {
      return;
    }
    let samples: Int16Array;
    try {
      samples = base64ToInt16Array(b64);
    } catch (err) {
      this._fsm.patchStatus({
        status: 'error',
        realtimeReady: false,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (samples.length === 0) return;
    if (!this._provider?.isReady) {
      this.bufferMicChunk(samples);
      return;
    }
    const provider = this._provider;
    if (this.aec) {
      this.aec.capture(samples, (processed) => {
        if (this._provider !== provider || !provider.isReady) return;
        this.sendMicSamples(provider, processed);
      });
    } else {
      this.sendMicSamples(provider, samples);
    }
  }

  private sendMicSamples(provider: TurnManagedRealtimeProvider, samples: Int16Array): void {
    const sessionId = this._fsm.getState().sessionId;
    if (sessionId) jarvisLatencyTracker.markAudioIn(sessionId, this.activeTurnId);
    const tick = this.micFramesCounter.tick(this.now());
    if (tick.fire) {
      logVoice('info', 'live.micFramesSent', 'frames de mic → socket', { frames: tick.count });
    }
    try {
      provider.sendAudioChunk(samples);
    } catch (err) {
      this._fsm.patchStatus({
        status: 'error',
        realtimeReady: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private bufferMicChunk(samples: Int16Array): void {
    const bytes = samples.byteLength;
    if (bytes <= 0 || bytes > PENDING_MIC_MAX_BYTES) return;
    while (this.pendingMicBytes + bytes > PENDING_MIC_MAX_BYTES && this.pendingMic.length > 0) {
      const dropped = this.pendingMic.shift();
      this.pendingMicBytes -= dropped?.byteLength ?? 0;
    }
    this.pendingMic.push(samples.slice());
    this.pendingMicBytes += bytes;
    const state = this._fsm.getState();
    if (!state.pendingMic && state.status !== 'off') {
      this._fsm.patchStatus({ status: state.status, pendingMic: true });
    }
  }

  private clearPendingMic(): void {
    this.pendingMic = [];
    this.pendingMicBytes = 0;
    this.pendingEndUserTurn = false;
    const state = this._fsm.getState();
    if (state.pendingMic && state.status !== 'off') {
      this._fsm.patchStatus({ status: state.status, pendingMic: false });
    }
  }

  private flushPendingMic(provider: TurnManagedRealtimeProvider): void {
    const chunks = this.pendingMic;
    const shouldEndUserTurn = this.pendingEndUserTurn && chunks.length > 0;
    this.pendingMic = [];
    this.pendingMicBytes = 0;
    this.pendingEndUserTurn = false;
    const state = this._fsm.getState();
    if (state.pendingMic && state.status !== 'off') {
      this._fsm.patchStatus({ status: state.status, pendingMic: false });
    }
    for (const chunk of chunks) this.sendMicSamples(provider, chunk);
    if (shouldEndUserTurn) provider.endUserTurn();
  }

  contextIn(text: string): void {
    const trimmed = text.trim().slice(0, 1_200);
    if (!trimmed) return;
    if (trimmed.startsWith('[wake]') || trimmed.startsWith('[reconexão]')) {
      if (this._provider?.isReady) {
        // The renderer already interrupts the previous response before opening
        // this capture. Do not interrupt again here: on a cold connect, buffered
        // user speech may have just flushed and a second interrupt would swallow
        // the beginning of the command.
        this._provider.sendText(trimmed);
        logVoice('info', 'live.wakeInjectSent', 'turno [wake]/[reconexão] enviado', {
          chars: trimmed.length,
        });
        this._fsm.patchStatus({ status: 'thinking', realtimeReady: true });
      } else {
        logVoice('warn', 'live.wakeInjectSkipped', 'provider not ready — [wake] dropped', {});
      }
      return;
    }
    this._latestContext = trimmed;
    // P5: screen snapshots go through the provider's coalescer (debounce + dedup);
    // tool results are immediate via sendProviderContext.
    if (
      this._provider?.isReady &&
      this._provider.supportsPassiveContextUpdates !== false &&
      this._provider.sendScreenUpdate &&
      isScreenContext(trimmed)
    ) {
      this._provider.sendScreenUpdate(trimmed);
      return;
    }
    this.sendProviderContext();
  }

  toolResult(event: JarvisLiveToolResultEvent): void {
    const sessionId = this._fsm.getState().sessionId;
    if (sessionId) jarvisLatencyTracker.markAction(sessionId, this.activeTurnId);
    if (event.callId && !isLocalToolCallId(event.callId)) {
      this.toolCalls.complete(event);
      return;
    }
    const status = event.ok ? 'ok' : 'failed';
    const summary = event.summary.trim() || status;
    this.recordToolResultContext(event.tool, status, summary);
    if (event.callId && isLocalToolCallId(event.callId)) {
      this.emitLocalToolTurnComplete(event);
    }
  }

  private emitLocalToolTurnComplete(event: JarvisLiveToolResultEvent): void {
    const sessionId = this._fsm.getState().sessionId;
    const turnId = this.activeTurnId;
    if (!sessionId || !turnId || sessionId !== event.sessionId || !event.callId) {
      logVoice(
        'warn',
        'live.localToolTurnUncorrelated',
        'tool local terminou sem sessão/turno para continuidade',
        { callId: event.callId },
      );
      return;
    }
    this.emit(VOICE_CHANNELS.liveToolTurnComplete, {
      sessionId,
      turnId,
      callId: event.callId,
      at: this.now(),
    });
    logVoice('info', 'live.localToolTurnComplete', 'tool local concluída no renderer', {
      callId: event.callId,
      turnId,
    });
  }

  private recordToolResultContext(
    tool: JarvisLiveToolResultEvent['tool'],
    status: 'ok' | 'failed',
    summary: string,
  ): void {
    this._recentToolResults = [
      ...this._recentToolResults,
      `- ${tool}: ${status} (${summary})`,
    ].slice(-5);
    this.touchIdle();
    this.sendProviderContext();
  }

  endTurn(): void {
    const provider = this._provider;
    if (provider?.isReady) {
      this.pendingEndUserTurn = false;
      provider.endUserTurn();
      return;
    }
    if (this.pendingMic.length > 0) this.pendingEndUserTurn = true;
  }

  interrupt(reason: string): ReturnType<JarvisLiveSession['interrupt']> {
    const status = this._fsm.getState().status;
    if (status === 'speaking' || status === 'thinking') {
      this._provider?.interrupt();
    }
    const sessionId = this._fsm.getState().sessionId;
    if (sessionId) jarvisLatencyTracker.discard(sessionId, this.activeTurnId);
    this.providerSpeaking = false;
    this.discardPendingToolFollowUp();
    this.pendingWorkDelegation = null;
    this.toolTurnOrigins.clear();
    return this._fsm.interrupt(reason);
  }

  /**
   * Soft-stop (Overclock F-107): keep the WS warm for graceReuseMs so a quick
   * re-wake reuses the same connection. Product logic sees voice as off
   * (realtimeReady=false); the socket stays alive until grace expires → dormant.
   * Farewell / hard teardown uses hardStop().
   */
  onStop(): void {
    this.smokeProbe.settleFailure('session_closed');
    this.clearPendingRendererAudio();
    this.discardPendingToolFollowUp();
    this.pendingWorkDelegation = null;
    this.toolTurnOrigins.clear();
    logVoice('info', 'live.flowSummary', 'resumo do fluxo de áudio da sessão', {
      micFramesSent: this.micFramesCounter.total,
      serverAudioChunks: this.serverAudioCounter.total,
      softStop: Boolean(this._provider?.isReady),
    });
    this.clearReconnectTimer();
    this.clearReconnectStabilityTimer();
    this.toolCalls.cancelPending('session_closed', 'sessão Live encerrada pelo usuário');
    this.questionPoller.stop();
    this.clearIdleTimer();
    this.providerSpeaking = false;
    this.clearPendingMic();
    this.connecting = null;
    if (this._provider?.isReady && this.keepWarmForWake) {
      this.clearGraceTimer();
      this._inGrace = false;
      this._fsm.patchStatus({ status: 'dormant', realtimeReady: true });
      return;
    }
    if (this._provider?.isReady) {
      this.enterGrace();
      this.patchRealtimeReady(false);
      this._fsm.patchStatus({ status: 'dormant', realtimeReady: false });
      return;
    }
    this.hardStop();
  }

  /** Hard teardown — closes the socket immediately (farewell / process exit). */
  hardStop(): void {
    this.keepWarmForWake = false;
    this.aec?.reset();
    this.smokeProbe.settleFailure('session_closed');
    this.clearPendingRendererAudio();
    this.discardPendingToolFollowUp();
    this.pendingWorkDelegation = null;
    this.toolTurnOrigins.clear();
    this.clearReconnectTimer();
    this.clearReconnectStabilityTimer();
    this.reconnectAttempt = 0;
    this.toolCalls.cancelPending('session_closed', 'sessão Live encerrada');
    this.questionPoller.stop();
    this.clearIdleTimer();
    this.clearGraceTimer();
    this._inGrace = false;
    this.geminiResumeHandle = undefined;
    this._provider?.close();
    this._provider = null;
    this.connecting = null;
    this.providerSpeaking = false;
    this.clearPendingMic();
    this.patchRealtimeReady(false);
  }

  /**
   * Transfer audio ownership to Classic. Closing the provider makes every late
   * provider callback fail the identity checks installed by bindProvider().
   */
  quiesce(reason: string): ReturnType<JarvisLiveSession['stop']> {
    logVoice('warn', 'live.quiescedForClassic', 'Live encerrado antes do fallback Classic', {
      reason,
    });
    this.hardStop();
    this._fsm.interrupt(reason);
    return this._fsm.stop();
  }

  // ── P4: grace / resume / dormancy ──────────────────────────────────────────

  enterGrace(): void {
    const config = getVoiceConfig();
    const graceMs = config.jarvisLive.graceReuseMs;
    this.clearGraceTimer();
    this._inGrace = true;
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      this._inGrace = false;
      this.enterDormant();
    }, graceMs);
  }

  promoteGrace(): void {
    if (!this._inGrace) return;
    this.clearGraceTimer();
    this._inGrace = false;
    this.touchIdle();
  }

  enterDormant(): void {
    this.smokeProbe.settleFailure('session_closed');
    this.clearPendingRendererAudio();
    this.discardPendingToolFollowUp();
    this.pendingWorkDelegation = null;
    this.toolTurnOrigins.clear();
    this.clearIdleTimer();
    this.clearGraceTimer();
    this.clearReconnectStabilityTimer();
    this.toolCalls.cancelPending('session_closed', 'sessão Live entrou em dormência');
    this._inGrace = false;
    // Keep liveHistory across dormancy so a re-wake can inject [reconexão].
    this._provider?.close();
    this._provider = null;
    this.connecting = null;
    this._fsm.patchStatus({ status: 'dormant', realtimeReady: false });
  }

  touchIdle(): void {
    this.clearIdleTimer();
    if (this.keepWarmForWake) return;
    const config = getVoiceConfig();
    const dormantMs = config.jarvisLive.dormantAfterMs;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.enterDormant();
    }, dormantMs);
  }

  recordLiveHistory(role: 'user' | 'assistant', text: string): void {
    const maxTurns = getVoiceConfig().jarvisLive.maxWindowTurns;
    this._liveHistory.push({ role, text });
    this._liveHistory = trimLiveHistory(this._liveHistory, maxTurns);
  }

  injectResumeContext(): void {
    const ctx = buildResumeContext(this._liveHistory);
    if (!ctx || !this._provider?.isReady) return;
    this._provider.sendContext(ctx);
  }

  private clearGraceTimer(): void {
    if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = null; }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
  }

  private nextLocalCallId(kind: string): string {
    this.localCallSeq += 1;
    return localToolCallId(kind, this.localCallSeq);
  }

  // ── connection ─────────────────────────────────────────────────────────────

  private async connectFirstAvailable(
    candidates: RealtimeProviderCandidate[],
    greeting?: string,
  ): Promise<void> {
    return connectFirstLiveProvider(candidates, greeting, this.providerRuntimeHost());
  }

  private providerRuntimeHost(): LiveProviderRuntimeHost {
    return {
      fsm: this._fsm,
      toolCalls: this.toolCalls,
      now: this.now,
      emitLiveAudio: (pcm16) => this.emitLiveAudio(pcm16),
      micFramesCounter: this.micFramesCounter,
      serverAudioCounter: this.serverAudioCounter,
      getProvider: () => this._provider,
      setProvider: (provider) => { this._provider = provider; },
      getActiveTurnId: () => this.activeTurnId,
      setProviderSpeaking: (speaking) => { this.providerSpeaking = speaking; },
      setLastUserTranscript: (text) => {
        this._lastUserTranscript = text;
        this.notePotentialWorkDelegation(text);
      },
      settleSmokeResponseDone: () => this.smokeProbe.settleResponseDone(),
      settleSmokeFailure: (reason) => this.smokeProbe.settleFailure(reason),
      onProviderResponseDone: () => {
        this.recoverMissingWorkDelegation();
        this.emitToolTurnComplete();
      },
      recordLiveHistory: (role, text) => this.recordLiveHistory(role, text),
      touchIdle: () => this.touchIdle(),
      routePendingAnswer: (text) => this.routePendingAnswer(text),
      clearReconnectStabilityTimer: () => this.clearReconnectStabilityTimer(),
      scheduleReconnect: () => this.scheduleReconnect(),
      handleToolCall: (call: RealtimeToolCallEvent) => {
        this.noteToolTurnOrigin(call);
        handleRealtimeToolCall(this as unknown as ToolDispatchHost, call);
      },
      armReconnectStability: (provider) => this.armReconnectStability(provider),
      sendProviderContext: () => this.sendProviderContext(),
      hasLiveHistory: () => this._liveHistory.length > 0,
      injectResumeContext: () => this.injectResumeContext(),
      sendGreetingIfSafe: (provider, greeting) => {
        this.sendGreetingIfSafe(provider, greeting);
      },
      flushPendingMic: (provider) => this.flushPendingMic(provider),
      startQuestionPoll: () => this.questionPoller.start(),
      clearPendingMic: () => this.clearPendingMic(),
    };
  }

  private noteToolResultSending(event: JarvisLiveToolResultEvent): void {
    if (event.source !== 'realtime' || !event.callId) return;
    const sessionId = this._fsm.getState().sessionId;
    const turnId = this.activeTurnId;
    const origin = this.toolTurnOrigins.get(this.toolTurnKey(event.sessionId, event.callId));
    if (
      !sessionId ||
      !turnId ||
      sessionId !== event.sessionId ||
      !origin ||
      origin.sessionId !== sessionId ||
      origin.turnId !== turnId
    ) {
      this.toolTurnOrigins.delete(this.toolTurnKey(event.sessionId, event.callId));
      // Session still hot but turn id drifted (wake/reopen race). Keep follow-up
      // arm so the user can continue without re-saying Jarvis (Overclock).
      if (sessionId && sessionId === event.sessionId && event.callId) {
        this.armPendingToolFollowUp({
          sessionId,
          turnId: turnId || event.sessionId,
          callId: event.callId,
          sentAt: this.now(),
        });
        logVoice(
          'info',
          'live.toolFollowUpStaleTurnRecovered',
          'tool de turno antigo — rearm follow-up na sessão quente',
          { callId: event.callId },
        );
        return;
      }
      logVoice('info', 'live.toolFollowUpStaleTurnDiscarded', 'resultado de tool de turno antigo não reabre mic', {
        callId: event.callId,
      });
      return;
    }
    this.armPendingToolFollowUp({
      sessionId,
      turnId,
      callId: event.callId,
      sentAt: this.now(),
    });
  }

  private armPendingToolFollowUp(pending: PendingToolFollowUp): void {
    this.discardPendingToolFollowUp();
    this.pendingToolFollowUp = pending;
    this.toolFollowUpCompletionTimer = setTimeout(() => {
      this.toolFollowUpCompletionTimer = null;
      if (this.pendingToolFollowUp !== pending) return;
      logVoice(
        'warn',
        'live.toolTurnCompletionDeadline',
        'provider não concluiu a tool; liberando follow-up pelo prazo local',
        { callId: pending.callId, turnId: pending.turnId },
      );
      // Do not let a late provider narration overlap the deterministic local
      // fallback that begins after this completion event.
      this._provider?.interrupt();
      this.emitToolTurnComplete('deadline');
    }, TOOL_FOLLOW_UP_COMPLETION_DEADLINE_MS);
  }

  private discardPendingToolFollowUp(): void {
    this.pendingToolFollowUp = null;
    if (!this.toolFollowUpCompletionTimer) return;
    clearTimeout(this.toolFollowUpCompletionTimer);
    this.toolFollowUpCompletionTimer = null;
  }

  private clearPendingToolFollowUp(event: JarvisLiveToolResultEvent): void {
    const pending = this.pendingToolFollowUp;
    if (
      pending &&
      pending.sessionId === event.sessionId &&
      pending.callId === event.callId
    ) {
      this.discardPendingToolFollowUp();
    }
    if (event.callId) {
      this.toolTurnOrigins.delete(this.toolTurnKey(event.sessionId, event.callId));
    }
  }

  private emitToolTurnComplete(source: 'provider' | 'deadline' = 'provider'): void {
    const pending = this.pendingToolFollowUp;
    if (!pending) return;
    this.discardPendingToolFollowUp();
    this.toolTurnOrigins.delete(this.toolTurnKey(pending.sessionId, pending.callId));
    const sessionId = this._fsm.getState().sessionId;
    if (sessionId !== pending.sessionId || this.activeTurnId !== pending.turnId) return;
    this.emit(VOICE_CHANNELS.liveToolTurnComplete, {
      sessionId,
      turnId: pending.turnId,
      callId: pending.callId,
      at: this.now(),
    });
    logVoice('info', 'live.toolTurnComplete', 'turno de ferramenta concluído', {
      callId: pending.callId,
      turnId: pending.turnId,
      source,
      waitedMs: Math.max(0, this.now() - pending.sentAt),
    });
  }

  private notePotentialWorkDelegation(text: string): void {
    const trimmed = text.trim();
    const turnId = this.activeTurnId;
    if (!turnId || !isExplicitEngineeringWorkIntent(trimmed)) {
      this.pendingWorkDelegation = null;
      return;
    }
    this.pendingWorkDelegation = { text: trimmed.slice(0, 4_000), turnId };
  }

  /**
   * Last line of defence for action promises: a completed provider response is
   * not allowed to consume an explicit engineering request after only talking,
   * reading a pane, or calling an invalid MCP tool. The normal renderer safety
   * gate still confirms the delegation before any pane receives text.
   */
  private recoverMissingWorkDelegation(): void {
    const pending = this.pendingWorkDelegation;
    if (!pending || pending.turnId !== this.activeTurnId) {
      this.pendingWorkDelegation = null;
      return;
    }
    this.pendingWorkDelegation = null;
    logVoice(
      'warn',
      'live.missingDelegationRecovered',
      'pedido explícito de trabalho terminou sem delegação — enviando ao fluxo seguro',
      { chars: pending.text.length, turnId: pending.turnId },
    );
    dispatchNexusAction(
      this as unknown as ToolDispatchHost,
      {
        callId: this.nextLocalCallId('recover-delegation'),
        name: NEXUS_REALTIME_ACTION_TOOL,
        argumentsJson: '',
        arguments: {},
      },
      { action: 'send_to_pane', text: pending.text },
    );
  }

  private routePendingAnswer(text: string): void {
    if (this.pendingQuestionRouter.wasAnswerJustRouted(text)) return;
    const decision = this.pendingQuestionRouter.decide(text);
    if (!decision.route) return;
    this.pendingQuestionRouter.markRouted(decision.paneId, decision.text);
    dispatchNexusAction(
      this as unknown as ToolDispatchHost,
      {
        callId: this.nextLocalCallId('route-answer'),
        name: NEXUS_REALTIME_ACTION_TOOL,
        argumentsJson: '',
        arguments: {},
      },
      { action: 'send_to_pane', text: decision.text, paneId: decision.paneId },
    );
  }

  armToolResultTimeout(event: JarvisLiveToolEvent): void {
    const callId = event.callId;
    if (!callId || isLocalToolCallId(callId)) return;
    this.toolCalls.arm(event);
  }

  private sendProviderContext(): void {
    sendLiveProviderContext(this._provider, this._latestContext, this._recentToolResults);
  }

  private emitLiveAudio(pcm16: Int16Array): void {
    if (pcm16.byteLength === 0) return;
    this.prunePendingRendererAudio();
    const id = randomUUID();
    this.pendingRendererAudio.set(id, {
      sentAt: this.now(),
      ...(this.aec ? { aecPcm16: pcm16.slice() } : {}),
      ...(this.smokeProbe.isActive && this.activeSmokeOwnerWebContentsId !== undefined
        ? { smokeOwnerWebContentsId: this.activeSmokeOwnerWebContentsId }
        : {}),
    });
    while (this.pendingRendererAudio.size > PENDING_RENDERER_AUDIO_MAX) {
      const oldestId = this.pendingRendererAudio.keys().next().value;
      if (!oldestId) break;
      this.pendingRendererAudio.delete(oldestId);
    }
    this.smokeProbe.noteProviderAudio(id);
    this.emit(VOICE_CHANNELS.liveAudioOut, {
      id,
      pcm16: int16ArrayToBase64(pcm16),
    });
  }

  private clearPendingRendererAudio(): void {
    this.pendingRendererAudio.clear();
  }

  private prunePendingRendererAudio(): void {
    const expiresBefore = this.now() - PENDING_RENDERER_AUDIO_TTL_MS;
    for (const [id, delivery] of this.pendingRendererAudio) {
      if (delivery.sentAt >= expiresBefore) continue;
      this.pendingRendererAudio.delete(id);
    }
  }

  private sendGreetingIfSafe(
    provider: TurnManagedRealtimeProvider,
    greeting: string | undefined,
  ): void {
    const text = greeting?.trim();
    if (!text || !provider.isReady) return;
    if (this.pendingMic.length > 0) {
      logVoice('info', 'live.wakeGreetingOmitted', 'greeting omitido — fala já pendente', {
        pendingChunks: this.pendingMic.length,
      });
      return;
    }
    provider.sendText(text.slice(0, 400));
    logVoice('info', 'live.wakeGreetingSent', 'greeting enviado antes do áudio', {});
  }

  private buildSystemInstruction(): string {
    return buildLiveSystemInstruction({
      latestContext: this._latestContext,
      recentToolResults: this._recentToolResults,
      recentHistory: this._liveHistory,
      memory: this.memory,
    });
  }

  private patchRealtimeReady(realtimeReady: boolean): void {
    const state = this._fsm.getState();
    if (!state.enabled || !state.sessionId) return;
    this._fsm.patchStatus({
      status: state.status === 'off' ? 'dormant' : state.status,
      realtimeReady,
      error: realtimeReady ? undefined : state.error,
    });
  }

  private scheduleReconnect(): void {
    // A responseDone from a new socket must never release a mic arm belonging
    // to a tool result sent over the disconnected socket.
    this.discardPendingToolFollowUp();
    this.toolTurnOrigins.clear();
    const state = this._fsm.getState();
    if (!state.enabled || !state.sessionId) return;
    if (this.reconnectAttempt >= RUNTIME_RECONNECT_MAX_ATTEMPTS) {
      this._fsm.patchStatus({
        status: 'error',
        realtimeReady: false,
        error: 'realtime instável após 3 reconexões — usando Classic',
      });
      return;
    }
    this.reconnectAttempt += 1;
    this.clearReconnectTimer();
    const generation = this.reconnectGeneration;
    const delay = RUNTIME_RECONNECT_BASE_MS * 2 ** (this.reconnectAttempt - 1);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (generation !== this.reconnectGeneration) return;
      const latest = this._fsm.getState();
      if (!latest.enabled || !latest.sessionId) return;
      void this.onStart()
        .then(() => { if (!this._provider?.isReady) this.scheduleReconnect(); })
        .catch((err) => { console.warn('[live] reconnect failed', err); this.scheduleReconnect(); });
    }, delay);
  }

  private noteToolTurnOrigin(call: RealtimeToolCallEvent): void {
    const sessionId = this._fsm.getState().sessionId;
    const turnId = this.activeTurnId;
    if (!sessionId || !turnId || !call.callId) return;
    this.toolTurnOrigins.set(this.toolTurnKey(sessionId, call.callId), { sessionId, turnId });
    while (this.toolTurnOrigins.size > MAX_TOOL_TURN_ORIGINS) {
      const oldest = this.toolTurnOrigins.keys().next().value;
      if (oldest === undefined) return;
      this.toolTurnOrigins.delete(oldest);
    }
  }

  private toolTurnKey(sessionId: string, callId: string): string {
    return `${sessionId}\u0000${callId}`;
  }

  private clearReconnectTimer(): void {
    this.reconnectGeneration += 1;
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private armReconnectStability(provider: TurnManagedRealtimeProvider): void {
    this.clearReconnectStabilityTimer();
    this.reconnectStableTimer = setTimeout(() => {
      this.reconnectStableTimer = null;
      if (this._provider === provider && provider.isReady) {
        this.reconnectAttempt = 0;
      }
    }, RUNTIME_RECONNECT_STABLE_MS);
    this.reconnectStableTimer.unref?.();
  }

  private clearReconnectStabilityTimer(): void {
    if (!this.reconnectStableTimer) return;
    clearTimeout(this.reconnectStableTimer);
    this.reconnectStableTimer = null;
  }
}
