/**
 * Identidade de missão no modo agêntico com squad REUSADO.
 *
 * Caso de campo (17/07): o agêntico reusa o squad salvo mais recente para
 * honrar o roster do usuário — mas a missão nova herdava o NOME do squad
 * antigo como título ("Clone Reference ADE" numa missão de dashboards) e as
 * orchestratorInstructions salvas ainda abriam com "# Missão <objetivo
 * antigo>", competindo com o objetivo vigente no kickoff.
 */

import { parseInlineMarkdown, spanText } from './rich-text-marks';

const MISSION_TITLE_MAX = 72;
const MISSION_CHROME_MAX = 48;
const MISSION_CHROME_FALLBACK = 'Missão';
const URL_IN_TEXT = /https?:\/\/[^\s]+/giu;

function clipMissionLabel(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function hostnameFromUrl(raw: string): string | null {
  try {
    const host = new URL(raw).hostname.replace(/^www\./u, '');
    return host.length > 0 ? host : null;
  } catch {
    return null;
  }
}

/**
 * Chrome da missão (rail, quadro, paleta): nunca o briefing colado.
 * Objetivo que começa com URL vira o hostname; o resto clipa numa linha.
 */
export function missionChromeTitle(
  raw: string,
  max: number = MISSION_CHROME_MAX,
): string {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (!collapsed) return MISSION_CHROME_FALLBACK;
  const urls = collapsed.match(URL_IN_TEXT) ?? [];
  const withoutUrls = collapsed.replace(URL_IN_TEXT, ' ').replace(/\s+/g, ' ').trim();
  if (urls.length > 0 && /^https?:\/\//iu.test(collapsed)) {
    const host = hostnameFromUrl(urls[0]!);
    if (host) return clipMissionLabel(host, max);
  }
  if (withoutUrls) return clipMissionLabel(withoutUrls, max);
  if (urls[0]) {
    const host = hostnameFromUrl(urls[0]);
    if (host) return clipMissionLabel(host, max);
  }
  return MISSION_CHROME_FALLBACK;
}

/**
 * F-1170: o objetivo é markdown canônico (o editor do wizard escreve
 * `**negrito**` e escapa `\*` literal). Título e chrome são texto puro:
 * marcadores saem, escapes viram o caractere — o objetivo guardado não muda.
 */
export function objectivePlainText(objective: string): string {
  return spanText(parseInlineMarkdown(objective.replace(/\r\n?/gu, '\n')));
}

/** Primeira linha do objetivo (mesmo vazia), em texto puro e aparada. */
export function objectiveFirstLinePlainText(objective: string): string {
  return objectivePlainText(objective).split('\n', 1)[0]!.trim();
}

/**
 * Título de missão derivado do objetivo do usuário: primeira linha com
 * conteúdo, em texto puro, truncada com reticências. Fallback (nome do squad)
 * só quando o objetivo está vazio.
 */
export function missionTitleFromGoal(goal: string, fallback: string): string {
  const firstLine =
    objectivePlainText(goal)
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? '';
  if (!firstLine) return fallback;
  return missionChromeTitle(firstLine, MISSION_TITLE_MAX);
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
