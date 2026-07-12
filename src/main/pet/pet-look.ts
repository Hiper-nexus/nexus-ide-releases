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
 */

/** Cursor mais perto que isso do centro do sprite = "olhando para si": idle. */
export const LOOK_NEAR_RADIUS_PX = 90;

/** Centro visual do sprite: bottom-center da janela (o pet ancora embaixo). */
export function petAnchor(bounds: Rect): Point {
  return {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height - 60,
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
  return (
    Math.round(angleDeg / SHEET_LOOK.stepDeg) % SHEET_LOOK.directions
  );
}

/**
 * Direção de look para o estado atual, ou null quando o pet deve ficar em
 * idle: cursor em cima/perto do sprite (olhar para si mesmo tremula) ou
 * parado há tempo demais (o pet volta a digitar).
 */
export function computeLookDir(
  cursor: Point,
  bounds: Rect,
  options: { cursorIdleMs: number; maxIdleMs: number },
): number | null {
  if (options.cursorIdleMs > options.maxIdleMs) return null;
  const anchor = petAnchor(bounds);
  const dist = Math.hypot(cursor.x - anchor.x, cursor.y - anchor.y);
  if (dist < LOOK_NEAR_RADIUS_PX) return null;
  return quantizeLookDir(lookAngleDeg(anchor, cursor));
}
