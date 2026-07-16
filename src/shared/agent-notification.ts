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

/** Minimum continuous busy time before idle counts as completed. */
export const MIN_BUSY_MS_FOR_COMPLETED = 1_500;

/**
 * Época de atividade de um pane. `fromIdle` marca a origem: só uma época
 * nascida da aresta idle→busy (turno real do usuário) pode virar COMPLETED.
 * Boot/respawn (spawning→busy) dura mais que o mínimo em praticamente todo
 * spawn de CLI — sem a origem, reabrir um workspace com N panes dispararia
 * N "CONCLUÍDO" falsos.
 */
export interface BusyEpoch {
  readonly startedAt: number;
  readonly fromIdle: boolean;
}

export interface TransitionEvalInput {
  readonly prev: PaneRuntimeHint | undefined;
  readonly next: PaneRuntimeHint;
  /** Época corrente do pane (undefined = fora de atividade). */
  readonly busyEpoch: BusyEpoch | undefined;
  readonly now: number;
  readonly minBusyMs?: number;
}

export interface TransitionEvalResult {
  readonly kind: AgentNotificationKind | null;
  /** Época atualizada para este pane (undefined = não ocupado). */
  readonly busyEpoch: BusyEpoch | undefined;
}

/**
 * Evaluate one pane runtime transition. Tracks busy epoch so short
 * busy→idle blips (tool ticks, false idle) do not spam COMPLETED, and so
 * boot noise (spawning→busy) never counts as a finished turn.
 */
export function evaluatePaneTransition(
  input: TransitionEvalInput,
): TransitionEvalResult {
  const minBusy = input.minBusyMs ?? MIN_BUSY_MS_FOR_COMPLETED;
  const { prev, next, now } = input;

  // Boot/respawn: nunca abre época elegível — o output de inicialização
  // não é um turno concluído.
  if (next === 'spawning') {
    return { kind: null, busyEpoch: undefined };
  }

  if (next === 'busy') {
    return {
      kind: null,
      busyEpoch: input.busyEpoch ?? { startedAt: now, fromIdle: prev === 'idle' },
    };
  }

  if (next === 'exited' && prev !== 'exited') {
    return { kind: 'exited', busyEpoch: undefined };
  }

  if (next === 'idle' && prev === 'busy') {
    const epoch = input.busyEpoch;
    const sustained =
      epoch !== undefined &&
      epoch.fromIdle &&
      now - epoch.startedAt >= minBusy;
    return {
      kind: sustained ? 'completed' : null,
      busyEpoch: undefined,
    };
  }

  // hibernated / unknown / idle from idle — clear busy epoch, no notify
  if (next === 'hibernated' || next === 'unknown' || next === 'idle') {
    return { kind: null, busyEpoch: undefined };
  }

  return { kind: null, busyEpoch: input.busyEpoch };
}

/** @deprecated Prefer evaluatePaneTransition (busy-epoch aware). */
export function notificationKindFromTransition(
  prev: PaneRuntimeHint | undefined,
  next: PaneRuntimeHint,
  opts?: { busyEpoch?: BusyEpoch; now?: number; minBusyMs?: number },
): AgentNotificationKind | null {
  return evaluatePaneTransition({
    prev,
    next,
    busyEpoch: opts?.busyEpoch,
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
