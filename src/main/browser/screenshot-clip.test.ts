import { describe, expect, it, vi } from 'vitest';
import {
  HIDDEN_CAPTURE_RETRY_MS,
  captureWithWakeRetry,
  clampScreenshotClip,
} from './screenshot-clip';

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

describe('captureWithWakeRetry', () => {
  const image = (width: number, height: number) => ({
    getSize: () => ({ width, height }),
  });
  const noWait = vi.fn(async () => {});

  it('retries once when a page loaded while hidden has no frame yet', async () => {
    // Medido no Electron: navegar com a vista escondida faz a primeira
    // captura falhar na hora; a seguinte sai com a página atual.
    const capture = vi
      .fn()
      .mockRejectedValueOnce(new Error('UnknownVizError'))
      .mockResolvedValueOnce(image(1280, 960));
    const shot = await captureWithWakeRetry(capture, undefined, noWait);
    expect(shot.getSize()).toEqual({ width: 1280, height: 960 });
    expect(capture).toHaveBeenCalledTimes(2);
    expect(noWait).toHaveBeenLastCalledWith(HIDDEN_CAPTURE_RETRY_MS);
  });

  it('retries an empty frame and keeps the first good one', async () => {
    const empty = vi
      .fn()
      .mockResolvedValueOnce(image(0, 0))
      .mockResolvedValueOnce(image(640, 480));
    await expect(captureWithWakeRetry(empty, undefined, noWait)).resolves.toBeTruthy();
    expect(empty).toHaveBeenCalledTimes(2);

    const good = vi.fn().mockResolvedValue(image(640, 480));
    await captureWithWakeRetry(good, undefined, noWait);
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('surfaces the second failure and stops when authority is revoked', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('UnknownVizError'));
    await expect(captureWithWakeRetry(failing, undefined, noWait)).rejects.toThrow(
      'UnknownVizError',
    );
    expect(failing).toHaveBeenCalledTimes(2);

    const revoked = vi.fn().mockRejectedValue(new Error('UnknownVizError'));
    await expect(
      captureWithWakeRetry(
        revoked,
        () => {
          throw new Error('session_authority_revoked');
        },
        noWait,
      ),
    ).rejects.toThrow('session_authority_revoked');
    expect(revoked).toHaveBeenCalledTimes(1);
  });
});
