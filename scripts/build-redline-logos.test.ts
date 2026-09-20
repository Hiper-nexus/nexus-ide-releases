import { inflateSync } from 'node:zlib';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — parser compartilhado com o rasterizador (mjs puro)
import { parseProviderLogos } from './build-redline-logos.mjs';

const root = resolve(__dirname, '..');
const assetsDir = join(root, 'native', 'menubar-redline', 'assets', 'provider-logos');

/** PNG 8-bit RGBA/RGB mínimo: IHDR + unfilter dos IDAT, para medir alfa real. */
function decodePng(path: string): { width: number; height: number; pixels: Buffer; channels: number } {
  const data = readFileSync(path);
  expect(data.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  let offset = 8;
  let width = 0; let height = 0; let colorType = -1;
  const idat: Buffer[] = [];
  while (offset < data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString('ascii', offset + 4, offset + 8);
    const body = data.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      expect(body[8]).toBe(8); // bit depth 8 apenas
      colorType = body[9];
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  const channels = { 6: 4, 2: 3, 0: 1, 4: 2 }[colorType];
  if (!channels) throw new Error(`PNG ${path}: colorType ${colorType} não suportado pelo guarda`);
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos]; pos += 1;
    for (let x = 0; x < stride; x += 1) {
      const v = raw[pos + x];
      const a = x >= channels ? pixels[y * stride + x - channels] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const c = y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      let out = v;
      if (filter === 1) out = v + a;
      else if (filter === 2) out = v + b;
      else if (filter === 3) out = v + ((a + b) >> 1);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
        out = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      pixels[y * stride + x] = out & 0xff;
    }
    pos += stride;
  }
  return { width, height, pixels, channels };
}

describe('redline provider logos', () => {
  it('manifest commitado bate com PROVIDER_LOGOS (drift guard)', () => {
    const tsx = readFileSync(join(root, 'src/renderer/components/ProviderLogo.tsx'), 'utf8');
    const expected = parseProviderLogos(tsx);
    const manifest = JSON.parse(readFileSync(join(assetsDir, 'manifest.json'), 'utf8'));
    const expectedManifest = Object.fromEntries(
      Object.keys(expected).sort().map((id) => [id, { file: expected[id].file, mono: expected[id].mono }]),
    );
    expect(manifest).toEqual(expectedManifest);
  });

  it('todo PNG referenciado existe, é 48×48 e não é em branco', () => {
    const manifest = JSON.parse(readFileSync(join(assetsDir, 'manifest.json'), 'utf8')) as Record<
      string, { file: string; mono: boolean }
    >;
    for (const [adapterId, entry] of Object.entries(manifest)) {
      const file = join(assetsDir, entry.file);
      expect(existsSync(file), `${adapterId}: ${entry.file} ausente`).toBe(true);
      const { width, height, pixels, channels } = decodePng(file);
      expect(`${adapterId}: ${width}x${height}`).toBe(`${adapterId}: 48x48`);
      if (channels === 4) {
        let opaque = 0;
        for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 12) opaque += 1;
        // A guarda do rasterizador: logo em branco nunca pode ser commitado.
        expect(opaque / (width * height), `${adapterId}: logo em branco`).toBeGreaterThanOrEqual(0.05);
      } else {
        // Sem canal alfa, o arquivo precisa ao menos variar de conteúdo.
        expect(new Set(pixels).size, `${adapterId}: PNG sem variação`).toBeGreaterThan(8);
      }
    }
  });
});
