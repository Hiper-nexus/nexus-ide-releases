// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: o mock de heic-to
// virou o conversor injetável (Main/sips); casos de stash/thumbnail/snapshot
// saíram com o código; casos novos para `unsupported`, conversor padrão via
// window.nexus e HEIF com MIME vazio.
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HeicConvertResult } from '../../shared/files-types';
import {
  compressImageToByteLimit,
  imageNeedsPreparation,
  isHeicImageFile,
  MAX_COMPRESSIBLE_SOURCE_BYTES,
  prepareImageForAttachment,
} from './image-compression';

/**
 * Node has no real canvas/codec, so the re-encode path is exercised with
 * stubbed `createImageBitmap` + `OffscreenCanvas`. The encoder stub returns a
 * payload whose size scales with quality, mirroring how a real JPEG encoder
 * shrinks as quality drops — enough to verify the ladder logic and budget
 * enforcement without pulling in a native canvas.
 */

const originalCreateImageBitmap = globalThis.createImageBitmap;
const originalOffscreenCanvas = globalThis.OffscreenCanvas;

const convertHeic = vi.fn<(file: File) => Promise<HeicConvertResult>>();

function jpegBytes(bytes: Uint8Array): HeicConvertResult {
  return { ok: true, bytes };
}

function makeFile(sizeBytes: number, type = 'image/png'): File {
  return new File([new Uint8Array(sizeBytes).fill(7)], 'shot.png', { type });
}

function makeHeicFile(options?: {
  name?: string;
  type?: string;
  width?: number;
  height?: number;
  lastModified?: number;
}): File {
  const encoder = new TextEncoder();
  const makeBox = (name: string, ...contents: Uint8Array[]) => {
    const bytes = new Uint8Array(8 + contents.reduce((size, content) => size + content.length, 0));
    new DataView(bytes.buffer).setUint32(0, bytes.length);
    bytes.set(encoder.encode(name), 4);
    let offset = 8;
    for (const content of contents) {
      bytes.set(content, offset);
      offset += content.length;
    }
    return bytes;
  };

  const dimensions = new Uint8Array(12);
  const view = new DataView(dimensions.buffer);
  view.setUint32(4, options?.width ?? 4000);
  view.setUint32(8, options?.height ?? 3000);
  const properties = makeBox('iprp', makeBox('ipco', makeBox('ispe', dimensions)));

  return new File(
    [
      makeBox('ftyp', encoder.encode('heic'), new Uint8Array(4)),
      makeBox('meta', new Uint8Array(4), properties),
    ],
    options?.name ?? 'photo.heic',
    {
      type: options?.type ?? 'image/heic',
      ...(options?.lastModified !== undefined ? { lastModified: options.lastModified } : {}),
    },
  );
}

/**
 * Installs a fake bitmap + canvas whose encoded size follows `sizeForQuality`.
 * `supportsWebp: false` makes `convertToBlob` hand back a differently-typed
 * blob for WebP requests, which is how a real browser signals it cannot
 * encode that format.
 */
function stubCanvasPipeline(
  sizeForQuality: (quality: number) => number,
  options?: { supportsWebp?: boolean; htmlCanvas?: boolean },
) {
  const supportsWebp = options?.supportsWebp ?? true;
  const close = vi.fn();
  const fillRect = vi.fn();
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: 4000, height: 3000, close })),
  );
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      constructor(
        public width: number,
        public height: number,
      ) {}
      getContext() {
        return {
          fillStyle: '',
          fillRect,
          drawImage: vi.fn(),
        };
      }
      async convertToBlob({ type, quality }: { type: string; quality: number }) {
        const resolvedType = type === 'image/webp' && !supportsWebp ? 'image/png' : type;
        return new Blob([new Uint8Array(sizeForQuality(quality))], { type: resolvedType });
      }
    },
  );
  if (options?.htmlCanvas) {
    const Canvas = globalThis.OffscreenCanvas as unknown as new (
      width: number,
      height: number,
    ) => { convertToBlob(input: { type: string; quality: number }): Promise<Blob> };
    class HtmlCanvas extends Canvas {
      toBlob(callback: BlobCallback, type: string, quality: number) {
        void this.convertToBlob({ type, quality }).then(callback);
      }
    }
    vi.stubGlobal('OffscreenCanvas', undefined);
    vi.stubGlobal('HTMLCanvasElement', HtmlCanvas);
    vi.stubGlobal('document', { createElement: () => new HtmlCanvas(0, 0) });
  }
  return { close, fillRect };
}

