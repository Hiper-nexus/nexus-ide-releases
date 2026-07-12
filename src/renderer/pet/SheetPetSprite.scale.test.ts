import { describe, expect, it } from 'vitest';
import { integerSheetScale } from './SheetPetSprite';

describe('integerSheetScale', () => {
  it('usa 2× quando o alvo cabe duas células', () => {
    expect(integerSheetScale(192, 208, 416)).toEqual({
      scale: 2,
      displayW: 384,
      displayH: 416,
      integer: true,
    });
  });

  it('meio-termo (ex. 260) encaixa no alvo sem forçar 2×', () => {
    const r = integerSheetScale(192, 208, 260);
    expect(r.displayH).toBe(260);
    expect(r.displayW).toBe(Math.round((192 / 208) * 260));
    expect(r.integer).toBe(true); // nearest, não blur
  });

  it('1× exacto quando o alvo é a altura da célula', () => {
    expect(integerSheetScale(192, 208, 208)).toEqual({
      scale: 1,
      displayW: 192,
      displayH: 208,
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
