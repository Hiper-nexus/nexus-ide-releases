import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NEXUS_N_CELLS, ICON_LAYOUT, renderAppIcon } from './build-app-icon-source.mjs';
import { decodePng } from './build-windows-icon.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FAVICON = resolve(ROOT, '..', 'nexus-site', 'public', 'favicon.svg');
const PINK = [0xff, 0x4f, 0x8b];
const INK = [0x08, 0x07, 0x09];

function pixel(image, x, y) {
  const i = (Math.floor(y) * image.width + Math.floor(x)) * 4;
  return [image.data[i], image.data[i + 1], image.data[i + 2], image.data[i + 3]];
}

describe('N pixel do Nexus (mesma logomarca do site)', () => {
  it('é a grade 4×4 do favicon: colunas das pontas cheias e a diagonal no meio', () => {
    const grid = Array.from({ length: 4 }, () => Array(4).fill('.'));
    for (const [col, row] of NEXUS_N_CELLS) grid[row][col] = '#';
    expect(grid.map((row) => row.join(''))).toEqual(['#..#', '##.#', '#.##', '#..#']);
  });

  // O site é um repositório irmão: onde ele não existe (CI), a conferência não se aplica.
  it.skipIf(!existsSync(FAVICON))('o favicon do site e o ícone do app desenham o mesmo N (grade 4×4 de células de 8)', () => {
    const svg = readFileSync(FAVICON, 'utf8');
    expect(svg).toContain('M16 16h8v8h8v8h8V16h8v32h-8v-8h-8v-8h-8v16h-8z');
  });
});

describe('ícone-fonte do app (1024×1024)', () => {
  const png = renderAppIcon();
  const image = decodePng(png);

  it('é 1024×1024 com cantos transparentes e miolo opaco, no recuo da grade do macOS', () => {
    expect([image.width, image.height]).toEqual([1024, 1024]);
    expect(pixel(image, 0, 0)[3]).toBe(0);
    expect(pixel(image, 1023, 1023)[3]).toBe(0);
    expect(pixel(image, ICON_LAYOUT.margin + 4, 512)[3]).toBe(255);
    expect(pixel(image, ICON_LAYOUT.margin - 4, 512)[3]).toBe(0);
  });

  it('o fundo é o near-black do site e o N é o rosa da marca', () => {
    expect(pixel(image, 512, ICON_LAYOUT.margin + 30).slice(0, 3)).toEqual(INK);
    const cell = ICON_LAYOUT.cell;
    const left = ICON_LAYOUT.glyphX;
    const top = ICON_LAYOUT.glyphY;
    expect(pixel(image, left + cell / 2, top + cell / 2).slice(0, 3)).toEqual(PINK);
    // célula vazia do N (linha 0, coluna 1) fica no fundo
    expect(pixel(image, left + cell * 1.5, top + cell / 2).slice(0, 3)).toEqual(INK);
  });

  it('o N fica centrado no ícone', () => {
    expect(ICON_LAYOUT.glyphX + (ICON_LAYOUT.cell * 4) / 2).toBe(512);
    expect(ICON_LAYOUT.glyphY + (ICON_LAYOUT.cell * 4) / 2).toBe(512);
  });

  it('o ícone versionado em assets/icon.png é exatamente o que o script gera', () => {
    // Compara a imagem, não os bytes: o deflate do zlib muda entre versões do
    // Node e o mesmo desenho saía com 15633 ou 15599 bytes, quebrando o teste
    // sem nenhum pixel diferente.
    const committed = decodePng(readFileSync(resolve(ROOT, 'assets', 'icon.png')));
    expect([committed.width, committed.height]).toEqual([image.width, image.height]);
    expect(Buffer.compare(Buffer.from(committed.data), Buffer.from(image.data))).toBe(0);
  });
});
