export type MissionStatus =
  | 'pending'
  | 'running'
  | 'blocked'
  | 'done'
  | 'failed';

export interface MissionSummary {
  id: string;
  title: string;
  status: MissionStatus;
  agentCount: number;
  updatedAt: number;
}

export interface CompanionStatus {
  workspaceName: string;
  activeMissions: number;
  totalMissions: number;
  missions: MissionSummary[];
}

export const STATUS_LABEL: Record<MissionStatus, string> = {
  pending: 'na fila',
  running: 'rodando',
  blocked: 'precisa de você',
  done: 'concluída',
  failed: 'falhou',
};
