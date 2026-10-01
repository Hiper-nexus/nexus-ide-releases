import { z } from 'zod';
import type { BrowserVisualMasks } from '../../shared/browser-visual';

const MAX_PIXELS = 16_000_000;
const BYTES_PER_PIXEL = 4;
const MASK_PADDING_PX = 2;
const coordinate = z.number().finite().min(-100_000).max(100_000);
export const browserVisualMasksSchema = z.object({
  width: z.number().finite().positive().max(100_000), height: z.number().finite().positive().max(100_000),
  scrollX: coordinate, scrollY: coordinate,
  rectangles: z.array(z.object({ x: coordinate, y: coordinate,
    width: z.number().finite().nonnegative().max(100_000), height: z.number().finite().nonnegative().max(100_000),
  }).strict()).max(2_000),
}).strict();

/** NativeImage uses four-byte pixels; black is identical in BGRA and RGBA. */
export function maskBrowserBitmap(bitmap: Buffer, size: { width: number; height: number }, raw: BrowserVisualMasks): Buffer {
  const masks = browserVisualMasksSchema.parse(raw);
  const { width, height } = size;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 ||
    width * height > MAX_PIXELS || bitmap.length !== width * height * BYTES_PER_PIXEL) throw new Error('invalid visual bitmap');
  const copy = Buffer.from(bitmap);
  const scaleX = width / masks.width; const scaleY = height / masks.height;
  for (const rect of masks.rectangles) {
    const left = Math.max(0, Math.floor(rect.x * scaleX) - MASK_PADDING_PX);
    const top = Math.max(0, Math.floor(rect.y * scaleY) - MASK_PADDING_PX);
    const right = Math.min(width, Math.ceil((rect.x + rect.width) * scaleX) + MASK_PADDING_PX);
    const bottom = Math.min(height, Math.ceil((rect.y + rect.height) * scaleY) + MASK_PADDING_PX);
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        const index = (y * width + x) * BYTES_PER_PIXEL;
        copy[index] = 0; copy[index + 1] = 0; copy[index + 2] = 0; copy[index + 3] = 255;
      }
    }
  }
  return copy;
}
