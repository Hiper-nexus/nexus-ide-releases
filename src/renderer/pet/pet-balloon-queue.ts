import {
  isPetUrgentEvent,
  petOpenActionFor,
  type PetEvent,
  type PetEventCause,
  type PetEventKind,
  type PetOpenAction,
} from '../../shared/pet-types';
import { missionBlockCauseText } from '../../shared/mission-block-cause';

/** Teto do balão: o porquê pode ser cortado, o acionável nunca. */
const BALLOON_CAUSE_LIMIT = 150;

function causeText(cause: PetEventCause | undefined): string | null {
  if (!cause) return null;
  return missionBlockCauseText(
    { ...cause, detail: null },
    BALLOON_CAUSE_LIMIT,
  );
}

/**
 * Fila de balões do pet — reducer puro (testável): um balão visível por vez,
 * fila curta (descarta o mais antigo quando estoura) e cópia por tipo de
 * evento. `agent-idle` nunca vira balão: é celebração muda do sprite.
 */

export interface Balloon {
  id: number;
  kind: PetEventKind;
  /** Título curto e forte (ex.: "Missão pronta"). */
  title: string;
  /** Detalhe: nome da missão / dica de ação. */
  text: string;
  /** O que o clique do balão pede à janela principal. */
  action: PetOpenAction;
  /** CTA legível no botão do balão. */
  cta: string;
  urgent: boolean;
}

export interface BalloonQueueState {
  current: Balloon | null;
  queued: Balloon[];
  nextId: number;
}

export const BALLOON_QUEUE_LIMIT = 3;

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
        title: 'Missão pronta',
        text: event.title,
        cta: 'Abrir o painel',
      };
    case 'mission-failed':
      return {
        title: 'Missão falhou',
        text: event.title,
        cta: 'Ver no painel',
      };
    case 'mission-technical-failure': {
      const why =
        causeText(event.cause) ??
        'A recuperação automática parou. Abra o diagnóstico para tentar novamente.';
      return {
        title: 'Falha técnica',
        text: event.title.trim() ? `${event.title.trim()} — ${why}` : why,
        cta: 'Ver diagnóstico',
      };
    }
    case 'mission-blocked': {
      // O PORQUÊ vem no evento. Sem ele o balão dizia "parou esperando uma
      // decisão", que não deixa o operador entender, resolver nem ajustar.
      const why =
        causeText(event.cause) ??
        'Motivo não registrado. Abra a missão e veja a aba Atividade.';
      return {
        title: 'Preciso de você',
        // Texto completo; a UI do balão faz wrap (sem line-clamp).
        text: event.title.trim() ? `${event.title.trim()} — ${why}` : why,
        cta: 'Intervir agora',
      };
    }
    case 'agent-waiting':
      return {
        title: 'Agente pediu input',
        text: event.title.trim()
          ? `${event.title.trim()} — permissão ou resposta pendente no terminal.`
          : 'Permissão ou resposta pendente no terminal.',
        cta: 'Abrir e responder',
      };
    case 'agent-exited':
      return {
        title: 'Agente saiu',
        text: event.title.trim()
          ? `${event.title.trim()} encerrou — confira o grid e o pipeline.`
          : 'Um pane encerrou — confira o grid e o pipeline.',
        cta: 'Abrir o painel',
      };
    case 'agent-idle':
      return null;
    case 'goal-wave-started':
      return {
        title: '🎯 Meta /goal',
        text: event.title,
        cta: 'Ver terminais',
      };
    case 'goal-wave-completed':
      return {
        title: '✨ Onda concluída',
        text: event.title,
        cta: 'Ver progresso',
      };
    case 'goal-gate-passed':
      return {
        title: '✅ Gate aprovado',
        text: event.title,
        cta: 'Avançando meta',
      };
    case 'goal-finished':
      return {
        title: '🏆 Meta 100% concluída',
        text: event.title,
        cta: 'Ver resultado',
      };
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
  const balloon: Balloon = {
    id: state.nextId,
    kind: event.kind,
    title: content.title,
    text: content.text,
    cta: content.cta,
    action: petOpenActionFor(event.kind),
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
