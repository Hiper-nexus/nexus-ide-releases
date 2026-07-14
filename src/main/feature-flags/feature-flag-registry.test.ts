import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import { FeatureFlagRegistry } from './feature-flag-registry';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('FeatureFlagRegistry', () => {
  it('fails closed for unknown ids', () => {
    const registry = new FeatureFlagRegistry({ runtimeChannel: 'dev' });
    expect(registry.isEnabled('feature.does.not.exist')).toBe(false);
    expect(registry.resolve('feature.does.not.exist').reason).toBe(
      'unknown-flag',
    );
  });

  it('keeps learning-wave flags off by default on stable (channel allows, default false)', () => {
    const registry = new FeatureFlagRegistry({ runtimeChannel: 'stable' });
    // channel=dev means available from dev upward; defaultEnabled remains false.
    expect(registry.isEnabled(FEATURE_FLAG_IDS.terminalCommandBlocks)).toBe(
      false,
    );
    expect(
      registry.resolve(FEATURE_FLAG_IDS.terminalCommandBlocks).reason,
    ).toBe('default');
  });

  it('blocks dogfood runtime from preview-channel flags', () => {
    const registry = new FeatureFlagRegistry({
      runtimeChannel: 'dogfood',
      definitions: [
        {
          id: 'feature.test.previewOnly',
          owner: 'test',
          description: 'preview-only fixture',
          channel: 'preview',
          createdAt: '2026-07-13',
          removeAfter: '2026-12-31',
          killSwitch: false,
          telemetry: false,
          defaultEnabled: true,
        },
      ],
    });
    expect(registry.isEnabled('feature.test.previewOnly')).toBe(false);
    expect(registry.resolve('feature.test.previewOnly').reason).toBe(
      'channel-blocked',
    );
  });

  it('allows overrides on matching channel and kill switch force-off', () => {
    const registry = new FeatureFlagRegistry({ runtimeChannel: 'dev' });
    registry.setOverride(FEATURE_FLAG_IDS.searchMixer, true);
    expect(registry.isEnabled(FEATURE_FLAG_IDS.searchMixer)).toBe(true);

    registry.engageKillSwitch(FEATURE_FLAG_IDS.searchMixer);
    expect(registry.isEnabled(FEATURE_FLAG_IDS.searchMixer)).toBe(false);
    expect(registry.resolve(FEATURE_FLAG_IDS.searchMixer).reason).toBe(
      'kill-switch',
    );
  });

  it('loads overrides from disk fail-closed on corrupt JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ff-'));
    tempDirs.push(dir);
    const overridesPath = path.join(dir, 'feature-flags.json');
    fs.writeFileSync(overridesPath, '{not-json', 'utf8');

    const registry = new FeatureFlagRegistry({
      runtimeChannel: 'dev',
      overridesPath,
    });
    expect(registry.isEnabled(FEATURE_FLAG_IDS.missionEventJournal)).toBe(
      false,
    );
  });

  it('persists overrides atomically', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ff-'));
    tempDirs.push(dir);
    const overridesPath = path.join(dir, 'feature-flags.json');
    const registry = new FeatureFlagRegistry({
      runtimeChannel: 'dev',
      overridesPath,
    });
    registry.setOverride(FEATURE_FLAG_IDS.mcpHub, true);
    registry.persistOverrides();

    const reloaded = new FeatureFlagRegistry({
      runtimeChannel: 'dev',
      overridesPath,
    });
    expect(reloaded.isEnabled(FEATURE_FLAG_IDS.mcpHub)).toBe(true);
  });
});
