import { describe, expect, it } from 'vitest';
import { maskBrowserBitmap } from './browser-capture-redaction';

describe('browser screenshot pixel protection', () => {
  it('copies pixels and masks overlapping viewport rectangles at Retina scale', () => {
    const original = Buffer.alloc(8 * 8 * 4, 60);
    const masked = maskBrowserBitmap(original, { width: 8, height: 8 }, {
      width: 4, height: 4, scrollX: 0, scrollY: 0,
      rectangles: [{ x: 0, y: 0, width: 1, height: 1 }, { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }],
    });
    expect([...masked.subarray(0, 4)]).toEqual([0, 0, 0, 255]);
    expect([...masked.subarray(4 * 8 * 7, 4 * 8 * 7 + 4)]).toEqual([60, 60, 60, 60]);
    expect([...original]).toEqual(Array(256).fill(60));
  });
  it('rejects invalid geometry or bitmap limits before sending any pixels', () => {
    for (const rectangle of [{ x: NaN, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: -1, height: 1 }]) {
      expect(() => maskBrowserBitmap(Buffer.alloc(16), { width: 2, height: 2 }, {
        width: 2, height: 2, scrollX: 0, scrollY: 0, rectangles: [rectangle],
      })).toThrow();
    }
    expect(() => maskBrowserBitmap(Buffer.alloc(16), { width: 10000, height: 10000 }, {
      width: 2, height: 2, scrollX: 0, scrollY: 0, rectangles: [],
    })).toThrow();
  });
});
