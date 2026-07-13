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
 * Overhang no settle (px). A janela é maior que o sprite (~70px de padding
 * lateral): 40 deixa o mascote perto do canto sem mandar pixels transparentes
 * grandes para fora do ecrã (causa nº1 de piscar no compositor macOS).
 * Valores ≥100 (legado) piscavam forte em multi-monitor.
 */
export const EDGE_OVERHANG_SETTLE = 40;
/**
 * Overhang no arrasto: folga para atravessar bordas e a costura entre monitores
 * sem “bater” no clamp a cada tick. Settle volta a SETTLE.
 */
export const EDGE_OVERHANG_DRAG = 96;
/** Alias histórico (= settle) — testes e callers antigos. */
export const EDGE_OVERHANG = EDGE_OVERHANG_SETTLE;

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
 * Arrasto multi-monitor anti-flicker (macOS Retina + monitor 1×).
 *
 * Janela transparente a CAVALO entre monitores com scaleFactor diferente
 * re-rasteriza a cada frame e pisca. Esta função mantém a janela 100%
 * dentro de UM display (overhang 0). A troca de monitor é externa (cursor).
 */
export function clampPetFullyOnDisplay(
  pos: Point,
  size: Size,
  displayBounds: Rect,
): Point {
  return clampPetDrag(pos, size, displayBounds, 0);
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
 */
export function petParkCornerCandidates(
  size: Size,
  workArea: Rect,
  margin = SNAP_MARGIN,
): Point[] {
  const left = workArea.x + margin;
  const top = workArea.y + margin;
  const right = workArea.x + workArea.width - size.width - margin;
  const bottom = workArea.y + workArea.height - size.height - margin;
  return [
    { x: right, y: bottom },
    { x: right, y: top },
    { x: left, y: bottom },
    { x: left, y: top },
  ];
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
 */
export function petCoversMainSidebar(
  pos: Point,
  size: Size,
  mainBounds: Rect,
  sidebarWidth = 340,
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
  // ≥25% do pet sobre a faixa esquerda = tapa várias linhas do explorer.
  return windowOverlapArea(pos, size, strip) / area >= 0.25;
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
