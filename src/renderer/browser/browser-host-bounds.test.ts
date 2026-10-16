/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneModel } from '../../shared/types';
import {
  attachBrowserPane,
  boundsOf,
  scheduleBrowserPaneBoundsSync,
  setBrowserPaneSuppression,
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

describe('native browser view under floating surfaces', () => {
  const frames: FrameRequestCallback[] = [];
  const setBounds = vi.fn();
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  type Rect = [left: number, top: number, width: number, height: number];

  function measure(element: Element, [left, top, width, height]: Rect): void {
    element.getBoundingClientRect = () =>
      ({ left, top, right: left + width, bottom: top + height, x: left, y: top, width, height }) as DOMRect;
  }

  function popover(role: string, rect: Rect, attrs: Record<string, string> = {}): HTMLElement {
    const element = document.createElement('div');
    element.setAttribute('role', role);
    for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
    measure(element, rect);
    document.body.append(element);
    return element;
  }

  const visibleOf = (paneId: string): unknown =>
    setBounds.mock.calls.filter(([id]) => id === paneId).at(-1)?.[1]?.visible;

  async function attach(id: string, rect: Rect): Promise<{ slot: HTMLElement; detach: () => void }> {
    const slot = document.createElement('div');
    measure(slot, rect);
    document.body.append(slot);
    const detach = attachBrowserPane({ id, kind: 'browser', title: id } as PaneModel, slot, vi.fn());
    await Promise.resolve();
    while (frames.length > 0) frames.shift()?.(0);
    return { slot, detach };
  }

  beforeEach(() => {
    frames.length = 0;
    setBounds.mockReset();
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        browser: {
          create: vi.fn(async (paneId: string, url?: string) => ({
            paneId, url: url ?? 'about:blank', title: 'browser',
            canGoBack: false, canGoForward: false, loading: false,
          })),
          setBounds,
          onState: vi.fn(() => () => {}),
          destroy: vi.fn(),
        },
      },
    });
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, 'nexus');
  });

  it('hides the native view while a menu crosses it and restores it the moment the menu closes', async () => {
    const { detach } = await attach('occ-menu', [40, 60, 320, 240]);
    try {
      expect(visibleOf('occ-menu')).toBe(true);
      setBounds.mockClear();

      const menu = popover('menu', [300, 100, 200, 200]);
      await flush();
      expect(setBounds).toHaveBeenCalledTimes(1);
      expect(setBounds).toHaveBeenLastCalledWith('occ-menu', { x: 40, y: 60, width: 320, height: 240, visible: false });

      menu.remove();
      await flush();
      expect(setBounds).toHaveBeenCalledTimes(2);
      expect(setBounds).toHaveBeenLastCalledWith('occ-menu', { x: 40, y: 60, width: 320, height: 240, visible: true });
    } finally {
      detach();
    }
  });

  it('leaves the page alone when the popover is somewhere else on screen', async () => {
    const { detach } = await attach('occ-away', [40, 60, 320, 240]);
    try {
      setBounds.mockClear();
      const menu = popover('dialog', [600, 100, 200, 200]);
      await flush();
      menu.remove();
      await flush();
      expect(setBounds).not.toHaveBeenCalled();
    } finally {
      detach();
    }
  });

  it('hides only the view that is crossed', async () => {
    const left = await attach('occ-left', [0, 60, 300, 240]);
    const right = await attach('occ-right', [320, 60, 300, 240]);
    try {
      const picker = popover('dialog', [20, 80, 150, 150]);
      await flush();
      expect(visibleOf('occ-left')).toBe(false);
      expect(visibleOf('occ-right')).toBe(true);
      picker.remove();
      await flush();
      expect(visibleOf('occ-left')).toBe(true);
    } finally {
      left.detach();
      right.detach();
    }
  });

  it('hides every view while an aria-modal dialog is open, wherever its box is', async () => {
    const left = await attach('occ-modal-a', [0, 60, 300, 240]);
    const right = await attach('occ-modal-b', [320, 60, 300, 240]);
    try {
      const modal = popover('dialog', [900, 700, 50, 50], { 'aria-modal': 'true' });
      await flush();
      expect(visibleOf('occ-modal-a')).toBe(false);
      expect(visibleOf('occ-modal-b')).toBe(false);
      modal.remove();
      await flush();
      expect(visibleOf('occ-modal-a')).toBe(true);
      expect(visibleOf('occ-modal-b')).toBe(true);
    } finally {
      left.detach();
      right.detach();
    }
  });

  it('keeps a view hidden when it moves under an open popover and shows it when it moves out', async () => {
    popover('menu', [400, 60, 200, 200]);
    let slotLeft = 40;
    const slot = document.createElement('div');
    slot.getBoundingClientRect = () =>
      ({ left: slotLeft, top: 60, right: slotLeft + 320, bottom: 300, x: slotLeft, y: 60, width: 320, height: 240 }) as DOMRect;
    document.body.append(slot);
    const detach = attachBrowserPane({ id: 'occ-move', kind: 'browser' } as PaneModel, slot, vi.fn());
    try {
      await Promise.resolve();
      while (frames.length > 0) frames.shift()?.(0);
      expect(visibleOf('occ-move')).toBe(true);

      slotLeft = 200;
      scheduleBrowserPaneBoundsSync();
      frames.shift()?.(16);
      expect(visibleOf('occ-move')).toBe(false);

      slotLeft = 40;
      scheduleBrowserPaneBoundsSync();
      frames.shift()?.(32);
      expect(visibleOf('occ-move')).toBe(true);
    } finally {
      detach();
    }
  });

  it('re-checks a surface that grows over the view after it opened', async () => {
    const { detach } = await attach('occ-grow', [40, 60, 320, 240]);
    try {
      const panel = popover('dialog', [500, 60, 100, 100]);
      await flush();
      expect(visibleOf('occ-grow')).toBe(true);

      measure(panel, [300, 60, 300, 300]);
      panel.append(document.createElement('li'));
      await flush();
      expect(visibleOf('occ-grow')).toBe(false);
    } finally {
      detach();
    }
  });

  it('sends nothing while the covered state does not flip', async () => {
    const { detach } = await attach('occ-quiet', [40, 60, 320, 240]);
    try {
      const menu = popover('menu', [300, 100, 200, 200]);
      await flush();
      setBounds.mockClear();

      menu.append(document.createElement('button'));
      popover('listbox', [320, 120, 100, 100]);
      document.body.append(document.createElement('p'));
      await flush();
      expect(setBounds).not.toHaveBeenCalled();
    } finally {
      detach();
    }
  });

  it('composes with the app-level suppression instead of fighting it', async () => {
    const { detach } = await attach('occ-compose', [40, 60, 320, 240]);
    try {
      setBrowserPaneSuppression('test-destination', true);
      expect(visibleOf('occ-compose')).toBe(false);
      setBounds.mockClear();

      const menu = popover('menu', [300, 100, 200, 200]);
      await flush();
      expect(setBounds).not.toHaveBeenCalled();

      setBrowserPaneSuppression('test-destination', false);
      expect(visibleOf('occ-compose')).toBe(false); // menu still crosses it

      menu.remove();
      await flush();
      expect(visibleOf('occ-compose')).toBe(true);
    } finally {
      setBrowserPaneSuppression('test-destination', false);
      detach();
    }
  });

  it('stops watching once the last pane detaches', async () => {
    const { detach } = await attach('occ-detach', [40, 60, 320, 240]);
    detach();
    setBounds.mockClear();
    popover('menu', [300, 100, 200, 200]);
    await flush();
    expect(setBounds).not.toHaveBeenCalled();
  });
});
