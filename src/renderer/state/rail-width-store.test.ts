/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  RAIL_WIDTH_DEFAULT,
  RAIL_WIDTH_MAX,
  RAIL_WIDTH_MIN,
  RAIL_WIDTH_STORAGE_KEY,
  clampRailWidth,
  readStoredRailWidth,
  useRailWidthStore,
} from './rail-width-store';

beforeEach(() => {
  localStorage.clear();
  useRailWidthStore.setState({ width: RAIL_WIDTH_DEFAULT });
});

describe('rail width store', () => {
  it('keeps every width inside the allowed band the design system allows', () => {
    expect(clampRailWidth(120)).toBe(RAIL_WIDTH_MIN);
    expect(clampRailWidth(2_000)).toBe(RAIL_WIDTH_MAX);
    expect(clampRailWidth(252)).toBe(252);
    expect(clampRailWidth(Number.NaN)).toBe(RAIL_WIDTH_DEFAULT);
  });

  it('persists the resized width so the rail survives a restart', () => {
    useRailWidthStore.getState().setWidth(276);
    expect(localStorage.getItem(RAIL_WIDTH_STORAGE_KEY)).toBe('276');
    expect(readStoredRailWidth()).toBe(276);
  });

  it('clamps what it reads back instead of trusting stored junk', () => {
    localStorage.setItem(RAIL_WIDTH_STORAGE_KEY, '9000');
    expect(readStoredRailWidth()).toBe(RAIL_WIDTH_MAX);

    localStorage.setItem(RAIL_WIDTH_STORAGE_KEY, 'not-a-number');
    expect(readStoredRailWidth()).toBe(RAIL_WIDTH_DEFAULT);
  });

  it('stays usable when storage refuses to write', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('storage disabled');
      },
    });
    try {
      expect(() => useRailWidthStore.getState().setWidth(250)).not.toThrow();
      expect(useRailWidthStore.getState().width).toBe(250);
      expect(readStoredRailWidth()).toBe(RAIL_WIDTH_DEFAULT);
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });
});
