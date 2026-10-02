import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  RENDERED_ICON_SIZE,
  encodePng,
  redlineTrayIconPng,
  renderRedlineTrayIcon,
  type RedlineIconBitmap,
} from './redline-tray-icon';

const PLATE = [0xf6, 0xf3, 0xf8, 0xff];
const PINK = [0xff, 0x4f, 0x8b, 0xff];
const CYAN = [0x3c, 0xd0, 0xff, 0xff];
const INK = {
  ok: [0x2e, 0xb7, 0x5e, 0xff],
  warn: [0xe5, 0xc0, 0x7b, 0xff],
  danger: [0xff, 0x6b, 0x4a, 0xff],
  unknown: [0x88, 0x8a, 0x8f, 0xff],
} as const;

/** Pixel na coordenada de um grid de 32 unidades (a mesma do ícone do Windows). */
function at(icon: RedlineIconBitmap, ux: number, uy: number): number[] {
  const scale = icon.width / 32;
  const x = Math.floor(ux * scale);
  const y = Math.floor(uy * scale);
  const i = (y * icon.width + x) * 4;
  return Array.from(icon.rgba.slice(i, i + 4));
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readChunks(png: Buffer): Array<{ type: string; data: Buffer; crcOk: boolean }> {
  const chunks: Array<{ type: string; data: Buffer; crcOk: boolean }> = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('latin1');
    const data = png.subarray(offset + 8, offset + 8 + length);
    const crc = png.readUInt32BE(offset + 8 + length);
    const expected = crc32(png.subarray(offset + 4, offset + 8 + length));
    chunks.push({ type, data, crcOk: crc === expected });
    offset += 12 + length;
  }
  return chunks;
}

describe('renderRedlineTrayIcon', () => {
  it('renders a square RGBA bitmap of the requested size', () => {
    const icon = renderRedlineTrayIcon('ok', false, 32);
    expect(icon.width).toBe(32);
    expect(icon.height).toBe(32);
    expect(icon.rgba.length).toBe(32 * 32 * 4);
    expect(renderRedlineTrayIcon('ok', false).width).toBe(RENDERED_ICON_SIZE);
  });

  it('keeps the rounded plate corners transparent', () => {
    const icon = renderRedlineTrayIcon('ok', false, 64);
    expect(at(icon, 0, 0)[3]).toBe(0);
    expect(at(icon, 31.9, 0)[3]).toBe(0);
    expect(at(icon, 0, 31.9)[3]).toBe(0);
  });

  it('paints a light plate so the icon reads on dark and light panels', () => {
    const icon = renderRedlineTrayIcon('ok', false, 64);
    expect(at(icon, 4, 16)).toEqual(PLATE);
    expect(at(icon, 16, 4)).toEqual(PLATE);
  });

  it('paints the brand diamond: pink left, cyan right', () => {
    const icon = renderRedlineTrayIcon('ok', false, 64);
    expect(at(icon, 11, 15)).toEqual(PINK);
    expect(at(icon, 21, 15)).toEqual(CYAN);
    // O centro do losango é vazado (a placa aparece).
    expect(at(icon, 16, 15)).toEqual(PLATE);
  });

  it.each(Object.entries(INK))('the corner dot carries the %s ink', (urgency, ink) => {
    const icon = renderRedlineTrayIcon(urgency as keyof typeof INK, false, 64);
    expect(at(icon, 24, 24)).toEqual([...ink]);
  });

  it('a stale snapshot hollows the dot but keeps its ring', () => {
    const fresh = renderRedlineTrayIcon('danger', false, 64);
    const stale = renderRedlineTrayIcon('danger', true, 64);
    expect(at(fresh, 24, 24)).toEqual([...INK.danger]);
    expect(at(stale, 24, 24)).toEqual(PLATE);
    // Anel: 4 unidades do centro fica entre o raio interno (3) e o externo (5).
    expect(at(stale, 28, 24)).toEqual([...INK.danger]);
  });

  it('different urgencies and the stale flag produce different bitmaps', () => {
    const keys = [
      renderRedlineTrayIcon('ok', false, 32),
      renderRedlineTrayIcon('warn', false, 32),
      renderRedlineTrayIcon('danger', false, 32),
      renderRedlineTrayIcon('unknown', false, 32),
      renderRedlineTrayIcon('ok', true, 32),
    ].map((icon) => Buffer.from(icon.rgba).toString('base64'));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('is deterministic', () => {
    const a = renderRedlineTrayIcon('warn', true, 48);
    const b = renderRedlineTrayIcon('warn', true, 48);
    expect(Buffer.from(a.rgba).equals(Buffer.from(b.rgba))).toBe(true);
  });

  it('anti-aliases the plate edge (partial alpha exists)', () => {
    const icon = renderRedlineTrayIcon('ok', false, 64);
    const alphas = new Set<number>();
    for (let i = 3; i < icon.rgba.length; i += 4) alphas.add(icon.rgba[i]);
    expect([...alphas].some((a) => a > 0 && a < 255)).toBe(true);
  });

  it('rejects a nonsensical size', () => {
    expect(() => renderRedlineTrayIcon('ok', false, 0)).toThrow();
    expect(() => renderRedlineTrayIcon('ok', false, 4096)).toThrow();
    expect(() => renderRedlineTrayIcon('ok', false, 12.5)).toThrow();
  });
});

describe('encodePng', () => {
  it('writes a valid PNG: signature, IHDR, IDAT, IEND, correct CRCs', () => {
    const icon = renderRedlineTrayIcon('warn', false, 32);
    const png = encodePng(icon);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const chunks = readChunks(png);
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(chunks.every((c) => c.crcOk)).toBe(true);
    const ihdr = chunks[0].data;
    expect(ihdr.readUInt32BE(0)).toBe(32);
    expect(ihdr.readUInt32BE(4)).toBe(32);
    expect(ihdr[8]).toBe(8); // bit depth
    expect(ihdr[9]).toBe(6); // RGBA
  });

  it('round-trips the pixels through zlib (filter 0 per row)', () => {
    const icon = renderRedlineTrayIcon('danger', true, 32);
    const raw = inflateSync(readChunks(encodePng(icon))[1].data);
    expect(raw.length).toBe((1 + 32 * 4) * 32);
    for (let y = 0; y < 32; y += 1) {
      const row = raw.subarray(y * (1 + 32 * 4), (y + 1) * (1 + 32 * 4));
      expect(row[0]).toBe(0);
      expect(Buffer.from(row.subarray(1)).equals(Buffer.from(icon.rgba.subarray(y * 32 * 4, (y + 1) * 32 * 4)))).toBe(true);
    }
  });

  it('refuses a bitmap whose buffer does not match its size', () => {
    expect(() => encodePng({ width: 4, height: 4, rgba: new Uint8Array(10) })).toThrow();
  });

  it('redlineTrayIconPng is the encoded render', () => {
    const direct = encodePng(renderRedlineTrayIcon('ok', false, 32));
    expect(redlineTrayIconPng('ok', false, 32).equals(direct)).toBe(true);
  });
});
