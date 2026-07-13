import {
  isPetUrgentEvent,
  petOpenActionFor,
  type PetEvent,
  type PetEventKind,
  type PetOpenAction,
} from '../../shared/pet-types';

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
  /** O que o clique do balão pede à janela principal. */
  action: PetOpenAction;
  /** CTA legível no botão do balão. */
  cta: string;
  /** Tempo de exibição (ms). Intervenção fica mais tempo na tela. */
  durationMs: number;
  urgent: boolean;
}

export interface BalloonQueueState {
  current: Balloon | null;
  queued: Balloon[];
  nextId: number;
}

export const BALLOON_QUEUE_LIMIT = 3;
export const BALLOON_DURATION_MS = 6_000;
export const BALLOON_URGENT_DURATION_MS = 14_000;

export const EMPTY_BALLOON_QUEUE: BalloonQueueState = {
  current: null,
  queued: [],
  nextId: 1,
};

/** Título + detalhe do balão (formato Codex); null = evento sem balão. */
export function balloonContentFor(
  event: PetEvent,
): {
  title: string;
  text: string;
  cta: string;
} | null {
  switch (event.kind) {
    case 'mission-done':
      return {
        title: 'Missão concluída',
        text: event.title,
        cta: 'Abrir Ops Board',
      };
    case 'mission-failed':
      return {
        title: 'Missão falhou',
        text: event.title,
        cta: 'Ver no Ops Board',
      };
    case 'mission-blocked':
      return {
        title: 'Preciso de você',
        text: `${event.title} — a missão parou esperando uma decisão.`,
        cta: 'Intervir agora',
      };
    case 'agent-waiting':
      return {
        title: 'Agente pediu input',
        text: 'Permissão ou resposta pendente no terminal.',
        cta: 'Abrir e responder',
      };
    case 'agent-exited':
      return {
        title: 'Agente saiu',
        text: 'Um pane encerrou — confira o grid e o pipeline.',
        cta: 'Abrir Ops Board',
      };
    case 'agent-idle':
      return null;
  }
}

export function balloonDurationFor(kind: PetEventKind): number {
  return isPetUrgentEvent(kind)
    ? BALLOON_URGENT_DURATION_MS
    : BALLOON_DURATION_MS;
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
  const balloon: Balloon = {
    id: state.nextId,
    kind: event.kind,
    title: content.title,
    text: content.text,
    cta: content.cta,
    action: petOpenActionFor(event.kind),
    durationMs: balloonDurationFor(event.kind),
    urgent: isPetUrgentEvent(event.kind),
  };
  // Urgente sobe na frente do balão atual (intervenção > celebração).
  if (balloon.urgent && state.current && !state.current.urgent) {
    return {
      current: balloon,
      queued: [state.current, ...state.queued].slice(0, BALLOON_QUEUE_LIMIT),
      nextId: state.nextId + 1,
    };
  }
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
