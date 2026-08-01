/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneModel } from '../../shared/types';
import {
  attachBrowserPane,
  scheduleBrowserPaneBoundsSync,
} from './browser-host';

describe('native browser pane bounds', () => {
  const frames: FrameRequestCallback[] = [];
  const setBounds = vi.fn();

  beforeEach(() => {
    frames.length = 0;
    setBounds.mockReset();
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        browser: {
          create: vi.fn(async (paneId: string, url?: string) => ({
            paneId,
            url: url ?? 'about:blank',
            title: 'browser',
            canGoBack: false,
            canGoForward: false,
            loading: false,
          })),
          setBounds,
          onState: vi.fn(() => () => {}),
          destroy: vi.fn(),
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, 'nexus');
  });

  it('coalesces canvas transforms and resyncs the WebContentsView next frame', async () => {
    let left = 40;
    const slot = document.createElement('div');
    slot.getBoundingClientRect = () =>
      ({
        x: left,
        y: 60,
        left,
        top: 60,
        right: left + 320,
        bottom: 300,
        width: 320,
        height: 240,
        toJSON: () => ({}),
      }) as DOMRect;
    const pane = {
      id: 'browser-a',
      kind: 'browser',
      title: 'Browser',
      browserUrl: 'https://example.com',
    } as PaneModel;
    const detach = attachBrowserPane(pane, slot, vi.fn());
    await Promise.resolve();
    while (frames.length > 0) {
      frames.shift()?.(0);
    }
    setBounds.mockClear();

    left = 180;
    scheduleBrowserPaneBoundsSync();
    scheduleBrowserPaneBoundsSync();

    expect(frames).toHaveLength(1);
    frames.shift()?.(16);
    expect(setBounds).toHaveBeenCalledTimes(1);
    expect(setBounds).toHaveBeenLastCalledWith('browser-a', {
      x: 180,
      y: 60,
      width: 320,
      height: 240,
      visible: true,
    });

    detach();
  });
});
