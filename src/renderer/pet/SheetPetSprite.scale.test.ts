import { describe, expect, it } from 'vitest';
import { integerSheetScale } from './SheetPetSprite';

describe('integerSheetScale', () => {
  it('usa 2× quando o alvo cabe duas células (paridade Codex desktop)', () => {
    expect(integerSheetScale(192, 208, 416)).toEqual({
      scale: 2,
      displayW: 384,
      displayH: 416,
      integer: true,
    });
  });

  it('não usa escala fracionária no desktop (240 → 1×, não 1.15×)', () => {
    // Antigo SHEET_SIZE=240 emburrava pixel art; agora trava em 1× = 208.
    expect(integerSheetScale(192, 208, 240)).toEqual({
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