afterEach(() => {
  convertHeic.mockReset();
  vi.unstubAllGlobals();
  globalThis.createImageBitmap = originalCreateImageBitmap;
  globalThis.OffscreenCanvas = originalOffscreenCanvas;
});

describe('compressImageToByteLimit', () => {
  it.each([true, false])('encodes with HTML canvas when WebP support is %s', async (supportsWebp) => {
    const { close } = stubCanvasPipeline(() => 120_000, { htmlCanvas: true, supportsWebp });

    const result = await compressImageToByteLimit(makeFile(2_000_000), 1_000_000);

    expect(result.ok && result.file.type).toBe(supportsWebp ? 'image/webp' : 'image/jpeg');
    expect(result.ok && result.file.size).toBe(120_000);
    expect(close).toHaveBeenCalledOnce();
  });

  it('re-encodes an oversized image to WebP within the budget', async () => {
    const { close, fillRect } = stubCanvasPipeline(() => 120_000);

    const result = await compressImageToByteLimit(makeFile(4_000_000), 1_000_000);

    expect(result.ok && result.recompressed).toBe(true);
    expect(result.ok && result.file.type).toBe('image/webp');
    expect(result.ok && result.file.size).toBeLessThan(4_000_000);
    // WebP keeps alpha, so no white matte should be painted.
    expect(fillRect).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });

  it('falls back to JPEG with a white matte when WebP encoding is unavailable', async () => {
    const { fillRect } = stubCanvasPipeline(() => 120_000, { supportsWebp: false });

    const result = await compressImageToByteLimit(makeFile(4_000_000), 1_000_000);

    expect(result.ok && result.recompressed).toBe(true);
    expect(result.ok && result.file.type).toBe('image/jpeg');
    // JPEG has no alpha, so transparent regions must be matted white.
    expect(fillRect).toHaveBeenCalled();
  });

  it('steps quality down until the encoded image fits', async () => {
    // Only the lowest quality step (0.68) lands under the budget.
    const qualities: number[] = [];
    const { close } = stubCanvasPipeline((quality) => {
      qualities.push(quality);
      return quality <= 0.68 ? 400_000 : 3_000_000;
    });

    const result = await compressImageToByteLimit(makeFile(9_000_000), 1_000_000);

    expect(result.ok && result.file.size).toBe(400_000);
    expect(qualities).toEqual([0.92, 0.92, 0.85, 0.78, 0.68]);
    expect(close).toHaveBeenCalled();
  });

  it('reports too-large when even the smallest encoding overflows the budget', async () => {
    const { close } = stubCanvasPipeline(() => 8_000_000);

    const result = await compressImageToByteLimit(makeFile(9_000_000), 1_000_000);

    expect(result).toEqual({ ok: false, reason: 'too-large' });
    // The bitmap must still be released on the give-up path.
    expect(close).toHaveBeenCalled();
  });

  it('reports too-large for an oversized image when the browser cannot re-encode', async () => {
    vi.stubGlobal('createImageBitmap', undefined);
    vi.stubGlobal('OffscreenCanvas', undefined);

    expect(await compressImageToByteLimit(makeFile(4_000_000), 1_000_000)).toEqual({
      ok: false,
      reason: 'too-large',
    });
  });

  it('reports unreadable when the image fails to decode', async () => {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => {
        throw new Error('corrupt image');
      }),
    );
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        getContext() {
          return null;
        }
      },
    );

    expect(await compressImageToByteLimit(makeFile(4_000_000), 1_000_000)).toEqual({
      ok: false,
      reason: 'unreadable',
    });
  });

  it('passes small files through byte-for-byte', async () => {
    const bitmapSpy = vi.fn();
    vi.stubGlobal('createImageBitmap', bitmapSpy);

    const original = makeFile(1024);
    const result = await compressImageToByteLimit(original, 10 * 1024 * 1024);

    expect(result.ok).toBe(true);
    expect(result.ok && result.recompressed).toBe(false);
    // Pass-through must be the same File object, not a copy.
    expect(result.ok && result.file).toBe(original);
    expect(bitmapSpy).not.toHaveBeenCalled();
  });

  it('re-encodes an oversized file under the byte cap', async () => {
    stubCanvasPipeline(() => 200_000);

    const result = await compressImageToByteLimit(makeFile(2_000_000), 1_000_000);

    expect(result.ok).toBe(true);
    expect(result.ok && result.recompressed).toBe(true);
    expect(result.ok && result.file.type).toBe('image/webp');
    // The re-encoded name must match the new container format.
    expect(result.ok && result.file.name).toBe('shot.webp');
    expect(result.ok && result.file.size).toBeLessThanOrEqual(1_000_000);
  });

  it('refuses sources above the decode-safety ceiling', async () => {
    const bitmapSpy = vi.fn();
    vi.stubGlobal('createImageBitmap', bitmapSpy);

    const result = await compressImageToByteLimit(
      makeFile(MAX_COMPRESSIBLE_SOURCE_BYTES + 1),
      10 * 1024 * 1024,
    );

    expect(result).toEqual({ ok: false, reason: 'too-large' });
    // The whole point of the ceiling is to never decode such a file.
    expect(bitmapSpy).not.toHaveBeenCalled();
  });

  it('reports too-large when no encoding fits', async () => {
    const { close } = stubCanvasPipeline(() => 3_000_000);

    const result = await compressImageToByteLimit(makeFile(2_000_000), 1_000_000);

    expect(result).toEqual({ ok: false, reason: 'too-large' });
    expect(close).toHaveBeenCalled();
  });

  it('shrinks below the source size when the image is already under MAX_DIMENSION', async () => {
    // A small-but-heavy source (e.g. a dense PNG): only a real downscale can
    // get it under budget, since quality alone is stubbed to never suffice.
    let smallestRequested = Number.POSITIVE_INFINITY;
    const close = vi.fn();
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ width: 800, height: 600, close })),
    );
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        constructor(
          public width: number,
          public height: number,
        ) {
          smallestRequested = Math.min(smallestRequested, width);
        }
        getContext() {
          return { fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() };
        }
        async convertToBlob({ type }: { type: string; quality: number }) {
          // Only a genuinely downscaled pass fits the budget.
          const size = smallestRequested < 800 ? 100_000 : 5_000_000;
          return new Blob([new Uint8Array(size)], { type });
        }
      },
    );

    const result = await compressImageToByteLimit(makeFile(4_000_000), 1_000_000);

    expect(result.ok).toBe(true);
    // Fallback passes must scale off the bitmap, not a fixed 2048 ceiling
    // that would never go below an 800px source.
    expect(smallestRequested).toBeLessThan(800);
  });
});

