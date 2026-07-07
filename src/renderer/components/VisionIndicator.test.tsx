/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScreenCaptureMetadata } from '../../shared/vision-ipc';
import { VisionIndicator } from './VisionIndicator';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const CAPTURE: ScreenCaptureMetadata = {
  format: 'png',
  width: 1,
  height: 1,
  capturedAt: '2026-07-07T12:00:00.000Z',
  sourceId: 'window:1',
  hasImage: true,
  hasOcr: false,
};

function setVisionApi(
  onCaptured: (cb: (result: ScreenCaptureMetadata) => void) => () => void,
): void {
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    value: {
      vision: {
        onCaptured,
      },
    },
  });
}

describe('VisionIndicator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(window, 'nexus');
    document.body.innerHTML = '';
  });

  it('mounts without crashing when the vision API is absent', () => {
    const host = document.createElement('div');
    const root = createRoot(host);

    act(() => {
      root.render(<VisionIndicator />);
    });

    expect(host.textContent).toBe('');

    act(() => {
      root.unmount();
    });
  });

  it('shows after capture and hides after the visibility window', () => {
    let captured: ((result: ScreenCaptureMetadata) => void) | null = null;
    const unsubscribe = vi.fn();
    setVisionApi((cb) => {
      captured = cb;
      return unsubscribe;
    });

    const host = document.createElement('div');
    const root = createRoot(host);
    act(() => {
      root.render(<VisionIndicator />);
    });

    expect(host.textContent).toBe('');
    act(() => {
      captured?.(CAPTURE);
    });
    expect(host.textContent).toContain('Vision');

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(host.textContent).toBe('');

    act(() => {
      root.unmount();
    });
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
