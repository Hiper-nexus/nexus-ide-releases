import { describe, expect, it } from 'vitest';
import { PET_INTERACTIVE_SELECTOR, pointInRect } from './pet-hit-test';

describe('pointInRect', () => {
  const box = { left: 10, right: 50, top: 20, bottom: 80 };

  it('detecta interior e bordas', () => {
    expect(pointInRect(10, 20, box)).toBe(true);
    expect(pointInRect(50, 80, box)).toBe(true);
    expect(pointInRect(30, 40, box)).toBe(true);
  });

  it('rejeita exterior', () => {
    expect(pointInRect(9, 40, box)).toBe(false);
    expect(pointInRect(30, 19, box)).toBe(false);
    expect(pointInRect(51, 40, box)).toBe(false);
  });
});

describe('PET_INTERACTIVE_SELECTOR', () => {
  it('inclui hit, balão e menu', () => {
    expect(PET_INTERACTIVE_SELECTOR).toContain('pet__hit');
    expect(PET_INTERACTIVE_SELECTOR).toContain('pet__balloon');
    expect(PET_INTERACTIVE_SELECTOR).toContain('pet__menu');
  });
});
