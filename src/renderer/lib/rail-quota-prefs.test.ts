import { describe, expect, it } from 'vitest';
import {
  loadQuotaCardExpanded,
  saveQuotaCardExpanded,
} from './rail-quota-prefs';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

describe('rail quota card prefs', () => {
  it('starts collapsed when nothing was saved', () => {
    expect(loadQuotaCardExpanded(memoryStorage())).toBe(false);
  });

  it('round-trips the expanded choice', () => {
    const store = memoryStorage();
    saveQuotaCardExpanded(true, store);
    expect(loadQuotaCardExpanded(store)).toBe(true);
    saveQuotaCardExpanded(false, store);
    expect(loadQuotaCardExpanded(store)).toBe(false);
  });

  it('treats unknown or corrupt values as collapsed', () => {
    for (const raw of ['', 'yes', '1', '{"a":1}', 'null']) {
      expect(loadQuotaCardExpanded(memoryStorage({ 'nexus.rail.quotaExpanded.v1': raw }))).toBe(false);
    }
  });

  it('never throws when storage is unavailable or throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(loadQuotaCardExpanded(broken)).toBe(false);
    expect(() => saveQuotaCardExpanded(true, broken)).not.toThrow();
    expect(loadQuotaCardExpanded(null)).toBe(false);
    expect(() => saveQuotaCardExpanded(true, null)).not.toThrow();
  });
});
