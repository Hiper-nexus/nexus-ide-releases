import { randomUUID } from 'node:crypto';
import { VOICE_CHANNELS } from '../../shared/voice-channels';
import type {
  JarvisAction,
  JarvisLiveInterruptEvent,
  JarvisLiveStartRequest,
  JarvisLiveState,
  JarvisLiveStatusPatch,
  JarvisLiveToolEvent,
  JarvisLiveToolCancellationEvent,
  JarvisLiveToolResultEvent,
  JarvisLiveTranscriptEvent,
  JarvisReply,
} from '../../shared/voice-ipc';

type Emit = (channel: string, payload?: unknown) => void;
type TranscriptSink = (
  sessionId: string,
  line: Omit<JarvisLiveTranscriptEvent, 'sessionId' | 'at'>,
) => void;

function initialState(enabled = false): JarvisLiveState {
  return {
    enabled,
    sessionId: null,
    status: enabled ? 'dormant' : 'off',
    realtimeReady: false,
    startedAt: null,
    lastActiveAt: null,
    turns: 0,
    pendingMic: false,
  };
}

function actionSummary(action: JarvisAction): string {
  switch (action.type) {
    case 'none':
      return 'conversa';
    case 'open_squad':
      return `abrir squad ${action.squadName}`;
    case 'open_squad_picker':
      return 'abrir seletor de squads salvos';
    case 'open_workspace':
      return `abrir workspace ${action.workspaceName}`;
    case 'design_squad':
      return 'desenhar squad';
    case 'confirm_squad':
      return 'confirmar e iniciar squad';
    case 'new_mission':
      return 'nova missão';
    case 'new_agentic_mission':
      return action.intent ? 'nova missão agêntica com objetivo' : 'nova missão agêntica';
    case 'new_workspace':
      return 'novo workspace';
    case 'open_terminal':
      return 'abrir terminal';
    case 'close_pane':
      return 'fechar pane';
    case 'open_board':
      return 'abrir quadro de missões';
    case 'open_settings':
      return 'abrir configurações';
    case 'open_voice_settings':
      return 'abrir configurações de voz';
    case 'open_browser':
      return action.url ? `abrir browser em ${action.url}` : 'abrir browser';
    case 'browser_back':
      return 'voltar no browser';
    case 'browser_forward':
      return 'avançar no browser';
    case 'browser_reload':
      return 'recarregar browser';
    case 'focus_next_pane':
      return 'focar próximo pane';
    case 'focus_previous_pane':
      return 'focar pane anterior';
    case 'focus_pane':
      return `focar pane ${action.paneName}`;
    case 'read_pane':
      return action.paneId ? `ler pane ${action.paneId}` : 'ler pane ativo';
    case 'read_current_view':
      return 'ler visão atual';
    case 'send_to_pane':
      return 'enviar tarefa ao pane';
    case 'sync_repository':
      return 'sincronizar repositório local';
    case 'run_command':
      return `rodar comando: ${action.command}`;
    case 'mcp_tool':
      return action.tool;
    case 'restore_mission_panes':
      return action.alvo ? `restaurar missão ${action.alvo}` : 'restaurar missão';
    case 'ask_pane':
      return 'perguntar ao pane';
    case 'sync_repo_via_pane':
      if (action.mode === 'status') return 'checar status do repositório via pane';
      if (action.mode === 'push') return 'enviar repositório via pane';
      return 'atualizar repositório via pane';
    case 'open_agent':
      return action.model
        ? `abrir agente ${action.agentId} (${action.model})`
        : `abrir agente ${action.agentId}`;
  }
}

/**
 * Main-process state machine for Jarvis Live. The audio loop still runs in the
 * renderer (where getUserMedia lives); this object gives it a durable session
 * identity and broadcasts the live transcript/tool/interruption events.
 */
export class JarvisLiveSession {
  private state: JarvisLiveState = initialState(false);

  constructor(
    private emit: Emit,
    private now: () => number = Date.now,
    private transcriptSink?: TranscriptSink,
  ) {}

  getState(): JarvisLiveState {
    return { ...this.state };
  }

  setEnabled(enabled: boolean): JarvisLiveState {
    if (!enabled) {
      this.state = initialState(false);
      this.broadcastState();
      return this.getState();
    }
    if (!this.state.enabled) {
      this.state = initialState(true);
      this.broadcastState();
    }
    return this.getState();
  }

  start(_req: JarvisLiveStartRequest = {}): JarvisLiveState {
    if (!this.state.enabled) {
      this.state = {
        ...initialState(false),
        status: 'error',
        error: 'Jarvis Live está desativado nas configurações.',
      };
      this.broadcastState();
      return this.getState();
    }
    const now = this.now();
    this.state = {
      ...this.state,
      sessionId: this.state.sessionId ?? randomUUID(),
      status: 'listening',
      realtimeReady: false,
      startedAt: this.state.startedAt ?? now,
      lastActiveAt: now,
      pendingMic: false,
      error: undefined,
    };
    this.broadcastState();
    return this.getState();
  }

