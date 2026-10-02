/**
 * Nexus Redline (Linux) — ícone da bandeja gerado em código.
 *
 * O projeto não carrega asset de bandeja (o ícone do app mora fora do asar) e
 * a bandeja precisa mudar de cor com a urgência; então o ícone é desenhado
 * aqui e entregue como PNG (`nativeImage.createFromBuffer`). Sem canvas, sem
 * dependência: raster próprio com super-amostragem 4×4 e `zlib`.
 *
 * Visual espelhado do Windows (`makeTrayIcon`): placa clara arredondada, que
 * lê bem em painel escuro e claro (Waybar, GNOME, KDE), com o losango da
 * marca (rosa à esquerda, ciano à direita) e um ponto no canto com a tinta da
 * urgência. Dado velho vaza o ponto (anel vazio). Não existe "template image"
 * no Linux (é recurso do macOS), então não há variante monocromática.
 */

import { deflateSync } from 'node:zlib';
import type { RedlineUrgency } from './redline-tray-model';

export interface RedlineIconBitmap {
  width: number;
  height: number;
  /** RGBA, linha a linha, alfa NÃO pré-multiplicado. */
  rgba: Uint8Array;
}

/** 64 px: nítido em 22/24/32 px com escala dupla, e leve (poucos KB). */
export const RENDERED_ICON_SIZE = 64;
const MIN_SIZE = 8;
const MAX_SIZE = 512;
/** Grade de desenho: as mesmas 32 unidades do ícone do Windows. */
const GRID = 32;
const SUPERSAMPLE = 4;

type Rgb = readonly [number, number, number];

const PLATE: Rgb = [0xf6, 0xf3, 0xf8];
const PINK: Rgb = [0xff, 0x4f, 0x8b];
const CYAN: Rgb = [0x3c, 0xd0, 0xff];
const URGENCY_INK: Record<RedlineUrgency, Rgb> = {
  ok: [0x2e, 0xb7, 0x5e],
  warn: [0xe5, 0xc0, 0x7b],
  danger: [0xff, 0x6b, 0x4a],
  unknown: [0x88, 0x8a, 0x8f],
};

const PLATE_RADIUS = 8;
const DIAMOND_CENTER = { x: 16, y: 15 } as const;
const DIAMOND_INNER = 3;
const DIAMOND_OUTER = 8;
const DOT_CENTER = { x: 24, y: 24 } as const;
const DOT_RADIUS = 5;
const DOT_HOLLOW_RADIUS = 3;

function insidePlate(ux: number, uy: number): boolean {
  if (ux < 0 || uy < 0 || ux > GRID || uy > GRID) return false;
  const nearestX = Math.min(Math.max(ux, PLATE_RADIUS), GRID - PLATE_RADIUS);
  const nearestY = Math.min(Math.max(uy, PLATE_RADIUS), GRID - PLATE_RADIUS);
  const dx = ux - nearestX;
  const dy = uy - nearestY;
  return dx * dx + dy * dy <= PLATE_RADIUS * PLATE_RADIUS;
}

/** Cor do topo da pilha (ponto > losango > placa) numa amostra, ou null. */
function sampleColor(ux: number, uy: number, ink: Rgb, stale: boolean): Rgb | null {
  const dotDx = ux - DOT_CENTER.x;
  const dotDy = uy - DOT_CENTER.y;
  const dotD2 = dotDx * dotDx + dotDy * dotDy;
  const hollow = stale && dotD2 <= DOT_HOLLOW_RADIUS * DOT_HOLLOW_RADIUS;
  if (dotD2 <= DOT_RADIUS * DOT_RADIUS && !hollow) return ink;

  const manhattan = Math.abs(ux - DIAMOND_CENTER.x) + Math.abs(uy - DIAMOND_CENTER.y);
  if (manhattan >= DIAMOND_INNER && manhattan <= DIAMOND_OUTER) {
    return ux < DIAMOND_CENTER.x ? PINK : CYAN;
  }
  return insidePlate(ux, uy) ? PLATE : null;
}

export function renderRedlineTrayIcon(
  urgency: RedlineUrgency,
  stale: boolean,
  size: number = RENDERED_ICON_SIZE,
): RedlineIconBitmap {
  if (!Number.isInteger(size) || size < MIN_SIZE || size > MAX_SIZE) {
    throw new RangeError(`tamanho de ícone inválido: ${size}`);
  }
  const ink = URGENCY_INK[urgency];
  const rgba = new Uint8Array(size * size * 4);
  const samples = SUPERSAMPLE * SUPERSAMPLE;
  const unitsPerPixel = GRID / size;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let covered = 0;
      let red = 0;
      let green = 0;
      let blue = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const ux = (x + (sx + 0.5) / SUPERSAMPLE) * unitsPerPixel;
          const uy = (y + (sy + 0.5) / SUPERSAMPLE) * unitsPerPixel;
          const color = sampleColor(ux, uy, ink, stale);
          if (color === null) continue;
          covered += 1;
          red += color[0];
          green += color[1];
          blue += color[2];
        }
      }
      if (covered === 0) continue;
      const offset = (y * size + x) * 4;
      rgba[offset] = Math.round(red / covered);
      rgba[offset + 1] = Math.round(green / covered);
      rgba[offset + 2] = Math.round(blue / covered);
      rgba[offset + 3] = Math.round((covered / samples) * 255);
    }
  }
  return { width: size, height: size, rgba };
}

// ── PNG ─────────────────────────────────────────────────────────────────────

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

/** RGBA 8 bits, sem entrelaçamento, filtro 0 em todas as linhas. */
export function encodePng(bitmap: RedlineIconBitmap): Buffer {
  const { width, height, rgba } = bitmap;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError('dimensões de PNG inválidas');
  }
  if (rgba.length !== width * height * 4) {
    throw new RangeError('buffer RGBA não bate com as dimensões');
  }
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, rowStart + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // profundidade
  header[9] = 6; // RGBA
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function redlineTrayIconPng(
  urgency: RedlineUrgency,
  stale: boolean,
  size: number = RENDERED_ICON_SIZE,
): Buffer {
  return encodePng(renderRedlineTrayIcon(urgency, stale, size));
}
