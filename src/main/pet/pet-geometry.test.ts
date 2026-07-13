import { describe, expect, it } from 'vitest';
import {
  clampPetDrag,
  clampToWorkArea,
  snapToCorner,
  EDGE_OVERHANG,
  SNAP_MARGIN,
  SNAP_THRESHOLD,
} from './pet-geometry';

const AREA = { x: 0, y: 25, width: 1440, height: 875 };
const SIZE = { width: 240, height: 200 };

describe('clampToWorkArea', () => {
  it('mantém posição já visível intacta', () => {
    expect(clampToWorkArea({ x: 100, y: 100 }, SIZE, AREA)).toEqual({
      x: 100,
      y: 100,
    });
  });

  it('puxa de volta uma janela fora da borda direita/inferior', () => {
    expect(clampToWorkArea({ x: 5000, y: 5000 }, SIZE, AREA)).toEqual({
      x: AREA.x + AREA.width - SIZE.width,
      y: AREA.y + AREA.height - SIZE.height,
    });
  });

  it('respeita a origem da workArea (menu bar do macOS)', () => {
    expect(clampToWorkArea({ x: -50, y: 0 }, SIZE, AREA)).toEqual({
      x: 0,
      y: 25,
    });
  });

  it('não explode com display menor que a janela', () => {
    const tiny = { x: 0, y: 0, width: 100, height: 80 };
    expect(clampToWorkArea({ x: 40, y: 40 }, SIZE, tiny)).toEqual({ x: 0, y: 0 });
  });
});

describe('snapToCorner', () => {
  it('gruda no canto inferior-direito quando perto', () => {
    const nearCorner = {
      x: AREA.x + AREA.width - SIZE.width - SNAP_THRESHOLD + 1,
      y: AREA.y + AREA.height - SIZE.height - SNAP_THRESHOLD + 1,
    };
    expect(snapToCorner(nearCorner, SIZE, AREA)).toEqual({
      x: AREA.x + AREA.width - SIZE.width - SNAP_MARGIN,
      y: AREA.y + AREA.height - SIZE.height - SNAP_MARGIN,
    });
  });

  it('gruda no canto superior-esquerdo quando perto', () => {
    expect(snapToCorner({ x: 10, y: 30 }, SIZE, AREA)).toEqual({
      x: AREA.x + SNAP_MARGIN,
      y: AREA.y + SNAP_MARGIN,
    });
  });

  it('longe de qualquer canto, só clampa', () => {
    expect(snapToCorner({ x: 600, y: 400 }, SIZE, AREA)).toEqual({
      x: 600,
      y: 400,
    });
  });

  it('snap em um eixo só quando apenas ele está perto', () => {
    const pos = { x: 10, y: 400 };
    expect(snapToCorner(pos, SIZE, AREA)).toEqual({
      x: AREA.x + SNAP_MARGIN,
      y: 400,
    });
  });
});

describe('clampPetDrag', () => {
  it('permite overhang perto da borda (sprite pode chegar ao canto)', () => {
    // Ligeiramente fora à esquerda — strict clamp puxava a 0; loose mantém.
    const loose = clampPetDrag({ x: -40, y: 100 }, SIZE, AREA);
    expect(loose.x).toBe(-40);
    expect(loose.y).toBe(100);
  });

  it('ainda impede o pet de desaparecer completamente fora do ecrã', () => {
    const loose = clampPetDrag({ x: -5000, y: -5000 }, SIZE, AREA);
    // overhang capped at size/3 for this fixture
    const oh = Math.min(EDGE_OVERHANG, Math.floor(SIZE.width / 3), Math.floor(SIZE.height / 3));
    expect(loose.x).toBe(AREA.x - oh);
    expect(loose.y).toBe(AREA.y - oh);
  });

  it('mantém posição interior intacta', () => {
    expect(clampPetDrag({ x: 400, y: 300 }, SIZE, AREA)).toEqual({
      x: 400,
      y: 300,
    });
  });
});
