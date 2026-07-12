import type { PetEvent, PetEventKind } from '../../shared/pet-types';

/**
 * Fila de balões do pet — reducer puro (testável): um balão visível por vez,
 * fila curta (descarta o mais antigo quando estoura) e cópia por tipo de
 * evento. `agent-idle` nunca vira balão: é celebração muda do sprite.
 */

export interface Balloon {
  id: number;
  kind: PetEventKind;
  text: string;
}

export interface BalloonQueueState {
  current: Balloon | null;
  queued: Balloon[];
  nextId: number;
}

export const BALLOON_QUEUE_LIMIT = 3;
export const BALLOON_DURATION_MS = 6_000;

export const EMPTY_BALLOON_QUEUE: BalloonQueueState = {
  current: null,
  queued: [],
  nextId: 1,
};

export function balloonTextFor(event: PetEvent): string | null {
  switch (event.kind) {
    case 'mission-done':
      return `Missão concluída: ${event.title}`;
    case 'mission-failed':
      return `Missão falhou: ${event.title}`;
    case 'mission-blocked':
      return `Preciso de você: ${event.title}`;
    case 'agent-exited':
      return 'Um agente saiu — dá uma olhada no grid.';
    case 'agent-idle':
      return null;
  }
}

/** Enfileira (ou mostra direto) o balão de um evento; agent-idle passa reto. */
export function enqueueBalloon(
  state: BalloonQueueState,
  event: PetEvent,
): BalloonQueueState {
  const text = balloonTextFor(event);
  if (text === null) return state;
  const balloon: Balloon = { id: state.nextId, kind: event.kind, text };
  if (state.current === null) {
    return { current: balloon, queued: [], nextId: state.nextId + 1 };
  }
  const queued = [...state.queued, balloon].slice(-BALLOON_QUEUE_LIMIT);
  return { current: state.current, queued, nextId: state.nextId + 1 };
}

/** Expira o balão atual e promove o próximo da fila. */
export function dismissBalloon(state: BalloonQueueState): BalloonQueueState {
  const [next, ...rest] = state.queued;
  return { current: next ?? null, queued: rest, nextId: state.nextId };
}
