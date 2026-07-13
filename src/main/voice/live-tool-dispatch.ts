/**
 * Extracted tool dispatch logic for the LiveTransportController.
 * Handles coarse voice tool resolution, direct-answer, encerrar, and reject
 * paths so the controller stays under the 800-line cap.
 */
import { logVoice } from './voice-log';
import { buildToolset } from '../orch/tools';
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
import { isLocalToolCallId } from './live-transport-helpers';
import type { RealtimeToolCallEvent, TurnManagedRealtimeProvider } from '../jarvis/realtime/provider';
import type { JarvisLiveSession } from './jarvis-live';
import type { JarvisLiveToolEvent, JarvisLiveToolResultEvent } from '../../shared/voice-ipc';

const NEXUS_MCP_TOOL_NAMES = new Set(buildToolset().map((tool) => tool.name));

function normalizedIntent(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Destructive-ish navigation must be grounded in explicit user language. */
export function isExplicitNewWorkspaceIntent(text: string): boolean {
  const normalized = normalizedIntent(text);
  const creation = /\b(nov[oa]|cria(?:r|e)?|create|new|nuevo|crear|iniciar)\b/.test(normalized);
  const target = /\b(workspace|projeto|project|ambiente|environment|espacio de trabajo)\b/.test(normalized);
  return creation && target;
}

/**
 * Work requested in imperative form must reach an agent pane. Gemini may first
 * inspect a pane (or narrate "vou analisar") and then finish the turn without
 * delegating. This narrow classifier lets the controller recover that missing
 * effect deterministically; questions and conversational mentions stay with
 * the model.
 */
export function isExplicitEngineeringWorkIntent(text: string): boolean {
  const normalized = normalizedIntent(text);
  if (!normalized || normalized.split(' ').length < 2) return false;
  if (/^(como|porque|por que|qual|quais|quando|onde|sera|seria|what|why|how)\b/.test(normalized)) {
    return false;
  }
  const work = /\b(corrij(?:a|am|ir)|consert(?:e|ar)|resolv(?:a|am|er)|investigu(?:e|em|ar)|analis(?:e|em|ar)|implement(?:e|em|ar)|refator(?:e|em|ar)|ajust(?:e|em|ar)|apliqu(?:e|em|ar)|cri(?:e|ar|em)|fac(?:a|am)|fix|debug|repair|investigate|analy[sz]e|implement|refactor|apply|create)\b/;
  const match = work.exec(normalized);
  if (!match || match.index === undefined) return false;
  const before = normalized.slice(0, match.index).trim().split(' ').filter(Boolean);
  const nearby = before.slice(-3).join(' ');
  if (/\b(nao|nunca|jamais|dont|do not|never)\b/.test(nearby)) return false;
  if (/\b(disse|falou|comentou|escreveu|said|told|wrote|quoted)\b/.test(before.join(' '))) return false;
  return true;
}

export interface ToolDispatchHost {
  readonly provider: TurnManagedRealtimeProvider | null;
  readonly fsm: JarvisLiveSession;
  readonly currentTurnId?: string;
  readonly lastUserTranscript: string;
  latestContext: string;
  recentToolResults: string[];
  toolResult(event: JarvisLiveToolResultEvent): void;
  armToolResultTimeout(event: JarvisLiveToolEvent): void;
  /** C3 defesa (follow-up 2): o pane tem pergunta pendente narrada no router? */
  hasPendingQuestion(paneId: string): boolean;
  /** Records that this turn actually attempted the required delegation. */
  markDelegationAttempt?(): void;
  /** Soft-stop (grace). Prefer hardStop for farewell. */
  onStop(): void;
  /** Hard teardown — closes the socket immediately (encerrar / farewell). */
  hardStop(): void;
}

/**
 * A provider tool call must always receive an output. The session FSM can
 * refuse an event during teardown or ownership handover; replying directly in
 * that narrow case prevents the realtime model from waiting forever.
 */
export function answerProviderWithoutSession(
  host: ToolDispatchHost,
  call: RealtimeToolCallEvent,
  payload: { ok: boolean; tool: string; summary: string; output: unknown },
): void {
  logVoice(
    'warn',
    'live.toolResultFsmDropped',
    'FSM sem sessão — resultado enviado direto ao provider',
    { callId: call.callId, name: call.name, tool: payload.tool },
  );
  if (!call.callId || isLocalToolCallId(call.callId) || !host.provider?.isReady) return;
  host.provider.sendToolResult(call.callId, payload);
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
  if (
    args.action === 'new_workspace' &&
    !isExplicitNewWorkspaceIntent(host.lastUserTranscript)
  ) {
    logVoice(
      'warn',
      'live.newWorkspaceRejected',
      'new_workspace sem intenção explícita no transcript — ação bloqueada',
      { lastUserTranscript: host.lastUserTranscript.slice(0, 120) },
    );
    rejectToolCall(host, call, 'não abri workspace: pedido explícito ausente', {
      error: 'no_explicit_new_workspace_intent',
    });
    return;
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
  if (!event) {
    answerProviderWithoutSession(host, call, {
      ok: false,
      tool: action?.type ?? 'none',
      summary: 'sessão de voz indisponível',
      output: { error: 'session_unavailable' },
    });
    return;
  }
  if (action) {
    if (args.action === 'send_to_pane') host.markDelegationAttempt?.();
    if (host.currentTurnId) {
      jarvisLatencyTracker.markAction(event.sessionId, host.currentTurnId);
    } else {
      jarvisLatencyTracker.markAction(event.sessionId);
    }
    host.armToolResultTimeout(event);
    return;
  }
  const invalidSummary = `ação realtime inválida: ${summarizeNexusRealtimeAction(args)}`;
  const invalidOutput = {
    error: 'invalid_action',
    expected: 'valid Nexus action arguments',
    args: argsRecord,
  };
  const result = host.fsm.toolResult({
    source: 'realtime',
    callId: call.callId,
    name: call.name,
    tool: event.tool,
    args: argsRecord,
    ok: false,
    summary: invalidSummary,
    output: invalidOutput,
  });
  if (result) host.toolResult(result);
  else answerProviderWithoutSession(host, call, {
    ok: false,
    tool: event.tool,
    summary: invalidSummary,
    output: invalidOutput,
  });
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
  const context = buildDirectAnswerContext(host);
  const output =
    context ||
    (resolution.intent === 'consult'
      ? 'Sem contexto de tela disponível agora.'
      : 'Sem output de pane disponível agora.');
  if (!event) {
    answerProviderWithoutSession(host, call, {
      ok: false,
      tool: 'none',
      summary: 'sessão de voz indisponível',
      output: { error: 'session_unavailable' },
    });
    return;
  }
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
  else answerProviderWithoutSession(host, call, { ok: true, tool: 'none', summary, output });
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
  if (!event) {
    answerProviderWithoutSession(host, call, {
      ok: true,
      tool: 'none',
      summary: 'encerrar sessão',
      output: { ended: true },
    });
    host.hardStop();
    return;
  }
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
  if (!event) {
    answerProviderWithoutSession(host, call, { ok: false, tool: 'none', summary: reason, output });
    return;
  }
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
  else answerProviderWithoutSession(host, call, { ok: false, tool: 'none', summary: reason, output });
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
  if (NEXUS_MCP_TOOL_NAMES.has(call.name)) {
    dispatchNexusAction(host, call, {
      action: 'mcp_tool',
      tool: call.name,
      args: call.arguments,
    });
    return;
  }
  rejectToolCall(host, call, `tool realtime não suportada: ${call.name}`, { error: 'unsupported_tool' });
}
