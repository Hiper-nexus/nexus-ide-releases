import type { ApiRequestInit, ApiResult } from './api-client';
import type { AppEvent } from './connectors/app-events';

/** Account-level flags only. No event payload, provider identity or project content crosses the network. */
interface ActivityDeps {
  sessionKey: () => string | null;
  snapshot: () => { agentPresent: boolean; agentWorking: boolean };
  api: (path: string, init: ApiRequestInit) => Promise<ApiResult>;
}
const FLAGS = ['agentStarted', 'agentWorking', 'missionCompleted'] as const;
type Flag = typeof FLAGS[number];
const empty = (): Record<Flag, number> => ({ agentStarted: 0, agentWorking: 0, missionCompleted: 0 });

export function createProductActivity(deps: ActivityDeps) {
  let identity: string | null = null;
  let versions = empty(), acknowledged = empty();
  let stopped = false;
  let flight: Promise<void> | null = null;
  const abort = new AbortController();
  function current(): string | null {
    const key = deps.sessionKey();
    if (key !== identity) { identity = key; versions = empty(); acknowledged = empty(); }
    return key;
  }
  function mark(flag: Flag): void {
    if (!stopped && current()) versions[flag] += 1;
  }
  return {
    agentState(state: string): void {
      if (state === 'exited') return;
      mark('agentStarted');
      if (state === 'busy') mark('agentWorking');
    },
    observe(event: Pick<AppEvent, 'kind' | 'payload'>): void {
      // `done` is the app's mission status, not a claim that a diff passed review.
      if (event.kind === 'mission.completed') mark('missionCompleted');
    },
    flush(): Promise<void> {
      if (stopped || flight) return flight ?? Promise.resolve();
      const key = current();
      if (!key) return Promise.resolve();
      try {
        const sample = deps.snapshot();
        if (sample.agentPresent) mark('agentStarted');
        if (sample.agentWorking) mark('agentWorking');
      } catch { return Promise.resolve(); }
      const sent = { ...versions };
      const body = Object.fromEntries(FLAGS.map(flag => [flag, sent[flag] > acknowledged[flag]]));
      flight = (async () => {
        try {
          const result = await deps.api('/v1/activity', {
            method: 'POST', body, redirect: 'error', timeoutMs: 5000,
            maxResponseBytes: 4096, signal: abort.signal,
          });
          if (current() !== key || stopped || result.status !== 200 || (result.json as { ok?: boolean } | null)?.ok !== true) return;
          acknowledged = sent;
        } catch { /* Measurement never blocks agents or surfaces a quota/auth error. */ }
      })().finally(() => { flight = null; });
      return flight;
    },
    async stop(): Promise<void> { stopped = true; abort.abort(); await flight; },
  };
}

/** Start after boot/login restoration; send once a minute, not once per tool or token. */
export function startProductActivity(): () => Promise<void> {
  const { apiFetch } = require('./api-client') as typeof import('./api-client');
  const auth = require('./auth-client') as typeof import('./auth-client');
  const pty = require('./pty/pty-manager') as typeof import('./pty/pty-manager');
  const acp = require('./acp/acp-harness-driver') as typeof import('./acp/acp-harness-driver');
  const { subscribeAppEvents } = require('./connectors/app-events') as typeof import('./connectors/app-events');
  const service = createProductActivity({
    api: apiFetch,
    sessionKey: () => {
      const id = auth.getAuthenticatedAccountId();
      return id ? `${id}:${auth.getAuthGeneration()}` : null;
    },
    snapshot: () => {
      const terminals = pty.listLiveSessionLocations().filter(({ sessionId }) => pty.getAgentSessionInfo(sessionId));
      const clients = acp.listAcpDriverAgentSessions();
      return {
        agentPresent: terminals.length + clients.length > 0,
        agentWorking: terminals.some(({ sessionId }) => pty.getSessionState(sessionId) === 'busy')
          || clients.some(({ sessionId }) => acp.getAcpDriverSemanticStatus(sessionId) === 'working'),
      };
    },
  });
  const stopEvents = subscribeAppEvents(service.observe);
  const stopStates = pty.tapSessionState((sessionId, state) => {
    if (pty.getAgentSessionInfo(sessionId)) service.agentState(state);
  });
  const timer = setInterval(() => { void service.flush(); }, 60_000);
  timer.unref();
  void service.flush();
  return async () => { clearInterval(timer); stopEvents(); stopStates(); await service.stop(); };
}
