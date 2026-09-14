import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ICON_SIZES,
  assembleIco,
  buildIco,
  decodePng,
  encodeDibEntry,
  encodePngEntry,
  readIcoEntries,
  resizeRgba,
} from './build-windows-icon.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Imagem RGBA sintética, com alfa variando — exercita a ponderação. */
function makeRgba(size, painter) {
  const data = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = painter(x, y);
      const i = (y * size + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return data;
}

describe('decodePng', () => {
  it('recupera exatamente os pixels que foram codificados', () => {
    // Arrange
    const original = makeRgba(8, (x, y) => [x * 30, y * 30, 128, 255 - x * 20]);
    const png = encodePngEntry(original, 8, 8);

    // Act
    const decoded = decodePng(png);

    // Assert
    expect(decoded.width).toBe(8);
    expect(decoded.height).toBe(8);
    expect(decoded.data.equals(original)).toBe(true);
  });

  it('recusa arquivo que não é PNG', () => {
    expect(() => decodePng(Buffer.from('nao sou um png'))).toThrow(/assinatura/);
  });
});

describe('resizeRgba', () => {
  it('devolve um quadrado do tamanho pedido', () => {
    const source = makeRgba(16, () => [200, 100, 50, 255]);

    const scaled = resizeRgba(source, 16, 16, 4);

    expect(scaled.length).toBe(4 * 4 * 4);
  });

  it('preserva a cor chapada ao reduzir', () => {
    // Uma cor uniforme tem que sobreviver à média: se a ponderação por alfa
    // estivesse errada, o resultado escureceria em direção ao preto.
    const source = makeRgba(16, () => [200, 100, 50, 255]);

    const scaled = resizeRgba(source, 16, 16, 4);

    expect([scaled[0], scaled[1], scaled[2], scaled[3]]).toEqual([200, 100, 50, 255]);
  });

  it('ignora o RGB de pixels totalmente transparentes', () => {
    // Metade opaca vermelha, metade transparente com RGB branco por baixo. O
    // resultado tem que ser o vermelho, não um rosa puxado pelo branco oculto.
    const source = makeRgba(4, (x) => (x < 2 ? [255, 0, 0, 255] : [255, 255, 255, 0]));

    const scaled = resizeRgba(source, 4, 4, 1);

    expect([scaled[0], scaled[1], scaled[2]]).toEqual([255, 0, 0]);
  });

  it('zera completamente quando a fonte é toda transparente', () => {
    const source = makeRgba(4, () => [10, 20, 30, 0]);

    const scaled = resizeRgba(source, 4, 4, 2);

    expect([...scaled]).toEqual(new Array(2 * 2 * 4).fill(0));
  });
});

describe('encodeDibEntry', () => {
  it('grava um BITMAPINFOHEADER com altura dobrada', () => {
    const rgba = makeRgba(2, () => [1, 2, 3, 255]);

    const dib = encodeDibEntry(rgba, 2);

    expect(dib.readUInt32LE(0)).toBe(40); // biSize
    expect(dib.readInt32LE(4)).toBe(2); // biWidth
    expect(dib.readInt32LE(8)).toBe(4); // biHeight dobrada (XOR + AND)
    expect(dib.readUInt16LE(14)).toBe(32); // biBitCount
  });

  it('grava as linhas de baixo para cima em BGRA', () => {
    // Linha 0 da fonte é vermelha, linha 1 é azul. O DIB guarda a linha 1
    // primeiro, então o primeiro pixel do arquivo tem que ser azul.
    const rgba = makeRgba(2, (_x, y) => (y === 0 ? [255, 0, 0, 255] : [0, 0, 255, 255]));

    const dib = encodeDibEntry(rgba, 2);

    expect([dib[40], dib[41], dib[42], dib[43]]).toEqual([255, 0, 0, 255]);
    expect([dib[48], dib[49], dib[50], dib[51]]).toEqual([0, 0, 255, 255]);
  });

  it('reserva a máscara AND com linhas alinhadas em 4 bytes', () => {
    // 48px → 48 bits = 6 bytes, que sobem para 8 no alinhamento de 4.
    const maskStride = 8;
    const dib = encodeDibEntry(makeRgba(48, () => [0, 0, 0, 0]), 48);

    expect(dib.length).toBe(40 + 48 * 48 * 4 + maskStride * 48);
  });
});

describe('assembleIco', () => {
  it('aponta cada entrada para o próprio bloco, sem sobreposição', () => {
    const entries = [
      { size: 16, data: Buffer.alloc(10, 1) },
      { size: 32, data: Buffer.alloc(20, 2) },
    ];

    const ico = assembleIco(entries);
    const read = readIcoEntries(ico);

    expect(read.map((entry) => entry.size)).toEqual([16, 32]);
    expect(read[0].offset).toBe(6 + 16 * 2);
    expect(read[1].offset).toBe(6 + 16 * 2 + 10);
    expect(ico.subarray(read[1].offset, read[1].offset + 20).equals(Buffer.alloc(20, 2))).toBe(true);
  });

  it('grava 256 como 0, porque o campo só tem um byte', () => {
    const ico = assembleIco([{ size: 256, data: Buffer.alloc(4) }]);

    expect(ico[6]).toBe(0);
    expect(ico[7]).toBe(0);
    expect(readIcoEntries(ico)[0].size).toBe(256);
  });
});

describe('buildIco', () => {
  it('produz uma entrada por tamanho, dentro dos limites do arquivo', () => {
    const source = encodePngEntry(makeRgba(64, (x, y) => [x * 4, y * 4, 90, 255]), 64, 64);

    const ico = buildIco(source);
    const entries = readIcoEntries(ico);

    expect(entries.map((entry) => entry.size)).toEqual(ICON_SIZES);
    for (const entry of entries) {
      expect(entry.offset + entry.bytes).toBeLessThanOrEqual(ico.length);
    }
  });

  it('usa DIB nos tamanhos pequenos e PNG em 256', () => {
    // A mistura é deliberada: DIB é o que o Shell espera nos tamanhos pequenos,
    // e PNG evita um bloco de 256KB na entrada maior.
    const source = encodePngEntry(makeRgba(64, () => [10, 10, 10, 255]), 64, 64);

    const ico = buildIco(source);
    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

    for (const entry of readIcoEntries(ico)) {
      const isPng = ico.subarray(entry.offset, entry.offset + 4).equals(pngSignature);
      expect(isPng).toBe(entry.size >= 256);
    }
  });

  it('gera um .ico válido a partir do ícone real do repositório', () => {
    const ico = buildIco(readFileSync(resolve(ROOT, 'assets/icon.png')));
    const entries = readIcoEntries(ico);

    expect(entries.map((entry) => entry.size)).toEqual(ICON_SIZES);
    // Toda entrada precisa decodificar de volta — é o que o Windows vai fazer.
    for (const entry of entries) {
      const block = ico.subarray(entry.offset, entry.offset + entry.bytes);
      if (entry.size >= 256) {
        expect(decodePng(block).width).toBe(entry.size);
      } else {
        expect(block.readUInt32LE(0)).toBe(40);
        expect(block.readInt32LE(8)).toBe(entry.size * 2);
      }
    }
  });
});
