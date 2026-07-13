/**
 * Geometria do pet — funções puras (testáveis sem Electron): manter a janela
 * dentro de uma área visível. O settle do arrasto usa só clamp (posição livre);
 * `snapToCorner` fica disponível se no futuro houver dock explícito.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Distância (px) do canto a partir da qual o snap "gruda". */
export const SNAP_THRESHOLD = 48;
/** Respiro entre a janela do pet e a borda da workArea após o snap. */
export const SNAP_MARGIN = 12;

/**
 * Clampa a posição para que a janela fique inteiramente dentro da workArea.
 * Se a janela for maior que a área (display minúsculo), encosta na origem.
 */
export function clampToWorkArea(pos: Point, size: Size, workArea: Rect): Point {
  const maxX = workArea.x + workArea.width - size.width;
  const maxY = workArea.y + workArea.height - size.height;
  return {
    x: Math.round(Math.min(Math.max(pos.x, workArea.x), Math.max(workArea.x, maxX))),
    y: Math.round(Math.min(Math.max(pos.y, workArea.y), Math.max(workArea.y, maxY))),
  };
}

/**
 * Snap de canto: se o pet foi solto a menos de SNAP_THRESHOLD de um canto da
 * workArea, assenta nele com SNAP_MARGIN de respiro; senão devolve a posição
 * clampada, sem mexer.
 */
export function snapToCorner(pos: Point, size: Size, workArea: Rect): Point {
  const clamped = clampToWorkArea(pos, size, workArea);
  const left = workArea.x + SNAP_MARGIN;
  const top = workArea.y + SNAP_MARGIN;
  const right = workArea.x + workArea.width - size.width - SNAP_MARGIN;
  const bottom = workArea.y + workArea.height - size.height - SNAP_MARGIN;

  const nearLeft = clamped.x - workArea.x <= SNAP_THRESHOLD;
  const nearRight =
    workArea.x + workArea.width - (clamped.x + size.width) <= SNAP_THRESHOLD;
  const nearTop = clamped.y - workArea.y <= SNAP_THRESHOLD;
  const nearBottom =
    workArea.y + workArea.height - (clamped.y + size.height) <= SNAP_THRESHOLD;

  return {
    x: nearLeft ? left : nearRight ? right : clamped.x,
    y: nearTop ? top : nearBottom ? bottom : clamped.y,
  };
}
