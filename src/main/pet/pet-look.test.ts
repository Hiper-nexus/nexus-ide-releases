import { describe, expect, it } from 'vitest';
import { sheetLookFrame } from '../../shared/pet-types';
import {
  angleDeltaDeg,
  computeLookDir,
  LOOK_FAR_RADIUS_PX,
  LOOK_NEAR_RADIUS_PX,
  lookAngleDeg,
  petAnchor,
  quantizeLookDir,
  stickyQuantizeLookDir,
} from './pet-look';

const BOUNDS = { x: 1000, y: 500, width: 240, height: 200 };
const ANCHOR = petAnchor(BOUNDS);
const OPTS = { cursorIdleMs: 0, maxIdleMs: 4000 };

describe('lookAngleDeg (0=cima, horário)', () => {
  it('cardeais do contrato', () => {
    expect(lookAngleDeg(ANCHOR, { x: ANCHOR.x, y: ANCHOR.y - 300 })).toBe(0);
    expect(lookAngleDeg(ANCHOR, { x: ANCHOR.x + 300, y: ANCHOR.y })).toBe(90);
    expect(lookAngleDeg(ANCHOR, { x: ANCHOR.x, y: ANCHOR.y + 300 })).toBe(180);
    expect(lookAngleDeg(ANCHOR, { x: ANCHOR.x - 300, y: ANCHOR.y })).toBe(270);
  });

  it('diagonal cima-direita = 45', () => {
    expect(
      lookAngleDeg(ANCHOR, { x: ANCHOR.x + 300, y: ANCHOR.y - 300 }),
    ).toBeCloseTo(45);
  });
});

describe('quantizeLookDir', () => {
  it('16 passos de 22,5° com arredondamento e wrap', () => {
    expect(quantizeLookDir(0)).toBe(0);
    expect(quantizeLookDir(90)).toBe(4);
    expect(quantizeLookDir(180)).toBe(8);
    expect(quantizeLookDir(270)).toBe(12);
    expect(quantizeLookDir(337.5)).toBe(15);
    // 348.75+ arredonda de volta para 0 (sem salto de registro)
    expect(quantizeLookDir(355)).toBe(0);
    expect(quantizeLookDir(11)).toBe(0);
    expect(quantizeLookDir(12)).toBe(1);
  });

  it('nunca devolve resto negativo (JS % keeps dividend sign)', () => {
    expect(quantizeLookDir(-1)).toBeGreaterThanOrEqual(0);
    expect(quantizeLookDir(-22.5)).toBeGreaterThanOrEqual(0);
    expect(quantizeLookDir(-22.5)).toBeLessThan(16);
  });
});

describe('stickyQuantizeLookDir', () => {
  it('mantém lastDir na fronteira de setores (anti-flicker 0↔1)', () => {
    // Centro do dir 0 = 0°; half sticky ≈ 11.25+8 = 19.25°
    // 12° quantiza para 1 sem sticky, mas com lastDir=0 deve manter 0
    expect(stickyQuantizeLookDir(12, 0)).toBe(0);
    // Longe o suficiente da fatia 0 → pode mudar
    expect(stickyQuantizeLookDir(30, 0)).toBe(1);
  });

  it('angleDeltaDeg wrap', () => {
    expect(angleDeltaDeg(350, 10)).toBeCloseTo(20);
    expect(angleDeltaDeg(10, 350)).toBeCloseTo(-20);
  });
});

describe('sheetLookFrame', () => {
  it('dir 0-7 na linha A, 8-15 na linha B (colunas 0-7)', () => {
    expect(sheetLookFrame(0)).toEqual({ row: 9, col: 0 });
    expect(sheetLookFrame(7)).toEqual({ row: 9, col: 7 });
    expect(sheetLookFrame(8)).toEqual({ row: 10, col: 0 });
    expect(sheetLookFrame(15)).toEqual({ row: 10, col: 7 });
  });

  it('wrap defensivo fora do intervalo', () => {
    expect(sheetLookFrame(16)).toEqual({ row: 9, col: 0 });
    expect(sheetLookFrame(-1)).toEqual({ row: 10, col: 7 });
  });
});

describe('computeLookDir', () => {
  it('olha para o cursor longe', () => {
    expect(
      computeLookDir({ x: ANCHOR.x + 400, y: ANCHOR.y }, BOUNDS, OPTS),
    ).toBe(4);
  });

  it('cursor em cima do pet = null (idle)', () => {
    expect(
      computeLookDir(
        { x: ANCHOR.x + LOOK_NEAR_RADIUS_PX - 5, y: ANCHOR.y },
        BOUNDS,
        OPTS,
      ),
    ).toBeNull();
  });

  it('histerese: idle não entra no look até FAR, look só sai abaixo de NEAR', () => {
    // Entre NEAR e FAR: se já idle, continua idle
    const mid = LOOK_NEAR_RADIUS_PX + 10;
    expect(mid).toBeLessThan(LOOK_FAR_RADIUS_PX);
    expect(
      computeLookDir(
        { x: ANCHOR.x + mid, y: ANCHOR.y },
        BOUNDS,
        { ...OPTS, lastDir: null },
      ),
    ).toBeNull();
    // Se já olhava, mantém look (sticky distância)
    expect(
      computeLookDir(
        { x: ANCHOR.x + mid, y: ANCHOR.y },
        BOUNDS,
        { ...OPTS, lastDir: 4 },
      ),
    ).toBe(4);
    // Abaixo de NEAR com lastDir → idle
    expect(
      computeLookDir(
        { x: ANCHOR.x + LOOK_NEAR_RADIUS_PX - 5, y: ANCHOR.y },
        BOUNDS,
        { ...OPTS, lastDir: 4 },
      ),
    ).toBeNull();
  });

  it('cursor parado além do teto = null (volta a digitar)', () => {
    expect(
      computeLookDir({ x: ANCHOR.x + 400, y: ANCHOR.y }, BOUNDS, {
        cursorIdleMs: 5000,
        maxIdleMs: 4000,
      }),
    ).toBeNull();
  });
});
