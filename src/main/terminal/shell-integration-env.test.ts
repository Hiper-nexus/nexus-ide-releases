import { afterEach, describe, expect, it } from 'vitest';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import {
  getFeatureFlagRegistry,
  resetFeatureFlagRegistryForTests,
} from '../feature-flags/feature-flag-registry';
import {
  applyShellIntegrationEnv,
  isShellIntegrationEnabled,
  shellIntegrationBootstrapCommand,
} from './shell-integration-env';

afterEach(() => {
  resetFeatureFlagRegistryForTests();
});

describe('shell integration env', () => {
  it('is enabled by default with product flags ON', () => {
    expect(isShellIntegrationEnabled()).toBe(true);
  });

  it('injects NEXUS_SHELL_INTEGRATION when flag on', () => {
    const env = applyShellIntegrationEnv({ PATH: '/usr/bin' }, '/bin/zsh');
    expect(env.NEXUS_SHELL_INTEGRATION).toBe('1');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('returns bootstrap source for zsh/bash when flag on', () => {
    const zsh = shellIntegrationBootstrapCommand('/bin/zsh');
    const bash = shellIntegrationBootstrapCommand('/bin/bash');
    // Scripts exist under resources/ in repo root for local runs.
    if (zsh) {
      expect(zsh).toContain('source');
      expect(zsh).toContain('nexus-osc133.zsh');
    }
    if (bash) {
      expect(bash).toContain('nexus-osc133.bash');
    }
  });

  it('no-ops when commandBlocks killed', () => {
    getFeatureFlagRegistry().engageKillSwitch(
      FEATURE_FLAG_IDS.terminalCommandBlocks,
    );
    expect(isShellIntegrationEnabled()).toBe(false);
    expect(applyShellIntegrationEnv({ A: '1' }, '/bin/zsh')).toEqual({ A: '1' });
    expect(shellIntegrationBootstrapCommand('/bin/zsh')).toBeNull();
  });
});
