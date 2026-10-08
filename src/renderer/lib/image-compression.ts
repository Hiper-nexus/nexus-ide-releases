// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: sem heic-to (LGPL):
// o HEIC/HEIF vai para o conversor do Main (sips no macOS) por IPC, injetável
// nos testes; motivo novo `unsupported` com a mensagem legível do Main; o
// parser de metadados HEIC mora em src/shared/heic-metadata.ts; caminhos de
// stash/dataUrl do composer do T3 ficaram de fora (sem consumidor); a
// miniatura do anexo (`createImageThumbnailDataUrl`, F-1005) é do Nexus e
// reusa o mesmo codificador.

/**
 * Downscale + re-encode for image attachments that are too big for where
 * they're headed. The mission attachment picker accepts pasted/dropped images
 * larger than the per-file cap and shrinks them to fit via
 * `compressImageToByteLimit` instead of rejecting the paste.
 *
 * Supported images already within budget pass through untouched. HEIC/HEIF
 * photos are decoded to JPEG first because agents cannot consume them.
 */

import type { HeicConvertResult } from '../../shared/files-types';
import {
  heicDimensionsError,
  MAX_HEIC_METADATA_BYTES,
} from '../../shared/heic-metadata';

/**
 * Longest edge kept when an image has to be re-encoded. Sized so a typical
 * retina screenshot (3024px wide) stays legible rather than being halved.
 */
const MAX_DIMENSION = 2048;
/**
 * Ceiling on the *source* file handed to the re-encoder. File size is a
 * proxy for pixel count, and decoding hundreds of megapixels into an
 * ImageBitmap can OOM the tab — beyond this we refuse rather than risk it.
 */
export const MAX_COMPRESSIBLE_SOURCE_BYTES = 50 * 1024 * 1024;
/**
 * Quality ladder tried in order until the encoded image fits the budget.
 * The floor stays high enough to avoid visible blocking on UI screenshots;
 * if even that overflows we drop resolution instead of quality.
 */
const QUALITY_STEPS = [0.92, 0.85, 0.78, 0.68] as const;
/** Extra downscale passes applied when even the lowest quality overflows. */
const FALLBACK_SCALE_STEPS = [0.75, 0.55] as const;
const HEIC_IMAGE_MIME_TYPE = /^image\/hei(?:c|f)$/i;
const HEIC_IMAGE_EXTENSION = /\.(?:heic|heif)$/i;
const HEIC_UNSUPPORTED_FALLBACK = 'HEIC não suportado neste sistema.';

type ImageSize = { width: number; height: number };

/**
 * Why an image could not be compressed. Callers report these differently:
 * "too large" is a budget outcome, "unreadable" is a decode failure and
 * "unsupported" means this system has no HEIC decoder.
 */
export type ImageCompressionFailureReason = 'too-large' | 'unreadable' | 'unsupported';

export type CompressImageFileResult =
  | { ok: true; file: File; recompressed: boolean; imageSize?: ImageSize }
  | { ok: false; reason: ImageCompressionFailureReason; message?: string };

/** HEIC bytes → JPEG bytes. Production: the Main process (`sips` on macOS). */
export type HeicToJpegConverter = (file: File) => Promise<HeicConvertResult>;

/** Finder and some browsers omit the MIME type when dragging HEIC photos. */
export function isHeicImageFile(file: Pick<File, 'name' | 'type'>): boolean {
  if (HEIC_IMAGE_MIME_TYPE.test(file.type)) {
    return true;
  }
  return (
    (file.type === '' || file.type.toLowerCase() === 'application/octet-stream') &&
    HEIC_IMAGE_EXTENSION.test(file.name)
  );
}

/** Read HEIC image dimensions before the decoder allocates full RGBA buffers. */
async function validateHeicImageDimensions(
  file: File,
): Promise<ImageCompressionFailureReason | null> {
  const metadata = await file.slice(0, MAX_HEIC_METADATA_BYTES).arrayBuffer();
  return heicDimensionsError(new DataView(metadata));
}

function dataUrlLength(blob: Blob): number {
  return (
    `data:${blob.type || 'application/octet-stream'};base64,`.length + 4 * Math.ceil(blob.size / 3)
  );
}

/**
 * Re-encoding changes the container, so a name like `shot.png` would lie
 * about its contents. Swap the extension to match the encoded mime type.
 */
function fileNameForMimeType(name: string, mimeType: string): string {
  const extension = mimeType === 'image/webp' ? '.webp' : '.jpg';
  const dotIndex = name.lastIndexOf('.');
  const base = dotIndex > 0 ? name.slice(0, dotIndex) : name;
  return `${base}${extension}`;
}

function canRecompress(): boolean {
  return (
    typeof createImageBitmap === 'function' &&
    (typeof OffscreenCanvas === 'function' || typeof document !== 'undefined')
  );
}

