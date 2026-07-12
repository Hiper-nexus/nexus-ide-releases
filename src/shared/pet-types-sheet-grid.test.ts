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

  it('não força 11 linhas em altura só quase divisível', () => {
    // 1872 % 11 === 2 — se forçasse 11, cortaria o personagem
    expect(detectSheetGrid(1536, 1872).rows).not.toBe(11);
  });
});
