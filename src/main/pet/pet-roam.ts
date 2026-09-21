/**
 * Motor de patrulha do companion — matemática pura, sem Electron.
 *
 * O pet caminha de verdade pela tela: a janela se move enquanto o renderer
 * toca a animação de corrida (walk) ou a gira 90° (climb nas bordas
 * verticais). Destinos são sorteados com viés de perímetro — o pet visita
 * TODAS as extremidades do display (o pedido original era "andar em todos
 * os cantos"), com visitas ocasionais ao interior.
 *
 * Coordenadas em px de ecrã; y cresce para baixo.
 */
import type { Point, Rect, Size } from './pet-geometry';
import type { PetRoamState } from '../../shared/pet-types';

/** Velocidade de passeio (px/s) — cruza um monitor ultrawide em ~25 s. */
export const ROAM_WALK_SPEED_PX_S = 120;
/** Trecho ocasional de corrida (2×) — a quebra de ritmo dá vida. */
export const ROAM_SPRINT_CHANCE = 0.12;
export const ROAM_SPRINT_FACTOR = 2.1;
/** Pausa parado entre destinos (ms) — sorteio dentro da faixa. */
export const ROAM_PAUSE_MIN_MS = 2_500;
export const ROAM_PAUSE_MAX_MS = 9_000;
/** Distância (px) a partir da qual o passo considera "chegou". */
export const ROAM_ARRIVE_PX = 3;
/** Razão |dy|/|dx| acima da qual o movimento vira escalada (sprite gira). */
export const ROAM_CLIMB_RATIO = 1.6;

export type Rng = () => number;

/**
 * Ponto no perímetro de `area` parametrizado por t ∈ [0,1): percorre as
 * bordas no sentido horário começando no canto superior esquerdo (topo
 * L→R, direita T→B, base R→L, esquerda B→T). A janela fica 100% dentro da
 * área — o clamp implícito nos cantos cobre size ≥ area.
 */
export function perimeterPoint(t: number, area: Rect, size: Size): Point {
  const maxX = Math.max(area.x, area.x + area.width - size.width);
  const maxY = Math.max(area.y, area.y + area.height - size.height);
  const w = Math.max(0, maxX - area.x);
  const h = Math.max(0, maxY - area.y);
  const perim = 2 * (w + h);
  if (perim <= 0) return { x: area.x, y: area.y };
  let d = (((t % 1) + 1) % 1) * perim;
  if (d <= w) return { x: Math.round(area.x + d), y: area.y };
  d -= w;
  if (d <= h) return { x: maxX, y: Math.round(area.y + d) };
  d -= h;
  if (d <= w) return { x: Math.round(maxX - d), y: maxY };
  d -= w;
  return { x: area.x, y: Math.round(maxY - d) };
}

/**
 * Parâmetro t do perímetro mais próximo de `pos` — usado para o pet
 * "continuar a ronda" de onde está em vez de teleportar para o trilho.
 * Amostragem grosseira (64 passos) basta: a patrulha não é física fina.
 */
export function nearestPerimeterT(pos: Point, area: Rect, size: Size): number {
  let bestT = 0;
  let bestDist = Infinity;
  for (let i = 0; i < 64; i += 1) {
    const t = i / 64;
    const p = perimeterPoint(t, area, size);
    const dist = (p.x - pos.x) * (p.x - pos.x) + (p.y - pos.y) * (p.y - pos.y);
    if (dist < bestDist) {
      bestDist = dist;
      bestT = t;
    }
  }
  return bestT;
}

export type RoamDestinationKind = 'rim-ahead' | 'rim-any' | 'interior';

/**
 * Sorteia o próximo destino de patrulha.
 *
 * Pesos: metade das vezes o pet segue o perímetro a partir de onde está
 * (caminhada contínua pelas bordas — lê como ronda), um terço salta para
 * um ponto qualquer do aro (cruza a tela — cobre os cantos "opostos") e o
 * restante visita o interior. Tudo clampado à área.
 */
export function pickRoamDestination(
  pos: Point,
  area: Rect,
  size: Size,
  rng: Rng,
): { point: Point; kind: RoamDestinationKind } {
  const roll = rng();
  if (roll < 0.55) {
    const here = nearestPerimeterT(pos, area, size);
    const advance = (rng() < 0.5 ? -1 : 1) * (0.08 + rng() * 0.3);
    return {
      point: perimeterPoint(here + advance, area, size),
      kind: 'rim-ahead',
    };
  }
  if (roll < 0.85) {
    return { point: perimeterPoint(rng(), area, size), kind: 'rim-any' };
  }
  const maxX = Math.max(area.x, area.x + area.width - size.width);
  const maxY = Math.max(area.y, area.y + area.height - size.height);
  const pad = Math.min(60, Math.max(0, (maxX - area.x) / 4));
  const padY = Math.min(60, Math.max(0, (maxY - area.y) / 4));
  return {
    point: {
      x: Math.round(area.x + pad + rng() * Math.max(0, maxX - area.x - 2 * pad)),
      y: Math.round(
        area.y + padY + rng() * Math.max(0, maxY - area.y - 2 * padY),
      ),
    },
    kind: 'interior',
  };
}

export interface RoamStepResult {
  next: Point;
  arrived: boolean;
  /** Fase/direção para a animação neste passo. */
  phase: 'walk' | 'climb';
  dir: 'left' | 'right';
  climb: 'up' | 'down' | null;
}

/**
 * Avança `pos` em direção a `target` a `speed` px/s por `dtMs`. Declara
 * climb quando o eixo vertical domina — o renderer gira o sprite 90°.
 * O dir de face segue o deslocamento horizontal quando houver; no climb
 * puro mantém-se a face anterior (o caller passa `lastDir`).
 */
export function roamStep(
  pos: Point,
  target: Point,
  dtMs: number,
  speed: number,
  lastDir: 'left' | 'right' = 'right',
): RoamStepResult {
  const dx = target.x - pos.x;
  const dy = target.y - pos.y;
  const dist = Math.hypot(dx, dy);
  const travel = Math.max(0, speed) * (dtMs / 1000);
  if (dist <= Math.max(ROAM_ARRIVE_PX, travel)) {
    return {
      next: { x: Math.round(target.x), y: Math.round(target.y) },
      arrived: true,
      phase: 'walk',
      dir: lastDir,
      climb: null,
    };
  }
  const ux = dx / dist;
  const uy = dy / dist;
  const climbing = Math.abs(dy) > Math.abs(dx) * ROAM_CLIMB_RATIO;
  return {
    next: {
      x: Math.round(pos.x + ux * travel),
      y: Math.round(pos.y + uy * travel),
    },
    arrived: false,
    phase: climbing ? 'climb' : 'walk',
    dir: Math.abs(dx) >= 1 ? (dx > 0 ? 'right' : 'left') : lastDir,
    climb: climbing ? (dy < 0 ? 'up' : 'down') : null,
  };
}

/** Estado serializado para o renderer — null quando a patrulha está off. */
export function roamUiState(
  phase: 'idle' | 'walk' | 'climb',
  dir: 'left' | 'right' | null,
  climb: 'up' | 'down' | null,
): PetRoamState {
  return { phase, dir, climb };
}
