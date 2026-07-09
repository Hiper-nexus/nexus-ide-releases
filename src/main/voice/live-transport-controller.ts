import { VOICE_CHANNELS } from '../../shared/voice-channels';
import { getVoiceConfig } from './voice-config-store';
import { resolveActiveJarvisBrain } from '../../shared/voice-config';
import { resolveVoiceApiKey, voiceApiKeySource } from './voice-secrets';
import { logVoice } from './voice-log';
import { echoSuppressor } from './echo-suppress';
import { isLikelyNoiseTranscript } from '../../shared/voice-noise';
import {
  buildRealtimeEngageDecision,
  type EngageCandidate,
} from '../jarvis/realtime/engage-decision';
import { shouldWithholdLiveMicFrame } from '../jarvis/realtime/live-mic-gate';
import type { JarvisLiveSession } from './jarvis-live';
import type {
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
  type TurnManagedRealtimeProvider,
} from '../jarvis/realtime/provider';
import { jarvisLatencyTracker } from '../jarvis/realtime/metrics';
import {
  NEXUS_REALTIME_ACTION_TOOL,
} from '../jarvis/realtime/nexus-realtime-tools';
import {
  PendingQuestionRouter,
  QUESTION_POLL_MS,
} from '../jarvis/realtime/pending-question-router';
import { ThrottledCounter } from '../../shared/live-flow-counter';
import {
  dispatchNexusAction,
  handleRealtimeToolCall,
  type ToolDispatchHost,
} from './live-tool-dispatch';
import {
  GRACE_STALE_SERVER_MS,
  isGraceSocketStale,
  isIgnorableRealtimeError,
  isLocalToolCallId,
  isScreenContext,
  localToolCallId,
  buildResumeContext,
  trimLiveHistory,
  shouldLogWakeSyncReset,
} from './live-transport-helpers';
import {
  buildSystemInstruction as buildLiveSystemInstruction,
  sendProviderContext as sendLiveProviderContext,
} from './live-transport-context';

export { isIgnorableRealtimeError, isLocalToolCallId } from './live-transport-helpers';

type Emit = (channel: string, payload?: unknown) => void;

export interface NarratedQuestion {
  paneId: string;
  questionHash: string;
}

export interface PendingQuestionSource {
  poll(): NarratedQuestion[];
}

const RUNTIME_RECONNECT_BASE_MS = 750;
const RUNTIME_RECONNECT_MAX_ATTEMPTS = 3;
const PENDING_MIC_MAX_BYTES = 512 * 1024;
const REALTIME_TOOL_RESULT_TIMEOUT_MS = 10_000;
const LIVE_SAY_MAX_CHARS = 1_000;

export class LiveTransportController {
  private _provider: TurnManagedRealtimeProvider | null = null;
  private connecting: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private reconnectGeneration = 0;
  private _latestContext = '';
  private _recentToolResults: string[] = [];
  private pendingMic: Int16Array[] = [];
  private pendingMicBytes = 0;
  private pendingToolResultTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pendingQuestionRouter: PendingQuestionRouter;
  private questionPollTimer: ReturnType<typeof setInterval> | null = null;
  private registeredQuestions = new Set<string>();
  private localCallSeq = 0;
  private _lastUserTranscript = '';
  private providerSpeaking = false;
  /** P4: bounded recent final transcripts surviving transport stop. */
  private _liveHistory: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  /** P4: grace/idle timers. */
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private _inGrace = false;
  private readonly now: () => number;
  private micFramesCounter = new ThrottledCounter(25, 2_000);
  private serverAudioCounter = new ThrottledCounter(25, 2_000);
  /** Last time we saw real server progress (audio / transcript / turn end). */
  private lastServerMsgAt = 0;
  /** When current provider finished connect() (0 = none). */
  private connectedAt = 0;

