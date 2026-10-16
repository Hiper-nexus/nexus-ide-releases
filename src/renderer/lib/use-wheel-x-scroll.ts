import { useEffect, type RefObject } from 'react';

/**
 * Faixa de abas horizontal: a roda do mouse (deltaY) rola a faixa para os
 * lados quando ela transborda. Trackpad horizontal (deltaX) segue nativo.
 */
export function wheelToScrollLeft(strip: HTMLElement, event: WheelEvent): boolean {
  if (event.ctrlKey || event.deltaX !== 0 || event.deltaY === 0) return false;
  if (strip.scrollWidth <= strip.clientWidth) return false;
  const max = strip.scrollWidth - strip.clientWidth;
  const next = Math.min(max, Math.max(0, strip.scrollLeft + event.deltaY));
  if (next === strip.scrollLeft) return false;
  strip.scrollLeft = next;
  return true;
}

/**
 * Listener nativo não-passivo: o onWheel do React é passivo e não consegue
 * impedir a rolagem vertical do ancestral.
 */
export function useWheelXScroll(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const strip = ref.current;
    if (!strip) return;
    const onWheel = (event: WheelEvent) => {
      if (wheelToScrollLeft(strip, event)) event.preventDefault();
    };
    strip.addEventListener('wheel', onWheel, { passive: false });
    return () => strip.removeEventListener('wheel', onWheel);
  }, [ref]);
}
