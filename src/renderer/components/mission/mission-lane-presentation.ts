import type { MissionLane } from '../../../shared/mission-intent';

export interface MissionLanePresentation {
  readonly label: string;
  readonly guidance: string;
}

const MISSION_LANE_PRESENTATIONS: Readonly<
  Record<MissionLane, MissionLanePresentation>
> = {
  standard: {
    label: 'Construir ou alterar o produto',
    guidance:
      'Pode ler e editar arquivos dentro da pasta autorizada do projeto e executar os comandos necessários para concluir a entrega.',
  },
  consult: {
    label: 'Investigar sem alterar arquivos',
    guidance:
      'Somente leitura: pode investigar e ler arquivos, sem alterar arquivos do projeto.',
  },
  plan: {
    label: 'Preparar um plano',
    guidance:
      'Somente leitura: pode investigar e preparar um plano, sem alterar arquivos do projeto.',
  },
  ops: {
    label: 'Operar infraestrutura',
    guidance:
      'Pode executar ações de infraestrutura autorizadas, mas não pode alterar o repositório nem os arquivos do projeto.',
  },
};

export const MISSION_LANE_OPTIONS: ReadonlyArray<{
  readonly value: MissionLane;
  readonly label: string;
}> = [
  { value: 'standard', label: MISSION_LANE_PRESENTATIONS.standard.label },
  { value: 'consult', label: MISSION_LANE_PRESENTATIONS.consult.label },
  { value: 'plan', label: MISSION_LANE_PRESENTATIONS.plan.label },
  { value: 'ops', label: MISSION_LANE_PRESENTATIONS.ops.label },
];

export function missionLanePresentation(
  lane: MissionLane,
): MissionLanePresentation {
  return MISSION_LANE_PRESENTATIONS[lane];
}
