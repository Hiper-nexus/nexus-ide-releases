import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import type { BrowserDesignAnnotationMarker } from '../shared/browser-design';
import { createBrowserAutomation } from './browser-automation';
import {
  DESIGN_ANNOTATION_HOST_ID,
  createAnnotationMarkerLayer,
  parseAnnotationMarkers,
} from './browser-design-annotations';

type BrowserDomWindow = Window & typeof globalThis;

function fixture(): {
  win: BrowserDomWindow;
  shadows: ShadowRoot[];
} {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>conteúdo</p></main></body></html>',
    { url: 'https://example.test/', pretendToBeVisual: true },
  );
  const win = dom.window as unknown as BrowserDomWindow;
  // The production layer uses a CLOSED shadow root; capture the instances at
  // attach time so tests can assert badge internals without opening it.
  const shadows: ShadowRoot[] = [];
  const originalAttach = win.Element.prototype.attachShadow;
  win.Element.prototype.attachShadow = function patched(init: ShadowRootInit) {
    const shadow = originalAttach.call(this, init);
    shadows.push(shadow);
    return shadow;
  };
  return { win, shadows };
}

function marker(
  id: string,
  index: number,
  overrides: Partial<BrowserDesignAnnotationMarker> = {},
): BrowserDesignAnnotationMarker {
  return {
    id,
    index,
    rectPage: { x: 40, y: 300, width: 120, height: 30 },
    rectViewport: { x: 40, y: 300, width: 120, height: 30 },
    isFixed: false,
    ...overrides,
  };
}

function badgesOf(shadow: ShadowRoot): HTMLElement[] {
  return [...shadow.querySelectorAll('.nx-badge')] as HTMLElement[];
}

describe('createAnnotationMarkerLayer', () => {
  it('mounts numbered badges (index+1) in a closed shadow host', () => {
    const { win, shadows } = fixture();
    const layer = createAnnotationMarkerLayer(win);

    const result = layer.set([marker('a', 0), marker('b', 1)]);

    expect(result).toEqual({ applied: true, markers: 2 });
    const host = win.document.getElementById(DESIGN_ANNOTATION_HOST_ID);
    expect(host).not.toBeNull();
    expect(host?.shadowRoot).toBeNull(); // closed to the page
    const labels = badgesOf(shadows[0]).map((badge) => badge.textContent);
    expect(labels).toEqual(['1', '2']);
  });

  it('positions page markers relative to scroll and pins fixed markers to the viewport', () => {
    const { win, shadows } = fixture();
    Object.defineProperty(win, 'scrollY', { value: 100, configurable: true });
    Object.defineProperty(win, 'scrollX', { value: 10, configurable: true });
    Object.defineProperty(win, 'innerWidth', { value: 800, configurable: true });
    Object.defineProperty(win, 'innerHeight', { value: 600, configurable: true });
    const layer = createAnnotationMarkerLayer(win);

    layer.set([
      marker('page', 0, { rectPage: { x: 40, y: 300, width: 120, height: 30 } }),
      marker('fixed', 1, {
        isFixed: true,
        rectViewport: { x: 700, y: 8, width: 60, height: 24 },
      }),
    ]);

    const [pageBadge, fixedBadge] = badgesOf(shadows[0]);
    // page: x = 40-10 + 120/2 - 12 = 78 ; y = 300-100 + 30 - 12 = 218
    expect(pageBadge.style.transform).toBe('translate(78px, 218px)');
    // fixed: x = 700 + 60/2 - 12 = 718 ; y = 8 + 24 - 12 = 20
    expect(fixedBadge.style.transform).toBe('translate(718px, 20px)');
  });

  it('hides badges whose element is outside the viewport', () => {
    const { win, shadows } = fixture();
    Object.defineProperty(win, 'innerWidth', { value: 800, configurable: true });
    Object.defineProperty(win, 'innerHeight', { value: 600, configurable: true });
    const layer = createAnnotationMarkerLayer(win);

    layer.set([
      marker('below-fold', 0, {
        rectPage: { x: 40, y: 5_000, width: 120, height: 30 },
      }),
    ]);

    expect(badgesOf(shadows[0])[0].style.display).toBe('none');
  });

  it('replaces the set: removed ids disappear, empty set tears the host down', () => {
    const { win, shadows } = fixture();
    const layer = createAnnotationMarkerLayer(win);

    layer.set([marker('a', 0), marker('b', 1)]);
    layer.set([marker('b', 0)]);
    expect(badgesOf(shadows[0]).map((badge) => badge.textContent)).toEqual(['1']);

    const result = layer.set([]);
    expect(result).toEqual({ applied: true, markers: 0 });
    expect(win.document.getElementById(DESIGN_ANNOTATION_HOST_ID)).toBeNull();
    expect(layer.count()).toBe(0);
  });
});

describe('parseAnnotationMarkers', () => {
  it('accepts a valid list and coerces isFixed to a strict boolean', () => {
    const parsed = parseAnnotationMarkers([
      { ...marker('ok', 3), isFixed: 'yes' as unknown as boolean },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].isFixed).toBe(false);
  });

  it('rejects oversized lists, bad ids, bad indexes and bad rects', () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => marker(`m${i}`, i));
    expect(() => parseAnnotationMarkers(tooMany)).toThrow(/at most 20/);
    expect(() => parseAnnotationMarkers([{ ...marker('a', 0), id: '' }])).toThrow(
      /id is invalid/,
    );
    expect(() =>
      parseAnnotationMarkers([{ ...marker('a', 0), index: 1.5 }]),
    ).toThrow(/index is invalid/);
    expect(() =>
      parseAnnotationMarkers([
        { ...marker('a', 0), rectPage: { x: Number.NaN, y: 0, width: 1, height: 1 } },
      ]),
    ).toThrow(/rect is invalid/);
    expect(() => parseAnnotationMarkers({} as unknown as [])).toThrow(
      /must be an array/,
    );
  });
});

describe('design_set_annotation_markers automation command', () => {
  it('applies markers through the closed automation channel', async () => {
    const { win, shadows } = fixture();
    const automation = createBrowserAutomation(win, {});

    const result = await automation.run('design_set_annotation_markers', {
      markers: [marker('a', 0)],
    });

    expect(result).toEqual({ applied: true, markers: 1 });
    expect(shadows).toHaveLength(1);
    expect(badgesOf(shadows[0])).toHaveLength(1);
  });

  it('clearing without a live layer is a no-op that mounts nothing', async () => {
    const { win } = fixture();
    const automation = createBrowserAutomation(win, {});

    const result = await automation.run('design_set_annotation_markers', {
      markers: [],
    });

    expect(result).toEqual({ applied: true, markers: 0 });
    expect(win.document.getElementById(DESIGN_ANNOTATION_HOST_ID)).toBeNull();
  });

  it('rejects malformed marker payloads', async () => {
    const { win } = fixture();
    const automation = createBrowserAutomation(win, {});

    await expect(
      automation.run('design_set_annotation_markers', { markers: 'nope' }),
    ).rejects.toThrow(/must be an array/);
  });
});
