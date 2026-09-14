/**
 * Gera `assets/icon.ico` a partir de `assets/icon.png`.
 *
 * O Windows não lê `.icns` nem `.png` para o ícone do app: ele exige um `.ico`
 * multi-resolução. Sem este arquivo o `MakerSquirrel` empacota um setup sem
 * ícone (ou falha), então ele é pré-requisito de qualquer artefato Windows.
 *
 * Sem dependência externa de propósito: `zlib` decodifica o PNG, um filtro de
 * caixa redimensiona, e o contêiner ICO é montado aqui. Assim o ícone é
 * reproduzível em qualquer máquina e em qualquer SO — inclusive no runner
 * Windows do CI, onde não há ImageMagick nem PIL.
 *
 * Formato: entradas DIB (`BITMAPINFOHEADER` + XOR BGRA + máscara AND) para os
 * tamanhos pequenos, que é o que todo utilitário de ícone produz e o que o
 * Shell do Windows espera; entrada PNG só em 256, onde o DIB ficaria grande
 * demais e o suporte a PNG é garantido desde o Vista.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { inflateSync, deflateSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/** Tamanhos que o Shell do Windows pede: lista pequena, jump list, alt-tab, 256. */
export const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256];

/** Acima disto vale PNG; abaixo, DIB (compatibilidade clássica). */
const PNG_ENTRY_MIN_SIZE = 256;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Decodifica um PNG de 8 bits por canal (RGB ou RGBA), sem entrelaçamento.
 * Devolve RGBA reto — o resto do pipeline só lida com um formato.
 */
export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('não é um PNG válido (assinatura ausente)');
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];

  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  if (bitDepth !== 8) throw new Error(`bit depth ${bitDepth} não suportado (só 8)`);
  if (interlace !== 0) throw new Error('PNG entrelaçado não suportado');
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : null;
  if (channels === null) {
    throw new Error(`color type ${colorType} não suportado (só 2=RGB e 6=RGBA)`);
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let previous = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride));

    unfilterLine(line, previous, filter, channels);

    for (let x = 0; x < width; x += 1) {
      const src = x * channels;
      const dst = (y * width + x) * 4;
      out[dst] = line[src];
      out[dst + 1] = line[src + 1];
      out[dst + 2] = line[src + 2];
      out[dst + 3] = channels === 4 ? line[src + 3] : 255;
    }
    previous = line;
  }

  return { width, height, data: out };
}

function unfilterLine(line, previous, filter, bpp) {
  switch (filter) {
    case 0:
      return;
    case 1:
      for (let i = bpp; i < line.length; i += 1) line[i] = (line[i] + line[i - bpp]) & 0xff;
      return;
    case 2:
      for (let i = 0; i < line.length; i += 1) line[i] = (line[i] + previous[i]) & 0xff;
      return;
    case 3:
      for (let i = 0; i < line.length; i += 1) {
        const left = i >= bpp ? line[i - bpp] : 0;
        line[i] = (line[i] + ((left + previous[i]) >> 1)) & 0xff;
      }
      return;
    case 4:
      for (let i = 0; i < line.length; i += 1) {
        const left = i >= bpp ? line[i - bpp] : 0;
        const upLeft = i >= bpp ? previous[i - bpp] : 0;
        line[i] = (line[i] + paeth(left, previous[i], upLeft)) & 0xff;
      }
      return;
    default:
      throw new Error(`filtro PNG desconhecido: ${filter}`);
  }
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Redimensiona por média de área (filtro de caixa). É o correto para reduzir
 * de 1024 para 16: cada pixel destino é a média dos pixels fonte que ele cobre,
 * então nada de serrilhado nem de pixel "escolhido a dedo".
 */
export function resizeRgba(source, sourceWidth, sourceHeight, targetSize) {
  const out = Buffer.alloc(targetSize * targetSize * 4);
  const scaleX = sourceWidth / targetSize;
  const scaleY = sourceHeight / targetSize;

  for (let y = 0; y < targetSize; y += 1) {
    const y0 = Math.floor(y * scaleY);
    const y1 = Math.min(sourceHeight, Math.max(y0 + 1, Math.floor((y + 1) * scaleY)));

    for (let x = 0; x < targetSize; x += 1) {
      const x0 = Math.floor(x * scaleX);
      const x1 = Math.min(sourceWidth, Math.max(x0 + 1, Math.floor((x + 1) * scaleX)));

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;

      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const i = (sy * sourceWidth + sx) * 4;
          // Pondera a cor pelo alfa: sem isso as bordas transparentes puxam a
          // média para o preto e o ícone ganha um halo escuro.
          const alpha = source[i + 3];
          r += source[i] * alpha;
          g += source[i + 1] * alpha;
          b += source[i + 2] * alpha;
          a += alpha;
          count += 1;
        }
      }

      const dst = (y * targetSize + x) * 4;
      if (a === 0) {
        out[dst] = 0;
        out[dst + 1] = 0;
        out[dst + 2] = 0;
        out[dst + 3] = 0;
      } else {
        out[dst] = Math.round(r / a);
        out[dst + 1] = Math.round(g / a);
        out[dst + 2] = Math.round(b / a);
        out[dst + 3] = Math.round(a / count);
      }
    }
  }

  return out;
}

