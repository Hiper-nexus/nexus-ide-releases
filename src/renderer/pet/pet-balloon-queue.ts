import type { PetEvent, PetEventKind } from '../../shared/pet-types';

/**
 * Fila de balões do pet — reducer puro (testável): um balão visível por vez,
 * fila curta (descarta o mais antigo quando estoura) e cópia por tipo de
 * evento. `agent-idle` nunca vira balão: é celebração muda do sprite.
 */

export interface Balloon {
  id: number;
  kind: PetEventKind;
  /** Título curto e forte (ex.: "Missão concluída"). */
  title: string;
  /** Detalhe: nome da missão / dica de ação. */
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

/** Título + detalhe do balão (formato Codex); null = evento sem balão. */
export function balloonContentFor(
  event: PetEvent,
): { title: string; text: string } | null {
  switch (event.kind) {
    case 'mission-done':
      return { title: 'Missão concluída', text: event.title };
    case 'mission-failed':
      return { title: 'Missão falhou', text: event.title };
    case 'mission-blocked':
      return { title: 'Preciso de você', text: event.title };
    case 'agent-waiting':
      return {
        title: 'Agente pediu input',
        text: 'Permissão ou resposta pendente — clique para abrir.',
      };
    case 'agent-exited':
      return {
        title: 'Agente saiu',
        text: 'Um pane encerrou — dá uma olhada no grid.',
      };
    case 'agent-idle':
      return null;
  }
}

/** Compat: texto único (título: detalhe) para quem só precisa da string. */
export function balloonTextFor(event: PetEvent): string | null {
  const content = balloonContentFor(event);
  return content ? `${content.title}: ${content.text}` : null;
}

/** Enfileira (ou mostra direto) o balão de um evento; agent-idle passa reto. */
export function enqueueBalloon(
  state: BalloonQueueState,
  event: PetEvent,
): BalloonQueueState {
  const content = balloonContentFor(event);
  if (content === null) return state;
  const balloon: Balloon = { id: state.nextId, kind: event.kind, ...content };
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
