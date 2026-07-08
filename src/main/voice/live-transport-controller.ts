import { VOICE_CHANNELS } from '../../shared/voice-channels';
import { getVoiceConfig } from './voice-config-store';
import { resolveVoiceApiKey } from './voice-secrets';
import { jarvisMemory } from './jarvis-memory';
import type { JarvisLiveSession } from './jarvis-live';
import type {
  JarvisLiveToolEvent,
  JarvisLiveToolResultEvent,
} from '../../shared/voice-ipc';
import {
  createRealtimeProviderCandidates,
  loadJarvisSystemPrompt,
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
  realtimeArgsToJarvisAction,
  summarizeNexusRealtimeAction,
  type NexusRealtimeActionArgs,
} from '../jarvis/realtime/nexus-realtime-tools';
import {
  COARSE_VOICE_TOOL_NAMES,
  resolveCoarseVoiceTool,
  type CoarseToolArgs,
  type CoarseToolResolution,
} from '../jarvis/realtime/coarse-voice-tools';

function isCoarseVoiceToolName(name: string): boolean {
  return (COARSE_VOICE_TOOL_NAMES as readonly string[]).includes(name);
}

type Emit = (channel: string, payload?: unknown) => void;
const RUNTIME_RECONNECT_BASE_MS = 750;
const RUNTIME_RECONNECT_MAX_ATTEMPTS = 3;
const PENDING_MIC_MAX_BYTES = 512 * 1024;
const REALTIME_TOOL_RESULT_TIMEOUT_MS = 10_000;
const LIVE_SAY_MAX_CHARS = 1_000;

/** OpenAI devolve isto quando cancelamos sem response ativa — ruído, não falha real. */
export function isIgnorableRealtimeError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('cancellation failed') ||
    m.includes('no active response') ||
    m.includes('response_cancel_not_active') ||
    m.includes('nothing to cancel')
  );
}

/**
 * Borda entre o IPC e o provider realtime: conecta o socket escolhido, roteia
 * mic→servidor e áudio/transcrição/barge-in→renderer + FSM. Quando o
 * transporte não está disponível (sem key, config classic), tudo isto é no-op
 * e o Jarvis Classic segue valendo — fallback nunca perde a intenção.
 */
