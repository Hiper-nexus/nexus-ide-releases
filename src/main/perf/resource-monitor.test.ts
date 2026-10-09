import { describe, expect, it } from 'vitest';
import {
  isSystemUnderMemoryPressure,
  ResourceSampleWindow,
  sampleSystemResources,
} from './resource-monitor';

describe('resource monitor (T3 first cut)', () => {
  it('samples system and process numbers', () => {
    const sample = sampleSystemResources({ now: () => 1_000 });
    expect(sample.sampledAt).toBe(1_000);
    expect(sample.totalMemBytes).toBeGreaterThan(0);
    expect(sample.usedMemRatio).toBeGreaterThanOrEqual(0);
    expect(sample.usedMemRatio).toBeLessThanOrEqual(1);
    expect(sample.process.rssBytes).toBeGreaterThan(0);
    expect(sample.uptimeSec).toBeGreaterThan(0);
  });

  it('pressure is real only when free memory ratio drops', () => {
    const base = sampleSystemResources();
    expect(
      isSystemUnderMemoryPressure({ ...base, freeMemBytes: base.totalMemBytes * 0.5 }),
    ).toBe(false);
    expect(
      isSystemUnderMemoryPressure({ ...base, freeMemBytes: base.totalMemBytes * 0.05 }),
    ).toBe(true);
    expect(
      isSystemUnderMemoryPressure({ ...base, totalMemBytes: 0, freeMemBytes: 0 }),
    ).toBe(false);
  });

  it('window keeps peak and average without unbounded growth', () => {
    const window = new ResourceSampleWindow(3);
    const sample = sampleSystemResources();
    window.push({ ...sample, usedMemRatio: 0.2, loadAvg1: 1 });
    window.push({ ...sample, usedMemRatio: 0.8, loadAvg1: 3 });
    window.push({ ...sample, usedMemRatio: 0.4, loadAvg1: 2 });
    window.push({ ...sample, usedMemRatio: 0.1, loadAvg1: 0 });
    expect(window.size).toBe(3);
    // 0.8 saiu da janela; pico da janela atual é 0.4
    expect(window.peakUsedMemRatio()).toBe(0.4);
    expect(window.averageLoad1()).toBeCloseTo((3 + 2 + 0) / 3, 5);
    expect(window.latest()?.usedMemRatio).toBe(0.1);
  });
});
