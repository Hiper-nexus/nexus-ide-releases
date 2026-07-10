/**
 * Breakpoint preview (VISUAL-EDIT-001, F4): the embedded page's viewport IS
 * the WebContentsView size, so responsive preview = narrowing the view inside
 * its slot (centered). Pure math, CSS px — multi-DPI safe by construction.
 */

export const DESIGN_BREAKPOINTS = [375, 768, 1440] as const;

export interface ViewportBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
}

export function applyViewportOverride(
  bounds: ViewportBounds,
  width: number | null,
): ViewportBounds {
  if (!width || bounds.width <= width) return bounds;
  return {
    ...bounds,
    x: bounds.x + Math.floor((bounds.width - width) / 2),
    width,
  };
}