interface Canvas2D {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
}

function createCanvas(width: number, height: number): Canvas2D | null {
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) return null;
    return { canvas, context };
  }
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  return { canvas, context };
}

/**
 * WebP is preferred: at matched visual quality it lands roughly 25-35%
 * smaller than JPEG, so the same budget buys more resolution and detail —
 * and it keeps alpha, so screenshots with transparency survive intact.
 * Browsers that can't encode it silently fall back to JPEG.
 */
async function encodeCanvas(
  canvas: OffscreenCanvas | HTMLCanvasElement,
  quality: number,
  mimeType: string,
): Promise<Blob | null> {
  let blob: Blob | null;
  if (typeof HTMLCanvasElement !== 'undefined' && canvas instanceof HTMLCanvasElement) {
    blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mimeType, quality));
  } else {
    blob = await (canvas as OffscreenCanvas).convertToBlob({ type: mimeType, quality });
  }
  return blob?.type === mimeType ? blob : null;
}

/**
 * Draws `bitmap` scaled to fit `maxDimension` and encodes it, stepping
 * quality down until the data URL fits `budgetChars`.
 */
async function encodeWithinBudget(
  bitmap: ImageBitmap,
  maxDimension: number,
  budgetChars: number,
  preferredMimeType?: 'image/jpeg',
): Promise<{ blob: Blob; mimeType: string; imageSize: ImageSize } | null> {
  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const target = createCanvas(width, height);
  if (!target) return null;

  // Probe WebP once; JPEG (no alpha) needs a white matte, so the fill has to
  // happen before drawing and depends on which codec we end up using.
  const mimeType =
    preferredMimeType ??
    ((await encodeCanvas(target.canvas, QUALITY_STEPS[0], 'image/webp'))
      ? 'image/webp'
      : 'image/jpeg');

  if (mimeType === 'image/jpeg') {
    target.context.fillStyle = '#ffffff';
    target.context.fillRect(0, 0, width, height);
  }
  target.context.drawImage(bitmap, 0, 0, width, height);

  for (const quality of QUALITY_STEPS) {
    const encoded = await encodeCanvas(target.canvas, quality, mimeType);
    if (!encoded) break;
    if (dataUrlLength(encoded) <= budgetChars) {
      return { blob: encoded, mimeType, imageSize: { width, height } };
    }
  }
  return null;
}

type ReencodeResult =
  | { ok: true; blob: Blob; mimeType: string; imageSize: ImageSize }
  | { ok: false; reason: ImageCompressionFailureReason };

/**
 * Shared re-encode loop: decodes `file`, then walks the quality ladder and
 * fallback downscale passes until an encoding fits `budgetChars`.
 */
async function reencodeWithinBudget(
  file: File,
  budgetChars: number,
  preferredMimeType?: 'image/jpeg',
): Promise<ReencodeResult> {
  if (!canRecompress()) {
    return { ok: false, reason: 'too-large' };
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }

  try {
    // Each pass shrinks relative to the *previous target*, capped by
    // MAX_DIMENSION. Scaling a fixed ceiling instead would be a no-op for
    // images already smaller than that ceiling — the fallback passes would
    // all resolve to the source size and never actually reduce resolution.
    const baseDimension = Math.min(MAX_DIMENSION, Math.max(bitmap.width, bitmap.height));
    // Tracks whether the *last* attempt threw, so a run of encoder failures
    // is reported as unreadable while a run of merely-too-big results is
    // reported as too-large.
    let encodeFailed = false;
    for (const dimensionScale of [1, ...FALLBACK_SCALE_STEPS]) {
      const targetDimension = Math.max(1, Math.round(baseDimension * dimensionScale));
      let encoded: Awaited<ReturnType<typeof encodeWithinBudget>>;
      try {
        encoded = await encodeWithinBudget(bitmap, targetDimension, budgetChars, preferredMimeType);
      } catch {
        // Canvas allocation, drawing, or the codec itself can throw — often
        // precisely *because* the target is too big (OOM on a large bitmap).
        // Keep trying the smaller fallback scales rather than giving up: a
        // reduced pass may well succeed. The exception must never escape,
        // though, since callers finalize state after this returns and a
        // throw would strand it (e.g. the picker stuck "Anexando…").
        encodeFailed = true;
        continue;
      }
      encodeFailed = false;
      if (encoded) {
        return {
          ok: true,
          blob: encoded.blob,
          mimeType: encoded.mimeType,
          imageSize: encoded.imageSize,
        };
      }
    }
    return { ok: false, reason: encodeFailed ? 'unreadable' : 'too-large' };
  } finally {
    bitmap.close();
  }
}

