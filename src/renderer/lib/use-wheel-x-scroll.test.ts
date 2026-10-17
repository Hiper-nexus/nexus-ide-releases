/** @vitest-environment jsdom */
import { expect, it } from 'vitest';
import { wheelToScrollLeft } from './use-wheel-x-scroll';

it('clamps wheel scrolling and releases the event at either edge', () => {
  const strip = document.createElement('div');
  Object.defineProperties(strip, {
    clientWidth: { value: 180 },
    scrollWidth: { value: 500 },
  });
  expect(wheelToScrollLeft(strip, new WheelEvent('wheel', { deltaY: 600 }))).toBe(true);
  expect(strip.scrollLeft).toBe(320);
  expect(wheelToScrollLeft(strip, new WheelEvent('wheel', { deltaY: 80 }))).toBe(false);
  expect(wheelToScrollLeft(strip, new WheelEvent('wheel', { deltaY: -600 }))).toBe(true);
  expect(strip.scrollLeft).toBe(0);
  expect(wheelToScrollLeft(strip, new WheelEvent('wheel', { deltaY: -80 }))).toBe(false);
  expect(wheelToScrollLeft(strip, new WheelEvent('wheel', { deltaY: 80, ctrlKey: true }))).toBe(false);
  expect(wheelToScrollLeft(strip, new WheelEvent('wheel', { deltaY: 80, deltaX: 40 }))).toBe(false);
});
