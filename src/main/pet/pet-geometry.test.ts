import { describe, expect, it } from 'vitest';
import {
  bestPetParkPosition,
  clampPetCoveredByDisplays,
  clampPetDrag,
  clampPetDragAcrossDisplays,
  clampPetDragFreeDesktop,
  clampPetFullyOnDisplay,
  clampToWorkArea,
  windowFullyOnDisplays,
  petCoversMainSidebar,
  petParkCornerCandidates,
  petWindowOverlapRatio,
  snapPetToCursorEdges,
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
  it('settle mantém toda a superfície transparente dentro do ecrã', () => {
    const loose = clampPetDrag({ x: -40, y: 100 }, SIZE, AREA, EDGE_OVERHANG);
    expect(loose.x).toBe(AREA.x);
    expect(loose.y).toBe(100);
  });

  it('remove overhang extremo que piscava o compositor', () => {
    const far = clampPetDrag({ x: -5000, y: -5000 }, SIZE, AREA, EDGE_OVERHANG);
    const oh = Math.min(
      EDGE_OVERHANG,
      Math.floor(SIZE.width / 3),
      Math.floor(SIZE.height / 3),
    );
    expect(far.x).toBe(AREA.x - oh);
    expect(far.y).toBe(AREA.y - oh);
    expect(oh).toBe(0);
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

describe('snapPetToCursorEdges', () => {
  const display = { x: -75, y: -1080, width: 1920, height: 1080 };
  const pet = { width: 380, height: 360 };

  it('encaixa exatamente no canto físico indicado pelo cursor', () => {
    expect(
      snapPetToCursorEdges(
        { x: 1200, y: -700 },
        pet,
        display,
        { x: 1844, y: -1 },
      ),
    ).toEqual({ x: 1465, y: -360 });
  });

  it('preserva uma posição interior quando o cursor está longe das bordas', () => {
    expect(
      snapPetToCursorEdges(
        { x: 600, y: -700 },
        pet,
        display,
        { x: 900, y: -500 },
      ),
    ).toEqual({ x: 600, y: -700 });
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

describe('windowFullyOnDisplays / clampPetCoveredByDisplays', () => {
  const pet = { width: 300, height: 340 };
  // Mac embutido + LG externa mais alta e deslocada para cima: a união é
  // um retângulo em L — há zona morta acima do Mac, à esquerda da LG.
  const mac = { x: 0, y: 0, width: 1440, height: 900 };
  const lg = { x: 1440, y: -100, width: 1920, height: 1080 };

  it('cobre janela inteira num display só', () => {
    expect(windowFullyOnDisplays({ x: 100, y: 100 }, pet, [mac])).toBe(true);
    // 1px fora da direita já é corte físico.
    expect(
      windowFullyOnDisplays({ x: 1440 - pet.width + 1, y: 100 }, pet, [mac]),
    ).toBe(false);
    // Topo da menubar é pixel físico — coberto.
    expect(windowFullyOnDisplays({ x: 0, y: 0 }, pet, [mac])).toBe(true);
  });

  it('cobre a cavalgadura na costura quando os displays se tocam', () => {
    // x 1300..1600: 140px no Mac + 160px na LG; mesma faixa Y coberta.
    expect(windowFullyOnDisplays({ x: 1300, y: 200 }, pet, [mac, lg])).toBe(
      true,
    );
  });

  it('recusa zona morta acima do Mac (só a LG chega lá)', () => {
    // y -80..260: slab -80..0 só tem a LG (x>=1440); left=1300 descoberto.
    expect(windowFullyOnDisplays({ x: 1300, y: -80 }, pet, [mac, lg])).toBe(
      false,
    );
  });

  it('recusa slab inferior fora da LG mais baixa', () => {
    const tall = { x: 1440, y: 0, width: 1440, height: 1200 };
    const short = { x: 0, y: 0, width: 1440, height: 900 };
    // Janela a cavalo descendo até y 1000: slab 900..1000 só existe na tall.
    expect(
      windowFullyOnDisplays({ x: 1300, y: 700 }, pet, [short, tall]),
    ).toBe(false);
    // Totalmente dentro da alta é válido (850+340=1190 ≤ 1200).
    expect(
      windowFullyOnDisplays({ x: 1500, y: 850 }, pet, [short, tall]),
    ).toBe(true);
  });

  it('clamp coberto mantém posição válida intacta', () => {
    const ok = { x: 1300, y: 200 };
    expect(clampPetCoveredByDisplays(ok, pet, [mac, lg])).toEqual(ok);
  });

  it('clamp coberto tira a janela da zona morta para o display mais perto', () => {
    const dead = { x: 1300, y: -80 };
    const out = clampPetCoveredByDisplays(dead, pet, [mac, lg]);
    expect(windowFullyOnDisplays(out, pet, [mac, lg])).toBe(true);
    // A LG é o mais perto: clamp ao Mac moveria x 1300→1140 E y -80→0
    // (32000), enquanto à LG só desliza x 1300→1440 (19600).
    expect(out).toEqual({ x: 1440, y: -80 });
  });

  it('clamp coberto alcança o pixel físico 0,0 (menubar)', () => {
    const out = clampPetCoveredByDisplays({ x: -500, y: -500 }, pet, [mac]);
    expect(out).toEqual({ x: 0, y: 0 });
  });
});
