import { missionChromeTitle } from '../../shared/mission-identity';

/**
 * Título do quadro é chrome, não o briefing. Objetivo longo (URL + parágrafo)
 * no h1 virava um cartaz de 4 linhas e comia o grafo.
 */
export function missionBoardHeading(raw: string): string {
  return missionChromeTitle(raw);
}
