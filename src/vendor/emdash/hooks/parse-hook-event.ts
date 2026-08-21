// Vendored from generalaction/emdash@c1af543 — Apache-2.0
// Source: packages/core/src/agents/plugins/helpers/parse-hook-event.ts
// See src/vendor/emdash/hooks/LICENSE.md. Nexus changes: attribution header,
// local hooks-types import, and a main-owned interactive-question/explicit-
// clear event mapping. The waiting-intent addition also adapts the pattern in
// Adapted from stablyai/orca @ 0121f571e4c9929f4d299f1a339d6e72c5d58c8b
// (secondary MIT waiting-intent pattern); see the Orca ledger.

import type { CanonicalHookEvent, NotificationType } from './hooks-types';

const NOTIFICATION_TYPES = new Set<string>([
  'permission_prompt',
  'idle_prompt',
  'auth_success',
  'elicitation_dialog',
]);

function asNotificationType(value: unknown): NotificationType | undefined {
  return typeof value === 'string' && NOTIFICATION_TYPES.has(value)
    ? (value as NotificationType)
    : undefined;
}

export function isInteractiveQuestionTool(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return [
    'askuserquestion',
    'exitplanmode',
    'requestuserinput',
  ].includes(normalized);
}

/**
 * F-104 (21/08): a frase "waiting for your input" é o aviso de IDLE do CLI
 * (disparado ~60s após o fim do turno), não um diálogo interativo. Promovê-la
 * a elicitation_dialog lacrava o pane em awaiting-input para sempre em
 * missões — onde ninguém digita o próximo turno. Elicitação REAL chega por
 * tool interativa (AskUserQuestion/request_user_input via PreToolUse,
 * isInteractiveQuestionTool) ou por frases que nomeiam pergunta/aprovação.
 */
export function looksLikeAwaitingInput(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return /\b(?:asks?|needs?)\s+(?:the\s+)?user\b|\buser\s+(?:question|approval|permission)\b|\b(?:awaiting|awaits?)\s+(?:user\s+)?(?:question|answer|response|decision)\b/i.test(
    value,
  );
}

function hookToolName(body: Record<string, unknown>): unknown {
  const nested = body.tool;
  return body.tool_name ?? body.toolName ?? body.name ??
    (nested && typeof nested === 'object'
      ? (nested as Record<string, unknown>).name
      : undefined);
}

/** Extract the first non-empty string from a list of candidates. */
export function extractProviderSessionId(body: Record<string, unknown>): string | undefined {
  const candidates = [
    body.session_id,
    body.provider_session_id,
    body.providerSessionId,
    body.sessionId,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

/**
 * Generic hook event parser used as the fallback for providers that do not
 * supply a custom parseHookEvent. Implements the superset of mappings that
 * were previously hard-coded in the desktop's normalizePayload / session-hook
 * handlers.
 *
 * Event-type routing:
 *  'session' | 'session-start' → kind: 'session' (if a session id is present)
 *  'start' | 'stop' | 'error'  → kind: 'status' with the matching type
 *  'notification'               → kind: 'status', type: 'notification', reads
 *                                 notification_type / notificationType from body
 *  everything else              → kind: 'ignore'
 */
export function defaultHookEventParser(
  eventType: string,
  body: Record<string, unknown>
): CanonicalHookEvent {
  if (eventType === 'user-submit') {
    return {
      kind: 'status',
      type: 'start',
      clearsAwaitingInput: true,
      promptSubmitted: true,
    };
  }

  if (
    eventType === 'tool-use' ||
    eventType === 'tool-complete' ||
    eventType === 'tool-use-failure'
  ) {
    const interactive = isInteractiveQuestionTool(hookToolName(body));
    if (eventType === 'tool-use' && interactive) {
      return {
        kind: 'status',
        type: 'notification',
        notificationType: 'elicitation_dialog',
        message: String(hookToolName(body)),
      };
    }
    return {
      kind: 'status',
      type: 'start',
      // A non-interactive tool running in parallel must never clear an
      // outstanding AskUserQuestion/request_user_input latch.
      clearsAwaitingInput: eventType !== 'tool-use' && interactive,
    };
  }

  if (eventType === 'session' || eventType === 'session-start') {
    const providerSessionId = extractProviderSessionId(body);
    if (providerSessionId) return { kind: 'session', providerSessionId };
    return { kind: 'ignore' };
  }

  if (eventType === 'start' || eventType === 'stop' || eventType === 'error') {
    const rawLam = body.last_assistant_message ?? body.lastAssistantMessage;
    return {
      kind: 'status',
      type: eventType,
      lastAssistantMessage: typeof rawLam === 'string' ? rawLam : undefined,
      title: typeof body.title === 'string' ? body.title : undefined,
      message: typeof body.message === 'string' ? body.message : undefined,
    };
  }

  if (eventType === 'notification') {
    const message = typeof body.message === 'string' ? body.message : undefined;
    const title = typeof body.title === 'string' ? body.title : undefined;
    const rawType = asNotificationType(
      body.notification_type ?? body.notificationType,
    );
    const notificationType =
      looksLikeAwaitingInput(message) || looksLikeAwaitingInput(title)
        ? 'elicitation_dialog'
        : rawType;
    return {
      kind: 'status',
      type: 'notification',
      notificationType,
      lastAssistantMessage:
        typeof (body.last_assistant_message ?? body.lastAssistantMessage) === 'string'
          ? String(body.last_assistant_message ?? body.lastAssistantMessage)
          : undefined,
      title,
      message,
    };
  }

  return { kind: 'ignore' };
}
