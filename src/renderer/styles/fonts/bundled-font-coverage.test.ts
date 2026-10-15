import { readFileSync } from 'node:fs';
import { brotliDecompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

/** Box drawing, blocks and the marks the CLIs paint. Required only when the TTF has them. */
const TERMINAL_CODEPOINTS = [
  ...range(0x2500, 0x257f),
  ...range(0x2580, 0x259f),
  0x25cf, // ●
  0x276f, // ❯
  0x26a0, // ⚠
  0x2713, // ✓
  0x2717, // ✗
  0x23fa, // ⏺
  0x23bf, // ⎿
];

const FACES = [
  { ttf: 'Inter.var.ttf', woff2: 'Inter.var.woff2', variable: true },
  { ttf: 'JetBrainsMono.var.ttf', woff2: 'JetBrainsMono.var.woff2', variable: true },
  { ttf: 'VT323-Regular.ttf', woff2: 'VT323-Regular.woff2', variable: false },
] as const;

const KNOWN_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ',
  'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp',
  'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF',
  'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL',
  'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc',
  'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx',
  'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill',
];

const CMAP_PREFERENCE: Array<[number, number]> = [
  [3, 10], [0, 6], [0, 4], [3, 1], [0, 3], [0, 2], [0, 1], [0, 0],
];

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let cp = from; cp <= to; cp += 1) out.push(cp);
  return out;
}

function load(name: string): Buffer {
  return readFileSync(new URL(`./${name}`, import.meta.url));
}

function sfntTable(font: Buffer, tag: string): Buffer {
  const count = font.readUInt16BE(4);
  for (let i = 0; i < count; i += 1) {
    const at = 12 + i * 16;
    if (font.toString('latin1', at, at + 4) !== tag) continue;
    const offset = font.readUInt32BE(at + 8);
    const length = font.readUInt32BE(at + 12);
    return font.subarray(offset, offset + length);
  }
  throw new Error(`missing ${tag}`);
}

function unpackBase128(data: Buffer, offset: number): [number, number] {
  let result = 0;
  for (let i = 0; i < 5; i += 1) {
    if (offset >= data.length) throw new Error('UIntBase128 truncated');
    const byte = data[offset];
    offset += 1;
    if (i === 0 && byte === 0x80) throw new Error('UIntBase128 leading zero');
    result = result * 128 + (byte & 0x7f);
    if (result > 0xffff_ffff) throw new Error('UIntBase128 overflow');
    if ((byte & 0x80) === 0) return [result, offset];
  }
  throw new Error('UIntBase128 too long');
}

function woff2Tables(file: Buffer): Map<string, Buffer> {
  if (file.toString('latin1', 0, 4) !== 'wOF2') throw new Error('not woff2');
  const numTables = file.readUInt16BE(12);
  const totalCompressedSize = file.readUInt32BE(20);
  let cursor = 48;
  const entries: Array<{ tag: string; length: number; transformed: boolean }> = [];
  for (let i = 0; i < numTables; i += 1) {
    const flags = file[cursor];
    cursor += 1;
    const index = flags & 0x3f;
    let tag: string;
    if (index === 0x3f) {
      tag = file.toString('latin1', cursor, cursor + 4);
      cursor += 4;
    } else {
      tag = KNOWN_TAGS[index];
    }
    let origLength: number;
    [origLength, cursor] = unpackBase128(file, cursor);
    const version = flags >> 6;
    const transformed = tag === 'glyf' || tag === 'loca' ? version !== 3 : version !== 0;
    let length = origLength;
    if (transformed) [length, cursor] = unpackBase128(file, cursor);
    entries.push({ tag, length, transformed });
  }
  const raw = brotliDecompressSync(file.subarray(cursor, cursor + totalCompressedSize));
  const tables = new Map<string, Buffer>();
  let at = 0;
  for (const entry of entries) {
    const slice = Buffer.from(raw.subarray(at, at + entry.length));
    if (entry.tag === 'cmap' && entry.transformed) {
      throw new Error('cmap transform is not decoded');
    }
    tables.set(entry.tag, slice);
    at += entry.length;
  }
  return tables;
}

