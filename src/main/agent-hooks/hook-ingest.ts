/**
 * Production agent-hook ingest path.
 * Uses shared agent-hook-listener helpers + agent-status-types, then publishes
 * activity-only pane state via agent-runtime-bridge (§12.4).
 */

import {
  createHookListenerState,
  parseFormEncodedBody,
  resolveHookSource,
  type HookListenerState,
} from '../../shared/agent-hook-listener';
import {
  normalizeAgentStatusPayload,
  type AgentStatusState,
} from '../../shared/agent-status-types';
import { publishAgentHookActivity } from '../agent-runtime/agent-runtime-bridge';

let listenerState: HookListenerState | null = null;

/** Ensure listener module is live (state reserved for full HTTP ingest later). */
export function getAgentHookListenerState(): HookListenerState {
  if (!listenerState) listenerState = createHookListenerState();
  return listenerState;
}

export type IngestAgentHookResult =
  | {
      ok: true;
      sessionId: string;
      status: AgentStatusState;
      paneSessionState: string;
      authorizesEvidence: false;
      source: string | null;
    }
  | { ok: false; reason: string };

/**
 * Ingest a structured agent status payload for a known PTY session.
 */
export function ingestAgentHookStatus(
  sessionId: string,
  payload: unknown,
  options?: { pathname?: string },
): IngestAgentHookResult {
  if (!sessionId || sessionId.length > 200) {
    return { ok: false, reason: 'invalid-session-id' };
  }
  // Touch listener state so production always owns the shared listener module.
  getAgentHookListenerState();
  const source = options?.pathname
    ? resolveHookSource(options.pathname)
    : null;
  const parsed = normalizeAgentStatusPayload(payload);
  if (!parsed) {
    return { ok: false, reason: 'invalid-status-payload' };
  }
  const published = publishAgentHookActivity(parsed.state, {
    sessionId,
    agentType: parsed.agentType,
  });
  return {
    ok: true,
    sessionId,
    status: parsed.state,
    paneSessionState: published.paneSessionState,
    authorizesEvidence: false,
    source,
  };
}

/**
 * Parse form-encoded hook body (Claude-style) then ingest status JSON field.
 */
export function ingestAgentHookFormBody(
  sessionId: string,
  formBody: string,
  pathname = '/hook/claude',
): IngestAgentHookResult {
  getAgentHookListenerState();
  const fields = parseFormEncodedBody(formBody);
  let payload: unknown = fields;
  if (typeof fields.payload === 'string' && fields.payload.length > 0) {
    try {
      payload = JSON.parse(fields.payload);
    } catch {
      payload = fields;
    }
  } else if (typeof fields.state === 'string') {
    payload = {
      state: fields.state,
      prompt: fields.prompt,
      agentType: fields.agentType,
    };
  }
  return ingestAgentHookStatus(sessionId, payload, { pathname });
}

export function __resetHookIngestForTests(): void {
  listenerState = null;
}
