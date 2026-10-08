import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HEIC_CONVERT_MAX_SOURCE_BYTES } from '../../shared/files-types';
import {
  convertHeicToJpeg,
  HEIC_UNSUPPORTED_MESSAGE,
  heicConvertPayloadBytes,
  type HeicExecFile,
} from './heic-convert';

const run = promisify(execFile);
const SIPS = '/usr/bin/sips';
const hasSips = process.platform === 'darwin' && fs.existsSync(SIPS);

/** Same ISO-BMFF skeleton the renderer test uses: meta/iprp/ipco/ispe. */
function heicHeader(width = 4000, height = 3000): Uint8Array {
  const encoder = new TextEncoder();
  const box = (name: string, ...contents: Uint8Array[]) => {
    const bytes = new Uint8Array(8 + contents.reduce((size, item) => size + item.length, 0));
    new DataView(bytes.buffer).setUint32(0, bytes.length);
    bytes.set(encoder.encode(name), 4);
    let offset = 8;
    for (const item of contents) {
      bytes.set(item, offset);
      offset += item.length;
    }
    return bytes;
  };
  const dimensions = new Uint8Array(12);
  new DataView(dimensions.buffer).setUint32(4, width);
  new DataView(dimensions.buffer).setUint32(8, height);
  const ftyp = box('ftyp', encoder.encode('heic'), new Uint8Array(4));
  const meta = box('meta', new Uint8Array(4), box('iprp', box('ipco', box('ispe', dimensions))));
  const bytes = new Uint8Array(ftyp.length + meta.length);
  bytes.set(ftyp, 0);
  bytes.set(meta, ftyp.length);
  return bytes;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A real 64×48 RGB PNG — the source `sips` turns into a real HEIC. */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([head, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = y * (width * 3 + 1) + 1 + x * 3;
      raw[offset] = (x * 4) % 256;
      raw[offset + 1] = (y * 5) % 256;
      raw[offset + 2] = 200;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let scratch = '';
let tmpDir = '';

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-heic-test-'));
  tmpDir = path.join(scratch, 'tmp');
  fs.mkdirSync(tmpDir);
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** Minimal baseline JPEG: SOI + SOF0 (declared size) + EOI, plus `padding` bytes. */
function jpeg(width: number, height: number, padding = 0): Uint8Array {
  const sof = [
    0xff, 0xc0, 0x00, 0x11, 0x08,
    height >> 8, height & 0xff, width >> 8, width & 0xff,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ];
  const comment = padding > 0 ? [0xff, 0xfe, (padding + 2) >> 8, (padding + 2) & 0xff] : [];
  return new Uint8Array([
    0xff, 0xd8, ...comment, ...new Array<number>(padding).fill(0x20), ...sof, 0xff, 0xd9,
  ]);
}

function sipsDimensions(width: number | null, height: number | null): string {
  return `/tmp/x/input.heic\n  pixelWidth: ${width ?? '<nil>'}\n  pixelHeight: ${height ?? '<nil>'}\n`;
}

/**
 * Fake `sips`: answers the `-g pixelWidth -g pixelHeight` probe with `probe`
 * and writes `output` where the real converter would.
 */
function fakeSips(
  output: Uint8Array | null,
  probe: { width: number | null; height: number | null } = { width: 64, height: 48 },
) {
  return vi.fn<HeicExecFile>((_file, args, _options, callback) => {
    if (args[0] === '-g') {
      setImmediate(() => callback(null, sipsDimensions(probe.width, probe.height)));
      return undefined;
    }
    const outPath = args[args.indexOf('--out') + 1]!;
    if (output) fs.writeFileSync(outPath, output);
    setImmediate(() => callback(output ? null : new Error('sips failed'), ''));
    return undefined;
  });
}

/** Real `sips`, observed: proves which calls happened (probe vs conversion). */
function realSips() {
  return vi.fn<HeicExecFile>((file, args, options, callback) =>
    execFile(file, [...args], options, (error, stdout) => callback(error, String(stdout))),
  );
}

function conversionCalls(spy: ReturnType<typeof fakeSips>): number {
  return spy.mock.calls.filter(([, args]) => args.includes('--out')).length;
}

/** Rewrite the `index`-th `ispe` box (0-based) — a lying-metadata fixture. */
function patchIspe(bytes: Uint8Array, index: number, width: number, height: number): Uint8Array {
  const copy = new Uint8Array(bytes);
  const view = new DataView(copy.buffer);
  let seen = 0;
  for (let offset = 4; offset + 16 <= copy.length; offset += 1) {
    if (copy[offset] === 0x69 && copy[offset + 1] === 0x73 && copy[offset + 2] === 0x70 && copy[offset + 3] === 0x65) {
      if (seen === index) {
        view.setUint32(offset + 8, width);
        view.setUint32(offset + 12, height);
        return copy;
      }
      seen += 1;
    }
  }
  throw new Error(`ispe #${index} not found`);
}

async function sipsHeic(width: number, height: number): Promise<Uint8Array> {
  const source = path.join(scratch, `source-${width}x${height}.png`);
  const heic = path.join(scratch, `source-${width}x${height}.heic`);
  fs.writeFileSync(source, png(width, height));
  await run(SIPS, ['-s', 'format', 'heic', source, '--out', heic]);
  return new Uint8Array(fs.readFileSync(heic));
}

describe('heicConvertPayloadBytes', () => {
  it('accepts only binary payloads', () => {
    const bytes = new Uint8Array([1, 2]);
    expect(heicConvertPayloadBytes({ bytes })).toBe(bytes);
    expect(heicConvertPayloadBytes({ bytes: bytes.buffer })).toEqual(bytes);
    expect(heicConvertPayloadBytes({ bytes: 'AQI=' })).toBeNull();
    expect(heicConvertPayloadBytes(null)).toBeNull();
    expect(heicConvertPayloadBytes([1, 2])).toBeNull();
  });
});

describe('convertHeicToJpeg — guards before any process', () => {
  it.each(['linux', 'win32'] as const)(
    'answers a readable unsupported error on %s without spawning',
    async (platform) => {
      const execFileSpy = fakeSips(new Uint8Array([0xff, 0xd8, 0xff]));

      const result = await convertHeicToJpeg(heicHeader(), {
        platform,
        execFile: execFileSpy,
        tmpDir,
      });

      expect(result).toEqual({
        ok: false,
        reason: 'unsupported',
        error: 'HEIC não suportado neste sistema.',
      });
      expect(execFileSpy).not.toHaveBeenCalled();
      expect(fs.readdirSync(tmpDir)).toEqual([]);
    },
  );

  it('treats a Mac without sips as unsupported', async () => {
    const execFileSpy = fakeSips(new Uint8Array([0xff, 0xd8, 0xff]));

    const result = await convertHeicToJpeg(heicHeader(), {
      platform: 'darwin',
      sipsPath: path.join(scratch, 'missing-sips'),
      execFile: execFileSpy,
      tmpDir,
    });

    expect(result).toEqual({ ok: false, reason: 'unsupported', error: HEIC_UNSUPPORTED_MESSAGE });
    expect(execFileSpy).not.toHaveBeenCalled();
  });

  it('refuses sources above 50 MiB before writing or spawning', async () => {
    const execFileSpy = fakeSips(new Uint8Array([0xff, 0xd8, 0xff]));
    const huge = new Uint8Array(HEIC_CONVERT_MAX_SOURCE_BYTES + 1);
    huge.set(heicHeader(), 0);

    const result = await convertHeicToJpeg(huge, { platform: 'darwin', execFile: execFileSpy, tmpDir });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('too-large');
    expect(execFileSpy).not.toHaveBeenCalled();
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  it('refuses more than 64 MP and corrupt metadata before spawning', async () => {
    const execFileSpy = fakeSips(new Uint8Array([0xff, 0xd8, 0xff]));
    const deps = { platform: 'darwin' as const, sipsPath: '/bin/sh', execFile: execFileSpy, tmpDir };

    const tooMany = await convertHeicToJpeg(heicHeader(16_000, 4001), deps);
    const corrupt = await convertHeicToJpeg(new Uint8Array([1, 2, 3]), deps);

    expect(tooMany).toEqual({
      ok: false,
      reason: 'too-large',
      error: 'A foto HEIC tem mais de 64 megapixels.',
    });
    expect(corrupt).toEqual({
      ok: false,
      reason: 'unreadable',
      error: 'O arquivo não é uma foto HEIC/HEIF válida.',
    });
    expect(execFileSpy).not.toHaveBeenCalled();
  });
});

describe('convertHeicToJpeg — child process contract', () => {
  it('probes, then runs sips with a deadline in a private temp dir and cleans it up', async () => {
    const output = jpeg(64, 48);
    const execFileSpy = fakeSips(output);

    const result = await convertHeicToJpeg(heicHeader(), {
      platform: 'darwin',
      sipsPath: '/bin/sh',
      execFile: execFileSpy,
      tmpDir,
      timeoutMs: 1234,
    });

    expect(result.ok && [...result.bytes]).toEqual([...output]);
    expect(execFileSpy).toHaveBeenCalledTimes(2);
    const [probeFile, probeArgs, probeOptions] = execFileSpy.mock.calls[0]!;
    expect(probeFile).toBe('/bin/sh');
    expect(probeArgs.slice(0, 4)).toEqual(['-g', 'pixelWidth', '-g', 'pixelHeight']);
    expect(path.basename(probeArgs[4])).toBe('input.heic');
    expect(probeOptions).toMatchObject({ timeout: 1234, killSignal: 'SIGKILL' });
    const [file, args, options] = execFileSpy.mock.calls[1]!;
    expect(file).toBe('/bin/sh');
    expect(args.slice(0, 6)).toEqual(['-s', 'format', 'jpeg', '-s', 'formatOptions', '92']);
    expect(path.basename(args[6])).toBe('input.heic');
    expect(args[7]).toBe('--out');
    expect(path.dirname(args[6])).toBe(path.dirname(args[8]));
    expect(path.dirname(args[6]).startsWith(path.join(tmpDir, 'nexus-heic-'))).toBe(true);
    expect(options).toMatchObject({ timeout: 1234, killSignal: 'SIGKILL' });
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  it('refuses before converting when the decoder reports more pixels than the cap', async () => {
    // ispe do arquivo diz 4000×3000 (passa no parser); o ImageIO diz 9000×8000.
    const execFileSpy = fakeSips(jpeg(64, 48), { width: 9000, height: 8000 });

    const result = await convertHeicToJpeg(heicHeader(), {
      platform: 'darwin',
      sipsPath: '/bin/sh',
      execFile: execFileSpy,
      tmpDir,
    });

    expect(result).toEqual({
      ok: false,
      reason: 'too-large',
      error: 'A foto HEIC tem mais de 64 megapixels.',
    });
    expect(conversionCalls(execFileSpy)).toBe(0);
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  it('refuses before converting when the decoder cannot tell the size', async () => {
    const execFileSpy = fakeSips(jpeg(64, 48), { width: null, height: null });

    const result = await convertHeicToJpeg(heicHeader(), {
      platform: 'darwin',
      sipsPath: '/bin/sh',
      execFile: execFileSpy,
      tmpDir,
    });

    expect(result).toEqual({
      ok: false,
      reason: 'unreadable',
      error: 'O arquivo não é uma foto HEIC/HEIF válida.',
    });
    expect(conversionCalls(execFileSpy)).toBe(0);
  });

  it('checks the dimensions of the JPEG it got back', async () => {
    // Sonda diz 64×48, mas o JPEG que saiu declara 9000×8000 no SOF.
    const result = await convertHeicToJpeg(heicHeader(), {
      platform: 'darwin',
      sipsPath: '/bin/sh',
      execFile: fakeSips(jpeg(9000, 8000)),
      tmpDir,
    });

    expect(result).toEqual({
      ok: false,
      reason: 'too-large',
      error: 'O JPEG convertido passou de 64 megapixels.',
    });
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  it('caps the output size before reading it', async () => {
    const result = await convertHeicToJpeg(heicHeader(), {
      platform: 'darwin',
      sipsPath: '/bin/sh',
      execFile: fakeSips(jpeg(64, 48, 4096)),
      tmpDir,
      maxOutputBytes: 1024,
    });

    expect(result).toEqual({
      ok: false,
      reason: 'too-large',
      error: 'O JPEG convertido ficou grande demais.',
    });
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  it('rejects an output that is not a JPEG', async () => {
    const result = await convertHeicToJpeg(heicHeader(), {
      platform: 'darwin',
      sipsPath: '/bin/sh',
      execFile: fakeSips(new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
      tmpDir,
    });

    expect(result).toEqual({
      ok: false,
      reason: 'unreadable',
      error: 'Não foi possível converter a foto HEIC para JPEG.',
    });
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  it('caps concurrent conversions instead of piling up decoders', async () => {
    const callbacks: Array<() => void> = [];
    const blocking: HeicExecFile = (_file, args, _options, callback) => {
      if (args[0] === '-g') {
        setImmediate(() => callback(null, sipsDimensions(64, 48)));
        return undefined;
      }
      const outPath = args[args.indexOf('--out') + 1]!;
      callbacks.push(() => {
        fs.writeFileSync(outPath, jpeg(64, 48));
        callback(null, '');
      });
      return undefined;
    };
    const deps = { platform: 'darwin' as const, sipsPath: '/bin/sh', execFile: blocking, tmpDir };

    const first = convertHeicToJpeg(heicHeader(), deps);
    const second = convertHeicToJpeg(heicHeader(), deps);
    await vi.waitFor(() => expect(callbacks).toHaveLength(2));
    const third = await convertHeicToJpeg(heicHeader(), deps);
    for (const release of callbacks) release();

    expect(third).toEqual({
      ok: false,
      reason: 'unreadable',
      error: 'Outra conversão HEIC está em andamento; tente de novo.',
    });
    expect((await first).ok).toBe(true);
    expect((await second).ok).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'kills a size probe that passes the deadline and says so',
    async () => {
      const slow = path.join(scratch, 'slow-probe.sh');
      fs.writeFileSync(slow, '#!/bin/sh\nexec /bin/sleep 10\n', { mode: 0o755 });
      const started = Date.now();

      const result = await convertHeicToJpeg(heicHeader(), {
        platform: 'darwin',
        sipsPath: slow,
        timeoutMs: 300,
        tmpDir,
      });

      expect(result).toEqual({
        ok: false,
        reason: 'unreadable',
        error: 'A conversão HEIC passou do prazo de 300 ms.',
      });
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(fs.readdirSync(tmpDir)).toEqual([]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'kills a converter that passes the deadline and says so',
    async () => {
      // A sonda responde na hora; só a conversão trava.
      const slow = path.join(scratch, 'slow-sips.sh');
      fs.writeFileSync(
        slow,
        '#!/bin/sh\nif [ "$1" = "-g" ]; then\n  echo "  pixelWidth: 64"\n  echo "  pixelHeight: 48"\n  exit 0\nfi\nexec /bin/sleep 10\n',
        { mode: 0o755 },
      );
      const started = Date.now();

      const result = await convertHeicToJpeg(heicHeader(), {
        platform: 'darwin',
        sipsPath: slow,
        timeoutMs: 300,
        tmpDir,
      });

      expect(result).toEqual({
        ok: false,
        reason: 'unreadable',
        error: 'A conversão HEIC passou do prazo de 300 ms.',
      });
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(fs.readdirSync(tmpDir)).toEqual([]);
    },
  );
});

describe.runIf(hasSips)('convertHeicToJpeg — real macOS sips', () => {
  it('converts a HEIC that sips generated from a PNG into a real JPEG', async () => {
    const source = path.join(scratch, 'source.png');
    const heic = path.join(scratch, 'source.heic');
    fs.writeFileSync(source, png(64, 48));
    await run(SIPS, ['-s', 'format', 'heic', source, '--out', heic]);
    const heicBytes = new Uint8Array(fs.readFileSync(heic));
    expect(new TextDecoder().decode(heicBytes.subarray(4, 12))).toBe('ftypheic');

    const result = await convertHeicToJpeg(heicBytes, { tmpDir });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    const jpeg = path.join(scratch, 'converted.jpg');
    fs.writeFileSync(jpeg, result.bytes);
    const { stdout } = await run(SIPS, ['-g', 'format', '-g', 'pixelWidth', '-g', 'pixelHeight', jpeg]);
    expect(stdout).toMatch(/format: jpeg/);
    expect(stdout).toMatch(/pixelWidth: 64/);
    expect(stdout).toMatch(/pixelHeight: 48/);
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  it('a corrupt HEIC with valid-looking metadata fails visibly, not silently', async () => {
    const execFileSpy = realSips();

    const result = await convertHeicToJpeg(heicHeader(640, 480), { tmpDir, execFile: execFileSpy });

    expect(result).toEqual({
      ok: false,
      reason: 'unreadable',
      error: 'O arquivo não é uma foto HEIC/HEIF válida.',
    });
    expect(conversionCalls(execFileSpy)).toBe(0);
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  it('the pixel cap uses what ImageIO will decode for a real grid, before converting', async () => {
    // 1024×768 vira grade 2×2 de tiles 512×512 no sips. Teto reduzido para
    // o teste: o parser (teto real de 64 MP) deixa passar; a sonda não.
    const grid = await sipsHeic(1024, 768);
    const execFileSpy = realSips();

    const result = await convertHeicToJpeg(grid, {
      tmpDir,
      execFile: execFileSpy,
      maxPixels: 100_000,
    });

    expect(result).toEqual({
      ok: false,
      reason: 'too-large',
      error: 'A foto HEIC tem mais de 0,1 megapixels.',
    });
    expect(execFileSpy).toHaveBeenCalledOnce();
    expect(execFileSpy.mock.calls[0]![1].slice(0, 4)).toEqual([
      '-g',
      'pixelWidth',
      '-g',
      'pixelHeight',
    ]);
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  it('a grid whose ispe lies (64×48 over 1024×768 of tiles) never converts', async () => {
    // O parser lê o ispe mentiroso (64×48) e deixa passar; o ImageIO recusa
    // a grade inconsistente já na sonda — e, se um dia decodificar, o teto
    // vale para o tamanho que ele reportar.
    const lying = patchIspe(await sipsHeic(1024, 768), 1, 64, 48);
    const execFileSpy = realSips();

    const result = await convertHeicToJpeg(lying, {
      tmpDir,
      execFile: execFileSpy,
      maxPixels: 100_000,
    });

    expect(result.ok).toBe(false);
    expect(conversionCalls(execFileSpy)).toBe(0);
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });
});