/** Entrada DIB: BITMAPINFOHEADER + XOR BGRA (de baixo para cima) + máscara AND. */
export function encodeDibEntry(rgba, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // dobra: XOR + AND
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);

  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const sourceRow = size - 1 - y; // DIB grava de baixo para cima
    for (let x = 0; x < size; x += 1) {
      const src = (sourceRow * size + x) * 4;
      const dst = (y * size + x) * 4;
      xor[dst] = rgba[src + 2]; // B
      xor[dst + 1] = rgba[src + 1]; // G
      xor[dst + 2] = rgba[src]; // R
      xor[dst + 3] = rgba[src + 3]; // A
    }
  }

  // Máscara AND: 1 bit/pixel, linhas alinhadas em 4 bytes. Com alfa de 32 bits
  // o Windows ignora o conteúdo, mas o campo precisa existir com o tamanho certo.
  const maskStride = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskStride * size, 0);

  return Buffer.concat([header, xor, mask]);
}

/** Entrada PNG: um PNG RGBA comum, com CRC em cada chunk. */
export function encodePngEntry(rgba, width, height = width) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filtro None: simples e o deflate cuida do resto
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** Monta o contêiner ICO a partir de entradas já codificadas. */
export function assembleIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(16 * entries.length);
  let offset = header.length + directory.length;

  entries.forEach((entry, index) => {
    const at = index * 16;
    // 256 é gravado como 0: o campo só tem um byte.
    directory[at] = entry.size >= 256 ? 0 : entry.size;
    directory[at + 1] = entry.size >= 256 ? 0 : entry.size;
    directory[at + 2] = 0;
    directory[at + 3] = 0;
    directory.writeUInt16LE(1, at + 4);
    directory.writeUInt16LE(32, at + 6);
    directory.writeUInt32LE(entry.data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += entry.data.length;
  });

  return Buffer.concat([header, directory, ...entries.map((entry) => entry.data)]);
}

/** Lê o diretório de um ICO. Usado para conferir o que foi gerado. */
export function readIcoEntries(buffer) {
  const count = buffer.readUInt16LE(4);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    const at = 6 + index * 16;
    entries.push({
      size: buffer[at] === 0 ? 256 : buffer[at],
      bytes: buffer.readUInt32LE(at + 8),
      offset: buffer.readUInt32LE(at + 12),
    });
  }
  return entries;
}

export function buildIco(pngBuffer) {
  const source = decodePng(pngBuffer);
  return assembleIco(
    ICON_SIZES.map((size) => {
      const scaled = resizeRgba(source.data, source.width, source.height, size);
      const data =
        size >= PNG_ENTRY_MIN_SIZE
          ? encodePngEntry(scaled, size)
          : encodeDibEntry(scaled, size);
      return { size, data };
    }),
  );
}

function main() {
  const input = resolve(ROOT, 'assets/icon.png');
  const output = resolve(ROOT, 'assets/icon.ico');

  const ico = buildIco(readFileSync(input));
  writeFileSync(output, ico);

  // Confere o que foi escrito em vez de confiar no gerador.
  const written = readFileSync(output);
  const entries = readIcoEntries(written);
  const sizes = entries.map((entry) => entry.size);
  const expected = ICON_SIZES.join(',');
  if (sizes.join(',') !== expected) {
    throw new Error(`tamanhos inesperados no .ico: ${sizes.join(',')} (esperado ${expected})`);
  }
  for (const entry of entries) {
    if (entry.offset + entry.bytes > written.length) {
      throw new Error(`entrada de ${entry.size}px aponta para fora do arquivo`);
    }
  }

  console.log(
    `[icon] assets/icon.ico escrito — ${written.length} bytes, tamanhos: ${sizes.join(', ')}`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
