/**
 * Extracted tool dispatch logic for the LiveTransportController.
 * Handles coarse voice tool resolution, direct-answer, encerrar, and reject
 * paths so the controller stays under the 800-line cap.
 */
import { logVoice } from './voice-log';
import { isFarewellIntent } from '../jarvis/realtime/farewell-intent';
import {
  COARSE_VOICE_TOOL_NAMES,
  resolveCoarseVoiceTool,
  type CoarseToolArgs,
  type CoarseToolResolution,
} from '../jarvis/realtime/coarse-voice-tools';
import {
  NEXUS_REALTIME_ACTION_TOOL,
  realtimeArgsToJarvisAction,
  summarizeNexusRealtimeAction,
  type NexusRealtimeActionArgs,
} from '../jarvis/realtime/nexus-realtime-tools';
import { jarvisLatencyTracker } from '../jarvis/realtime/metrics';
import type { RealtimeToolCallEvent, TurnManagedRealtimeProvider } from '../jarvis/realtime/provider';
import type { JarvisLiveSession } from './jarvis-live';
import type { JarvisLiveToolEvent, JarvisLiveToolResultEvent } from '../../shared/voice-ipc';

export interface ToolDispatchHost {
  readonly provider: TurnManagedRealtimeProvider | null;
  readonly fsm: JarvisLiveSession;
  readonly lastUserTranscript: string;
  latestContext: string;
  recentToolResults: string[];
  toolResult(event: JarvisLiveToolResultEvent): void;
  armToolResultTimeout(event: JarvisLiveToolEvent): void;
  /** C3 defesa (follow-up 2): o pane tem pergunta pendente narrada no router? */
  hasPendingQuestion(paneId: string): boolean;
  /** Soft-stop (grace). Prefer hardStop for farewell. */
  onStop(): void;
  /** Hard teardown — closes the socket immediately (encerrar / farewell). */
  hardStop(): void;
}

export function handleCoarseVoiceToolCall(host: ToolDispatchHost, call: RealtimeToolCallEvent): void {
  const resolution = resolveCoarseVoiceTool(call.name, call.arguments as CoarseToolArgs);
  switch (resolution.kind) {
    case 'action':
      dispatchNexusAction(host, call, resolution.action);
      return;
    case 'direct':
      answerDirectToolCall(host, call, resolution);
      return;
    case 'restore':
      dispatchNexusAction(host, call, {
        action: 'restore_mission_panes',
        ...(resolution.alvo ? { alvo: resolution.alvo } : {}),
      });
      return;
    case 'end':
      answerEndToolCall(host, call);
      return;
    case 'invalid':
      rejectToolCall(host, call, resolution.reason, { error: 'invalid_action' });
      return;
  }
}

/**
 * C3 defesa (follow-up 2): paneId em send_to_pane só é legítimo quando veio do
 * roteamento de pergunta pendente (PendingQuestionRouter). Um paneId inventado
 * pelo modelo (fora do schema) seria escrita direta SEM confirmação em qualquer
 * pane — aqui ele é removido, derrubando a ação no gate de confirmação de
 * delegação do renderer.
 */
export function sanitizeNexusActionArgs(
  args: NexusRealtimeActionArgs,
  hasPendingQuestion: (paneId: string) => boolean,
): { args: NexusRealtimeActionArgs; strippedPaneId: string | null } {
  if (args.action !== 'send_to_pane' || !args.paneId || hasPendingQuestion(args.paneId)) {
    return { args, strippedPaneId: null };
  }
  const { paneId, ...rest } = args;
  return { args: rest, strippedPaneId: paneId };
}

export function dispatchNexusAction(
  host: ToolDispatchHost,
  call: RealtimeToolCallEvent,
  rawArgs: NexusRealtimeActionArgs,
): void {
  const { args, strippedPaneId } = sanitizeNexusActionArgs(rawArgs, (paneId) =>
    host.hasPendingQuestion(paneId),
  );
  if (strippedPaneId) {
    logVoice(
      'warn',
      'live.paneIdStripped',
      'send_to_pane com paneId sem pergunta pendente — rebaixado pro gate de delegação',
      { paneId: strippedPaneId },
    );
  }
  const action = realtimeArgsToJarvisAction(args);
  const argsRecord = args as Record<string, unknown>;
  const event = host.fsm.realtimeToolCall({
    source: 'realtime',
    callId: call.callId,
    name: NEXUS_REALTIME_ACTION_TOOL,
    tool: action?.type ?? 'none',
    summary: summarizeNexusRealtimeAction(args),
    args: argsRecord,
  });
  if (!event) return;
  if (action) {
    jarvisLatencyTracker.markAction(event.sessionId);
    host.armToolResultTimeout(event);
    return;
  }
  const result = host.fsm.toolResult({
    source: 'realtime',
    callId: call.callId,
    name: call.name,
    tool: event.tool,
    args: argsRecord,
    ok: false,
    summary: `ação realtime inválida: ${summarizeNexusRealtimeAction(args)}`,
    output: { error: 'invalid_action', expected: 'valid Nexus action arguments', args: argsRecord },
  });
  if (result) host.toolResult(result);
}

