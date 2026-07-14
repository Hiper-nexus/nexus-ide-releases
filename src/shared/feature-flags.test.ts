import { describe, expect, it } from 'vitest';
import {
  BUILTIN_FEATURE_FLAGS,
  channelAllowsFlag,
  featureFlagDefinitionSchema,
  resolveFeatureFlag,
} from './feature-flags';

describe('feature flags', () => {
  it('parses builtin definitions', () => {
    for (const flag of BUILTIN_FEATURE_FLAGS) {
      expect(() => featureFlagDefinitionSchema.parse(flag)).not.toThrow();
    }
  });

  it('channel policy is fail-closed for lower channels', () => {
    expect(channelAllowsFlag('dev', 'stable')).toBe(false);
    expect(channelAllowsFlag('stable', 'dev')).toBe(true);
    expect(channelAllowsFlag('preview', 'preview')).toBe(true);
    expect(channelAllowsFlag('dogfood', 'preview')).toBe(false);
  });

  it('kill switch wins over override', () => {
    const def = featureFlagDefinitionSchema.parse({
      id: 'feature.test.kill',
      owner: 'test',
      description: 'kill switch fixture',
      channel: 'dev',
      createdAt: '2026-07-13',
      removeAfter: '2026-12-31',
      killSwitch: true,
      telemetry: false,
      defaultEnabled: true,
    });
    expect(
      resolveFeatureFlag(def, { runtimeChannel: 'dev', override: true }),
    ).toMatchObject({ enabled: false, reason: 'kill-switch' });
  });

  it('unknown flags fail closed', () => {
    expect(
      resolveFeatureFlag(undefined, { runtimeChannel: 'stable' }),
    ).toMatchObject({ enabled: false, reason: 'unknown-flag' });
  });

  it('keeps every deferred product-wave flag default off', () => {
    for (const flag of BUILTIN_FEATURE_FLAGS) {
      expect(flag.defaultEnabled).toBe(false);
      expect(flag.channel).toBe('dev');
    }
  });
});
