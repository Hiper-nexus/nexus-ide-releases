/** @vitest-environment jsdom */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MISSION_INSPECTOR_WIDTH_DEFAULT,
  MISSION_INSPECTOR_WIDTH_MAX,
  MISSION_INSPECTOR_WIDTH_MIN,
  MISSION_INSPECTOR_WIDTH_STORAGE_KEY,
  clampInspectorWidth,
  readStoredInspectorWidth,
  useInspectorWidthStore,
} from './mission-inspector-width-store';

beforeEach(() => {
  localStorage.clear();
  useInspectorWidthStore.setState({ width: MISSION_INSPECTOR_WIDTH_DEFAULT });
});

describe('mission inspector width store', () => {
  it('mirrors the shell inspector band declared in app-shell.css', () => {
    const appShellCss = fs.readFileSync(
      path.resolve(process.cwd(), 'src/renderer/styles/app-shell.css'),
      'utf8',
    );
    const min = appShellCss.match(/--nexus-shell-inspector-min:\s*(\d+)px/u);
    const max = appShellCss.match(/--nexus-shell-inspector-max:\s*(\d+)px/u);

    expect(Number(min?.[1])).toBe(MISSION_INSPECTOR_WIDTH_MIN);
    expect(Number(max?.[1])).toBe(MISSION_INSPECTOR_WIDTH_MAX);
    expect(MISSION_INSPECTOR_WIDTH_DEFAULT).toBeGreaterThanOrEqual(
      MISSION_INSPECTOR_WIDTH_MIN,
    );
    expect(MISSION_INSPECTOR_WIDTH_DEFAULT).toBeLessThanOrEqual(
      MISSION_INSPECTOR_WIDTH_MAX,
    );
  });

  it('keeps every width inside the band the shell grants the inspector', () => {
    expect(clampInspectorWidth(120)).toBe(MISSION_INSPECTOR_WIDTH_MIN);
    expect(clampInspectorWidth(2_000)).toBe(MISSION_INSPECTOR_WIDTH_MAX);
    expect(clampInspectorWidth(412.4)).toBe(412);
    expect(clampInspectorWidth(Number.NaN)).toBe(MISSION_INSPECTOR_WIDTH_DEFAULT);
    expect(clampInspectorWidth(Number.POSITIVE_INFINITY)).toBe(
      MISSION_INSPECTOR_WIDTH_DEFAULT,
    );
  });

  it('persists the resized width so the inspector survives a restart', () => {
    useInspectorWidthStore.getState().setWidth(424);
    expect(localStorage.getItem(MISSION_INSPECTOR_WIDTH_STORAGE_KEY)).toBe(
      '424',
    );
    expect(readStoredInspectorWidth()).toBe(424);
  });

  it('clamps what it reads back instead of trusting stored junk', () => {
    localStorage.setItem(MISSION_INSPECTOR_WIDTH_STORAGE_KEY, '9000');
    expect(readStoredInspectorWidth()).toBe(MISSION_INSPECTOR_WIDTH_MAX);

    localStorage.setItem(MISSION_INSPECTOR_WIDTH_STORAGE_KEY, '12');
    expect(readStoredInspectorWidth()).toBe(MISSION_INSPECTOR_WIDTH_MIN);

    localStorage.setItem(MISSION_INSPECTOR_WIDTH_STORAGE_KEY, 'not-a-number');
    expect(readStoredInspectorWidth()).toBe(MISSION_INSPECTOR_WIDTH_DEFAULT);
  });

  it('resets to the default and persists that choice', () => {
    useInspectorWidthStore.getState().setWidth(MISSION_INSPECTOR_WIDTH_MAX);
    useInspectorWidthStore.getState().reset();

    expect(useInspectorWidthStore.getState().width).toBe(
      MISSION_INSPECTOR_WIDTH_DEFAULT,
    );
    expect(localStorage.getItem(MISSION_INSPECTOR_WIDTH_STORAGE_KEY)).toBe(
      String(MISSION_INSPECTOR_WIDTH_DEFAULT),
    );
  });

  it('stays usable when storage refuses to work', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('storage disabled');
      },
    });
    try {
      expect(() => useInspectorWidthStore.getState().setWidth(380)).not.toThrow();
      expect(useInspectorWidthStore.getState().width).toBe(380);
      expect(() => useInspectorWidthStore.getState().reset()).not.toThrow();
      expect(readStoredInspectorWidth()).toBe(MISSION_INSPECTOR_WIDTH_DEFAULT);
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });

  it('survives a storage that exists but throws on access', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem() {
          throw new Error('quota');
        },
        setItem() {
          throw new Error('quota');
        },
      },
    });
    try {
      expect(readStoredInspectorWidth()).toBe(MISSION_INSPECTOR_WIDTH_DEFAULT);
      expect(() => useInspectorWidthStore.getState().setWidth(400)).not.toThrow();
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });
});
