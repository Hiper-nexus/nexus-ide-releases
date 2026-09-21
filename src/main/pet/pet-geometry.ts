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
 * Overhang no settle (px). ZERO é intencional: mesmo pixels transparentes fora
 * do display fazem a superfície always-on-top oscilar no WindowServer do macOS,
 * sobretudo no canto e em monitores com DPI/Hz diferentes.
 */
export const EDGE_OVERHANG_SETTLE = 0;
/**
 * Overhang no arrasto também é zero nas bordas externas. A travessia entre
 * monitores continua livre porque o clamp usa a união do desktop virtual.
 */
export const EDGE_OVERHANG_DRAG = 0;
/** Alias histórico (= settle) — testes e callers antigos. */
export const EDGE_OVERHANG = EDGE_OVERHANG_SETTLE;
/** Cursor dentro desta faixa encaixa a janela exatamente na borda física. */
export const PHYSICAL_EDGE_SNAP_THRESHOLD = 64;

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
 * Clamp do pet. Default = settle (EDGE_OVERHANG_SETTLE): sprite alcança
 * cantos, mas a janela não some fora do ecrã. Drag usa EDGE_OVERHANG_DRAG.
 */
export function clampPetDrag(
  pos: Point,
  size: Size,
  workArea: Rect,
  overhang = EDGE_OVERHANG_SETTLE,
): Point {
  const oh = Math.max(
    0,
    Math.min(overhang, Math.floor(size.width / 3), Math.floor(size.height / 3)),
  );
  const minX = workArea.x - oh;
  const minY = workArea.y - oh;
  const maxX = workArea.x + workArea.width - size.width + oh;
  const maxY = workArea.y + workArea.height - size.height + oh;
  return {
    x: Math.round(Math.min(Math.max(pos.x, minX), Math.max(minX, maxX))),
    y: Math.round(Math.min(Math.max(pos.y, minY), Math.max(minY, maxY))),
  };
}

/**
 * Encaixa nos eixos físicos que o cursor realmente alcançou. A decisão pelo
 * cursor evita que a área transparente da janela selecione o monitor vizinho
 * ou faça o pet voltar para o meio ao soltar numa costura multi-monitor.
 */
export function snapPetToCursorEdges(
  pos: Point,
  size: Size,
  displayBounds: Rect,
  cursor: Point,
  threshold = PHYSICAL_EDGE_SNAP_THRESHOLD,
): Point {
  const t = Math.max(0, threshold);
  const left = displayBounds.x;
  const top = displayBounds.y;
  const right = displayBounds.x + displayBounds.width;
  const bottom = displayBounds.y + displayBounds.height;
  const maxX = Math.max(left, right - size.width);
  const maxY = Math.max(top, bottom - size.height);
  const next = { ...pos };

  if (cursor.x <= left + t) next.x = left;
  else if (cursor.x >= right - 1 - t) next.x = maxX;

  if (cursor.y <= top + t) next.y = top;
  else if (cursor.y >= bottom - 1 - t) next.y = maxY;

  return clampPetDrag(next, size, displayBounds, 0);
}

/** True se a posição já está dentro do envelope de settle (não precisa setBounds). */
export function isWithinPetOverhang(
  pos: Point,
  size: Size,
  workArea: Rect,
  overhang = EDGE_OVERHANG_SETTLE,
): boolean {
  const settled = clampPetDrag(pos, size, workArea, overhang);
  return settled.x === pos.x && settled.y === pos.y;
}

/**
 * True se algum pixel da janela está fora do rect físico do display.
 * Em transparent + alwaysOnTop no macOS, pixels off-display fazem o compositor
 * piscar o conteúdo inteiro — preferir 0 overhang na borda física se possível.
 */
export function windowIntersectsOffDisplay(
  pos: Point,
  size: Size,
  displayBounds: Rect,
): boolean {
  return (
    pos.x < displayBounds.x ||
    pos.y < displayBounds.y ||
    pos.x + size.width > displayBounds.x + displayBounds.width ||
    pos.y + size.height > displayBounds.y + displayBounds.height
  );
}

/** Área de interseção entre a janela e um rect (px²). 0 = sem overlap. */
export function windowOverlapArea(
  pos: Point,
  size: Size,
  area: Rect,
): number {
  const ix = Math.max(
    0,
    Math.min(pos.x + size.width, area.x + area.width) - Math.max(pos.x, area.x),
  );
  const iy = Math.max(
    0,
    Math.min(pos.y + size.height, area.y + area.height) -
      Math.max(pos.y, area.y),
  );
  return ix * iy;
}

/**
 * @deprecated Prefer clampPetFullyOnDisplay no arrasto multi-DPI.
 * Mantido para testes de regressão do clamp “livre se intersecta”.
 */
