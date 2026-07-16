/**
 * Agent notification feed (BridgeMind-style): completed / needs-input events
 * for CLI agent panes. Pure domain — no React, no I/O.
 *
 * PTY idle is noisy: "completed" only fires after a sustained busy period.
 * True "needs_input" requires agent-status hooks (not inferred from hibernate).
 */

export const AGENT_NOTIFICATION_KINDS = [
  'completed',
  'needs_input',
  'exited',
] as const;

export type AgentNotificationKind = (typeof AGENT_NOTIFICATION_KINDS)[number];

export interface AgentNotification {
  readonly id: string;
  readonly paneId: string;
  readonly agentLabel: string;
  readonly kind: AgentNotificationKind;
  readonly createdAt: number;
  readonly read: boolean;
}

export type PaneRuntimeHint =
  | 'spawning'
  | 'busy'
  | 'idle'
  | 'exited'
  | 'hibernated'
  | 'unknown';

/** Minimum continuous busy/spawning time before idle counts as completed. */
export const MIN_BUSY_MS_FOR_COMPLETED = 1_500;

export interface TransitionEvalInput {
  readonly prev: PaneRuntimeHint | undefined;
  readonly next: PaneRuntimeHint;
  /** Wall-clock when busy/spawning started (if still in a busy epoch). */
  readonly busyStartedAt: number | undefined;
  readonly now: number;
  readonly minBusyMs?: number;
}

export interface TransitionEvalResult {
  readonly kind: AgentNotificationKind | null;
  /** Updated busy epoch start for this pane (undefined = not busy). */
  readonly busyStartedAt: number | undefined;
}

/**
 * Evaluate one pane runtime transition. Tracks busy epoch so short
 * busy→idle blips (tool ticks, false idle) do not spam COMPLETED.
 */
export function evaluatePaneTransition(
  input: TransitionEvalInput,
): TransitionEvalResult {
  const minBusy = input.minBusyMs ?? MIN_BUSY_MS_FOR_COMPLETED;
  const { prev, next, now } = input;

  if (next === 'busy' || next === 'spawning') {
    return {
      kind: null,
      busyStartedAt: input.busyStartedAt ?? now,
    };
  }

  if (next === 'exited' && prev !== 'exited') {
    return { kind: 'exited', busyStartedAt: undefined };
  }

  if (next === 'idle' && (prev === 'busy' || prev === 'spawning')) {
    const started = input.busyStartedAt;
    const sustained =
      typeof started === 'number' && now - started >= minBusy;
    return {
      kind: sustained ? 'completed' : null,
      busyStartedAt: undefined,
    };
  }

  // hibernated / unknown / idle from idle — clear busy epoch, no notify
  if (next === 'hibernated' || next === 'unknown' || next === 'idle') {
    return { kind: null, busyStartedAt: undefined };
  }

  return { kind: null, busyStartedAt: input.busyStartedAt };
}

/** @deprecated Prefer evaluatePaneTransition (busy-duration aware). */
export function notificationKindFromTransition(
  prev: PaneRuntimeHint | undefined,
  next: PaneRuntimeHint,
  opts?: { busyStartedAt?: number; now?: number; minBusyMs?: number },
): AgentNotificationKind | null {
  return evaluatePaneTransition({
    prev,
    next,
    busyStartedAt: opts?.busyStartedAt,
    now: opts?.now ?? Date.now(),
    minBusyMs: opts?.minBusyMs,
  }).kind;
}

export function agentNotificationStatusLabel(kind: AgentNotificationKind): string {
  if (kind === 'completed') return 'CONCLUÍDO';
  if (kind === 'needs_input') return 'PRECISA DE INPUT';
  return 'ENCERRADO';
}

export function formatNotificationAgo(now: number, createdAt: number): string {
  const delta = Math.max(0, now - createdAt);
  if (delta < 60_000) return 'agora';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} min`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} h`;
  return `${Math.floor(delta / 86_400_000)} d`;
}

export function countUnread(items: readonly AgentNotification[]): number {
  return items.reduce((n, item) => n + (item.read ? 0 : 1), 0);
}

export const AGENT_NOTIFICATION_MAX = 40;

export function pushAgentNotification(
  items: readonly AgentNotification[],
  next: Omit<AgentNotification, 'id' | 'read'> & { id?: string; read?: boolean },
): AgentNotification[] {
  const entry: AgentNotification = {
    id: next.id ?? `an-${next.paneId}-${next.createdAt}-${next.kind}`,
    paneId: next.paneId,
    agentLabel: next.agentLabel.slice(0, 64),
    kind: next.kind,
    createdAt: next.createdAt,
    read: next.read ?? false,
  };
  // Dedupe: same pane+kind within 2s → keep newest only.
  const filtered = items.filter(
    (item) =>
      !(
        item.paneId === entry.paneId &&
        item.kind === entry.kind &&
        Math.abs(item.createdAt - entry.createdAt) < 2_000
      ),
  );
  return [entry, ...filtered].slice(0, AGENT_NOTIFICATION_MAX);
}