function answerDirectToolCall(
  host: ToolDispatchHost,
  call: RealtimeToolCallEvent,
  resolution: Extract<CoarseToolResolution, { kind: 'direct' }>,
): void {
  const summaryMap: Record<string, string> = {
    consult: 'consultar estado',
    read: 'ler pane',
    ask: 'perguntar ao pane',
  };
  const summary = summaryMap[resolution.intent] ?? 'direto';

  if (resolution.intent === 'ask') {
    dispatchNexusAction(host, call, {
      action: 'ask_pane',
      pergunta: resolution.query,
      ...(resolution.paneId ? { paneId: resolution.paneId } : {}),
    });
    return;
  }

  const event = host.fsm.realtimeToolCall({
    source: 'realtime',
    callId: call.callId,
    name: call.name,
    tool: 'none',
    summary,
    args: call.arguments,
  });
  if (!event) return;
  const context = buildDirectAnswerContext(host);
  const output =
    context ||
    (resolution.intent === 'consult'
      ? 'Sem contexto de tela disponível agora.'
      : 'Sem output de pane disponível agora.');
  const result = host.fsm.toolResult({
    source: 'realtime',
    callId: call.callId,
    name: call.name,
    tool: 'none',
    args: call.arguments,
    ok: true,
    summary,
    output,
  });
  if (result) host.toolResult(result);
}

function answerEndToolCall(host: ToolDispatchHost, call: RealtimeToolCallEvent): void {
  if (!isFarewellIntent(host.lastUserTranscript)) {
    logVoice('warn', 'encerrar.rejected', 'encerrar sem intenção de despedida — sessão mantida', {
      lastUserTranscript: host.lastUserTranscript.slice(0, 120),
    });
    rejectToolCall(host, call, 'não encerrei: sem despedida explícita, sigo na conversa', {
      error: 'no_farewell_intent',
      kept: 'session',
    });
    return;
  }
  const event = host.fsm.realtimeToolCall({
    source: 'realtime',
    callId: call.callId,
    name: call.name,
    tool: 'none',
    summary: 'encerrar sessão',
    args: call.arguments,
  });
  if (!event) return;
  const result = host.fsm.toolResult({
    source: 'realtime',
    callId: call.callId,
    name: call.name,
    tool: 'none',
    args: call.arguments,
    ok: true,
    summary: 'encerrar sessão',
    output: { ended: true },
  });
  if (result) host.toolResult(result);
  host.fsm.endTurn();
  // Farewell must hard-stop — softStop would leave a warm zombie speaking.
  host.hardStop();
}

export function rejectToolCall(
  host: ToolDispatchHost,
  call: RealtimeToolCallEvent,
  reason: string,
  output: Record<string, unknown>,
): void {
  const event = host.fsm.realtimeToolCall({
    source: 'realtime',
    callId: call.callId,
    name: call.name,
    tool: 'none',
    summary: reason,
    args: call.arguments,
  });
  if (!event) return;
  const result = host.fsm.toolResult({
    source: 'realtime',
    callId: call.callId,
    name: call.name,
    tool: 'none',
    args: call.arguments,
    ok: false,
    summary: reason,
    output,
  });
  if (result) host.toolResult(result);
}

export function buildDirectAnswerContext(host: ToolDispatchHost): string {
  const parts: string[] = [];
  if (host.latestContext) parts.push(host.latestContext);
  if (host.recentToolResults.length > 0) {
    parts.push(host.recentToolResults.join('\n'));
  }
  return parts.join('\n\n').trim().slice(0, 1_200);
}

export function handleRealtimeToolCall(host: ToolDispatchHost, call: RealtimeToolCallEvent): void {
  if (call.name === NEXUS_REALTIME_ACTION_TOOL) {
    dispatchNexusAction(host, call, call.arguments as NexusRealtimeActionArgs);
    return;
  }
  if ((COARSE_VOICE_TOOL_NAMES as readonly string[]).includes(call.name)) {
    handleCoarseVoiceToolCall(host, call);
    return;
  }
  rejectToolCall(host, call, `tool realtime não suportada: ${call.name}`, { error: 'unsupported_tool' });
}
