import { describe, expect, it } from 'vitest';
import { DESIGN_BREAKPOINTS, applyViewportOverride } from './viewport-override';

const SLOT = { x: 100, y: 50, width: 1200, height: 800, visible: true };

describe('applyViewportOverride', () => {
  it('narrows and centers the view at the breakpoint width', () => {
    expect(applyViewportOverride(SLOT, 375)).toEqual({
      x: 100 + Math.floor((1200 - 375) / 2),
      y: 50,
      width: 375,
      height: 800,
      visible: true,
    });
  });

  it('leaves bounds alone when the slot is narrower than the breakpoint', () => {
    const narrow = { ...SLOT, width: 360 };
    expect(applyViewportOverride(narrow, 375)).toEqual(narrow);
  });

  it('null override is a no-op; breakpoints are the canonical trio', () => {
    expect(applyViewportOverride(SLOT, null)).toEqual(SLOT);
    expect(DESIGN_BREAKPOINTS).toEqual([375, 768, 1440]);
  });
});
