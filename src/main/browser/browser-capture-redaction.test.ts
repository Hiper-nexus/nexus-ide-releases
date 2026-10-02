import { describe, expect, it } from 'vitest';
import { maskBrowserBitmap, unionMaskBands } from './browser-capture-redaction';
import { BrowserVisualRefusal } from './browser-visual-refusal';

const BLACK = [0, 0, 0, 255];
const px = (buffer: Buffer, width: number, x: number, y: number): number[] =>
  [...buffer.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];

function naivePaint(width: number, height: number, boxes: ReadonlyArray<[number, number, number, number]>): Uint8Array {
  const painted = new Uint8Array(width * height);
  for (const [left, top, right, bottom] of boxes) {
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) painted[y * width + x] = 1;
  }
  return painted;
}

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

  it('does not paint pixels outside every rectangle (a non-sensitive neighbour stays visible)', () => {
    const masked = maskBrowserBitmap(Buffer.alloc(100 * 100 * 4, 90), { width: 100, height: 100 }, {
      width: 100, height: 100, scrollX: 0, scrollY: 0, rectangles: [{ x: 10, y: 10, width: 20, height: 10 }],
    });
    expect(px(masked, 100, 20, 15)).toEqual(BLACK);
    expect(px(masked, 100, 60, 60)).toEqual([90, 90, 90, 90]);
    expect(px(masked, 100, 20, 40)).toEqual([90, 90, 90, 90]);
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

  it('merges 2,000 overlapping rectangles without blocking the main thread', () => {
    const width = 1280; const height = 800;
    const rectangles = Array.from({ length: 2_000 }, (_, index) => ({ x: index % 7, y: (index * 37) % 380, width: 1_100, height: 300 }));
    const started = performance.now();
    const masked = maskBrowserBitmap(Buffer.alloc(width * height * 4, 33), { width, height }, {
      width, height, scrollX: 0, scrollY: 0, rectangles,
    });
    expect(performance.now() - started).toBeLessThan(750);
    expect(px(masked, width, 600, 10)).toEqual(BLACK);
    expect(px(masked, width, 600, 790)).toEqual([33, 33, 33, 33]);
  });

  it('refuses a page of full-viewport rectangles instantly instead of painting each one', () => {
    const width = 1280; const height = 800;
    const rectangles = Array.from({ length: 2_000 }, () => ({ x: 0, y: 0, width, height }));
    const started = performance.now();
    expect(() => maskBrowserBitmap(Buffer.alloc(width * height * 4), { width, height }, {
      width, height, scrollX: 0, scrollY: 0, rectangles,
    })).toThrow(expect.objectContaining({ code: 'mostly_masked' }));
    expect(performance.now() - started).toBeLessThan(750);
  });

  it('produces exactly the union of the rectangles (compared with a naive painter)', () => {
    let seed = 7;
    const random = (max: number): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % max; };
    const boxes: Array<[number, number, number, number]> = Array.from({ length: 60 }, () => {
      const left = random(90); const top = random(90);
      return [left, top, Math.min(100, left + 1 + random(25)), Math.min(100, top + 1 + random(25))];
    });
    const { area, bands } = unionMaskBands(boxes.map(([left, top, right, bottom]) => ({ left, top, right, bottom })), 100);
    const expected = naivePaint(100, 100, boxes);
    expect(area).toBe(expected.reduce((sum, value) => sum + value, 0));
    const painted = new Uint8Array(100 * 100);
    for (const band of bands) for (let y = band.top; y < band.bottom; y++) for (const [l, r] of band.spans) painted.fill(1, y * 100 + l, y * 100 + r);
    expect([...painted]).toEqual([...expected]);
  });

  it('refuses a capture that would be almost entirely masked', () => {
    const attempt = (rectangles: Array<{ x: number; y: number; width: number; height: number }>) => () =>
      maskBrowserBitmap(Buffer.alloc(100 * 100 * 4), { width: 100, height: 100 }, { width: 100, height: 100, scrollX: 0, scrollY: 0, rectangles });
    expect(attempt([{ x: 0, y: 0, width: 100, height: 60 }])).not.toThrow();
    expect(attempt([{ x: 0, y: 0, width: 100, height: 97 }])).toThrow(BrowserVisualRefusal);
    expect(attempt([{ x: 0, y: 0, width: 100, height: 97 }])).toThrow(expect.objectContaining({ code: 'mostly_masked' }));
  });

  it('checks the image against the mask coordinate space, not only the buffer length', () => {
    // 8x16 pixels over a 4x4 CSS viewport: x scales by 2, y by 4 — the masks are not aligned.
    const attempt = (css?: { width: number; height: number }) => () => maskBrowserBitmap(Buffer.alloc(8 * 16 * 4), { width: 8, height: 16 }, {
      width: 4, height: 4, scrollX: 0, scrollY: 0, rectangles: [{ x: 0, y: 0, width: 1, height: 1 }],
    }, css);
    expect(attempt()).toThrow(expect.objectContaining({ code: 'unverifiable_geometry' }));
    // An explicit CSS viewport (the clip that was captured) defines the scale instead.
    expect(attempt({ width: 4, height: 8 })).not.toThrow();
    expect(attempt({ width: 4, height: 16 })).toThrow(expect.objectContaining({ code: 'unverifiable_geometry' }));
  });
});
