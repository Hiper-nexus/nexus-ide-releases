import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import forgeConfig from '../../../forge.config';
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

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

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

  // Symlinks de diretório pedem privilégio no Windows; zsh/bash são POSIX aqui.
  it.skipIf(process.platform === 'win32')('F-1210: o app empacotado acha os scripts OSC 133 em Resources', () => {
    getFeatureFlagRegistry().setOverride(
      FEATURE_FLAG_IDS.terminalCommandBlocks,
      true,
    );
    // Resources do app empacotado: o packager copia cada extraResource para
    // Resources/<basename>. Aberto pelo Finder, o cwd é "/" e não há
    // NEXUS_RESOURCES_DIR — só o process.resourcesPath vale.
    const resources = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-packaged-resources-'));
    for (const entry of forgeConfig.packagerConfig?.extraResource ?? []) {
      fs.symlinkSync(path.resolve(repoRoot, entry), path.join(resources, path.basename(entry)));
    }
    const runtime = process as NodeJS.Process & { resourcesPath?: string };
    const previousResources = runtime.resourcesPath;
    const previousDir = process.env.NEXUS_RESOURCES_DIR;
    delete process.env.NEXUS_RESOURCES_DIR;
    runtime.resourcesPath = resources;
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue('/');
    let applied: ReturnType<typeof applyShellIntegrationEnv>;
    try {
      applied = applyShellIntegrationEnv({ PATH: '/usr/bin' }, '/bin/zsh');
    } finally {
      cwd.mockRestore();
      runtime.resourcesPath = previousResources;
      if (previousDir !== undefined) process.env.NEXUS_RESOURCES_DIR = previousDir;
    }
    try {
      expect(applied.env.NEXUS_OSC133_ZSH).toBe(
        path.join(resources, 'shell-integration', 'nexus-osc133.zsh'),
      );
      expect(applied.env.ZDOTDIR).toBeTruthy();
    } finally {
      cleanupShellIntegrationPaths(applied.cleanupPaths);
      fs.rmSync(resources, { recursive: true, force: true });
    }
  });
});
