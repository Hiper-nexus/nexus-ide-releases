/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FLOATING_SURFACE_SELECTOR,
  collectFloatingSurfaces,
  isCoveredByFloatingSurface,
  watchFloatingSurfaces,
} from './browser-occlusion';

type Rect = [left: number, top: number, width: number, height: number];

function measure(element: Element, [left, top, width, height]: Rect): void {
  element.getBoundingClientRect = () =>
    ({
      left,
      top,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
      width,
      height,
    }) as DOMRect;
}

function surface(
  attrs: Record<string, string>,
  rect: Rect,
  parent: Element = document.body,
): HTMLElement {
  const element = document.createElement('div');
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
  measure(element, rect);
  parent.append(element);
  return element;
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  document.body.replaceChildren();
});

describe('floating surface detection (native view occlusion)', () => {
  it.each([
    ['dialog', { role: 'dialog' }],
    ['alertdialog', { role: 'alertdialog' }],
    ['menu', { role: 'menu' }],
    ['listbox', { role: 'listbox' }],
    ['aria-modal', { 'aria-modal': 'true' }],
  ])('recognizes a %s that is on screen', (_name, attrs) => {
    const element = surface(attrs, [10, 10, 100, 100]);
    expect(collectFloatingSurfaces().map((found) => found.element)).toEqual([element]);
  });

  it('ignores roles that never float over a page and boxes that are not painted', () => {
    surface({ role: 'status' }, [0, 0, 100, 100]);
    surface({ role: 'region' }, [0, 0, 100, 100]);
    surface({ role: 'tab' }, [0, 0, 100, 100]);
    surface({ role: 'menu' }, [0, 0, 0, 0]);
    const invisible = surface({ role: 'dialog' }, [0, 0, 100, 100]);
    invisible.style.visibility = 'hidden';
    surface({ 'aria-modal': 'false' }, [0, 0, 100, 100]);
    expect(collectFloatingSurfaces()).toEqual([]);
  });

  it('marks aria-modal surfaces as modal and plain popovers as not', () => {
    surface({ role: 'menu' }, [0, 0, 50, 50]);
    surface({ role: 'dialog', 'aria-modal': 'true' }, [0, 0, 50, 50]);
    expect(collectFloatingSurfaces().map((found) => found.modal)).toEqual([false, true]);
  });

  it('exposes the selector as the single contract with the a11y roles', () => {
    for (const role of ['dialog', 'alertdialog', 'menu', 'listbox']) {
      const probe = document.createElement('div');
      probe.setAttribute('role', role);
      expect(probe.matches(FLOATING_SURFACE_SELECTOR)).toBe(true);
    }
  });
});

describe('isCoveredByFloatingSurface', () => {
  const view = { x: 100, y: 100, width: 200, height: 150 };
  const slot = () => document.createElement('div');

  it('is covered when a popover crosses the view, even by a corner', () => {
    surface({ role: 'menu' }, [280, 230, 100, 100]);
    expect(isCoveredByFloatingSurface(view, slot(), collectFloatingSurfaces())).toBe(true);
  });

  it('is not covered by a popover that only touches the edge or sits elsewhere', () => {
    surface({ role: 'menu' }, [300, 100, 80, 80]);
    surface({ role: 'menu' }, [0, 250, 400, 40]);
    surface({ role: 'dialog' }, [500, 500, 80, 80]);
    expect(isCoveredByFloatingSurface(view, slot(), collectFloatingSurfaces())).toBe(false);
  });

  it('covers every view while an aria-modal surface is open, wherever its box is', () => {
    surface({ role: 'dialog', 'aria-modal': 'true' }, [900, 900, 50, 50]);
    expect(isCoveredByFloatingSurface(view, slot(), collectFloatingSurfaces())).toBe(true);
  });

  it('does not treat the pane\'s own frame as something on top of the page', () => {
    const frame = surface({ role: 'dialog', 'aria-modal': 'true' }, [0, 0, 1000, 800]);
    const inside = slot();
    frame.append(inside);
    expect(isCoveredByFloatingSurface(view, inside, collectFloatingSurfaces())).toBe(false);

    const nested = surface({ role: 'listbox' }, [100, 100, 200, 150], inside);
    expect(isCoveredByFloatingSurface(view, inside, collectFloatingSurfaces())).toBe(false);
    nested.remove();
  });
});

describe('watchFloatingSurfaces', () => {
  it('fires when a surface mounts, grows and unmounts', async () => {
    const onChange = vi.fn();
    const stop = watchFloatingSurfaces(onChange);
    try {
      const menu = surface({ role: 'menu' }, [0, 0, 50, 50]);
      await flush();
      expect(onChange).toHaveBeenCalledTimes(1);

      menu.append(document.createElement('button'));
      await flush();
      expect(onChange).toHaveBeenCalledTimes(2);

      menu.remove();
      await flush();
      expect(onChange).toHaveBeenCalledTimes(3);
    } finally {
      stop();
    }
  });

  it('fires when a wrapper that holds a surface is added or removed', async () => {
    const onChange = vi.fn();
    const stop = watchFloatingSurfaces(onChange);
    try {
      const wrapper = document.createElement('div');
      surface({ role: 'dialog' }, [0, 0, 50, 50], wrapper);
      document.body.append(wrapper);
      await flush();
      expect(onChange).toHaveBeenCalledTimes(1);
      wrapper.remove();
      await flush();
      expect(onChange).toHaveBeenCalledTimes(2);
    } finally {
      stop();
    }
  });

  it('fires when an element gains, loses or hides behind its role', async () => {
    const element = document.createElement('div');
    document.body.append(element);
    const onChange = vi.fn();
    const stop = watchFloatingSurfaces(onChange);
    try {
      element.setAttribute('role', 'menu');
      await flush();
      expect(onChange).toHaveBeenCalledTimes(1);

      element.hidden = true;
      await flush();
      expect(onChange).toHaveBeenCalledTimes(2);

      element.removeAttribute('role');
      await flush();
      expect(onChange).toHaveBeenCalledTimes(3);
    } finally {
      stop();
    }
  });

  it('ignores unrelated churn: plain nodes, text, class and style', async () => {
    const plain = document.createElement('div');
    document.body.append(plain);
    const onChange = vi.fn();
    const stop = watchFloatingSurfaces(onChange);
    try {
      plain.append(document.createElement('span'));
      plain.textContent = 'streaming output';
      plain.className = 'busy';
      plain.style.opacity = '0.5';
      plain.setAttribute('role', 'tab');
      plain.hidden = true;
      await flush();
      expect(onChange).toHaveBeenCalledTimes(1); // only the `role` write counts
      onChange.mockClear();

      plain.append(document.createElement('div'));
      plain.className = 'quiet';
      await flush();
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it('stops observing once disposed', async () => {
    const onChange = vi.fn();
    watchFloatingSurfaces(onChange)();
    surface({ role: 'menu' }, [0, 0, 50, 50]);
    await flush();
    expect(onChange).not.toHaveBeenCalled();
  });
});