export function clampPetDragAcrossDisplays(
  pos: Point,
  size: Size,
  displays: readonly Rect[],
  overhang = EDGE_OVERHANG_DRAG,
): Point {
  if (displays.length === 0) {
    return { x: Math.round(pos.x), y: Math.round(pos.y) };
  }
  if (displays.length === 1) {
    return clampPetDrag(pos, size, displays[0]!, overhang);
  }

  const desired = { x: Math.round(pos.x), y: Math.round(pos.y) };
  for (const d of displays) {
    if (windowOverlapArea(desired, size, d) > 0) {
      return desired;
    }
  }
  let best = clampPetDrag(desired, size, displays[0]!, overhang);
  let bestDist =
    (best.x - desired.x) * (best.x - desired.x) +
    (best.y - desired.y) * (best.y - desired.y);
  for (let i = 1; i < displays.length; i += 1) {
    const c = clampPetDrag(desired, size, displays[i]!, overhang);
    const dist =
      (c.x - desired.x) * (c.x - desired.x) +
      (c.y - desired.y) * (c.y - desired.y);
    if (dist < bestDist) {
      best = c;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Janela 100% dentro de UM display (overhang 0). Usar no settle/persist —
 * não no arrasto livre (gruda na costura multi-monitor).
 */
export function clampPetFullyOnDisplay(
  pos: Point,
  size: Size,
  displayBounds: Rect,
): Point {
  return clampPetDrag(pos, size, displayBounds, 0);
}

/** Bounding box de todos os monitores (desktop virtual contínuo). */
export function unionRects(rects: readonly Rect[]): Rect {
  if (rects.length === 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  return {
    x: minX,
    y: minY,
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY),
  };
}

/**
 * Arrasto livre no desktop virtual (todos os monitores).
 * Sem “parede” na costura Mac↔LG — o settle é que assenta num display.
 */
export function clampPetDragFreeDesktop(
  pos: Point,
  size: Size,
  displayBoundsList: readonly Rect[],
  overhang = EDGE_OVERHANG_DRAG,
): Point {
  if (displayBoundsList.length === 0) {
    return { x: Math.round(pos.x), y: Math.round(pos.y) };
  }
  if (displayBoundsList.length === 1) {
    return clampPetDrag(pos, size, displayBoundsList[0]!, overhang);
  }
  return clampPetDrag(pos, size, unionRects(displayBoundsList), overhang);
}

/**
 * True se TODA a janela é coberta pela união dos displays (nenhum pixel em
 * zona morta). Na costura entre monitores alinhados a janela pode cavalgar
 * os dois — o que é proibido é sobrar fora de qualquer tela física, porque
 * pixel off-display pisca/some no compositor do macOS.
 */
export function windowFullyOnDisplays(
  pos: Point,
  size: Size,
  displays: readonly Rect[],
): boolean {
  const left = pos.x;
  const right = pos.x + size.width;
  const top = pos.y;
  const bottom = pos.y + size.height;
  // Decompõe a altura da janela em faixas delimitadas pelas bordas
  // verticais dos displays; em cada faixa, a união dos intervalos em X dos
  // displays que a cobrem inteira precisa cobrir [left, right] sem buraco.
  const cuts = new Set<number>([top, bottom]);
  for (const d of displays) {
    if (d.y > top && d.y < bottom) cuts.add(d.y);
    const dBottom = d.y + d.height;
    if (dBottom > top && dBottom < bottom) cuts.add(dBottom);
  }
  const ys = [...cuts].sort((a, b) => a - b);
  for (let i = 0; i + 1 < ys.length; i += 1) {
    const y0 = ys[i]!;
    const y1 = ys[i + 1]!;
    const spans = displays
      .filter((d) => d.y <= y0 && d.y + d.height >= y1)
      .map((d) => ({ x0: d.x, x1: d.x + d.width }))
      .sort((a, b) => a.x0 - b.x0);
    let coveredUntil = left;
    for (const span of spans) {
      if (span.x0 > coveredUntil) break;
      coveredUntil = Math.max(coveredUntil, span.x1);
    }
    if (coveredUntil < right) return false;
  }
  return true;
}

/**
 * Arrasto livre exigindo a janela inteira coberta pela união dos bounds
 * físicos. Diferente do clamp por bounding-box, recusa zonas mortas entre
 * monitores de alturas diferentes — “alguns locais ele não vai” passa a
 * significar só “não existe tela ali”. Cruza a costura quando os displays
 * se tocam, porque a posição compartilhada continua coberta.
 */
export function clampPetCoveredByDisplays(
  pos: Point,
  size: Size,
  displayBoundsList: readonly Rect[],
): Point {
  const desired = { x: Math.round(pos.x), y: Math.round(pos.y) };
  if (displayBoundsList.length === 0) return desired;
  if (windowFullyOnDisplays(desired, size, displayBoundsList)) {
    return desired;
  }
  let best = clampPetDrag(desired, size, displayBoundsList[0]!, 0);
  let bestDist = Number.POSITIVE_INFINITY;
  for (const d of displayBoundsList) {
    const c = clampPetDrag(desired, size, d, 0);
    const dist =
      (c.x - desired.x) * (c.x - desired.x) +
      (c.y - desired.y) * (c.y - desired.y);
    if (dist < bestDist) {
      bestDist = dist;
      best = c;
    }
  }
  return best;
}

/** True se a janela tem pixels em mais de um display (straddle = flicker). */
export function windowStraddlesDisplays(
  pos: Point,
  size: Size,
  displays: readonly Rect[],
): boolean {
  let hits = 0;
  for (const d of displays) {
    if (windowOverlapArea(pos, size, d) > 0) {
      hits += 1;
      if (hits >= 2) return true;
    }
  }
  return false;
}

/** Largura típica da faixa explorer+activity bar (px de ecrã). */
export const PET_SIDEBAR_COVER_WIDTH = 340;
/**
 * Fração da área do pet sobre a faixa esquerda a partir da qual
 * consideramos que tapa a árvore de ficheiros.
 */
export const PET_SIDEBAR_COVER_RATIO = 0.25;

/**
 * Fração máxima da área do pet que intersecta algum obstáculo (0..1).
 * Usado para decidir se vale re-estacionar (ex.: em cima do explorer).
 */
export function petWindowOverlapRatio(
  pos: Point,
  size: Size,
  obstacles: readonly Rect[],
): number {
  const area = size.width * size.height;
  if (area <= 0 || obstacles.length === 0) return 0;
  let max = 0;
  for (const o of obstacles) {
    max = Math.max(max, windowOverlapArea(pos, size, o) / area);
  }
  return max;
}

/**
 * Cantos de estacionamento na workArea (ordem = preferência em empate):
 * BR → TR → BL → TL. O explorer do IDE fica à esquerda — BR/TR cobrem
 * menos a árvore de ficheiros quando a janela principal está maximizada.
 *
 * Cada candidato é clampado à workArea (display minúsculo / pet maior que
 * a área): evita right < left e posições NaN/fora.
 */
export function petParkCornerCandidates(
  size: Size,
  workArea: Rect,
  margin = SNAP_MARGIN,
): Point[] {
  const m = Math.max(0, margin);
  // Espaço interior com margem; se a workArea for apertada, o clamp
  // abaixo colapsa para o canto real da área.
  const inner: Rect = {
    x: workArea.x + m,
    y: workArea.y + m,
    width: Math.max(0, workArea.width - 2 * m),
    height: Math.max(0, workArea.height - 2 * m),
  };
  const raw: Point[] = [
    { x: inner.x + inner.width - size.width, y: inner.y + inner.height - size.height },
    { x: inner.x + inner.width - size.width, y: inner.y },
    { x: inner.x, y: inner.y + inner.height - size.height },
    { x: inner.x, y: inner.y },
  ];
  // clampToWorkArea na workArea completa (não só inner) para não empurrar
  // para fora quando size > inner.
  return raw.map((p) => clampToWorkArea(p, size, workArea));
}

/**
 * Escolhe o canto com menor sobreposição total com `obstacles` (janelas
 * principais). Empates mantêm a ordem de preferência (BR primeiro).
 */
export function bestPetParkPosition(
  size: Size,
  workArea: Rect,
  obstacles: readonly Rect[] = [],
  margin = SNAP_MARGIN,
): Point {
  const candidates = petParkCornerCandidates(size, workArea, margin);
  let best = candidates[0]!;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    let score = 0;
    for (const o of obstacles) {
      score += windowOverlapArea(c, size, o);
    }
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

/**
 * True se o pet cobre uma faixa esquerda da janela principal (explorer /
 * activity bar). Utilizador a apontar o pet sobre a árvore de ficheiros é o
 * caso típico — re-estacionamos para o canto livre em vez de tapar pastas.
 *
 * Nota: assume layout LTR (explorer à esquerda). Nexus não espelha o rail.
 */
export function petCoversMainSidebar(
  pos: Point,
  size: Size,
  mainBounds: Rect,
  sidebarWidth = PET_SIDEBAR_COVER_WIDTH,
  coverRatio = PET_SIDEBAR_COVER_RATIO,
): boolean {
  if (mainBounds.width <= 0 || mainBounds.height <= 0) return false;
  const stripW = Math.min(Math.max(0, sidebarWidth), mainBounds.width);
  if (stripW <= 0) return false;
  const strip: Rect = {
    x: mainBounds.x,
    y: mainBounds.y,
    width: stripW,
    height: mainBounds.height,
  };
  const area = size.width * size.height;
  if (area <= 0) return false;
  const ratio = Math.min(1, Math.max(0, coverRatio));
  return windowOverlapArea(pos, size, strip) / area >= ratio;
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
