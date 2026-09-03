import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import {
  getFeatureFlagRegistry,
  resetFeatureFlagRegistryForTests,
} from '../feature-flags/feature-flag-registry';
import {
  applyShellIntegrationEnv,
  cleanupShellIntegrationPaths,
  isShellIntegrationEnabled,
  shellIntegrationBootstrapCommand,
  shellIntegrationSpawnArgs,
} from './shell-integration-env';

afterEach(() => {
  resetFeatureFlagRegistryForTests();
});

describe('shell integration env', () => {
  it('is enabled by default and disableable by override', () => {
    expect(isShellIntegrationEnabled()).toBe(true);
    getFeatureFlagRegistry().setOverride(
      FEATURE_FLAG_IDS.terminalCommandBlocks,
      false,
    );
    expect(isShellIntegrationEnabled()).toBe(false);
  });

  it('injects NEXUS_SHELL_INTEGRATION and ZDOTDIR for zsh without PTY write', () => {
    getFeatureFlagRegistry().setOverride(
      FEATURE_FLAG_IDS.terminalCommandBlocks,
      true,
    );
    const { env, cleanupPaths } = applyShellIntegrationEnv(
      { PATH: '/usr/bin' },
      '/bin/zsh',
    );
    expect(env.NEXUS_SHELL_INTEGRATION).toBe('1');
    expect(env.PATH).toBe('/usr/bin');
    expect(shellIntegrationBootstrapCommand('/bin/zsh')).toBeNull();
    if (cleanupPaths.length > 0) {
      expect(env.ZDOTDIR).toBeTruthy();
      expect(env.__NX_ORIG_ZDOTDIR).toBeTruthy();
      expect(fs.existsSync(env.ZDOTDIR!)).toBe(true);
      const rc = fs.readFileSync(`${env.ZDOTDIR}/.zshrc`, 'utf8');
      expect(rc).toContain('nexus-osc133.zsh');
      const profile = fs.readFileSync(`${env.ZDOTDIR}/.zprofile`, 'utf8');
      expect(profile).toContain('/etc/zprofile');
      expect(profile).toContain('.zprofile');
      const zshenv = fs.readFileSync(`${env.ZDOTDIR}/.zshenv`, 'utf8');
      expect(zshenv).toContain('.zshenv');
      cleanupShellIntegrationPaths(cleanupPaths);
    }
  });

  it('uses --rcfile for bash composite rc', () => {
    getFeatureFlagRegistry().setOverride(
      FEATURE_FLAG_IDS.terminalCommandBlocks,
      true,
    );
    const { env, cleanupPaths } = applyShellIntegrationEnv({}, '/bin/bash');
    const args = shellIntegrationSpawnArgs('/bin/bash', env);
    if (env.NEXUS_BASHRC) {
      expect(args).toEqual(['--rcfile', env.NEXUS_BASHRC]);
    }
    cleanupShellIntegrationPaths(cleanupPaths);
  });

  it('no-ops when commandBlocks killed', () => {
    getFeatureFlagRegistry().engageKillSwitch(
      FEATURE_FLAG_IDS.terminalCommandBlocks,
    );
    expect(isShellIntegrationEnabled()).toBe(false);
    const { env, cleanupPaths } = applyShellIntegrationEnv(
      { A: '1' },
      '/bin/zsh',
    );
    expect(env).toEqual({ A: '1' });
    expect(cleanupPaths).toEqual([]);
    expect(shellIntegrationBootstrapCommand('/bin/zsh')).toBeNull();
  });
});
