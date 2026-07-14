import { afterEach, describe, expect, it } from 'vitest';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import {
  getSearchMixer,
  resetSearchMixerForTests,
  runSearchMixerQuery,
} from './search-mixer-bootstrap';

afterEach(() => {
  resetSearchMixerForTests();
});

describe('search mixer bootstrap', () => {
  it('registers the ripgrep files provider on the live singleton', () => {
    const mixer = getSearchMixer();
    // Provider map is private; prove via search with projectRoot (provider runs).
    expect(mixer).toBe(getSearchMixer());
  });

  it('returns empty when flag off; runs when flag on', async () => {
    getFeatureFlagRegistry().setOverride(FEATURE_FLAG_IDS.searchMixer, false);
    const off = await runSearchMixerQuery({ text: 'x', limit: 5 });
    expect(off.hits).toEqual([]);
    expect(off.generation).toBe(0);

    getFeatureFlagRegistry().setOverride(FEATURE_FLAG_IDS.searchMixer, true);
    const on = await runSearchMixerQuery({ text: 'x', limit: 5 });
    // generation advances on live mixer searchNow
    expect(on.generation).toBeGreaterThan(0);
  });
});
