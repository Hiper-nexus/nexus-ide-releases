import { z } from 'zod';
import type { BrowserVisualMasks, BrowserVisualRect } from '../../shared/browser-visual';
import { BrowserVisualRefusal } from './browser-visual-refusal';

const MAX_PIXELS = 16_000_000;
const MAX_DIMENSION = 16_384;
const BYTES_PER_PIXEL = 4;
const MASK_PADDING_PX = 2;
/** Beyond this share of the image masked there is nothing left worth judging. */
const MAX_MASKED_FRACTION = 0.9;
/** Image/mask scale may differ per axis only by rounding (device pixel ratio is not integral). */
const MAX_AXIS_SCALE_SKEW = 0.02;
const MIN_SCALE = 0.25;
const MAX_SCALE = 8;
/** NativeImage uses four-byte pixels; black is identical in BGRA and RGBA. */
const OPAQUE_BLACK_PIXEL = Buffer.from([0, 0, 0, 255]);
const coordinate = z.number().finite().min(-100_000).max(100_000);
export const browserVisualMasksSchema = z.object({
  width: z.number().finite().positive().max(100_000), height: z.number().finite().positive().max(100_000),
  scrollX: coordinate, scrollY: coordinate,
  rectangles: z.array(z.object({ x: coordinate, y: coordinate,
    width: z.number().finite().nonnegative().max(100_000), height: z.number().finite().nonnegative().max(100_000),
  }).strict()).max(2_000),
}).strict();

export interface PixelBox { left: number; top: number; right: number; bottom: number }
type Span = readonly [left: number, right: number];
export interface MaskBand { top: number; bottom: number; spans: readonly Span[] }
export interface CssViewport { width: number; height: number }

function toPixelBox(rect: BrowserVisualRect, scaleX: number, scaleY: number, width: number, height: number): PixelBox | null {
  const left = Math.max(0, Math.floor(rect.x * scaleX) - MASK_PADDING_PX);
  const top = Math.max(0, Math.floor(rect.y * scaleY) - MASK_PADDING_PX);
  const right = Math.min(width, Math.ceil((rect.x + rect.width) * scaleX) + MASK_PADDING_PX);
  const bottom = Math.min(height, Math.ceil((rect.y + rect.height) * scaleY) + MASK_PADDING_PX);
  return right > left && bottom > top ? { left, top, right, bottom } : null;
}

function mergeSpans(active: readonly PixelBox[]): Span[] {
  const sorted = [...active].sort((a, b) => a.left - b.left);
  const spans: Array<[number, number]> = [];
  for (const box of sorted) {
    const last = spans[spans.length - 1];
    if (last && box.left <= last[1]) last[1] = Math.max(last[1], box.right);
    else spans.push([box.left, box.right]);
  }
  return spans;
}

/**
 * Sweep-line union: between two consecutive box edges the covered columns do not
 * change, so each band is merged once and painted by native fills. Painting
 * every rectangle in full cost seconds of main-thread time for a hostile page.
 */
export function unionMaskBands(boxes: readonly PixelBox[], imageHeight: number): { bands: MaskBand[]; area: number } {
  const byTop = [...boxes].sort((a, b) => a.top - b.top);
  const edges = [...new Set(boxes.flatMap(box => [box.top, box.bottom]))].filter(edge => edge >= 0 && edge <= imageHeight).sort((a, b) => a - b);
  const bands: MaskBand[] = []; let area = 0; let next = 0; let active: PixelBox[] = [];
  for (let index = 0; index < edges.length - 1; index++) {
    const top = edges[index]; const bottom = edges[index + 1];
    while (next < byTop.length && byTop[next].top <= top) active.push(byTop[next++]);
    active = active.filter(box => box.bottom > top);
    if (!active.length) continue;
    const spans = mergeSpans(active);
    bands.push({ top, bottom, spans });
    area += (bottom - top) * spans.reduce((sum, [left, right]) => sum + right - left, 0);
  }
  return { bands, area };
}

function assertBitmapShape(bitmap: Buffer, width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 ||
    width > MAX_DIMENSION || height > MAX_DIMENSION ||
    width * height > MAX_PIXELS || bitmap.length !== width * height * BYTES_PER_PIXEL) throw new Error('invalid visual bitmap');
}

/** The image must cover the coordinate space the masks were measured in, on both axes. */
function maskScale(size: { width: number; height: number }, css: CssViewport): { scaleX: number; scaleY: number } {
  const scaleX = size.width / css.width; const scaleY = size.height / css.height;
  const skew = Math.abs(scaleX - scaleY) / Math.max(scaleX, scaleY);
  if (![scaleX, scaleY].every(scale => scale >= MIN_SCALE && scale <= MAX_SCALE) || skew > MAX_AXIS_SCALE_SKEW) {
    throw new BrowserVisualRefusal('unverifiable_geometry');
  }
  return { scaleX, scaleY };
}

/**
 * Returns an opaque copy of the pixels; the input is never touched. `cssViewport`
 * is the CSS-pixel area that was captured (the clip), when it differs from the
 * page viewport the masks were measured against.
 */
export function maskBrowserBitmap(
  bitmap: Buffer, size: { width: number; height: number }, raw: BrowserVisualMasks, cssViewport?: CssViewport,
): Buffer {
  const masks = browserVisualMasksSchema.parse(raw);
  const { width, height } = size;
  assertBitmapShape(bitmap, width, height);
  const { scaleX, scaleY } = maskScale(size, cssViewport ?? masks);
  const boxes = masks.rectangles.flatMap(rect => toPixelBox(rect, scaleX, scaleY, width, height) ?? []);
  const { bands, area } = unionMaskBands(boxes, height);
  if (area > width * height * MAX_MASKED_FRACTION) throw new BrowserVisualRefusal('mostly_masked');
  const copy = Buffer.from(bitmap);
  for (const band of bands) {
    for (let y = band.top; y < band.bottom; y++) {
      for (const [left, right] of band.spans) copy.fill(OPAQUE_BLACK_PIXEL, (y * width + left) * BYTES_PER_PIXEL, (y * width + right) * BYTES_PER_PIXEL);
    }
  }
  return copy;
}
