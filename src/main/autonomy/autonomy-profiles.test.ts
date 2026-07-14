import { describe, expect, it } from 'vitest';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import { decideAutonomy } from './autonomy-profiles';

describe('autonomy profiles', () => {
  it('Inspect denies writes; Edit confirms; Autonomous needs worktree', () => {
    getFeatureFlagRegistry().setOverride(FEATURE_FLAG_IDS.autonomyProfiles, true);

    const inspect = decideAutonomy({
      profile: 'Inspect',
      tool: 'file_write',
      action: 'write',
      scope: '/ws',
    });
    expect(inspect.result).toBe('deny');

    const edit = decideAutonomy({
      profile: 'Edit',
      tool: 'file_write',
      action: 'write',
      scope: '/ws',
    });
    expect(edit.result).toBe('confirm');

    const autoOut = decideAutonomy({
      profile: 'Autonomous',
      tool: 'file_write',
      action: 'write',
      scope: '/ws',
      inIsolatedWorktree: false,
    });
    expect(autoOut.result).toBe('deny');

    const autoIn = decideAutonomy({
      profile: 'Autonomous',
      tool: 'file_write',
      action: 'write',
      scope: '/ws/worktree',
      inIsolatedWorktree: true,
    });
    expect(autoIn.result).toBe('allow');
    expect(autoIn.effectMayHaveCommitted).toBe(false);
  });
});
