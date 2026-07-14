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
  it('registers ripgrep files AND shallow workspaces without overwrite', () => {
    const mixer = getSearchMixer();
    expect(mixer).toBe(getSearchMixer());
    // Critical: one provider per source key — shallow must not clobber ripgrep.
    const sources = mixer.sources();
    expect(sources).toContain('files');
    expect(sources).toContain('workspaces');
    expect(sources).toContain('missions');
    expect(sources).toContain('skills');
    // uniqueness
    expect(new Set(sources).size).toBe(sources.length);
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
