import { describe, expect, it } from 'vitest';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import { builtinFlagDefaults, parseFlagList } from './use-product-flags';

describe('builtinFlagDefaults', () => {
  it('mirrors the fail-closed shared definitions', () => {
    const defaults = builtinFlagDefaults();
    expect(defaults[FEATURE_FLAG_IDS.contextualPanel]).toBe(false);
    expect(defaults[FEATURE_FLAG_IDS.progressiveOnboarding]).toBe(false);
  });
});

describe('parseFlagList', () => {
  it('parses the flagsList IPC payload', () => {
    const parsed = parseFlagList([
      { id: 'feature.ui.contextualPanel', enabled: false, reason: 'kill-switch' },
      { id: 'feature.search.mixer', enabled: true, reason: 'default' },
    ]);
    expect(parsed).toEqual({
      'feature.ui.contextualPanel': false,
      'feature.search.mixer': true,
    });
  });

  it('fails closed on malformed payloads', () => {
    expect(parseFlagList(null)).toBeNull();
    expect(parseFlagList('nope')).toBeNull();
    expect(parseFlagList([{ id: 42, enabled: true }])).toBeNull();
    expect(parseFlagList([{ id: 'x', enabled: 'yes' }])).toBeNull();
  });
});
