import { describe, expect, it } from 'vitest';
import { validateDecisionImages } from './decision-images';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const image = () => ({ content_type: 'image/png', base64: PNG });

describe('embedded image limits', () => {
  it('rejects too many images and mislabelled formats', () => {
    expect(validateDecisionImages(Array.from({ length: 5 }, image))).toBe(false);
    expect(validateDecisionImages([{ ...image(), content_type: 'image/jpeg' }])).toBe(false);
    expect(validateDecisionImages(['https://example.com/image.png'])).toBe(false);
  });

  it('rejects dimensions exceeding the visual token budget before decoding an image', () => {
    const bytes = Buffer.from(PNG, 'base64');
    bytes.writeUInt32BE(4_001, 16); bytes.writeUInt32BE(4_000, 20);
    expect(validateDecisionImages([{ ...image(), base64: bytes.toString('base64') }])).toBe(false);
  });

  it('rejects a decoded image larger than four MiB', () => {
    const bytes = Buffer.concat([Buffer.from(PNG, 'base64'), Buffer.alloc(4 * 1024 * 1024)]);
    expect(validateDecisionImages([{ ...image(), base64: bytes.toString('base64') }])).toBe(false);
  });
});
