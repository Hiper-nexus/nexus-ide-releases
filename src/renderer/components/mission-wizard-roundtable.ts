import type { Squad, SquadAgent } from "../../shared/orch-types";
import { classifyStandardMissionTopology } from "../../shared/mission-topology";

interface MissionWizardRoundtableInput {
  readonly guided: boolean;
  readonly missionGoal: string;
  readonly squad: Pick<Squad, "name">;
  readonly roster: readonly SquadAgent[];
}

export interface MissionWizardRoundtableState {
  readonly isTeamReadOnlyFanout: boolean;
  readonly guidedSummary: string;
  readonly configurationHint: (operatorChoice: boolean) => string;
  readonly workerLaunchContext: string;
  readonly isAdvisorRole: (category: SquadAgent["category"]) => boolean;
  readonly governedQualificationMessage: (
    category: SquadAgent["category"],
  ) => string;
}

export function deriveMissionWizardRoundtableState({
  guided,
  missionGoal,
  squad,
  roster,
}: MissionWizardRoundtableInput): MissionWizardRoundtableState {
  const isTeamReadOnlyFanout =
    guided &&
    classifyStandardMissionTopology(missionGoal) ===
      "team-read-only-fanout";
  const workerCount = roster.filter(
    (agent) => agent.category !== "orchestrator",
  ).length;
  const isAdvisorRole = (category: SquadAgent["category"]): boolean =>
    isTeamReadOnlyFanout ||
    category === "reviewer" ||
    category === "scout";

  return Object.freeze({
    isTeamReadOnlyFanout,
    guidedSummary: isTeamReadOnlyFanout
      ? `${squad.name} · ${workerCount} ${
          workerCount === 1
            ? "especialista responde"
            : "especialistas respondem"
        } em paralelo, somente leitura · Maestro consolida com sua perspectiva.`
      : `${squad.name} · ${roster.length} ${
          roster.length === 1 ? "agente" : "agentes"
        } para executar e verificar a missão.`,
    configurationHint: (operatorChoice: boolean) =>
      isTeamReadOnlyFanout
        ? "Rodada somente leitura: cada especialista usa sua CLI autenticada e responde em paralelo, sem editar o projeto nem esperar o participante anterior. O Maestro consolida os handoffs e identifica sua própria perspectiva. Salvar a configuração não inicia agentes."
        : operatorChoice
          ? "Autopiloto: qualquer CLI autenticada pode ser Maestro, executor ou reviewer. Cada tarefa usa worktree isolado, acesso de rede e merge validado pelo Nexus. Salvar a configuração não inicia agentes."
          : "O Maestro automático usa somente provider com gate verificado. Executores e arquitetos exigem escrita confinada; reviewers e scouts também podem usar uma CLI com leitura autônoma confinada. CLIs sem essas qualificações continuam visíveis como uso manual no Terminal. Salvar a configuração não inicia agentes.",
    workerLaunchContext: isTeamReadOnlyFanout
      ? "Nesta rodada, cada especialista responde em paralelo sem editar o projeto."
      : "No autopiloto, a tarefa usa worktree isolado, acesso de rede e merge validado pelo Nexus.",
    isAdvisorRole,
    governedQualificationMessage: (category: SquadAgent["category"]) =>
      isAdvisorRole(category)
        ? "Esta função exige leitura autônoma confinada e autenticação."
        : "Esta função exige escrita autônoma confinada e autenticação.",
  });
}
