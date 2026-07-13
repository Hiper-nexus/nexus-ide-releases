import { describe, expect, it } from 'vitest';
import {
  bestPetParkPosition,
  clampPetDrag,
  clampPetDragAcrossDisplays,
  clampPetDragFreeDesktop,
  clampPetFullyOnDisplay,
  clampToWorkArea,
  petCoversMainSidebar,
  petParkCornerCandidates,
  petWindowOverlapRatio,
  snapToCorner,
  unionRects,
  windowIntersectsOffDisplay,
  windowStraddlesDisplays,
  EDGE_OVERHANG,
  PET_SIDEBAR_COVER_WIDTH,
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
  it('settle deixa o sprite chegar perto do canto (overhang moderado)', () => {
    const loose = clampPetDrag({ x: -40, y: 100 }, SIZE, AREA, EDGE_OVERHANG);
    expect(loose.x).toBe(-40);
    expect(loose.y).toBe(100);
  });

  it('ainda impede overhang extremo que piscava o compositor', () => {
    // Posição legada tipo x=-65 y=-86 com oh=120; com settle cap, puxa.
    const far = clampPetDrag({ x: -5000, y: -5000 }, SIZE, AREA, EDGE_OVERHANG);
    const oh = Math.min(
      EDGE_OVERHANG,
      Math.floor(SIZE.width / 3),
      Math.floor(SIZE.height / 3),
    );
    expect(far.x).toBe(AREA.x - oh);
    expect(far.y).toBe(AREA.y - oh);
    expect(oh).toBeLessThanOrEqual(40);
  });

  it('windowIntersectsOffDisplay deteta overhang físico', () => {
    const bounds = { x: 0, y: 0, width: 1440, height: 900 };
    expect(
      windowIntersectsOffDisplay({ x: -10, y: 100 }, SIZE, bounds),
    ).toBe(true);
    expect(
      windowIntersectsOffDisplay({ x: 100, y: 100 }, SIZE, bounds),
    ).toBe(false);
  });

  it('mantém posição interior intacta', () => {
    expect(clampPetDrag({ x: 400, y: 300 }, SIZE, AREA)).toEqual({
      x: 400,
      y: 300,
    });
  });

  it('clamp legado free-across ainda permite straddle (não usar no drag)', () => {
    const mac = { x: 0, y: 0, width: 1440, height: 900 };
    const lg = { x: 1440, y: -100, width: 1920, height: 1080 };
    const straddling = { x: 1300, y: 200 };
    expect(
      clampPetDragAcrossDisplays(straddling, SIZE, [mac, lg], 96),
    ).toEqual(straddling);
  });

  it('clampPetFullyOnDisplay: janela 100% num monitor', () => {
    const mac = { x: 0, y: 0, width: 1440, height: 900 };
    const clamped = clampPetFullyOnDisplay({ x: 1300, y: 200 }, SIZE, mac);
    expect(clamped.x).toBe(1440 - SIZE.width);
    expect(clamped.y).toBe(200);
  });

  it('clampPetDragFreeDesktop: atravessa Mac→LG sem parede', () => {
    const mac = { x: 0, y: 0, width: 1440, height: 900 };
    const lg = { x: 1440, y: -100, width: 1920, height: 1080 };
    const mid = { x: 1300, y: 200 };
    expect(clampPetDragFreeDesktop(mid, SIZE, [mac, lg], 96)).toEqual(mid);
    const onLg = { x: 2000, y: 50 };
    expect(clampPetDragFreeDesktop(onLg, SIZE, [mac, lg], 96)).toEqual(onLg);
    // minY=-100, maxY=max(900, 980)=980 → height 1080
    expect(unionRects([mac, lg])).toEqual({
      x: 0,
      y: -100,
      width: 3360,
      height: 1080,
    });
  });

  it('windowStraddlesDisplays deteta janela a cavalo', () => {
    const mac = { x: 0, y: 0, width: 1440, height: 900 };
    const lg = { x: 1440, y: 0, width: 1920, height: 1080 };
    expect(
      windowStraddlesDisplays({ x: 1300, y: 100 }, SIZE, [mac, lg]),
    ).toBe(true);
    expect(
      windowStraddlesDisplays({ x: 100, y: 100 }, SIZE, [mac, lg]),
    ).toBe(false);
  });
});

