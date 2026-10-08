/**
 * Reordenar as abas dos Terminais (WEB-13): aritmética pura de ordem, sem DOM.
 *
 * A ordem natural das abas sai da árvore de layout (primeiro pane de cada
 * escopo). Reordenar não mexe na árvore — mover panes mudaria o mosaico e a
 * pasta de execução de ninguém deveria depender de arrastar uma aba. A ordem
 * escolhida é uma lista de chaves de escopo aplicada por cima: aba que não
 * está nela fica depois das ordenadas, na ordem natural (aba nova nasce no
 * fim, como antes).
 */

/** Tipo de dado do arraste: só a barra de abas o aceita; panes o ignoram. */
export const TAB_DRAG_MIME = 'application/x-nexus-workspace-tab';

/** Teto da lista persistida: chaves de outros projetos saem pelo fim. */
export const TAB_ORDER_CAP = 128;

export type DropSide = 'before' | 'after';

export function applyTabOrder<T extends { readonly key: string }>(
  items: readonly T[],
  order: readonly string[],
): T[] {
  if (order.length === 0) return [...items];
  const rank = new Map(order.map((key, index) => [key, index]));
  return items
    .map((item, natural) => ({ item, natural, rank: rank.get(item.key) }))
    .sort((a, b) => {
      if (a.rank !== undefined && b.rank !== undefined) return a.rank - b.rank;
      if (a.rank !== undefined) return -1;
      if (b.rank !== undefined) return 1;
      return a.natural - b.natural;
    })
    .map(({ item }) => item);
}

/** Move `key` para a posição `toIndex` da lista RESULTANTE (limitada às pontas). */
export function moveTabKey(keys: readonly string[], key: string, toIndex: number): string[] {
  const from = keys.indexOf(key);
  if (from < 0) return [...keys];
  const rest = keys.filter((candidate) => candidate !== key);
  const index = Math.max(0, Math.min(rest.length, Math.trunc(toIndex)));
  rest.splice(index, 0, key);
  return rest;
}

/** Posição final de `dragged` ao soltar antes/depois de `target`. */
export function dropIndex(
  keys: readonly string[],
  dragged: string,
  target: string,
  side: DropSide,
): number | null {
  if (dragged === target) return null;
  const rest = keys.filter((candidate) => candidate !== dragged);
  const at = rest.indexOf(target);
  if (at < 0) return null;
  return at + (side === 'after' ? 1 : 0);
}

/** Metade esquerda da aba = antes; direita = depois. */
export function dropSideFromPointer(
  rect: { readonly left: number; readonly width: number },
  clientX: number,
): DropSide {
  return clientX < rect.left + rect.width / 2 ? 'before' : 'after';
}

/**
 * Nova ordem persistida: as abas visíveis na ordem escolhida, depois as
 * chaves antigas que não estão na tela (outro projeto, aba fechada), até o teto.
 */
export function mergeTabOrder(
  previous: readonly string[],
  visible: readonly string[],
  cap = TAB_ORDER_CAP,
): string[] {
  const seen = new Set(visible);
  return [...visible, ...previous.filter((key) => !seen.has(key))].slice(0, cap);
}
