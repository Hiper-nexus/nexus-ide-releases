import { describe, expect, it } from 'vitest';
import { detectSheetGrid } from './pet-types';

describe('detectSheetGrid', () => {
  it('reconhece Codex v2 completo 8×11', () => {
    expect(detectSheetGrid(1536, 2288)).toEqual({ cols: 8, rows: 11 });
  });

  it('reconhece pack petdex 8×9 (1536×1872)', () => {
    expect(detectSheetGrid(1536, 1872)).toEqual({ cols: 8, rows: 9 });
  });

  it('reconhece meia-resolução petdex 8×9 (768×936)', () => {
    expect(detectSheetGrid(768, 936)).toEqual({ cols: 8, rows: 9 });
  });

  it('não força 11 linhas só porque divide (935÷11=85, célula errada)', () => {
    // 768×935 divide em 11, mas a razão da célula não é a canônica 192:208
    const grid = detectSheetGrid(768, 935);
    expect(grid.cols).toBe(8);
    // Deve preferir razão próxima de 104px de altura (96*(208/192)), não 85
    const cellH = 935 / grid.rows;
    expect(Math.abs(cellH - 104)).toBeLessThan(Math.abs(85 - 104));
  });

  it('não força 11 em 1536×1872 (petdex)', () => {
    expect(detectSheetGrid(1536, 1872).rows).toBe(9);
  });
});