export class LiveTransportController {
  private provider: TurnManagedRealtimeProvider | null = null;
  private connecting: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private reconnectGeneration = 0;
  private latestContext = '';
  private recentToolResults: string[] = [];
  private pendingMic: Int16Array[] = [];
  private pendingMicBytes = 0;
  private pendingToolResultTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private emit: Emit,
    private fsm: JarvisLiveSession,
  ) {}

  /** True quando a config pede o transporte realtime E há key. */
  isRealtimeConfigured(): boolean {
    return resolveRealtimeProviderIds(getVoiceConfig()).some((providerId) => {
      const envVar = providerId === 'openai' ? 'OPENAI_API_KEY' : 'GEMINI_API_KEY';
      return resolveVoiceApiKey(envVar) !== undefined;
    });
  }

  /** Chamado no start() do live: conecta o socket se o realtime estiver ligado. */
  onStart(): Promise<void> {
    this.clearReconnectTimer();
    if (!this.isRealtimeConfigured()) {
      this.clearPendingMic();
      this.fsm.patchStatus({
        status: 'error',
        realtimeReady: false,
        error: 'realtime sem credencial disponível — usando Classic',
      });
      return Promise.resolve();
    }
    if (this.provider?.isReady) {
      this.fsm.patchStatus({ status: 'listening', realtimeReady: true });
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
    this.fsm.patchStatus({ status: 'listening', realtimeReady: false });
    const connecting = this.connectFirstAvailable(candidates)
      .finally(() => {
        if (this.connecting === connecting) this.connecting = null;
      });
    this.connecting = connecting;
    return connecting;
  }

  async smokeTest(text: string): Promise<ReturnType<JarvisLiveSession['getState']>> {
    if (!this.fsm.getState().sessionId) this.fsm.start({ reason: 'manual' });
    await this.onStart();
    if (this.provider?.isReady) {
      this.provider.sendText(text);
      this.fsm.patchStatus({ status: 'thinking', realtimeReady: true });
    }
    return this.fsm.getState();
  }

  async say(text: string): Promise<ReturnType<JarvisLiveSession['getState']>> {
    const trimmed = text.trim().slice(0, LIVE_SAY_MAX_CHARS);
    if (!trimmed) return this.fsm.getState();
    if (!this.fsm.getState().sessionId) this.fsm.start({ reason: 'manual' });
    await this.onStart();
    if (this.provider?.isReady) {
      this.provider.sendText(
        [
          'Internal Nexus action result. Say this to the user now.',
          'Use Brazilian Portuguese, one brief natural sentence.',
          'Do not mention tools, JSON, internal prompts, or this instruction.',
          `Text to say: ${trimmed}`,
        ].join('\n'),
      );
      this.fsm.patchStatus({ status: 'thinking', realtimeReady: true });
    }
    return this.fsm.getState();
  }

  micIn(b64: string): void {
    const state = this.fsm.getState();
    if (!state.enabled || !state.sessionId) return;
    let samples: Int16Array;
    try {
      samples = base64ToInt16Array(b64);
    } catch (err) {
      this.fsm.patchStatus({
        status: 'error',
        realtimeReady: false,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (samples.length === 0) return;
    if (!this.provider?.isReady) {
      this.bufferMicChunk(samples);
      return;
    }
    this.sendMicSamples(this.provider, samples);
  }

  private sendMicSamples(provider: TurnManagedRealtimeProvider, samples: Int16Array): void {
    const sessionId = this.fsm.getState().sessionId;
    if (sessionId) jarvisLatencyTracker.markAudioIn(sessionId);
    try {
      provider.sendAudioChunk(samples);
    } catch (err) {
      this.fsm.patchStatus({
        status: 'error',
        realtimeReady: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private bufferMicChunk(samples: Int16Array): void {
    const bytes = samples.byteLength;
    if (bytes <= 0 || bytes > PENDING_MIC_MAX_BYTES) return;
    while (
      this.pendingMicBytes + bytes > PENDING_MIC_MAX_BYTES &&
      this.pendingMic.length > 0
    ) {
      const dropped = this.pendingMic.shift();
      this.pendingMicBytes -= dropped?.byteLength ?? 0;
    }
    this.pendingMic.push(samples.slice());
    this.pendingMicBytes += bytes;
    const state = this.fsm.getState();
    if (!state.pendingMic && state.status !== 'off') {
      this.fsm.patchStatus({ status: state.status, pendingMic: true });
    }
  }

  private flushPendingMic(provider: TurnManagedRealtimeProvider): void {
    const chunks = this.pendingMic;
    this.pendingMic = [];
    this.pendingMicBytes = 0;
    for (const chunk of chunks) this.sendMicSamples(provider, chunk);
    const state = this.fsm.getState();
    if (state.pendingMic && state.status !== 'off') {
      this.fsm.patchStatus({ status: state.status, pendingMic: false });
    }
  }

  private clearPendingMic(): void {
    this.pendingMic = [];
    this.pendingMicBytes = 0;
    const state = this.fsm.getState();
    if (state.pendingMic && state.status !== 'off') {
      this.fsm.patchStatus({ status: state.status, pendingMic: false });
    }
  }

  contextIn(text: string): void {
    this.latestContext = text.trim().slice(0, 1_200);
    this.sendProviderContext();
  }

  toolResult(event: JarvisLiveToolResultEvent): void {
    if (event.callId) this.clearToolResultTimer(event.callId);
    const status = event.ok ? 'ok' : 'failed';
    const summary = event.summary.trim() || status;
    if (event.callId && this.provider?.isReady) {
      this.provider.sendToolResult(event.callId, {
        ok: event.ok,
        tool: event.tool,
        summary,
        output: event.output ?? null,
      });
    }
    this.recentToolResults = [
      ...this.recentToolResults,
      `- ${event.tool}: ${status} (${summary})`,
    ].slice(-5);
    this.sendProviderContext();
  }

  endTurn(): void {
    this.provider?.endUserTurn();
  }

  interrupt(reason: string): ReturnType<JarvisLiveSession['interrupt']> {
    const status = this.fsm.getState().status;
    if (status === 'speaking' || status === 'thinking') {
      this.provider?.interrupt();
    }
    return this.fsm.interrupt(reason);
  }

  onStop(): void {
    this.clearReconnectTimer();
    this.clearToolResultTimers();
    this.provider?.close();
    this.provider = null;
    this.connecting = null;
    this.clearPendingMic();
    this.patchRealtimeReady(false);
  }

  private async connectFirstAvailable(
    candidates: RealtimeProviderCandidate[],
  ): Promise<void> {
    this.clearToolResultTimers();
    this.provider?.close();
    this.provider = null;
    for (const candidate of candidates) {
      const provider = candidate.provider;
      this.provider = provider;
      this.bindProvider(provider);
      try {
        await provider.connect();
        if (this.provider === provider) {
          this.reconnectAttempt = 0;
          this.sendProviderContext();
          this.flushPendingMic(provider);
          this.fsm.patchStatus({ status: 'listening', realtimeReady: true });
        }
        return;
      } catch (err) {
        console.warn(
          `[live] ${candidate.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        provider.close();
        if (this.provider === provider) this.provider = null;
      }
    }
    this.fsm.patchStatus({
      status: 'error',
      realtimeReady: false,
      error: 'transporte realtime falhou — usando Classic',
    });
    this.clearPendingMic();
  }

  private bindProvider(provider: TurnManagedRealtimeProvider): void {
    provider.onAudioOut((pcm16) => {
      if (this.provider !== provider) return;
      const sessionId = this.fsm.getState().sessionId;
      if (sessionId) jarvisLatencyTracker.markAudioOut(sessionId);
      this.fsm.patchStatus({ status: 'speaking', realtimeReady: true });
      this.emit(VOICE_CHANNELS.liveAudioOut, int16ArrayToBase64(pcm16));
    });
    provider.onRoleTranscript((line) => {
      if (this.provider !== provider) return;
      if (!line.text.trim()) return;
      const event = this.fsm.transcript(line);
      if (!event) return;
    });
    provider.onInterrupted(() => {
      if (this.provider !== provider) return;
      this.fsm.interrupt('barge-in');
    });
    provider.onResponseDone(() => {
      if (this.provider !== provider) return;
      const sessionId = this.fsm.getState().sessionId;
      if (sessionId) jarvisLatencyTracker.markResponseDone(sessionId);
      this.fsm.patchStatus({ status: 'dormant', realtimeReady: true });
    });
    provider.onError((err) => {
      if (this.provider !== provider) return;
      if (isIgnorableRealtimeError(err.message)) {
        console.log('[live] realtime cancel ignorado:', err.message);
        return;
      }
      console.warn('[live]', err.message);
      this.fsm.patchStatus({
        status: 'error',
        realtimeReady: false,
        error: err.message,
      });
    });
    provider.onDisconnected((err) => {
      if (this.provider !== provider) return;
      console.warn('[live]', err.message);
      this.clearToolResultTimers();
      provider.close();
      if (this.provider === provider) this.provider = null;
      this.fsm.patchStatus({
        status: 'listening',
        realtimeReady: false,
        error: err.message,
      });
      this.scheduleReconnect();
    });
    provider.onToolCall((call) => {
      if (this.provider !== provider) return;
      this.handleRealtimeToolCall(call);
    });
  }

  private handleRealtimeToolCall(call: RealtimeToolCallEvent): void {
    // OpenAI Realtime usa a tool única nexus_action; Gemini Live usa as 4 tools
    // coarse (delegar/consultar/ler/navegar) + encerrar. As duas convergem no
    // MESMO executor auditado abaixo.
    if (call.name === NEXUS_REALTIME_ACTION_TOOL) {
      this.dispatchNexusAction(call, call.arguments as NexusRealtimeActionArgs);
      return;
    }
    if (isCoarseVoiceToolName(call.name)) {
      this.handleCoarseVoiceToolCall(call);
      return;
    }
    this.rejectToolCall(call, `tool realtime não suportada: ${call.name}`, {
      error: 'unsupported_tool',
    });
  }

  /** Executa uma ação Nexus (nexus_action ou coarse resolvida) pelo caminho auditado. */
  private dispatchNexusAction(
    call: RealtimeToolCallEvent,
    args: NexusRealtimeActionArgs,
  ): void {
    const action = realtimeArgsToJarvisAction(args);
    const argsRecord = args as Record<string, unknown>;
    const event = this.fsm.realtimeToolCall({
      source: 'realtime',
      callId: call.callId,
      name: call.name,
      tool: action?.type ?? 'none',
      summary: summarizeNexusRealtimeAction(args),
      args: argsRecord,
    });
    if (!event) return;
    if (action) {
      jarvisLatencyTracker.markAction(event.sessionId);
      this.armToolResultTimeout(event);
      return;
    }
    const result = this.fsm.toolResult({
      source: 'realtime',
      callId: call.callId,
      name: call.name,
      tool: event.tool,
      args: argsRecord,
      ok: false,
      summary: `ação realtime inválida: ${summarizeNexusRealtimeAction(args)}`,
      output: {
        error: 'invalid_action',
        expected: 'valid Nexus action arguments',
        args: argsRecord,
      },
    });
    if (result) this.toolResult(result);
  }

  /** Gemini Live coarse tools: delegar/navegar → ação; consultar/ler → direto; encerrar → fim. */
  private handleCoarseVoiceToolCall(call: RealtimeToolCallEvent): void {
    const resolution = resolveCoarseVoiceTool(
      call.name,
      call.arguments as CoarseToolArgs,
    );
    switch (resolution.kind) {
      case 'action':
        this.dispatchNexusAction(call, resolution.action);
        return;
      case 'direct':
        this.answerDirectToolCall(call, resolution);
        return;
      case 'end':
        this.answerEndToolCall(call);
        return;
      case 'invalid':
        this.rejectToolCall(call, resolution.reason, { error: 'invalid_action' });
        return;
    }
  }

  /**
   * consultar/ler são respondidas DIRETO do contexto injetado (tela/últimos
   * resultados) — o modelo narra a partir do output, sem bloquear o loop no brain.
   */
  private answerDirectToolCall(
    call: RealtimeToolCallEvent,
    resolution: Extract<CoarseToolResolution, { kind: 'direct' }>,
  ): void {
    const summary = resolution.intent === 'consult' ? 'consultar estado' : 'ler pane';
    const event = this.fsm.realtimeToolCall({
      source: 'realtime',
      callId: call.callId,
      name: call.name,
      tool: 'none',
      summary,
      args: call.arguments,
    });
    if (!event) return;
    const context = this.buildDirectAnswerContext();
    const output =
      context ||
      (resolution.intent === 'consult'
        ? 'Sem contexto de tela disponível agora.'
        : 'Sem output de pane disponível agora.');
    const result = this.fsm.toolResult({
      source: 'realtime',
      callId: call.callId,
      name: call.name,
      tool: 'none',
      args: call.arguments,
      ok: true,
      summary,
      output,
    });
    if (result) this.toolResult(result);
  }

  private answerEndToolCall(call: RealtimeToolCallEvent): void {
    const event = this.fsm.realtimeToolCall({
      source: 'realtime',
      callId: call.callId,
      name: call.name,
      tool: 'none',
      summary: 'encerrar sessão',
      args: call.arguments,
    });
    if (!event) return;
    const result = this.fsm.toolResult({
      source: 'realtime',
      callId: call.callId,
      name: call.name,
      tool: 'none',
      args: call.arguments,
      ok: true,
      summary: 'encerrar sessão',
      output: { ended: true },
    });
    if (result) this.toolResult(result);
  }

  private rejectToolCall(
    call: RealtimeToolCallEvent,
    reason: string,
    output: Record<string, unknown>,
  ): void {
    const event = this.fsm.realtimeToolCall({
      source: 'realtime',
      callId: call.callId,
      name: call.name,
      tool: 'none',
      summary: reason,
      args: call.arguments,
    });
    if (!event) return;
    const result = this.fsm.toolResult({
      source: 'realtime',
      callId: call.callId,
      name: call.name,
      tool: 'none',
      args: call.arguments,
      ok: false,
      summary: reason,
      output,
    });
    if (result) this.toolResult(result);
  }

  private buildDirectAnswerContext(): string {
    const parts: string[] = [];
    if (this.latestContext) parts.push(this.latestContext);
    if (this.recentToolResults.length > 0) {
      parts.push(this.recentToolResults.join('\n'));
    }
    return parts.join('\n\n').trim().slice(0, 1_200);
  }

  private armToolResultTimeout(event: JarvisLiveToolEvent): void {
    const callId = event.callId;
    if (!callId) return;
    this.clearToolResultTimer(callId);
    const timer = setTimeout(() => {
      this.pendingToolResultTimers.delete(callId);
      const result = this.fsm.toolResult({
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
    if (!this.provider?.isReady) return;
    const parts: string[] = [];
    if (this.latestContext) parts.push(`Current Nexus screen:\n${this.latestContext}`);
    if (this.recentToolResults.length > 0) {
      parts.push(`Recent Nexus action results:\n${this.recentToolResults.join('\n')}`);
    }
    const text = parts.join('\n\n').trim();
    if (text) this.provider.sendContext(text);
  }

  private buildSystemInstruction(): string {
    const config = getVoiceConfig();
    const persona = config.persona;
    const parts = [loadJarvisSystemPrompt()];
    if (persona.assistantName?.trim()) {
      parts.push(`Assistant name: ${persona.assistantName.trim()}.`);
    }
    if (persona.userName?.trim()) {
      parts.push(`User name: ${persona.userName.trim()}.`);
    }
    if (persona.customInstructions?.trim()) {
      parts.push(`User custom instructions:\n${persona.customInstructions.trim()}`);
    }
    const memory = jarvisMemory.factsBlock();
    if (memory.trim()) parts.push(`Long-term memory:\n${memory.trim()}`);
    return parts.join('\n\n');
  }

  private patchRealtimeReady(realtimeReady: boolean): void {
    const state = this.fsm.getState();
    if (!state.enabled || !state.sessionId) return;
    this.fsm.patchStatus({
      status: state.status === 'off' ? 'dormant' : state.status,
      realtimeReady,
      error: realtimeReady ? undefined : state.error,
    });
  }

  private scheduleReconnect(): void {
    const state = this.fsm.getState();
    if (!state.enabled || !state.sessionId) return;
    if (this.reconnectAttempt >= RUNTIME_RECONNECT_MAX_ATTEMPTS) return;
    this.reconnectAttempt += 1;
    this.clearReconnectTimer();
    const generation = this.reconnectGeneration;
    const delay = RUNTIME_RECONNECT_BASE_MS * 2 ** (this.reconnectAttempt - 1);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (generation !== this.reconnectGeneration) return;
      const latest = this.fsm.getState();
      if (!latest.enabled || !latest.sessionId) return;
      void this.onStart()
        .then(() => {
          if (!this.provider?.isReady) this.scheduleReconnect();
        })
        .catch((err) => {
          console.warn('[live] reconnect failed', err);
          this.scheduleReconnect();
        });
    }, delay);
  }

  private clearReconnectTimer(): void {
    this.reconnectGeneration += 1;
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}
