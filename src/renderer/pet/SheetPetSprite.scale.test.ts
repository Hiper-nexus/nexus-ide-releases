import { describe, expect, it } from 'vitest';
import { integerSheetScale } from './SheetPetSprite';

describe('integerSheetScale', () => {
  it('full-res (192×208): 2× com smooth (não pixelated)', () => {
    expect(integerSheetScale(192, 208, 416)).toEqual({
      scale: 2,
      displayW: 384,
      displayH: 416,
      integer: false,
    });
  });

  it('meio-termo full-res (260) encaixa com smooth high', () => {
    const r = integerSheetScale(192, 208, 260);
    expect(r.displayH).toBe(260);
    expect(r.displayW).toBe(Math.round((192 / 208) * 260));
    expect(r.integer).toBe(false);
  });

  it('1× full-res exacto', () => {
    expect(integerSheetScale(192, 208, 208)).toEqual({
      scale: 1,
      displayW: 192,
      displayH: 208,
      integer: false,
    });
  });

  it('pixel-art pequena: nearest / integer', () => {
    expect(integerSheetScale(16, 16, 32)).toEqual({
      scale: 2,
      displayW: 32,
      displayH: 32,
      integer: true,
    });
  });

  it('encolhe para preview de biblioteca (< célula)', () => {
    const r = integerSheetScale(192, 208, 56);
    expect(r.integer).toBe(false);
    expect(r.displayH).toBe(56);
    expect(r.displayW).toBe(Math.round((192 / 208) * 56));
  });
});
