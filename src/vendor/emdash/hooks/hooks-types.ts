// Vendored from generalaction/emdash@c1af543 — Apache-2.0
// Source: packages/core/src/agents/plugins/capabilities/hooks-types.ts
// See src/vendor/emdash/hooks/LICENSE.md. Nexus adds an activity-only
// `clearsAwaitingInput` marker used by the main-owned injectable-idle latch,
// plus a content-free `promptSubmitted` provenance bit used to prove that a
// native UserPromptSubmit boundary really fired.

export const HOOK_EVENTS = [
  'notification',
  'stop',
  'session',
  'start',
  'tool-use',
  'tool-use-failure',
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export type HookRegistration = {
  event: string;
  command: string;
};

export type NotificationType =
  | 'permission_prompt'
  | 'idle_prompt'
  | 'auth_success'
  | 'elicitation_dialog';

/**
 * Normalised hook event produced by a plugin's parseHookEvent method.
 *
 * - kind: 'status'  — maps to an agent lifecycle event (start/stop/error/notification)
 * - kind: 'session' — carries a provider session id to persist on the conversation
 * - kind: 'ignore'  — event should be silently dropped
 */
export type CanonicalHookEvent =
  | {
      kind: 'status';
      type: 'start' | 'stop' | 'error' | 'notification';
      notificationType?: NotificationType;
      title?: string;
      message?: string;
      lastAssistantMessage?: string;
      /** Only explicit user-submit / matching interactive-tool completion may
       * release a main-owned awaiting-input latch. */
      clearsAwaitingInput?: boolean;
      /** Nexus-only provenance bit emitted exclusively for UserPromptSubmit.
       * It deliberately carries neither the prompt nor provider output. */
      promptSubmitted?: true;
    }
  | { kind: 'session'; providerSessionId: string }
  | { kind: 'ignore' };
