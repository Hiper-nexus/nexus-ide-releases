import { describe, expect, it } from 'vitest';
import {
  getAdapterHotCache,
  invalidateAdapterHotCache,
  loadAdaptersHot,
} from './adapter-hot-cache';
import type { AdapterInfo } from '../../shared/types';

function fake(id: string): AdapterInfo {
  return {
    id,
    kind: 'cli-pty',
    label: id,
    icon: 'x',
    models: { list: [], default: '' },
    installed: true,
    orchestratorCapable: true,
    installCommand: '',
    idleTimeoutMs: 800,
  };
}

describe('adapter-hot-cache', () => {
  it('caches until TTL then reloads', () => {
    invalidateAdapterHotCache();
    let now = 1_000;
    let loads = 0;
    const load = () => {
      loads += 1;
      return [fake('codex')];
    };
    const a = loadAdaptersHot(load, 100, () => now);
    const b = loadAdaptersHot(load, 100, () => now);
    expect(a).toBe(b);
    expect(loads).toBe(1);
    now += 150;
    loadAdaptersHot(load, 100, () => now);
    expect(loads).toBe(2);
  });

  it('invalidate clears snapshot', () => {
    invalidateAdapterHotCache();
    loadAdaptersHot(() => [fake('omp')], 60_000);
    expect(getAdapterHotCache()).not.toBeNull();
    invalidateAdapterHotCache();
    expect(getAdapterHotCache()).toBeNull();
  });
});