describe('HEIC attachment preparation', () => {
  it('recognizes HEIC and HEIF MIME types and case-insensitive file extensions', () => {
    expect(isHeicImageFile({ name: 'photo.bin', type: 'image/heic' })).toBe(true);
    expect(isHeicImageFile({ name: 'photo.bin', type: 'image/heif' })).toBe(true);
    expect(isHeicImageFile({ name: 'photo.heic', type: 'image/heic-sequence' })).toBe(false);
    expect(isHeicImageFile({ name: 'photo.heif', type: 'image/heif-sequence' })).toBe(false);
    expect(isHeicImageFile({ name: 'IMG_1234.HEIC', type: '' })).toBe(true);
    expect(isHeicImageFile({ name: 'photo.heif', type: 'application/octet-stream' })).toBe(true);
    expect(isHeicImageFile({ name: 'photo.png', type: 'image/png' })).toBe(false);
    expect(isHeicImageFile({ name: 'photo.heic', type: 'image/png' })).toBe(false);
    expect(isHeicImageFile({ name: 'photo.heif', type: 'image/jpeg' })).toBe(false);
  });

  it('only HEIC or over-limit images need preparation', () => {
    expect(imageNeedsPreparation({ name: 'a.heif', type: '', size: 10 }, 1024)).toBe(true);
    expect(imageNeedsPreparation({ name: 'a.png', type: 'image/png', size: 1025 }, 1024)).toBe(true);
    expect(imageNeedsPreparation({ name: 'a.png', type: 'image/png', size: 1024 }, 1024)).toBe(false);
  });

  it('converts a HEIC photo with a missing MIME type into a named JPEG', async () => {
    const original = makeHeicFile({
      name: 'IMG_1234.HEIC',
      type: '',
      lastModified: 123,
    });
    convertHeic.mockResolvedValueOnce(jpegBytes(new Uint8Array([4, 5, 6, 7])));

    const result = await prepareImageForAttachment(original, 1024, { convertHeic });

    expect(convertHeic).toHaveBeenCalledWith(original);
    expect(result.ok && result.file.name).toBe('IMG_1234.jpg');
    expect(result.ok && result.file.type).toBe('image/jpeg');
    expect(result.ok && result.file.size).toBe(4);
    expect(result.ok && result.file.lastModified).toBe(123);
    expect(result.ok && result.recompressed).toBe(true);
  });

  it('converts a HEIF photo with a missing MIME type into a named JPEG', async () => {
    const original = makeHeicFile({ name: 'retrato.heif', type: '' });
    convertHeic.mockResolvedValueOnce(jpegBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xd9])));

    const result = await prepareImageForAttachment(original, 1024, { convertHeic });

    expect(result.ok && result.file.name).toBe('retrato.jpg');
    expect(result.ok && result.file.type).toBe('image/jpeg');
    expect(result.ok && [...new Uint8Array(await result.file.arrayBuffer())]).toEqual([
      0xff, 0xd8, 0xff, 0xd9,
    ]);
  });

  it('keeps oversized converted photos in JPEG format while shrinking them', async () => {
    const original = makeHeicFile({
      name: 'photo.heif',
      type: 'image/heif',
    });
    convertHeic.mockResolvedValueOnce(jpegBytes(new Uint8Array(2_000_000)));
    const { fillRect } = stubCanvasPipeline(() => 200_000);

    const result = await prepareImageForAttachment(original, 1_000_000, { convertHeic });

    expect(result.ok && result.file.name).toBe('photo.jpg');
    expect(result.ok && result.file.type).toBe('image/jpeg');
    expect(result.ok && result.file.size).toBeLessThanOrEqual(1_000_000);
    expect(fillRect).toHaveBeenCalled();
  });

  it('compresses JPEG intermediates above the source safety ceiling', async () => {
    const original = makeHeicFile({
      name: 'large.heic',
      type: 'image/heic',
    });
    convertHeic.mockResolvedValueOnce(jpegBytes(new Uint8Array(MAX_COMPRESSIBLE_SOURCE_BYTES + 1)));
    const { close } = stubCanvasPipeline(() => 200_000);

    const result = await prepareImageForAttachment(original, 1_000_000, { convertHeic });

    expect(result.ok && result.file.name).toBe('large.jpg');
    expect(result.ok && result.file.type).toBe('image/jpeg');
    expect(result.ok && result.file.size).toBeLessThanOrEqual(1_000_000);
    expect(close).toHaveBeenCalled();
  });

  it.each([
    { label: '24 MP', width: 5712, height: 4284 },
    { label: '48 MP', width: 8064, height: 6048 },
  ])('accepts $label HEIC photos', async ({ width, height }) => {
    const original = makeHeicFile({ width, height });
    convertHeic.mockResolvedValueOnce(jpegBytes(new TextEncoder().encode('jpeg')));

    const result = await prepareImageForAttachment(original, 1024, { convertHeic });

    expect(result.ok && result.file.type).toBe('image/jpeg');
    expect(convertHeic).toHaveBeenCalledOnce();
  });

  it('rejects oversized HEIC dimensions before loading the decoder', async () => {
    const original = makeHeicFile({ width: 16_000, height: 4001 });

    expect(await prepareImageForAttachment(original, 1024, { convertHeic })).toEqual({
      ok: false,
      reason: 'too-large',
    });
    expect(convertHeic).not.toHaveBeenCalled();
  });

  it('rejects invalid HEIC metadata before loading the decoder', async () => {
    const original = new File([new Uint8Array([1, 2, 3])], 'broken.heic', {
      type: 'image/heic',
    });

    expect(await prepareImageForAttachment(original, 1024, { convertHeic })).toEqual({
      ok: false,
      reason: 'unreadable',
    });
    expect(convertHeic).not.toHaveBeenCalled();
  });

  it('reports unreadable with the readable reason when HEIC decoding fails', async () => {
    const original = makeHeicFile({
      name: 'broken.heic',
      type: 'image/heic',
    });
    convertHeic.mockResolvedValueOnce({
      ok: false,
      reason: 'unreadable',
      error: 'Não foi possível converter a foto HEIC para JPEG.',
    });

    expect(await prepareImageForAttachment(original, 1024, { convertHeic })).toEqual({
      ok: false,
      reason: 'unreadable',
      message: 'Não foi possível converter a foto HEIC para JPEG.',
    });
  });

  it('reports unreadable when the converter bridge throws', async () => {
    convertHeic.mockRejectedValueOnce(new Error('ipc closed'));

    expect(await prepareImageForAttachment(makeHeicFile(), 1024, { convertHeic })).toEqual({
      ok: false,
      reason: 'unreadable',
    });
  });

  it('surfaces the readable unsupported-system message from Main', async () => {
    convertHeic.mockResolvedValueOnce({
      ok: false,
      reason: 'unsupported',
      error: 'HEIC não suportado neste sistema.',
    });

    expect(await prepareImageForAttachment(makeHeicFile(), 1024, { convertHeic })).toEqual({
      ok: false,
      reason: 'unsupported',
      message: 'HEIC não suportado neste sistema.',
    });
  });

  it('rejects unsafe HEIC sources before loading the decoder', async () => {
    const original = new File(['photo'], 'large.heic', { type: 'image/heic' });
    Object.defineProperty(original, 'size', { value: MAX_COMPRESSIBLE_SOURCE_BYTES + 1 });

    expect(await prepareImageForAttachment(original, 1024, { convertHeic })).toEqual({
      ok: false,
      reason: 'too-large',
    });
    expect(convertHeic).not.toHaveBeenCalled();
  });

  it('leaves supported images untouched without loading the HEIC decoder', async () => {
    const original = makeFile(1024);

    const result = await prepareImageForAttachment(original, 2048, { convertHeic });

    expect(result.ok && result.file).toBe(original);
    expect(result.ok && result.recompressed).toBe(false);
    expect(convertHeic).not.toHaveBeenCalled();
  });

  it('the default converter sends the original bytes to window.nexus', async () => {
    const original = makeHeicFile({ name: 'IMG_9.heic', type: '' });
    const bridge = vi.fn(async (bytes: Uint8Array) => {
      expect(bytes).toBeInstanceOf(Uint8Array);
      return jpegBytes(new Uint8Array([0xff, 0xd8, 0xff]));
    });
    vi.stubGlobal('window', { nexus: { files: { convertHeicToJpeg: bridge } } });

    const result = await prepareImageForAttachment(original, 1024);

    expect(bridge).toHaveBeenCalledOnce();
    expect([...bridge.mock.calls[0]![0]]).toEqual([
      ...new Uint8Array(await original.arrayBuffer()),
    ]);
    expect(result.ok && result.file.name).toBe('IMG_9.jpg');
  });

  it('without a Main bridge the default converter fails visibly as unsupported', async () => {
    expect(await prepareImageForAttachment(makeHeicFile(), 1024)).toEqual({
      ok: false,
      reason: 'unsupported',
      message: 'HEIC não suportado neste sistema.',
    });
  });
});
