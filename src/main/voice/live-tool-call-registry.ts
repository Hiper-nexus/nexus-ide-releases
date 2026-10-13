import type {
  RealtimeToolCallEvent,
  TurnManagedRealtimeProvider,
} from '../jarvis/realtime/provider';
import type {
  JarvisLiveToolCancellationReason,
  JarvisLiveToolEvent,
  JarvisLiveToolResultEvent,
} from '../../shared/voice-ipc';
import type { JarvisLiveSession } from './jarvis-live';
import { logVoice } from './voice-log';

const MAX_TOOL_CALL_RECORDS = 512;

export type LiveToolCallStatus =
  | 'pending'
  | 'completed'
  | 'cancelled'
  | 'timed_out';

export interface LiveToolCallRecord {
  sessionId: string;
  call: RealtimeToolCallEvent;
  status: LiveToolCallStatus;
  event?: JarvisLiveToolEvent;
  response?: unknown;
}

export class LiveToolCallRegistry {
  private readonly records = new Map<string, LiveToolCallRecord>();

  private key(sessionId: string, callId: string): string {
    return `${sessionId}\u0000${callId}`;
  }

  claim(sessionId: string, call: RealtimeToolCallEvent): {
    accepted: boolean;
    record: LiveToolCallRecord;
  } {
    const key = this.key(sessionId, call.callId);
    const existing = this.records.get(key);
    if (existing) return { accepted: false, record: existing };
    const record: LiveToolCallRecord = { sessionId, call, status: 'pending' };
    this.records.set(key, record);
    this.trim();
    return { accepted: true, record };
  }

  attachEvent(event: JarvisLiveToolEvent): void {
    if (!event.callId) return;
    const record = this.records.get(this.key(event.sessionId, event.callId));
    if (record?.status === 'pending') record.event = event;
  }

  get(sessionId: string, callId: string): LiveToolCallRecord | undefined {
    return this.records.get(this.key(sessionId, callId));
  }

  complete(sessionId: string, callId: string, response: unknown): boolean {
    const record = this.records.get(this.key(sessionId, callId));
    if (!record || record.status !== 'pending') return false;
    record.status = 'completed';
    record.response = response;
    this.trim();
    return true;
  }

  terminate(
    sessionId: string,
    callId: string,
    status: Extract<LiveToolCallStatus, 'cancelled' | 'timed_out'>,
    response?: unknown,
  ): LiveToolCallRecord | null {
    const record = this.records.get(this.key(sessionId, callId));
    if (!record || record.status !== 'pending') return null;
    record.status = status;
    if (response !== undefined) record.response = response;
    this.trim();
    return record;
  }

  pending(): LiveToolCallRecord[] {
    return [...this.records.values()].filter((record) => record.status === 'pending');
  }

  private trim(): void {
    if (this.records.size <= MAX_TOOL_CALL_RECORDS) return;
    for (const [callId, record] of this.records) {
      if (record.status === 'pending') continue;
      this.records.delete(callId);
      if (this.records.size <= MAX_TOOL_CALL_RECORDS) return;
    }
  }
}

const HUMAN_TOOL_RESULT_TIMEOUT_MS = 120_000;

export interface LiveToolCallCoordinatorDeps {
  fsm: JarvisLiveSession;
  getProvider(): TurnManagedRealtimeProvider | null;
  onResultContext(
    tool: JarvisLiveToolResultEvent['tool'],
    status: 'ok' | 'failed',
    summary: string,
  ): void;
  /**
   * Fired immediately before sending a function response. A provider is allowed
   * to synchronously complete its response from inside sendToolResult(), so the
   * owner must be armed before that call begins.
   */
  onResultSending?(event: JarvisLiveToolResultEvent): void;
  /** Clears an optimistic pre-send arm when no provider accepted the result. */
  onResultSendFailed?(event: JarvisLiveToolResultEvent): void;
}