  constructor(
    private emit: Emit,
    private _fsm: JarvisLiveSession,
    now: () => number = Date.now,
    private questionSource?: PendingQuestionSource,
  ) {
    this.now = now;
    this.pendingQuestionRouter = new PendingQuestionRouter({ now });
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

  /** P4: bounded live history (last N final user/assistant transcripts). */
  get liveHistory(): ReadonlyArray<{ role: 'user' | 'assistant'; text: string }> {
    return this._liveHistory;
  }

  get inGrace(): boolean { return this._inGrace; }

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

  onStart(opts?: { forceFresh?: boolean }): Promise<void> {
    this.clearReconnectTimer();
    this.logEngageDecision();
    this.resetFlowCounters();
    if (opts?.forceFresh) {
      if (shouldLogWakeSyncReset({
        forceFresh: true,
        inGrace: this._inGrace,
        providerReady: this._provider?.isReady ?? false,
        connecting: Boolean(this.connecting),
      })) {
        logVoice('info', 'live.wakeSyncReset', 'hard stop — fresh socket on wake', {
          inGrace: this._inGrace,
          wasReady: this._provider?.isReady ?? false,
          wasConnecting: Boolean(this.connecting),
        });
      }
      this.hardStop();
      this.clearGraceTimer();
      this._inGrace = false;
      this.touchIdle();
    } else if (this._inGrace && this._provider?.isReady) {
      if (isGraceSocketStale(this.lastServerMsgAt, this.now(), GRACE_STALE_SERVER_MS, this.connectedAt)) {
        logVoice('warn', 'live.graceStaleReconnect', 'grace socket stale — fresh connect on wake', {
          silentForMs: this.lastServerMsgAt > 0 ? this.now() - this.lastServerMsgAt : null,
          thresholdMs: GRACE_STALE_SERVER_MS,
        });
        this.hardStop();
      } else {
        this.promoteGrace();
        this.clearPendingMic();
        this._provider.interrupt();
        this._fsm.patchStatus({ status: 'listening', realtimeReady: true });
        return Promise.resolve();
      }
    }
    this.clearGraceTimer();
    this._inGrace = false;
    this.touchIdle();
    if (!this.isRealtimeConfigured()) {
      this.clearPendingMic();
      this._fsm.patchStatus({ status: 'dormant', realtimeReady: false });
      return Promise.resolve();
    }
    // Ready but silent too long = zombie WS — reconnect before [wake].
    if (this._provider?.isReady && isGraceSocketStale(this.lastServerMsgAt, this.now(), GRACE_STALE_SERVER_MS, this.connectedAt)) {
      logVoice('warn', 'live.readyStaleReconnect', 'ready socket stale — fresh connect on wake', {
        silentForMs: this.lastServerMsgAt > 0 ? this.now() - this.lastServerMsgAt : null,
        thresholdMs: GRACE_STALE_SERVER_MS,
      });
      this.hardStop();
    } else if (this._provider?.isReady) {
      this.clearPendingMic();
      this._provider.interrupt();
      this._fsm.patchStatus({ status: 'listening', realtimeReady: true });
      return Promise.resolve();
    }
    if (this.connecting) return this.connecting;
    const candidates = createRealtimeProviderCandidates({
      config: getVoiceConfig(),
      instructions: this.buildSystemInstruction(),
    });
    if (candidates.length === 0) {
      this.clearPendingMic();
      this.patchRealtimeReady(false);
      return Promise.resolve();
    }
    this._fsm.patchStatus({ status: 'listening', realtimeReady: false });
    const connecting = this.connectFirstAvailable(candidates)
      .finally(() => {
        if (this.connecting === connecting) this.connecting = null;
      });
    this.connecting = connecting;
    return connecting;
  }

  async smokeTest(text: string): Promise<ReturnType<JarvisLiveSession['getState']>> {
    if (!this._fsm.getState().sessionId) this._fsm.start({ reason: 'manual' });
    await this.onStart();
    if (this._provider?.isReady) {
      this._provider.sendText(text);
      this._fsm.patchStatus({ status: 'thinking', realtimeReady: true });
    }
    return this._fsm.getState();
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

  micIn(b64: string): void {
    const state = this._fsm.getState();
    if (!state.enabled || !state.sessionId) return;
    if (shouldWithholdLiveMicFrame({ status: state.status, providerSpeaking: this.providerSpeaking })) {
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
    this.sendMicSamples(this._provider, samples);
  }

  private sendMicSamples(provider: TurnManagedRealtimeProvider, samples: Int16Array): void {
    const sessionId = this._fsm.getState().sessionId;
    if (sessionId) jarvisLatencyTracker.markAudioIn(sessionId);
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
    const state = this._fsm.getState();
    if (state.pendingMic && state.status !== 'off') {
      this._fsm.patchStatus({ status: state.status, pendingMic: false });
    }
  }

  contextIn(text: string): void {
    const trimmed = text.trim().slice(0, 1_200);
    if (!trimmed) return;
    if (trimmed.startsWith('[wake]') || trimmed.startsWith('[reconexão]')) {
      if (
        this._provider?.isReady &&
        isGraceSocketStale(this.lastServerMsgAt, this.now(), GRACE_STALE_SERVER_MS, this.connectedAt)
      ) {
        logVoice('warn', 'live.wakeStaleDrop', 'drop stale socket before [wake] inject', {
          silentForMs:
            this.lastServerMsgAt > 0
              ? this.now() - this.lastServerMsgAt
              : this.connectedAt > 0
                ? this.now() - this.connectedAt
                : null,
        });
        this.hardStop();
      }
      if (this._provider?.isReady) {
        this.clearPendingMic();
        this._provider.interrupt();
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
    if (this._provider?.isReady && this._provider.sendScreenUpdate && isScreenContext(trimmed)) {
      this._provider.sendScreenUpdate(trimmed);
      return;
    }
    this.sendProviderContext();
  }

  toolResult(event: JarvisLiveToolResultEvent): void {
    if (event.callId) this.clearToolResultTimer(event.callId);
    const status = event.ok ? 'ok' : 'failed';
    const summary = event.summary.trim() || status;
    if (event.callId && !isLocalToolCallId(event.callId) && this._provider?.isReady) {
      this._provider.sendToolResult(event.callId, {
        ok: event.ok,
        tool: event.tool,
        summary,
        output: event.output ?? null,
      });
    }
    this._recentToolResults = [
      ...this._recentToolResults,
      `- ${event.tool}: ${status} (${summary})`,
    ].slice(-5);
    this.touchIdle();
    this.sendProviderContext();
  }

  endTurn(): void {
    this._provider?.endUserTurn();
  }

  interrupt(reason: string): ReturnType<JarvisLiveSession['interrupt']> {
    const status = this._fsm.getState().status;
    if (status === 'speaking' || status === 'thinking') {
      this._provider?.interrupt();
    }
    this.providerSpeaking = false;
    return this._fsm.interrupt(reason);
  }

  /**
   * Soft-stop (Overclock F-107): keep the WS warm for graceReuseMs so a quick
   * re-wake reuses the same connection. Product logic sees voice as off
   * (realtimeReady=false); the socket stays alive until grace expires → dormant.
   * Farewell / hard teardown uses hardStop().
   */
  onStop(): void {
    logVoice('info', 'live.flowSummary', 'resumo do fluxo de áudio da sessão', {
      micFramesSent: this.micFramesCounter.total,
      serverAudioChunks: this.serverAudioCounter.total,
      softStop: Boolean(this._provider?.isReady),
    });
    this.clearReconnectTimer();
    this.clearToolResultTimers();
    this.stopQuestionPoll();
    this.clearIdleTimer();
    this.providerSpeaking = false;
    this.clearPendingMic();
    this.connecting = null;
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
    this.clearReconnectTimer();
    this.clearToolResultTimers();
    this.stopQuestionPoll();
    this.clearIdleTimer();
    this.clearGraceTimer();
    this._inGrace = false;
    this._provider?.close();
    this._provider = null;
    this.connectedAt = 0;
    this.lastServerMsgAt = 0;
    this.connecting = null;
    this.providerSpeaking = false;
    this.clearPendingMic();
    this.patchRealtimeReady(false);
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
    this.clearIdleTimer();
    this.clearGraceTimer();
    this._inGrace = false;
    // Keep liveHistory across dormancy so a re-wake can inject [reconexão].
    this._provider?.close();
    this._provider = null;
    this.connectedAt = 0;
    this.lastServerMsgAt = 0;
    this.connecting = null;
    this._fsm.patchStatus({ status: 'dormant', realtimeReady: false });
  }

  touchIdle(): void {
    this.clearIdleTimer();
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

  // ── question poll ──────────────────────────────────────────────────────────

  private startQuestionPoll(): void {
    if (!this.questionSource || this.questionPollTimer) return;
    const source = this.questionSource;
    const tick = (): void => {
      for (const q of source.poll()) {
        const key = `${q.paneId}::${q.questionHash}`;
        if (this.registeredQuestions.has(key)) continue;
        this.registeredQuestions.add(key);
        this.noteNarratedQuestion(q.paneId, q.questionHash);
      }
    };
    tick();
    this.questionPollTimer = setInterval(tick, QUESTION_POLL_MS);
    this.questionPollTimer.unref?.();
  }

  private stopQuestionPoll(): void {
    if (this.questionPollTimer) {
      clearInterval(this.questionPollTimer);
      this.questionPollTimer = null;
    }
    this.registeredQuestions.clear();
  }

  private nextLocalCallId(kind: string): string {
    this.localCallSeq += 1;
    return localToolCallId(kind, this.localCallSeq);
  }

  // ── connection ─────────────────────────────────────────────────────────────

  private async connectFirstAvailable(candidates: RealtimeProviderCandidate[]): Promise<void> {
    this.clearToolResultTimers();
    this._provider?.close();
    this._provider = null;
    for (const candidate of candidates) {
      const provider = candidate.provider;
      this._provider = provider;
      this.bindProvider(provider);
      try {
        await provider.connect();
        if (this._provider === provider) {
          this.reconnectAttempt = 0;
          this.connectedAt = this.now();
          this.lastServerMsgAt = 0;
          this.sendProviderContext();
          if (this._liveHistory.length > 0) this.injectResumeContext();
          // Do NOT flush ambient/pre-roll mic — that opens a competing audio
          // user-turn ahead of the [wake] inject (~20s RTT).
          this.clearPendingMic();
          this.startQuestionPoll();
          this._fsm.patchStatus({ status: 'listening', realtimeReady: true });
        }
        return;
      } catch (err) {
        console.warn(`[live] ${candidate.id}: ${err instanceof Error ? err.message : String(err)}`);
        provider.close();
        if (this._provider === provider) this._provider = null;
      }
    }
    this._fsm.patchStatus({ status: 'error', realtimeReady: false, error: 'transporte realtime falhou — usando Classic' });
    this.clearPendingMic();
  }

  private bindProvider(provider: TurnManagedRealtimeProvider): void {
    provider.onAudioOut((pcm16) => {
      if (this._provider !== provider) return;
      this.lastServerMsgAt = this.now();
      const sessionId = this._fsm.getState().sessionId;
      if (sessionId) jarvisLatencyTracker.markAudioOut(sessionId);
      const audioTick = this.serverAudioCounter.tick(this.now());
      if (audioTick.fire) {
        logVoice('info', 'live.serverAudioChunk', 'áudio do servidor recebido', {
          chunks: audioTick.count,
          micFramesSent: this.micFramesCounter.total,
        });
      }
      this.providerSpeaking = true;
      this._fsm.patchStatus({ status: 'speaking', realtimeReady: true });
      this.emit(VOICE_CHANNELS.liveAudioOut, int16ArrayToBase64(pcm16));
    });
    provider.onRoleTranscript((line) => {
      if (this._provider !== provider) return;
      if (!line.text.trim()) return;
      this.lastServerMsgAt = this.now();

      // P3: record ALL assistant transcripts (partial + final) into echo suppressor
      if (line.role === 'assistant') {
        echoSuppressor.record(line.text);
      }

      if (line.role === 'user' && line.final && echoSuppressor.isEcho(line.text)) {
        logVoice('info', 'live.inputEchoDiscarded', 'eco do TTS/ack descartado (live)', {
          text: line.text.slice(0, 120),
        });
        return;
      }
      if (line.role === 'user' && line.final && isLikelyNoiseTranscript(line.text)) {
        logVoice('info', 'live.noiseDiscarded', 'transcript live ruído/ambiente descartado', {
          text: line.text.slice(0, 120),
        });
        return;
      }
      const event = this._fsm.transcript(line);
      if (!event) return;

      // P4: record final transcripts into live history
      if (line.final) {
        this.recordLiveHistory(line.role, line.text.trim());
        this.touchIdle();
      }

      if (line.role === 'user' && line.final) {
        this._lastUserTranscript = line.text.trim();
        this.routePendingAnswer(line.text.trim());
      }
    });
    provider.onInterrupted(() => {
      if (this._provider !== provider) return;
      this.providerSpeaking = false;
      this._fsm.interrupt('barge-in');
    });
    provider.onResponseDone(() => {
      if (this._provider !== provider) return;
      this.lastServerMsgAt = this.now();
      this.providerSpeaking = false;
      const sessionId = this._fsm.getState().sessionId;
      if (sessionId) jarvisLatencyTracker.markResponseDone(sessionId);
      this._fsm.patchStatus({ status: 'dormant', realtimeReady: true });
    });
    provider.onError((err) => {
      if (this._provider !== provider) return;
      if (isIgnorableRealtimeError(err.message)) {
        console.log('[live] realtime cancel ignorado:', err.message);
        return;
      }
      console.warn('[live]', err.message);
      this._fsm.patchStatus({ status: 'error', realtimeReady: false, error: err.message });
    });
    provider.onDisconnected((err) => {
      if (this._provider !== provider) return;
      this.providerSpeaking = false;
      console.warn('[live]', err.message);
      this.clearToolResultTimers();
      provider.close();
      if (this._provider === provider) this._provider = null;
      this._fsm.patchStatus({ status: 'listening', realtimeReady: false, error: err.message });
      this.scheduleReconnect();
    });
    provider.onToolCall((call) => {
      if (this._provider !== provider) return;
      handleRealtimeToolCall(this as unknown as ToolDispatchHost, call);
    });
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
    if (!callId) return;
    this.clearToolResultTimer(callId);
    const timer = setTimeout(() => {
      this.pendingToolResultTimers.delete(callId);
      const result = this._fsm.toolResult({
        source: 'realtime',
        callId,
        name: event.name,
        tool: event.tool,
        args: event.args,
        ok: false,
        summary: `ação realtime sem resposta do executor: ${event.summary}`,
        output: { error: 'tool_result_timeout' },
      });
      if (result) this.toolResult(result);
    }, REALTIME_TOOL_RESULT_TIMEOUT_MS);
    this.pendingToolResultTimers.set(callId, timer);
  }

  private clearToolResultTimer(callId: string): void {
    const timer = this.pendingToolResultTimers.get(callId);
    if (!timer) return;
    clearTimeout(timer);
    this.pendingToolResultTimers.delete(callId);
  }

  private clearToolResultTimers(): void {
    for (const timer of this.pendingToolResultTimers.values()) clearTimeout(timer);
    this.pendingToolResultTimers.clear();
  }

  private sendProviderContext(): void {
    sendLiveProviderContext(this._provider, this._latestContext, this._recentToolResults);
  }

  private buildSystemInstruction(): string {
    return buildLiveSystemInstruction();
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
    const state = this._fsm.getState();
    if (!state.enabled || !state.sessionId) return;
    if (this.reconnectAttempt >= RUNTIME_RECONNECT_MAX_ATTEMPTS) return;
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

  private clearReconnectTimer(): void {
    this.reconnectGeneration += 1;
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}
