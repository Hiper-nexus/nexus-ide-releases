/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneModel } from '../../shared/types';
import {
  attachBrowserPane,
  boundsOf,
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

  it('captures non-bubbling ancestor scroll, coalesces IPC and removes the listener', async () => {
    const rail = document.createElement('div');
    const slot = document.createElement('div');
    let top = 60;
    slot.getBoundingClientRect = () => ({ left: 40, top, right: 360, bottom: top + 240, width: 320, height: 240 }) as DOMRect;
    rail.append(slot);
    document.body.append(rail);
    const detach = attachBrowserPane({ id: 'browser-scroll', kind: 'browser' } as PaneModel, slot, vi.fn());
    try {
      await Promise.resolve();
      while (frames.length) frames.shift()?.(0);
      setBounds.mockClear();
      top = 120;
      rail.dispatchEvent(new Event('scroll'));
      rail.dispatchEvent(new Event('scroll'));
      expect(frames).toHaveLength(1);
      frames.shift()?.(16);
      expect(setBounds).toHaveBeenCalledTimes(1);
      expect(setBounds).toHaveBeenLastCalledWith('browser-scroll', { x: 40, y: 120, width: 320, height: 240, visible: true });
    } finally {
      detach();
      rail.remove();
    }
    setBounds.mockClear();
    window.dispatchEvent(new Event('scroll'));
    expect(frames).toHaveLength(0);
    expect(setBounds).not.toHaveBeenCalled();
  });

});


describe('browser slot clipping (F-1407)', () => {
  function rect(left: number, top: number, width: number, height: number): DOMRect {
    return { left, top, right: left + width, bottom: top + height, x: left, y: top, width, height } as DOMRect;
  }

  it.each([
    [80, 80, 180, true],
    [20, 80, 120, true],
    [260, 260, 40, true],
    [320, 320, 0, false],
  ])('clips slot at y=%s to the scrolling client viewport', (top, y, height, visible) => {
    const rail = document.createElement('div');
    rail.style.overflowY = 'auto';
    rail.getBoundingClientRect = () => rect(40, 78, 400, 224);
    Object.defineProperties(rail, {
      clientTop: { value: 2 }, clientHeight: { value: 220 },
    });
    const slot = document.createElement('div');
    slot.getBoundingClientRect = () => rect(60, top, 320, 180);
    rail.append(slot);
    expect(boundsOf(slot)).toEqual({ x: 60, y, width: 320, height, visible });
  });

  it('intersects nested clips on each axis, including scaled client borders', () => {
    const outer = document.createElement('div');
    outer.style.overflowX = 'hidden';
    outer.getBoundingClientRect = () => rect(100, 0, 200, 500);
    Object.defineProperties(outer, {
      clientLeft: { value: 2 }, clientWidth: { value: 96 }, offsetWidth: { value: 100 },
    });
    const inner = document.createElement('div');
    inner.style.overflowY = 'clip';
    inner.getBoundingClientRect = () => rect(0, 100, 500, 100);
    Object.defineProperty(inner, 'clientHeight', { value: 100 });
    const slot = document.createElement('div');
    slot.getBoundingClientRect = () => rect(0, 0, 500, 500);
    outer.append(inner);
    inner.append(slot);
    expect(boundsOf(slot)).toEqual({ x: 104, y: 100, width: 192, height: 100, visible: true });
  });
});
