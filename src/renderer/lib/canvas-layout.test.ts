import { describe, expect, it } from 'vitest';
import {
  defaultCanvasLayout,
  ensureCanvasLayouts,
  nextCanvasLayout,
  pruneCanvasLayouts,
} from './canvas-layout';
import type { CanvasNodeLayout } from '../../shared/types';

describe('defaultCanvasLayout', () => {
  it('places the first pane at the origin offset', () => {
    const layout = defaultCanvasLayout(0);
    expect(layout.position).toEqual({ x: 24, y: 24 });
  });

  it('advances columns across the first row', () => {
    const first = defaultCanvasLayout(0);
    const second = defaultCanvasLayout(1);
    expect(second.position.y).toBe(first.position.y);
    expect(second.position.x).toBeGreaterThan(first.position.x);
  });

  it('wraps to a new row after 3 columns', () => {
    const first = defaultCanvasLayout(0);
    const fourth = defaultCanvasLayout(3);
    expect(fourth.position.x).toBe(first.position.x);
    expect(fourth.position.y).toBeGreaterThan(first.position.y);
  });

  it('returns a default size', () => {
    const { size } = defaultCanvasLayout(0);
    expect(size.width).toBeGreaterThan(0);
    expect(size.height).toBeGreaterThan(0);
  });
});

describe('ensureCanvasLayouts', () => {
  it('fills missing entries for each pane', () => {
    const panes = [
      { id: 'a', kind: 'shell' as const, title: 'A' },
      { id: 'b', kind: 'shell' as const, title: 'B' },
    ];
    const result = ensureCanvasLayouts(panes, {});
    expect(result['a']).toBeDefined();
    expect(result['b']).toBeDefined();
  });

  it('preserves existing entries unchanged', () => {
    const custom: CanvasNodeLayout = {
      position: { x: 999, y: 888 },
      size: { width: 100, height: 200 },
      z: 42,
    };
    const panes = [{ id: 'a', kind: 'shell' as const, title: 'A' }];
    const result = ensureCanvasLayouts(panes, { a: custom });
    expect(result['a']).toBe(custom);
  });

  it('does not mutate the existing record', () => {
    const existing: Record<string, CanvasNodeLayout> = {};
    const panes = [{ id: 'x', kind: 'shell' as const, title: 'X' }];
    ensureCanvasLayouts(panes, existing);
    expect(Object.keys(existing)).toHaveLength(0);
  });
});

describe('nextCanvasLayout', () => {
  it('places a new pane to the right of the focused pane', () => {
    const focused = defaultCanvasLayout(0);
    const next = nextCanvasLayout({ a: focused }, 'a', 1);

    expect(next.position.y).toBe(focused.position.y);
    expect(next.position.x).toBe(focused.position.x + focused.size.width + 24);
    expect(next.size).toEqual(focused.size);
    expect(next.z).toBeGreaterThan(focused.z);
  });

  it('keeps scanning right when the first sibling slot is occupied', () => {
    const focused = defaultCanvasLayout(0);
    const firstRight: CanvasNodeLayout = {
      ...defaultCanvasLayout(1),
      position: { x: focused.position.x + focused.size.width + 24, y: focused.position.y },
    };

    const next = nextCanvasLayout({ a: focused, b: firstRight }, 'a', 2);

    expect(next.position.y).toBe(focused.position.y);
    expect(next.position.x).toBe(firstRight.position.x + focused.size.width + 24);
  });

  it('falls back to the default cascade when no pivot layout exists', () => {
    const next = nextCanvasLayout({}, 'missing', 2);

    expect(next.position).toEqual(defaultCanvasLayout(2).position);
    expect(next.z).toBe(0);
  });
});

describe('pruneCanvasLayouts', () => {
  it('removes entries for panes that no longer exist', () => {
    const layouts: Record<string, CanvasNodeLayout> = {
      a: defaultCanvasLayout(0),
      b: defaultCanvasLayout(1),
    };
    const result = pruneCanvasLayouts(layouts, new Set(['a']));
    expect(result['a']).toBeDefined();
    expect(result['b']).toBeUndefined();
  });

  it('returns an empty object when live set is empty', () => {
    const layouts: Record<string, CanvasNodeLayout> = { a: defaultCanvasLayout(0) };
    expect(pruneCanvasLayouts(layouts, new Set())).toEqual({});
  });

  it('does not mutate the input', () => {
    const layouts: Record<string, CanvasNodeLayout> = { a: defaultCanvasLayout(0) };
    pruneCanvasLayouts(layouts, new Set());
    expect(layouts['a']).toBeDefined();
  });
});