/** Main-owned exactly-once/cancellation lifecycle for Live function calls. */
export class LiveToolCallCoordinator {
  private readonly records = new LiveToolCallRegistry();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: LiveToolCallCoordinatorDeps) {}

  claim(call: RealtimeToolCallEvent): boolean {
    if (!call.callId) {
      logVoice('warn', 'live.toolMissingCallId', 'tool realtime sem callId descartada', {
        name: call.name,
      });
      return false;
    }
    const sessionId = this.deps.fsm.getState().sessionId ?? 'inactive';
    const claim = this.records.claim(sessionId, call);
    if (claim.accepted) return true;
    logVoice('info', 'live.toolDuplicate', 'callId realtime duplicado ignorado', {
      callId: call.callId,
      status: claim.record.status,
    });
    if (claim.record.status !== 'pending' && claim.record.response !== undefined) {
      this.sendResponse(call.callId, claim.record.response, claim.record.call.name);
    }
    return false;
  }

  complete(event: JarvisLiveToolResultEvent): boolean {
    const callId = event.callId;
    if (!callId) return false;
    this.clearTimer(callId);
    const status = event.ok ? 'ok' : 'failed';
    const summary = event.summary.trim() || status;
    const response = {
      ok: event.ok,
      tool: event.tool,
      summary,
      output: event.output ?? null,
    };
    const record = this.records.get(event.sessionId, callId);
    if (!record || !this.records.complete(event.sessionId, callId, response)) {
      // F-1424: summary de tool carrega conteúdo ditado (ex.: URL) — no log
      // entra só mensagem estática + contagem; o sanitizador do logVoice é a
      // segunda barreira.
      logVoice('warn', 'live.toolLateResult', 'resultado tardio/duplicado não reenviado', {
        callId,
        terminalState: record?.status ?? 'unknown',
        reportedOk: event.ok,
        effectMayHaveCommitted: event.ok,
        summaryChars: summary.length,
      });
      return false;
    }
    this.deps.onResultSending?.(event);
    const sent = this.sendResponse(callId, response, record.call.name);
    if (!sent) this.deps.onResultSendFailed?.(event);
    this.deps.onResultContext(event.tool, status, summary);
    return true;
  }

  arm(event: JarvisLiveToolEvent): void {
    const callId = event.callId;
    if (!callId) return;
    this.records.attachEvent(event);
    this.clearTimer(callId);
    this.timers.set(
      callId,
      setTimeout(() => {
        this.timers.delete(callId);
        this.timeout(event);
      }, HUMAN_TOOL_RESULT_TIMEOUT_MS),
    );
  }

  cancel(
    callId: string,
    reason: JarvisLiveToolCancellationReason,
    summary: string,
    sessionId = this.deps.fsm.getState().sessionId ?? 'inactive',
  ): void {
    const existing = this.records.get(sessionId, callId);
    const response = {
      ok: false,
      tool: existing?.event?.tool ?? 'none',
      summary,
      output: { error: reason },
    };
    const record = this.records.terminate(sessionId, callId, 'cancelled', response);
    if (!record) return;
    this.clearTimer(callId);
    this.deps.fsm.toolCancelled({
      callId,
      name: record.event?.name ?? record.call.name,
      tool: record.event?.tool,
      reason,
      summary,
    });
  }

  cancelPending(
    reason: JarvisLiveToolCancellationReason,
    summary: string,
  ): void {
    for (const record of this.records.pending()) {
      this.cancel(record.call.callId, reason, summary, record.sessionId);
    }
    this.clearTimers();
  }

  private timeout(event: JarvisLiveToolEvent): void {
    const callId = event.callId;
    if (!callId) return;
    const summary = `ação realtime sem resposta do executor: ${event.summary}`;
    const response = {
      ok: false,
      tool: event.tool,
      summary,
      output: { error: 'tool_result_timeout' },
    };
    if (!this.records.terminate(event.sessionId, callId, 'timed_out', response)) return;
    this.deps.fsm.toolCancelled({
      callId,
      name: event.name,
      tool: event.tool,
      reason: 'timeout',
      summary: 'tempo de confirmação/execução esgotado',
    });
    this.deps.fsm.toolResult({
      source: 'realtime',
      callId,
      name: event.name,
      tool: event.tool,
      args: event.args,
      ok: false,
      summary,
      output: response.output,
    });
    const record = this.records.get(event.sessionId, callId);
    this.sendResponse(callId, response, record?.call.name ?? event.name ?? 'nexus_action');
    this.deps.onResultContext(event.tool, 'failed', summary);
  }

  private sendResponse(callId: string, response: unknown, name: string): boolean {
    const provider = this.deps.getProvider();
    if (!provider?.isReady) return false;
    if (provider.sendNamedToolResult) {
      provider.sendNamedToolResult(callId, name, response);
      return true;
    }
    provider.sendToolResult(callId, response);
    return true;
  }

  private clearTimer(callId: string): void {
    const timer = this.timers.get(callId);
    if (!timer) return;
    clearTimeout(timer);
    this.timers.delete(callId);
  }

  private clearTimers(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
