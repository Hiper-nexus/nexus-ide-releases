/**
 * Identidade de missão no modo agêntico com squad REUSADO.
 *
 * Caso de campo (17/07): o agêntico reusa o squad salvo mais recente para
 * honrar o roster do usuário — mas a missão nova herdava o NOME do squad
 * antigo como título ("Clone Overclock" numa missão de dashboards) e as
 * orchestratorInstructions salvas ainda abriam com "# Missão <objetivo
 * antigo>", competindo com o objetivo vigente no kickoff.
 */

const MISSION_TITLE_MAX = 72;

/**
 * Título de missão derivado do objetivo do usuário: primeira linha com
 * conteúdo, truncada com reticências. Fallback (nome do squad) só quando o
 * objetivo está vazio.
 */
export function missionTitleFromGoal(goal: string, fallback: string): string {
  const firstLine =
    goal
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? '';
  if (!firstLine) return fallback;
  if (firstLine.length <= MISSION_TITLE_MAX) return firstLine;
  return `${firstLine.slice(0, MISSION_TITLE_MAX - 1).trimEnd()}…`;
}

const STALE_MISSION_HEADING = /^#{1,6}\s*miss(?:ão|ao|ion)\b/i;
const ANY_HEADING = /^#{1,6}\s/;

/**
 * Reaponta as instruções de um squad salvo para o objetivo VIGENTE: remove a
 * seção "# Missão …" antiga do topo (até o próximo heading) e declara o novo
 * objetivo em primeiro lugar. O restante das instruções (sabedoria de
 * processo do squad) é preservado.
 */
export function retargetSquadInstructions(
  instructions: string,
  goal: string,
): string {
  const goalBlock = `# Missão\n${goal.trim()}`;
  const trimmed = instructions.trim();
  if (!trimmed) return goalBlock;
  const lines = trimmed.split('\n');
  let rest = trimmed;
  if (STALE_MISSION_HEADING.test(lines[0] ?? '')) {
    let cut = lines.length;
    for (let index = 1; index < lines.length; index += 1) {
      if (ANY_HEADING.test(lines[index])) {
        cut = index;
        break;
      }
    }
    rest = lines.slice(cut).join('\n').trim();
  }
  return rest ? `${goalBlock}\n\n${rest}` : goalBlock;
}
