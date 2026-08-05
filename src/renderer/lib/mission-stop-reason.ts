/**
 * Nenhuma parada silenciosa.
 *
 * Voo real 05/08 (mission-3be48989, HiperGO): o worker submeteu um handoff
 * `blocked` com o motivo COMPLETO escrito nele, o dispatch ficou terminal, os
 * panes fecharam — e o card mostrou "Aguarda você" sobre um wizard vazio. A
 * causa estava no banco o tempo todo; o produto é que não contava. Pior caso
 * da classe de diagnóstico invisível: temos a razão e escondemos.
 *
 * Este módulo é o contrato oposto: toda missão que PAROU tendo materializado
 * runtime devolve (a) o que aconteceu e (b) o que ela precisa de você. Quando
 * não há relatório do agente, isso também é uma resposta — dita em voz alta,
 * nunca um rótulo em branco.
 *
 * Puro: recebe o que já foi lido, não consulta store nem IPC.
 */
import type { HandoffStatus, MissionStatus } from '../../shared/orch-types';

/** Um relatório longo vira parágrafo no card; o motivo precisa caber no olhar. */
const MAX_REASON_CHARS = 240;

export interface MissionStopReasonInput {
  readonly status: MissionStatus;
  /** Algum agente pode agir agora? */
  readonly hasActiveRuntime?: boolean;
  /**
   * A missão já materializou runtime alguma vez (panes/workers/worktrees)?
   *
   * Só um SINAL entre outros — nunca a única prova. O chamador costuma derivar
   * isto do layout VIVO, que zera assim que o reaper colhe os panes; um handoff
   * durável ou um plano selado provam runtime muito depois disso.
   */
  readonly hasObservedRuntime?: boolean;
  readonly latestHandoff?: {
    readonly status: HandoffStatus;
    readonly summary: string;
  } | null;
  /** Tarefas seladas no plano — prova durável de que houve trabalho a fazer. */
  readonly plannedWork?: number;
}

export interface MissionStopReason {
  /** O que aconteceu, na voz do relatório do agente quando existe. */
  readonly reason: string;
  /** O que a missão precisa de você agora. */
  readonly nextAction: string;
}

function clamp(text: string): string {
  const clean = text.trim().replace(/\s+/g, ' ');
  if (clean.length <= MAX_REASON_CHARS) return clean;
  return `${clean.slice(0, MAX_REASON_CHARS - 1).trimEnd()}…`;
}

/**
 * `null` só para missão que não parou (viva ou terminal) ou que nunca teve
 * runtime — nesses casos não há parada a explicar. Para todo o resto a
 * resposta é obrigatória.
 */
export function missionStopReason(
  input: MissionStopReasonInput,
): MissionStopReason | null {
  if (input.status === 'done' || input.status === 'failed') return null;
  if (input.hasActiveRuntime) return null;
  // Evidência DURÁVEL vence o layout vivo. O caso HiperGO parou aqui: os panes
  // já tinham sido colhidos, `hasObservedRuntime` chegava false, e a função
  // devolvia null MESMO com um handoff `blocked` trazendo o motivo inteiro —
  // a razão estava no banco e o card voltava a "Retomar · data". Um relatório
  // de agente, ou um plano com tarefas seladas, provam runtime muito depois de
  // o último pane morrer.
  const observedRuntime =
    input.hasObservedRuntime === true ||
    input.latestHandoff != null ||
    (input.plannedWork ?? 0) > 0;
  if (!observedRuntime) return null;

  const handoff = input.latestHandoff;
  const nextAction =
    'Retomar devolve os panes desta missão — o plano e o trabalho já feito continuam gravados.';

  if (handoff?.status === 'failed') {
    return {
      reason: clamp(`O agente falhou: ${handoff.summary}`),
      nextAction,
    };
  }
  if (handoff?.status === 'blocked' || handoff?.status === 'stalled') {
    return {
      reason: clamp(`O agente parou e reportou: ${handoff.summary}`),
      nextAction,
    };
  }
  // Sem relatório o silêncio é o próprio diagnóstico — e precisa ser dito.
  return {
    reason:
      'A missão parou e nenhum agente deixou relatório. O trabalho gravado continua intacto.',
    nextAction,
  };
}
