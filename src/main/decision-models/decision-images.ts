import { readRasterImageDimensions } from '../../shared/raster-image-dimensions';
import type { DecisionImage } from '../../shared/decision-models';

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 16_000_000;
const MAX_BASE64_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function matchesMime(bytes: Buffer, mime: DecisionImage['content_type']): boolean {
  if (mime === 'image/png') return bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
  if (mime === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return mime === 'image/webp' && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
}

export function validateDecisionImages(images: unknown): images is readonly DecisionImage[] {
  if (!Array.isArray(images) || images.length > MAX_IMAGES) return false;
  let totalBytes = 0;
  for (const image of images) {
    if (!image || typeof image !== 'object' || typeof image.base64 !== 'string') return false;
    if (image.base64.length > MAX_BASE64_CHARS || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.base64)) return false;
    const bytes = Buffer.from(image.base64, 'base64');
    if (bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== image.base64 || !matchesMime(bytes, image.content_type)) return false;
    const dimensions = readRasterImageDimensions(bytes);
    if (!dimensions || dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) return false;
    totalBytes += bytes.length;
    if (totalBytes > MAX_TOTAL_BYTES) return false;
  }
  return true;
}
