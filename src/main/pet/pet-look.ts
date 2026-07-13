import { SHEET_LOOK } from '../../shared/pet-types';
import type { Point, Rect } from './pet-geometry';

/**
 * Look mechanics do pet (contrato v2 / look-mechanics do hatch-pet): o pet
 * olha para o cursor. Matemática pura, sem Electron — o poller em
 * pet-window.ts alimenta cursor + bounds da janela.
 *
 * Convenção de ângulo do contrato: 0° = CIMA, crescendo em sentido horário
 * (90° = direita da tela, 180° = baixo, 270° = esquerda). Coordenadas de
 * tela têm y crescendo para BAIXO.
 *
 * Histerese (anti-flicker em cantos / multi-monitor):
 * - raio próximo com entrada/saída separadas (não oscilar idle↔look na borda)
 * - quantização sticky: só muda de direção quando o ângulo sai da fatia atual
 *   com margem extra (evita piscar entre frames 0↔1 do spritesheet)
 */

/** Cursor mais perto que isso (já olhando) = volta a idle. */
export const LOOK_NEAR_RADIUS_PX = 90;
/**
 * Para COMEÇAR a olhar, o cursor precisa estar mais longe (histerese).
 * Sem isto, no limiar de 90px o lookDir alterna null↔N e o sprite pisca.
 */
export const LOOK_FAR_RADIUS_PX = 130;
/** Margem angular extra (° ) para trocar de direção quantizada. */
export const LOOK_DIR_STICK_DEG = 8;

/** Centro visual do sprite: bottom-center da janela (o pet ancora embaixo,
    sprite ~150px → centro ≈ 80px acima da base). */
export function petAnchor(bounds: Rect): Point {
  return {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height - 80,
  };
}

/** Ângulo (0..360) do vetor anchor→cursor na convenção do contrato. */
export function lookAngleDeg(anchor: Point, cursor: Point): number {
  const dx = cursor.x - anchor.x;
  const dy = cursor.y - anchor.y;
  // atan2(dx, -dy): 0 quando o cursor está ACIMA, horário via direita.
  const deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/** Quantiza o ângulo nos 16 passos de 22,5° do spritesheet. */
export function quantizeLookDir(angleDeg: number): number {
  // Always positive modulo — JS `%` keeps the sign of the dividend.
  const n = SHEET_LOOK.directions;
  return ((Math.round(angleDeg / SHEET_LOOK.stepDeg) % n) + n) % n;
}

/** Menor diferença angular signed em [-180, 180]. */
export function angleDeltaDeg(from: number, to: number): number {
  let d = to - from;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

/**
 * Quantização com sticky sector: mantém lastDir até o ângulo sair da
 * fatia (step/2) + LOOK_DIR_STICK_DEG.
 */
export function stickyQuantizeLookDir(
  angleDeg: number,
  lastDir: number | null,
): number {
  const raw = quantizeLookDir(angleDeg);
  if (lastDir === null || lastDir === raw) return raw;
  const center = lastDir * SHEET_LOOK.stepDeg;
  const half = SHEET_LOOK.stepDeg / 2 + LOOK_DIR_STICK_DEG;
  if (Math.abs(angleDeltaDeg(center, angleDeg)) <= half) {
    return lastDir;
  }
  return raw;
}

export interface ComputeLookDirOptions {
  cursorIdleMs: number;
  maxIdleMs: number;
  /** Última direção enviada (null = idle) — histerese anti-flicker. */
  lastDir?: number | null;
}

/**
 * Direção de look para o estado atual, ou null quando o pet deve ficar em
 * idle: cursor em cima/perto do sprite (olhar para si mesmo tremula) ou
 * parado há tempo demais (o pet volta a digitar).
 */
export function computeLookDir(
  cursor: Point,
  bounds: Rect,
  options: ComputeLookDirOptions,
): number | null {
  if (options.cursorIdleMs > options.maxIdleMs) return null;
  const lastDir = options.lastDir ?? null;
  const anchor = petAnchor(bounds);
  const dist = Math.hypot(cursor.x - anchor.x, cursor.y - anchor.y);

  // Histerese de distância: idle→look só além de FAR; look→idle só abaixo de NEAR.
  if (lastDir === null) {
    if (dist < LOOK_FAR_RADIUS_PX) return null;
  } else if (dist < LOOK_NEAR_RADIUS_PX) {
    return null;
  }

  return stickyQuantizeLookDir(lookAngleDeg(anchor, cursor), lastDir);
}
