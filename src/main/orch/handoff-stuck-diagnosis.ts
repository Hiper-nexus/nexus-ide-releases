/**
 * Diagnóstico de handoff preso na fila (resto F-1040 / handoff-8f388157).
 *
 * Módulo PURO: classifica POR QUE a entrega não anda e nomeia o escape
 * seguro. Não força nada — o operador decide. Categorias batem com os
 * mecanismos vivos (F-925 park, idle-delivery, outbox de handoff).
 */

export type HandoffStuckReason =
  | 'queued-awaiting-idle'
  | 'accepted-not-consumed'
  | 'parked-needs-operator'
  | 'retry-backoff'
  | 'session-dead'
  | 'waiting-acceptance-window'
  | 'waiting-paste-start'
  | 'not-stuck';

export interface HandoffStuckView {
  readonly id: string;
  /**
   * F-1232: `null` = handoff de workspace (helper do operador sem missão),
   * entregue direto no pane do pai. Ausente = desconhecido (como antes).
   */
  readonly missionId?: string | null;
  readonly deliveryState?: string;
  readonly delivered?: boolean;
  readonly consumedAt?: number | null;
  readonly submittedAt?: number | null;
  readonly createdAt?: number;
  /** Início da última tentativa real de entrega, quando houver. */
  readonly attemptedAt?: number | null;
  /** Estado da tentativa da sessão atual; reserved ainda não prova colagem. */
  readonly deliveryAttemptState?: string | null;
  /** Prazo persistido pelo transporte após a colagem/ingestão. */
  readonly acceptDeadlineAt?: number | null;
  readonly sessionId?: string | null;
  readonly sessionAlive?: boolean;
  readonly parked?: boolean;
  readonly retryRound?: number | null;
}

export interface HandoffStuckDiagnosis {
  readonly reason: HandoffStuckReason;
  readonly stuck: boolean;
  /** Linguagem para o operador/agente. */
  readonly summary: string;
  /** Chamada/ação exata do escape seguro. */
  readonly escape: string;
}

const ACCEPTANCE_WINDOW_MS = 12_000;

/** F-925: a sexta rodada sem aceite estaciona a entrega. */
export const HANDOFF_STUCK_PARK_ROUND = 6;

function queuedAnchor(view: HandoffStuckView): number | null {
  return view.submittedAt ?? view.attemptedAt ?? view.createdAt ?? null;
}

export function diagnoseHandoffStuck(
  view: HandoffStuckView,
  now: number = Date.now(),
): HandoffStuckDiagnosis {
  if (view.delivered === true && (view.deliveryState === 'consumed' || view.deliveryState === 'acknowledged')) {
    return {
      reason: 'not-stuck',
      stuck: false,
      summary: 'Entrega já consumida/aceita pelo Maestro.',
      escape: 'Nada a fazer.',
    };
  }
  // F-1232: sem missão não há Maestro nem ACK — todo caminho de consumo
  // (nexus_handoff_ack, list-ack) exige mission_id. A colagem no pane do
  // operador (`submitted`) é o estado final da entrega.
  if (view.missionId === null && view.delivered === true) {
    return {
      reason: 'not-stuck',
      stuck: false,
      summary: 'Entregue no pane do operador (helper sem missão): não há Maestro nem ACK a esperar.',
      escape: 'Nada a fazer.',
    };
  }
  if (
    view.parked === true ||
    (view.retryRound != null && view.retryRound >= HANDOFF_STUCK_PARK_ROUND)
  ) {
    return {
      reason: 'parked-needs-operator',
      stuck: true,
      summary:
        'Entrega estacionada após rodadas sem aceite (F-925). Não é fila travada: ' +
        'o Nexus parou de recolar sozinho e pede o operador.',
      escape:
        'Operador: use a listagem de handoffs e confirme a entrega (list-ack) ou reabra o ' +
        'Maestro; uma borda busy→idle real ou sessão nova também retoma.',
    };
  }
  if (view.sessionAlive === false) {
    return {
      reason: 'session-dead',
      stuck: true,
      summary: 'A sessão do Maestro que receberia a entrega não está viva.',
      escape:
        'Use nexus_mission_request_resume({missionId}) ou o botão “Retomar missão” para ' +
        'religar a coordenação; o outbox re-entrega na sessão nova.',
    };
  }
  if (view.delivered === true && view.deliveryState === 'submitted' && !view.consumedAt) {
    return {
      reason: 'accepted-not-consumed',
      stuck: true,
      summary:
        'Entrega aceita fisicamente mas ainda não consumida pelo ACK do Maestro. ' +
        'A topologia selada assenta no ACK explícito.',
      escape:
        'O Maestro deve chamar nexus_handoff_ack({handoffId, verdict:"accepted"}) — ' +
        'ou list-ack do operador se o Maestro não puder.',
    };
  }
  if (view.retryRound != null && view.retryRound > 0) {
    return {
      reason: 'retry-backoff',
      stuck: true,
      summary:
        `Em backoff de retentativa (rodada ${view.retryRound}; escada até 15 min, F-925).`,
      escape: 'A borda busy→idle real dispara a rodada; nada de forçar recolagem em loop.',
    };
  }
  if (view.deliveryState === 'queued') {
    // F-1046: handoff real que nunca foi enviado tem só `createdAt` —
    // queuedAnchor cobre submittedAt ?? attemptedAt ?? createdAt.
    if (view.deliveryAttemptState === 'reserved') {
      return {
        reason: 'waiting-paste-start', stuck: false,
        summary: 'Tentativa reservada; a colagem ainda não abriu a janela de aceite.',
        escape: 'Aguarde o transporte atual; não force uma segunda colagem.',
      };
    }
    const deadline = view.deliveryAttemptState === 'pasted' &&
      view.acceptDeadlineAt != null && Number.isFinite(view.acceptDeadlineAt)
      ? view.acceptDeadlineAt : null;
    const anchor = queuedAnchor(view);
    if (anchor == null && deadline == null) {
      return {
        reason: 'not-stuck',
        stuck: false,
        summary: 'Sem sinal de travamento no estado atual.',
        escape: 'Nada a fazer.',
      };
    }
    const waitingMs = anchor == null ? Infinity : now - anchor;
    if (deadline != null ? now <= deadline : waitingMs < ACCEPTANCE_WINDOW_MS) {
      return {
        reason: 'waiting-acceptance-window',
        stuck: false,
        summary:
          deadline != null
            ? `Dentro do prazo de aceite persistido (${Math.max(0, deadline - now)}ms restantes).`
            : `Dentro da janela de aceite (${ACCEPTANCE_WINDOW_MS}ms) — ainda não é preso.`,
        escape: 'Aguarde a borda ociosa do Maestro.',
      };
    }
    return {
      reason: 'queued-awaiting-idle',
      stuck: true,
      summary:
        'Handoff enfileirado esperando a borda ociosa do Maestro. Entregas em rajada ' +
        'saem juntas (MAX_DELIVERY_BATCH); uma espera represada não segura a fila inteira.',
      escape:
        'A borda busy→idle do Maestro dispara a entrega. Se a sessão estiver muda, ' +
        'nexus_mission_request_resume religa; o operador também pode list-ack.',
    };
  }
  return {
    reason: 'not-stuck',
    stuck: false,
    summary: 'Sem sinal de travamento no estado atual.',
    escape: 'Nada a fazer.',
  };
}
