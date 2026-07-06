import { describe, expect, it } from 'vitest';
import { fmt, OPERATOR_GRID, paletteFor } from './operator-sprite-data';

describe('OPERATOR_GRID', () => {
  it('é 16×16 e só usa índices válidos da paleta (0–5)', () => {
    expect(OPERATOR_GRID).toHaveLength(16);
    for (const row of OPERATOR_GRID) {
      expect(row).toHaveLength(16);
      for (const cell of row) {
        expect(Number.isInteger(cell)).toBe(true);
        expect(cell).toBeGreaterThanOrEqual(0);
        expect(cell).toBeLessThan(6);
      }
    }
  });

  it('usa os slots semânticos (visor, acento e aura aparecem no desenho)', () => {
    const used = new Set(OPERATOR_GRID.flat());
    expect(used.has(3)).toBe(true); // visor
    expect(used.has(4)).toBe(true); // acento
    expect(used.has(5)).toBe(true); // aura
  });
});

describe('paletteFor', () => {
  it('retorna 6 cores e varia por tier (aura cresce)', () => {
    const recruta = paletteFor('RECRUTA', 'base', null);
    const maestro = paletteFor('MAESTRO', 'base', null);
    expect(recruta).toHaveLength(6);
    expect(maestro).toHaveLength(6);
    for (const color of maestro) expect(color.length).toBeGreaterThan(0);
    expect(recruta).not.toEqual(maestro);
  });

  it('varia por ramo (guardião vs forja têm corpo/acento próprios)', () => {
    const guardiao = paletteFor('VETERANO', 'guardiao', null);
    const forja = paletteFor('VETERANO', 'forja', null);
    expect(guardiao[1]).not.toBe(forja[1]);
    expect(guardiao[4]).not.toBe(forja[4]);
  });

  it('skin sobrepõe a paleta (gold muda o acento)', () => {
    const semSkin = paletteFor('RECRUTA', 'base', null);
    const gold = paletteFor('RECRUTA', 'base', 'gold');
    expect(gold[4]).not.toBe(semSkin[4]);
    // skin desconhecida = ignorada (paleta do ramo/tier)
    expect(paletteFor('RECRUTA', 'base', 'inexistente')).toEqual(semSkin);
  });
});

describe('fmt', () => {
  it('formata potência em unidades compactas', () => {
    expect(fmt(0)).toBe('0');
    expect(fmt(999)).toBe('999');
    expect(fmt(1_500)).toBe('1.5K');
    expect(fmt(100_000)).toBe('100K');
    expect(fmt(1_000_000)).toBe('1M');
    expect(fmt(35_500_000)).toBe('35.5M');
  });
});
