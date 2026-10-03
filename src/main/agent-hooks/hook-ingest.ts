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
import { extractAgentProviderSession } from '../../shared/agent-session-resume';
import {
  normalizeAgentStatusPayload,
  type AgentStatusState,
} from '../../shared/agent-status-types';
import { publishAgentHookActivity } from '../agent-runtime/agent-runtime-bridge';
import { getAgentSessionInfo } from '../pty/pty-manager';
import { saveProviderPaneSession } from '../persistence/provider-session-store';
import { isMimoSessionBindingCurrent, publishMimoSessionBinding, validateMimoSessionBinding } from './mimo-session-registry';
import type { MimoSessionBinding } from '../usage/mimo-scanner';

let listenerState: HookListenerState | null = null;

/**
 * Tap de status para serviços derivados do main (desktop pet): observa o
 * estado EXPLÍCITO reportado pelos hooks (working/blocked/waiting/done) sem
 * entrar no caminho de publicação. Mesmo idioma dos taps do pty-manager.
 * §12.4 continua valendo: é atividade/aviso, nunca sensor ou evidência.
 */
export type AgentHookStatusTap = (
  sessionId: string,
  state: AgentStatusState,
) => void;
const hookStatusTaps = new Set<AgentHookStatusTap>();

export function tapAgentHookStatus(cb: AgentHookStatusTap): () => void {
  hookStatusTaps.add(cb);
  return () => hookStatusTaps.delete(cb);
}

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
  options?: { pathname?: string; mimoToken?: string },
): IngestAgentHookResult | Promise<IngestAgentHookResult> {
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
  const normalized = parsed;
  const providerSession =
    parsed.providerSession ??
    (source && typeof payload === 'object' && payload !== null
      ? extractAgentProviderSession(source, payload as Record<string, unknown>)
      : null);
  const agent = getAgentSessionInfo(sessionId);
  const isMimo = source === 'mimo-code' || parsed.agentType === 'mimo-code' || agent?.adapterId === 'mimo-code';
  if (isMimo && (source !== 'mimo-code' || parsed.agentType !== 'mimo-code')) {
    return { ok: false, reason: 'unverified-mimo-session' };
  }
  if (isMimo) {
    if (providerSession?.key !== 'session_id') return { ok: false, reason: 'unverified-mimo-session' };
    return validateMimoSessionBinding(sessionId, providerSession.id, options?.mimoToken).then(binding => {
      if (!binding || !isMimoSessionBindingCurrent(binding)) return { ok: false, reason: 'unverified-mimo-session' };
      return publish(binding);
    });
  }
  return publish(null);
  function publish(mimoBinding: MimoSessionBinding | null): IngestAgentHookResult {
  const currentAgent = getAgentSessionInfo(sessionId);
  if (providerSession) {
    if (currentAgent?.paneId) {
      const saved = saveProviderPaneSession(
        currentAgent.scope,
        currentAgent.paneId,
        currentAgent.adapterId,
        providerSession,
        currentAgent.accountId,
        mimoBinding?.nativeOwnerKey,
      );
      if (mimoBinding && !saved) return { ok: false, reason: 'unverified-mimo-session' };
    }
  }
  const published = publishAgentHookActivity(normalized.state, { sessionId, agentType: normalized.agentType });
  for (const tap of hookStatusTaps) tap(sessionId, normalized.state);
  if (mimoBinding) publishMimoSessionBinding(mimoBinding);
  return {
    ok: true,
    sessionId,
    status: normalized.state,
    paneSessionState: published.paneSessionState,
    authorizesEvidence: false,
    source,
  };
  }
}

/**
 * Parse form-encoded hook body (Claude-style) then ingest status JSON field.
 */
export function ingestAgentHookFormBody(
  sessionId: string,
  formBody: string,
  pathname = '/hook/claude',
): IngestAgentHookResult | Promise<IngestAgentHookResult> {
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
