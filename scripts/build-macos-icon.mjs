/**
 * Gera `assets/icon.icns` a partir de `assets/icon.png` sem depender de uma
 * máquina macOS. As entradas modernas do ICNS carregam PNGs comuns, então o
 * mesmo raster canônico que alimenta o ICO do Windows mantém a identidade
 * visual idêntica nos três sistemas operacionais.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodePng, encodePngEntry, resizeRgba } from './build-windows-icon.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/**
 * Legacy/base plus Retina ICNS keys. Repeating a size in its Retina semantic
 * slot is intentional: it lets Finder pick the sharpest appropriate rendition
 * on old and current macOS versions without requiring iconutil on Windows.
 */
export const ICNS_PNG_ENTRIES = [
  { type: 'icp4', size: 16 },
  { type: 'icp5', size: 32 },
  { type: 'icp6', size: 64 },
  { type: 'ic07', size: 128 },
  { type: 'ic08', size: 256 },
  { type: 'ic09', size: 512 },
  { type: 'ic10', size: 1024 },
  { type: 'ic11', size: 32 },
  { type: 'ic12', size: 64 },
  { type: 'ic13', size: 256 },
  { type: 'ic14', size: 512 },
];

const SIZE_BY_TYPE = new Map(ICNS_PNG_ENTRIES.map((entry) => [entry.type, entry.size]));

export function buildIcns(pngBuffer) {
  const source = decodePng(pngBuffer);
  const chunks = ICNS_PNG_ENTRIES.map(({ type, size }) => {
    const png = encodePngEntry(
      resizeRgba(source.data, source.width, source.height, size),
      size,
    );
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, 'ascii');
    header.writeUInt32BE(header.length + png.length, 4);
    return Buffer.concat([header, png]);
  });
  const container = Buffer.alloc(8);
  container.write('icns', 0, 4, 'ascii');
  container.writeUInt32BE(container.length + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
  return Buffer.concat([container, ...chunks]);
}

/** Parses and bounds-checks a modern PNG-backed ICNS container. */
export function readIcnsEntries(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'icns') {
    throw new Error('não é um ICNS válido (assinatura ausente)');
  }
  const declaredLength = buffer.readUInt32BE(4);
  if (declaredLength !== buffer.length) {
    throw new Error(`ICNS tem tamanho declarado inválido: ${declaredLength}`);
  }

  const entries = [];
  let offset = 8;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) throw new Error('cabeçalho ICNS truncado');
    const type = buffer.toString('ascii', offset, offset + 4);
    const bytes = buffer.readUInt32BE(offset + 4);
    if (bytes < 8 || offset + bytes > buffer.length) {
      throw new Error(`entrada ICNS inválida: ${type}`);
    }
    const size = SIZE_BY_TYPE.get(type);
    if (!size) throw new Error(`tipo ICNS não suportado: ${type}`);
    const png = decodePng(buffer.subarray(offset + 8, offset + bytes));
    entries.push({
      type,
      size,
      bytes: bytes - 8,
      offset: offset + 8,
      width: png.width,
      height: png.height,
    });
    offset += bytes;
  }
  return entries;
}

function main() {
  const input = resolve(ROOT, 'assets/icon.png');
  const output = resolve(ROOT, 'assets/icon.icns');
  const icns = buildIcns(readFileSync(input));
  writeFileSync(output, icns);

  const entries = readIcnsEntries(readFileSync(output));
  const sizes = entries.map((entry) => entry.size).join(', ');
  console.log(`[icon] assets/icon.icns escrito — ${icns.length} bytes, tamanhos: ${sizes}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