/**
 * Shrinks `file` until its binary size fits `maxBytes`, returning a new
 * `File` (WebP or JPEG). Files already within the limit pass through
 * untouched, preserving their exact bytes and format. Sources above
 * `MAX_COMPRESSIBLE_SOURCE_BYTES` are refused outright — decoding them is
 * the risk, so no amount of output budget makes them safe. An internally
 * converted image can provide its original source size when the intermediate
 * format expands beyond that ceiling.
 */
export async function compressImageToByteLimit(
  file: File,
  maxBytes: number,
  options?: { preferredMimeType?: 'image/jpeg'; sourceSizeBytes?: number },
): Promise<CompressImageFileResult> {
  if (file.size <= maxBytes) {
    return { ok: true, file, recompressed: false };
  }
  if ((options?.sourceSizeBytes ?? file.size) > MAX_COMPRESSIBLE_SOURCE_BYTES) {
    return { ok: false, reason: 'too-large' };
  }
  // The re-encode loop budgets in data-URL characters. Base64 turns 3 bytes
  // into 4 chars; flooring keeps the budget a hair conservative instead of
  // admitting an encoding right at the byte cap.
  const budgetChars = Math.floor(maxBytes / 3) * 4;
  const reencoded = await reencodeWithinBudget(file, budgetChars, options?.preferredMimeType);
  if (!reencoded.ok) {
    return reencoded;
  }
  return {
    ok: true,
    file: new File(
      [reencoded.blob],
      fileNameForMimeType(file.name || 'image', reencoded.mimeType),
      { type: reencoded.mimeType },
    ),
    recompressed: true,
    imageSize: reencoded.imageSize,
  };
}

/** True when `prepareImageForAttachment` would change the file at all. */
export function imageNeedsPreparation(
  file: Pick<File, 'name' | 'type' | 'size'>,
  maxBytes: number,
): boolean {
  return isHeicImageFile(file) || file.size > maxBytes;
}

/** Default converter: bytes go to the Main process, which owns the decoder. */
async function convertHeicInMain(file: File): Promise<HeicConvertResult> {
  const convert =
    typeof window === 'undefined' ? undefined : window.nexus?.files?.convertHeicToJpeg;
  if (typeof convert !== 'function') {
    return { ok: false, reason: 'unsupported', error: HEIC_UNSUPPORTED_FALLBACK };
  }
  return convert(new Uint8Array(await file.arrayBuffer()));
}

/**
 * Converts HEIC/HEIF photos to agent-compatible JPEG before applying the
 * attachment size limit. The decoder runs only when such a photo arrives,
 * and only after the size and pixel ceilings pass.
 */
export async function prepareImageForAttachment(
  file: File,
  maxBytes: number,
  options?: { convertHeic?: HeicToJpegConverter },
): Promise<CompressImageFileResult> {
  if (!isHeicImageFile(file)) {
    return compressImageToByteLimit(file, maxBytes);
  }

  if (file.size > MAX_COMPRESSIBLE_SOURCE_BYTES) {
    return { ok: false, reason: 'too-large' };
  }

  let converted: Blob;
  try {
    const dimensionError = await validateHeicImageDimensions(file);
    if (dimensionError) {
      return { ok: false, reason: dimensionError };
    }
    const result = await (options?.convertHeic ?? convertHeicInMain)(file);
    if (!result.ok) {
      return { ok: false, reason: result.reason, message: result.error };
    }
    converted = new Blob([result.bytes as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' });
  } catch {
    return { ok: false, reason: 'unreadable' };
  }

  const jpeg = new File([converted], fileNameForMimeType(file.name || 'image', 'image/jpeg'), {
    type: 'image/jpeg',
    lastModified: file.lastModified,
  });
  const result = await compressImageToByteLimit(jpeg, maxBytes, {
    preferredMimeType: 'image/jpeg',
    sourceSizeBytes: file.size,
  });

  return result.ok ? { ...result, recompressed: true } : result;
}

/** F-1005: aresta da miniatura (2× os 48px exibidos, para tela retina). */
const THUMBNAIL_DIMENSION = 96;
/** Teto do data URL da miniatura: pequeno o bastante para morar na memória. */
const THUMBNAIL_BUDGET_CHARS = 24 * 1024;

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

/**
 * F-1005: miniatura (data URL WebP/JPEG, ≤ 96px) de uma imagem já preparada
 * para anexo. A CSP do renderer só aceita `data:` em `img-src`; o arquivo
 * copiado para a missão não é lido de volta. `null` quando o sistema não
 * decodifica a imagem — a linha do anexo segue só com o nome.
 */
export async function createImageThumbnailDataUrl(file: Blob): Promise<string | null> {
  if (!canRecompress()) return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  try {
    const encoded = await encodeWithinBudget(bitmap, THUMBNAIL_DIMENSION, THUMBNAIL_BUDGET_CHARS);
    if (!encoded) return null;
    return `data:${encoded.mimeType};base64,${await blobToBase64(encoded.blob)}`;
  } catch {
    return null;
  } finally {
    bitmap.close();
  }
}