  stop(): JarvisLiveState {
    this.state = initialState(this.state.enabled);
    this.broadcastState();
    return this.getState();
  }

  endTurn(): JarvisLiveState {
    if (!this.state.enabled) return this.getState();
    this.state = {
      ...this.state,
      status: 'dormant',
      lastActiveAt: this.state.sessionId ? this.now() : this.state.lastActiveAt,
      pendingMic: false,
      error: undefined,
    };
    this.broadcastState();
    return this.getState();
  }

  patchStatus(patch: JarvisLiveStatusPatch): JarvisLiveState {
    if (!this.state.enabled) return this.getState();
    if (!this.state.sessionId) this.start({ reason: 'manual' });
    this.state = {
      ...this.state,
      status: patch.status,
      lastActiveAt: this.now(),
      pendingMic: patch.pendingMic ?? this.state.pendingMic,
      realtimeReady: patch.realtimeReady ?? this.state.realtimeReady,
      error: patch.error,
    };
    this.broadcastState();
    return this.getState();
  }

  transcript(
    raw: Omit<JarvisLiveTranscriptEvent, 'sessionId' | 'at'>,
  ): JarvisLiveTranscriptEvent | null {
    if (!this.state.enabled) return null;
    if (!this.state.sessionId) this.start({ reason: 'manual' });
    const sessionId = this.state.sessionId;
    if (!sessionId) return null;
    const event: JarvisLiveTranscriptEvent = {
      ...raw,
      sessionId,
      at: this.now(),
    };
    this.state = {
      ...this.state,
      lastActiveAt: event.at,
      turns:
        raw.final && raw.role === 'user'
          ? this.state.turns + 1
          : this.state.turns,
    };
    this.transcriptSink?.(sessionId, raw);
    this.emit(VOICE_CHANNELS.liveTranscript, event);
    this.broadcastState();
    return event;
  }

  onJarvisReply(transcript: string, reply: JarvisReply): void {
    if (!this.state.enabled || !this.state.sessionId) return;
    this.transcript({ role: 'user', text: transcript, final: true });
    if (reply.say.trim()) {
      this.transcript({ role: 'assistant', text: reply.say, final: true });
    }
    if (reply.action.type !== 'none') {
      this.emit(VOICE_CHANNELS.liveToolCall, {
        sessionId: this.state.sessionId,
        tool: reply.action.type,
        summary: actionSummary(reply.action),
        source: 'classic',
        at: this.now(),
      });
    }
  }

  realtimeToolCall(
    raw: Omit<JarvisLiveToolEvent, 'sessionId' | 'at'>,
  ): JarvisLiveToolEvent | null {
    if (!this.state.enabled) return null;
    if (!this.state.sessionId) this.start({ reason: 'manual' });
    const sessionId = this.state.sessionId;
    if (!sessionId) return null;
    const event: JarvisLiveToolEvent = {
      ...raw,
      source: raw.source ?? 'realtime',
      sessionId,
      at: this.now(),
    };
    this.state = {
      ...this.state,
      status: 'thinking',
      lastActiveAt: event.at,
      pendingMic: false,
    };
    this.emit(VOICE_CHANNELS.liveToolCall, event);
    this.broadcastState();
    return event;
  }

  toolResult(
    raw: Omit<JarvisLiveToolResultEvent, 'sessionId' | 'at'>,
  ): JarvisLiveToolResultEvent | null {
    if (!this.state.enabled || !this.state.sessionId) return null;
    const event: JarvisLiveToolResultEvent = {
      ...raw,
      sessionId: this.state.sessionId,
      at: this.now(),
    };
    this.emit(VOICE_CHANNELS.liveToolResult, event);
    return event;
  }

  toolCancelled(
    raw: Omit<JarvisLiveToolCancellationEvent, 'sessionId' | 'at'>,
  ): JarvisLiveToolCancellationEvent | null {
    if (!this.state.enabled || !this.state.sessionId) return null;
    const event: JarvisLiveToolCancellationEvent = {
      ...raw,
      sessionId: this.state.sessionId,
      at: this.now(),
    };
    this.emit(VOICE_CHANNELS.liveToolCancelled, event);
    return event;
  }

  interrupt(reason: string): JarvisLiveInterruptEvent {
    const event: JarvisLiveInterruptEvent = {
      sessionId: this.state.sessionId,
      reason,
      at: this.now(),
    };
    if (this.state.enabled) {
      this.state = {
        ...this.state,
        status: 'interrupted',
        lastActiveAt: event.at,
        pendingMic: true,
      };
      this.broadcastState();
    }
    this.emit(VOICE_CHANNELS.liveInterrupted, event);
    return event;
  }

  private broadcastState(): void {
    this.emit(VOICE_CHANNELS.liveState, this.getState());
  }
}
