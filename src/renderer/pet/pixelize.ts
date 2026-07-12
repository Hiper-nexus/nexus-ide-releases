import {
  PET_CUSTOM_GRID_SIZE,
  type PetCustomGrid,
} from '../../shared/pet-types';

/**
 * Pixelização local de uma imagem do usuário em uma grade 16×16 — o "pet
 * personalizado" sem nuvem nem chave de API: a imagem nunca sai da máquina.
 * A parte pura (RGBA → grade de hex) é testável; a leitura do arquivo usa
 * canvas e fica na borda DOM.
 */

const ALPHA_FLOOR = 128;

function toHexByte(value: number): string {
  return value.toString(16).padStart(2, '0');
}

/**
 * Converte um buffer RGBA de exatamente gridSize×gridSize pixels na grade de
 * células (`#rrggbb` ou null para transparente).
 */
export function rgbaToGrid(
  data: Uint8ClampedArray | readonly number[],
  gridSize: number = PET_CUSTOM_GRID_SIZE,
): PetCustomGrid {
  const expected = gridSize * gridSize * 4;
  if (data.length !== expected) {
    throw new Error(
      `rgbaToGrid: esperado ${expected} bytes (${gridSize}×${gridSize} RGBA), recebi ${data.length}`,
    );
  }
  const grid: PetCustomGrid = [];
  for (let y = 0; y < gridSize; y += 1) {
    const row: (string | null)[] = [];
    for (let x = 0; x < gridSize; x += 1) {
      const i = (y * gridSize + x) * 4;
      const alpha = data[i + 3];
      if (alpha < ALPHA_FLOOR) {
        row.push(null);
      } else {
        row.push(`#${toHexByte(data[i])}${toHexByte(data[i + 1])}${toHexByte(data[i + 2])}`);
      }
    }
    grid.push(row);
  }
  return grid;
}

/**
 * Lê um arquivo de imagem, faz center-crop quadrado e reamostra para a grade
 * do pet. Borda DOM fina — a conversão de cor fica em rgbaToGrid.
 */
export async function imageFileToGrid(file: Blob): Promise<PetCustomGrid> {
  const bitmap = await createImageBitmap(file);
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const sx = (bitmap.width - side) / 2;
    const sy = (bitmap.height - side) / 2;
    const canvas = document.createElement('canvas');
    canvas.width = PET_CUSTOM_GRID_SIZE;
    canvas.height = PET_CUSTOM_GRID_SIZE;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('canvas 2d indisponível');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(
      bitmap,
      sx,
      sy,
      side,
      side,
      0,
      0,
      PET_CUSTOM_GRID_SIZE,
      PET_CUSTOM_GRID_SIZE,
    );
    const image = ctx.getImageData(
      0,
      0,
      PET_CUSTOM_GRID_SIZE,
      PET_CUSTOM_GRID_SIZE,
    );
    return rgbaToGrid(image.data);
  } finally {
    bitmap.close();
  }
}