function readFormat4(sub: Buffer): Set<number> {
  const segCount = sub.readUInt16BE(6) / 2;
  const endAt = 14;
  const startAt = endAt + segCount * 2 + 2;
  const deltaAt = startAt + segCount * 2;
  const offsetAt = deltaAt + segCount * 2;
  const points = new Set<number>();
  for (let i = 0; i < segCount; i += 1) {
    const end = sub.readUInt16BE(endAt + i * 2);
    const start = sub.readUInt16BE(startAt + i * 2);
    const delta = sub.readInt16BE(deltaAt + i * 2);
    const rangeOffset = sub.readUInt16BE(offsetAt + i * 2);
    for (let code = start; code <= end; code += 1) {
      let glyph = 0;
      if (rangeOffset === 0) {
        glyph = (code + delta) & 0xffff;
      } else {
        const glyphAt = offsetAt + i * 2 + rangeOffset + (code - start) * 2;
        glyph = sub.readUInt16BE(glyphAt);
        if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
      }
      if (glyph !== 0) points.add(code);
    }
  }
  return points;
}

function readFormat12(sub: Buffer): Set<number> {
  const groups = sub.readUInt32BE(12);
  const points = new Set<number>();
  for (let i = 0; i < groups; i += 1) {
    const at = 16 + i * 12;
    const start = sub.readUInt32BE(at);
    const end = sub.readUInt32BE(at + 4);
    for (let code = start; code <= end; code += 1) points.add(code);
  }
  return points;
}

/** Unicode cmap, same preference order as fontTools TTFont.getBestCmap. */
function unicodeCodepoints(cmap: Buffer): Set<number> {
  const count = cmap.readUInt16BE(2);
  const records: Array<{ platform: number; encoding: number; offset: number }> = [];
  for (let i = 0; i < count; i += 1) {
    const at = 4 + i * 8;
    records.push({
      platform: cmap.readUInt16BE(at),
      encoding: cmap.readUInt16BE(at + 2),
      offset: cmap.readUInt32BE(at + 4),
    });
  }
  const chosen = CMAP_PREFERENCE
    .map(([platform, encoding]) => records.find((row) => row.platform === platform && row.encoding === encoding))
    .find((row) => row !== undefined);
  if (!chosen) throw new Error('no unicode cmap');
  const sub = cmap.subarray(chosen.offset);
  const format = sub.readUInt16BE(0);
  if (format === 4) return readFormat4(sub);
  if (format === 12) return readFormat12(sub);
  throw new Error(`unsupported cmap format ${format}`);
}

describe('bundled woff2 keeps the TTF cmap', () => {
  for (const face of FACES) {
    it(`${face.woff2} drops no codepoint the TTF maps`, () => {
      const source = unicodeCodepoints(sfntTable(load(face.ttf), 'cmap'));
      const tables = woff2Tables(load(face.woff2));
      const shipped = unicodeCodepoints(tables.get('cmap')!);
      const lost = [...source].filter((cp) => !shipped.has(cp)).sort((a, b) => a - b);
      expect(lost, face.woff2).toEqual([]);
      const required = TERMINAL_CODEPOINTS.filter((cp) => source.has(cp) && !shipped.has(cp));
      expect(required, `${face.woff2} terminal marks`).toEqual([]);
      if (face.variable) expect(tables.has('fvar'), face.woff2).toBe(true);
    });
  }

  it('JetBrains Mono still draws the terminal frame', () => {
    const shipped = unicodeCodepoints(woff2Tables(load('JetBrainsMono.var.woff2')).get('cmap')!);
    const frame = [
      ...range(0x2500, 0x257f),
      ...range(0x2580, 0x259f),
      0x25cf,
      0x276f,
      0x26a0,
    ];
    expect(frame.filter((cp) => !shipped.has(cp))).toEqual([]);
  });
});