describe('bestPetParkPosition / sidebar cover', () => {
  const work = { x: 0, y: 25, width: 1440, height: 875 };
  const pet = { width: 380, height: 360 };

  it('sem obstáculos escolhe canto inferior-direito', () => {
    expect(bestPetParkPosition(pet, work, [])).toEqual({
      x: work.x + work.width - pet.width - SNAP_MARGIN,
      y: work.y + work.height - pet.height - SNAP_MARGIN,
    });
  });

  it('IDE maximizado: ainda prefere BR (não o explorer à esquerda)', () => {
    const main = { x: 0, y: 25, width: 1440, height: 875 };
    const park = bestPetParkPosition(pet, work, [main]);
    expect(park.x).toBe(work.x + work.width - pet.width - SNAP_MARGIN);
    expect(park.y).toBe(work.y + work.height - pet.height - SNAP_MARGIN);
  });

  it('IDE só na esquerda: prefere canto à direita do ecrã', () => {
    const main = { x: 0, y: 25, width: 700, height: 875 };
    const park = bestPetParkPosition(pet, work, [main]);
    // BR e TR não sobrepõem o main (main termina em x=700; pet BR em ~1048).
    expect(park.x).toBeGreaterThan(700);
  });

  it('petCoversMainSidebar deteta pet sobre a árvore de ficheiros', () => {
    const main = { x: 0, y: 0, width: 1440, height: 900 };
    // Canto superior-esquerdo do IDE = explorer.
    expect(
      petCoversMainSidebar(
        { x: 20, y: 80 },
        pet,
        main,
        PET_SIDEBAR_COVER_WIDTH,
      ),
    ).toBe(true);
    // Canto inferior-direito = chat/status, não explorer.
    expect(
      petCoversMainSidebar(
        {
          x: 1440 - pet.width - 12,
          y: 900 - pet.height - 12,
        },
        pet,
        main,
        PET_SIDEBAR_COVER_WIDTH,
      ),
    ).toBe(false);
  });

  it('petWindowOverlapRatio mede fração coberta', () => {
    const obstacle = { x: 0, y: 0, width: 200, height: 200 };
    // Pet 380×360 totalmente fora.
    expect(
      petWindowOverlapRatio({ x: 500, y: 500 }, pet, [obstacle]),
    ).toBe(0);
    // Pet no canto sobre o obstáculo 200×200.
    const ratio = petWindowOverlapRatio({ x: 0, y: 0 }, pet, [obstacle]);
    expect(ratio).toBeCloseTo((200 * 200) / (380 * 360), 5);
  });

  it('workArea minúscula: candidatos park não rebentam (right < left)', () => {
    const tiny = { x: 0, y: 0, width: 200, height: 150 };
    const candidates = petParkCornerCandidates(pet, tiny);
    expect(candidates).toHaveLength(4);
    for (const c of candidates) {
      expect(Number.isFinite(c.x)).toBe(true);
      expect(Number.isFinite(c.y)).toBe(true);
      // Todos colapsam para o único ponto clampável.
      expect(c).toEqual(clampToWorkArea(c, pet, tiny));
    }
    expect(bestPetParkPosition(pet, tiny, [])).toEqual(candidates[0]);
  });

  it('unionRects + free desktop atravessam costura multi-monitor', () => {
    const mac = { x: 0, y: 0, width: 1440, height: 900 };
    const lg = { x: 1440, y: -100, width: 1920, height: 1080 };
    const union = unionRects([mac, lg]);
    expect(union.x).toBe(0);
    expect(union.y).toBe(-100);
    expect(union.width).toBe(1440 + 1920);
    // Straddle: free permite; fully-on não.
    const straddle = { x: 1300, y: 200 };
    expect(
      clampPetDragFreeDesktop(straddle, pet, [mac, lg], 96),
    ).toEqual(straddle);
    expect(clampPetFullyOnDisplay(straddle, pet, mac).x).toBe(
      mac.width - pet.width,
    );
  });
});
