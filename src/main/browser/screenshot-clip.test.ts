import { describe, expect, it } from 'vitest';
import { clampScreenshotClip } from './screenshot-clip';

const VIEW = { width: 1280, height: 800 };

describe('clampScreenshotClip', () => {
  it('passes an in-bounds rect through as integers', () => {
    expect(
      clampScreenshotClip({ x: 10.4, y: 20.6, width: 100.2, height: 40.9 }, VIEW),
    ).toEqual({ x: 10, y: 20, width: 101, height: 42 });
  });

  it('clamps rects that overflow the viewport edges', () => {
    expect(
      clampScreenshotClip({ x: -30, y: 780, width: 100, height: 100 }, VIEW),
    ).toEqual({ x: 0, y: 780, width: 70, height: 20 });
  });

  it('returns null for rects fully outside the viewport', () => {
    expect(
      clampScreenshotClip({ x: 2000, y: 10, width: 50, height: 50 }, VIEW),
    ).toBeNull();
    expect(
      clampScreenshotClip({ x: 10, y: -60, width: 50, height: 50 }, VIEW),
    ).toBeNull();
  });

  it('returns null for degenerate rects', () => {
    expect(clampScreenshotClip({ x: 10, y: 10, width: 0, height: 40 }, VIEW)).toBeNull();
    expect(clampScreenshotClip({ x: 10, y: 10, width: 40, height: 0 }, VIEW)).toBeNull();
  });

  it('expands by padding while staying inside the viewport', () => {
    expect(
      clampScreenshotClip({ x: 4, y: 4, width: 20, height: 20 }, VIEW, { padding: 8 }),
    ).toEqual({ x: 0, y: 0, width: 32, height: 32 });
  });

  it('returns null when the viewport itself is empty (pane hidden)', () => {
    expect(
      clampScreenshotClip({ x: 0, y: 0, width: 10, height: 10 }, { width: 0, height: 0 }),
    ).toBeNull();
  });
});
