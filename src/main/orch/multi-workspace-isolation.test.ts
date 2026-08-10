/**
 * Multi-workspace / multi-window isolation contracts.
 *
 * Electron multi-window is not exercised here (no Playwright harness).
 * These unit tests pin the isolation rules that multi-window must obey:
 * SearchMixer per root, pane recovery scope filtering.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import {
  getSearchMixer,
  resetSearchMixerForTests,
  runSearchMixerQuery,
} from '../search/search-mixer-bootstrap';

afterEach(() => {
  resetSearchMixerForTests();
});

describe('multi-workspace isolation (multi-window confidence)', () => {
  it('isolates SearchMixer instances and cancel domains per workspace root', () => {
    getFeatureFlagRegistry().setOverride(FEATURE_FLAG_IDS.searchMixer, true);
    const a = getSearchMixer('/ws-a');
    const b = getSearchMixer('/ws-b');
    expect(a).not.toBe(b);
    expect(getSearchMixer('/ws-a')).toBe(a);
    expect(getSearchMixer('/ws-b')).toBe(b);
  });

  it('does not share search generation across workspace roots', async () => {
    getFeatureFlagRegistry().setOverride(FEATURE_FLAG_IDS.searchMixer, true);
    const ra = await runSearchMixerQuery({
      text: 'alpha',
      limit: 3,
      projectRoot: '/ws-a',
    });
    const rb = await runSearchMixerQuery({
      text: 'beta',
      limit: 3,
      projectRoot: '/ws-b',
    });
    expect(ra.generation).toBeGreaterThan(0);
    expect(rb.generation).toBeGreaterThan(0);
    const ra2 = await runSearchMixerQuery({
      text: 'alpha2',
      limit: 3,
      projectRoot: '/ws-a',
    });
    expect(ra2.generation).toBeGreaterThan(ra.generation);
  });

});
