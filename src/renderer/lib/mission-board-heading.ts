/**
 * Título do quadro é chrome, não o briefing. Objetivo longo (URL + parágrafo)
 * no h1 virava um cartaz de 4 linhas e comia o grafo.
 */
const HEADING_MAX = 96;

export function missionBoardHeading(raw: string): string {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return 'Missão';
  const withoutLeadingUrl = collapsed.replace(/^https?:\/\/\S+\s+/iu, '');
  const text =
    withoutLeadingUrl.length > 0 ? withoutLeadingUrl : collapsed;
  if (text.length <= HEADING_MAX) return text;
  return `${text.slice(0, HEADING_MAX - 1).trimEnd()}…`;
}
