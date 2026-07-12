/**
 * Filtro do command palette — puro e sem dependências. Busca por substring
 * normalizada (caixa e acentos ignorados: "missao" acha "Missão") sobre
 * label + keywords, preservando a ordem de grupos/inserção.
 */

export interface PaletteActionLike {
  label: string;
  keywords?: string;
}

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

export function matchesPaletteQuery(
  action: PaletteActionLike,
  query: string,
): boolean {
  const q = normalize(query.trim());
  if (!q) return true;
  const haystack = normalize(`${action.label} ${action.keywords ?? ''}`);
  // Cada termo do query precisa aparecer (ordem livre): "term claude" acha
  // "Abrir terminal — claude".
  return q.split(/\s+/).every((term) => haystack.includes(term));
}

export function filterPaletteActions<T extends PaletteActionLike>(
  actions: readonly T[],
  query: string,
): T[] {
  return actions.filter((action) => matchesPaletteQuery(action, query));
}
