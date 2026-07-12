import { describe, expect, it } from 'vitest';
import { rgbaToGrid } from './pixelize';

function rgbaBuffer(
  size: number,
  fill: (x: number, y: number) => [number, number, number, number],
): Uint8ClampedArray {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = fill(x, y);
      const i = (y * size + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return data;
}

describe('rgbaToGrid', () => {
  it('converte cores opacas para #rrggbb minúsculo', () => {
    const grid = rgbaToGrid(rgbaBuffer(16, () => [255, 0, 68, 255]));
    expect(grid).toHaveLength(16);
    expect(grid[0]).toHaveLength(16);
    expect(grid[5][7]).toBe('#ff0044');
  });

  it('alpha abaixo do piso vira null (transparente)', () => {
    const grid = rgbaToGrid(
      rgbaBuffer(16, (x) => (x < 8 ? [10, 20, 30, 255] : [10, 20, 30, 40])),
    );
    expect(grid[3][2]).toBe('#0a141e');
    expect(grid[3][12]).toBeNull();
  });

  it('padding hex de canal de um dígito', () => {
    const grid = rgbaToGrid(rgbaBuffer(16, () => [1, 2, 3, 255]));
    expect(grid[0][0]).toBe('#010203');
  });

  it('rejeita buffer de tamanho errado', () => {
    expect(() => rgbaToGrid(new Uint8ClampedArray(10))).toThrow(/esperado/);
  });

  it('grade resultante passa no sanitizador de prefs (round-trip IPC)', async () => {
    const { sanitizePetPrefsPatch } = await import('../../shared/pet-types');
    const grid = rgbaToGrid(rgbaBuffer(16, () => [200, 150, 100, 255]));
    expect(sanitizePetPrefsPatch({ customGrid: grid }).customGrid).toEqual(grid);
  });
});
