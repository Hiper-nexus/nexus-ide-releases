import type { Mission, MissionStatus } from '../../shared/orch-types';
import { hasAutomaticTechnicalRecovery } from '../../shared/mission-recovery-policy';

/**
 * Lógica pura do Ops Board — pipeline espacial de missões. O board é uma
 * projeção do MESMO domínio de missões do MissionRail/OrchestrationPanel:
 * mesmas entidades, mesmo vocabulário, outra superfície.
 */

/** Ordem fixa do pipeline, da esquerda pra direita. */
export const BOARD_ORDER: MissionStatus[] = [
  'pending',
  'running',
  'blocked',
  'done',
  'failed',
];

/** Vocabulário único de status — o mesmo do MissionRail. */
export const MISSION_STATUS_LABELS: Record<MissionStatus, string> = {
  pending: 'na fila',
  running: 'rodando',
  blocked: 'travada',
  done: 'concluída',
  failed: 'falhou',
};

export interface BoardColumn {
  status: MissionStatus;
  missions: Mission[];
}

/**
 * Retry técnico continua sob autoridade do Main. No board ele pertence ao
 * trabalho em andamento, não à fila de decisões humanas.
 */
export function isMissionBoardRecovering(mission: Mission): boolean {
  return hasAutomaticTechnicalRecovery(mission);
}

function missionBoardStatus(mission: Mission): MissionStatus {
  return isMissionBoardRecovering(mission) ? 'running' : mission.status;
}

/** Agrupa missões nas 5 colunas do pipeline, mais recentes primeiro. */
export function groupMissionsIntoColumns(missions: Mission[]): BoardColumn[] {
  return BOARD_ORDER.map((status) => ({
    status,
    missions: missions
      .filter((mission) => missionBoardStatus(mission) === status)
      .sort((a, b) => b.updatedAt - a.updatedAt),
  }));
}

/**
 * Arrastar um card é ato de PLANEJAMENTO (override manual de status).
 * Entrar em "rodando" exige agentes reais no grid — só via Retomar.
 */
export function canDropMission(from: MissionStatus, to: MissionStatus): boolean {
  if (from === to) return false;
  if (to === 'running') return false;
  return true;
}

/** Tempo relativo compacto e determinístico (now injetado, testável). */
export function formatAgo(now: number, ts: number): string {
  const delta = Math.max(0, now - ts);
  if (delta < 60_000) return 'agora';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}min`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
  return `${Math.floor(delta / 86_400_000)}d`;
}
