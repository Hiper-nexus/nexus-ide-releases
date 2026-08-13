/**
 * Live "pede Enter" state. Two hook planes can report the same pane:
 *   - semantic: Nexus `/hook/status` → awaiting-input (permission/elicitation)
 *   - orca: managed `/hook/claude` → waiting/blocked (pet balloon)
 * The inbox shows the pane while EITHER source still needs a human.
 * Last-write-wins would drop a latch when the other plane says working.
 */

export const AGENT_WAITING_SOURCES = ['orca', 'semantic'] as const;
export type AgentWaitingSource = (typeof AGENT_WAITING_SOURCES)[number];

export type AgentWaitingEntry = {
  readonly sessionId: string;
  readonly paneId: string;
  readonly agentLabel: string;
};

export type AgentWaitingUpdate = {
  readonly source: AgentWaitingSource;
  readonly sessionId: string;
  readonly paneId: string;
  readonly agentLabel: string;
  readonly state: string;
};

export type AgentWaitingSnapshot = {
  readonly sources: ReadonlyMap<string, ReadonlySet<AgentWaitingSource>>;
  readonly entries: ReadonlyMap<string, AgentWaitingEntry>;
};

export function hookStateNeedsHumanInput(state: string): boolean {
  return (
    state === 'waiting' ||
    state === 'blocked' ||
    state === 'awaiting-input'
  );
}

export function createAgentWaitingSnapshot(): AgentWaitingSnapshot {
  return { sources: new Map(), entries: new Map() };
}

export function applyAgentWaitingUpdate(
  snapshot: AgentWaitingSnapshot,
  update: AgentWaitingUpdate,
): {
  readonly next: AgentWaitingSnapshot;
  readonly entered: boolean;
  readonly left: boolean;
  readonly entry: AgentWaitingEntry | null;
} {
  const key = update.paneId;
  const needs = hookStateNeedsHumanInput(update.state);
  const prevSources = snapshot.sources.get(key);
  const had = (prevSources?.size ?? 0) > 0;
  const nextForPane = new Set(prevSources);
  if (needs) nextForPane.add(update.source);
  else nextForPane.delete(update.source);
  const nowHas = nextForPane.size > 0;

  const sources = new Map(snapshot.sources);
  const entries = new Map(snapshot.entries);
  const entry: AgentWaitingEntry = {
    sessionId: update.sessionId,
    paneId: update.paneId,
    agentLabel: update.agentLabel.trim() || 'Agente',
  };
  const previous = snapshot.entries.get(key) ?? null;

  if (nowHas) {
    sources.set(key, nextForPane);
    entries.set(key, entry);
  } else {
    sources.delete(key);
    entries.delete(key);
  }

  return {
    next: { sources, entries },
    entered: !had && nowHas,
    left: had && !nowHas,
    entry: nowHas ? entry : previous,
  };
}

export function clearAgentWaitingPane(
  snapshot: AgentWaitingSnapshot,
  paneId: string,
): {
  readonly next: AgentWaitingSnapshot;
  readonly left: boolean;
  readonly entry: AgentWaitingEntry | null;
} {
  const previous = snapshot.entries.get(paneId) ?? null;
  if (!previous && !snapshot.sources.has(paneId)) {
    return { next: snapshot, left: false, entry: null };
  }
  const sources = new Map(snapshot.sources);
  const entries = new Map(snapshot.entries);
  sources.delete(paneId);
  entries.delete(paneId);
  return { next: { sources, entries }, left: previous !== null, entry: previous };
}
