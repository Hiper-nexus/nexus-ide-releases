import type {
  MissionLifecycleState,
  MissionSummarySnapshot,
} from './mission-engine-contract';
import { isIsolationStopReasonCode } from './session-restore-liveness';

/**
 * Lanes do quadro de missões — padrão do Agent Orchestrator
 * (`contract/kanban.go`) no idioma do Nexus.
 *
 * A lane é uma LEITURA do `MissionSummarySnapshot` (`state`, `stateReason`,
 * `needsAttention`) mais o aceite humano. Nunca é persistida e, por isso,
 * nunca se arrasta: mover o card não muda o estado, e o estado é do motor.
 */
export type MissionKanbanLane =
  | 'building'
  | 'validating'
  | 'needs_you'
  | 'ready'
  | 'archive';

export interface MissionKanbanLaneSpec {
  readonly id: MissionKanbanLane;
  /** Sentence case, PT-BR (DESIGN.md §3). */
  readonly label: string;
  /** Colunas vivas ficam lado a lado; o arquivo é gaveta recolhida no rodapé. */
  readonly placement: 'column' | 'drawer';
}

export const MISSION_KANBAN_LANE_LABELS: Readonly<
  Record<MissionKanbanLane, string>
> = {
  building: 'Construindo',
  validating: 'Validando',
  needs_you: 'Precisa de você',
  ready: 'Pronto',
  archive: 'Arquivo',
};

/** Ordem de leitura do quadro: da esquerda para a direita, arquivo por último. */
export const MISSION_KANBAN_LANES: readonly MissionKanbanLaneSpec[] =
  Object.freeze([
    { id: 'building', label: MISSION_KANBAN_LANE_LABELS.building, placement: 'column' },
    { id: 'validating', label: MISSION_KANBAN_LANE_LABELS.validating, placement: 'column' },
    { id: 'needs_you', label: MISSION_KANBAN_LANE_LABELS.needs_you, placement: 'column' },
    { id: 'ready', label: MISSION_KANBAN_LANE_LABELS.ready, placement: 'column' },
    { id: 'archive', label: MISSION_KANBAN_LANE_LABELS.archive, placement: 'drawer' },
  ] satisfies MissionKanbanLaneSpec[]);

export interface MissionKanbanLaneInput {
  /**
   * Motor concluiu e o aceite de quem pediu ainda não veio
   * (`missionAwaitsOperatorReview` em mission-recovery-policy). Só importa
   * para `completed`; nos outros estados é ignorado.
   */
  readonly awaitsOperatorReview: boolean;
  /**
   * O operador tirou a missão do fluxo (histórico intacto). Nunca esconde
   * trabalho vivo nem pedido aberto — mesma regra da rail.
   */
  readonly archivedByOperator?: boolean;
}

export type MissionKanbanSummary = Pick<
  MissionSummarySnapshot,
  'state' | 'stateReason' | 'needsAttention'
>;

/**
 * Precedência, de cima para baixo:
 * 1. Terminal durável é autoridade (mesma régua do main): `failed` é arquivo;
 *    `completed` só é "Pronto" com o aceite humano — antes disso é "Validando".
 * 2. Parou/Dormindo (Encerrar, leftover-park, session-dead): sem processo e
 *    sem pergunta. A doutrina da rail diz que isso não é pedido humano; aqui
 *    é histórico, como a seção "Encerradas".
 * 3. Atenção viva vence o estado: pergunta aberta, reparo, recuperação que
 *    pede gente. É a única lane que pulsa.
 * 4. Trabalho vivo nunca se esconde, nem arquivado.
 * 5. Plano pronto (`review_ready`) espera a sua validação para começar.
 * 6. `draft` ainda está em construção.
 */
export function missionKanbanLane(
  summary: MissionKanbanSummary,
  input: MissionKanbanLaneInput,
): MissionKanbanLane {
  const { state } = summary;
  const archived = input.archivedByOperator === true;
  if (state === 'failed') return 'archive';
  if (state === 'completed') {
    if (archived) return 'archive';
    return input.awaitsOperatorReview ? 'validating' : 'ready';
  }
  if (isIsolationStopReasonCode(summary.stateReason?.code)) return 'archive';
  if (
    summary.needsAttention ||
    state === 'blocked_user' ||
    state === 'blocked_technical'
  ) {
    return 'needs_you';
  }
  switch (state) {
    case 'starting':
    case 'running':
    case 'recovering':
    case 'stopping':
      return 'building';
    case 'review_ready':
      return archived ? 'archive' : 'validating';
    case 'draft':
      return archived ? 'archive' : 'building';
  }
}

export interface MissionKanbanOrderKey {
  readonly needsAttention: boolean;
  readonly updatedAt: number;
}

function compareMissionOrder(
  a: MissionKanbanOrderKey,
  b: MissionKanbanOrderKey,
): number {
  if (a.needsAttention !== b.needsAttention) return a.needsAttention ? -1 : 1;
  return b.updatedAt - a.updatedAt;
}

/**
 * Ordem dentro da lane: quem pede atenção primeiro, depois o mais recente.
 * Devolve um array novo; empates preservam a ordem de entrada (sort estável).
 */
export function sortMissionsForLane<T>(
  missions: readonly T[],
  keyOf: (mission: T) => MissionKanbanOrderKey,
): readonly T[] {
  return missions
    .map((mission) => ({ mission, key: keyOf(mission) }))
    .sort((a, b) => compareMissionOrder(a.key, b.key))
    .map((entry) => entry.mission);
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Idade relativa curta para o card: `agora`, `5m`, `2h`, `3d`. Sem segundos —
 * o quadro não é cronômetro. Relógio adiantado ou valor inválido lê `agora`.
 */
export function relativeAgeLabel(updatedAt: number, now: number): string {
  const elapsed = now - updatedAt;
  if (!Number.isFinite(elapsed) || elapsed < MINUTE_MS) return 'agora';
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h`;
  return `${Math.floor(elapsed / DAY_MS)}d`;
}

/** Re-exportado para quem monta tabelas por estado (testes, projeções). */
export type { MissionLifecycleState };
