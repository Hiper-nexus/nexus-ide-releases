import { describe, expect, it } from 'vitest';
import {
  isWslRuntimeUsable,
  planWslRuntime,
  wslCredentialSlot,
} from './wsl-runtime';

describe('WSL runtime backend (first cut)', () => {
  it('plans wsl.exe argv with distro, cwd and quoted command', () => {
    const plan = planWslRuntime({
      distro: 'Ubuntu',
      hostCwd: 'C:\\Users\\me\\project',
      command: ['npm', 'test', '--', 'file name.ts'],
    });
    expect(plan.argv.slice(0, 4)).toEqual(['-d', 'Ubuntu', '--cd', '/mnt/c/Users/me/project']);
    expect(plan.argv[4]).toBe('--exec');
    expect(plan.argv.slice(5, 7)).toEqual(['bash', '-lc']);
    expect(plan.argv[7]).toBe("npm test -- 'file name.ts'");
    expect(plan.credentialSlot).toBe('wsl:Ubuntu');
    expect(plan.windowsUncCwd).toContain('wsl.localhost\\Ubuntu');
  });

  it('maps WSL UNC host cwd to a Linux path inside the distro', () => {
    const plan = planWslRuntime({
      distro: 'Debian',
      hostCwd: '\\\\wsl.localhost\\Debian\\home\\me\\app',
      command: ['git', 'status'],
    });
    expect(plan.linuxCwd).toBe('/home/me/app');
  });

  it('credential slot is a safe identifier per distro', () => {
    expect(wslCredentialSlot('Ubuntu-22.04')).toBe('wsl:Ubuntu-22.04');
    expect(() => wslCredentialSlot('')).toThrow(/required/);
    expect(() => wslCredentialSlot('bad/name')).toThrow(/safe credential slot/);
  });

  it('refuses empty command or distro', () => {
    expect(() =>
      planWslRuntime({ distro: 'U', hostCwd: '/tmp', command: [] }),
    ).toThrow(/command is required/);
    expect(() =>
      planWslRuntime({ distro: '  ', hostCwd: '/tmp', command: ['ls'] }),
    ).toThrow(/distro is required/);
  });

  it('usability: WSL env without distro is not usable; with distro it is', () => {
    const env = { WSL_DISTRO_NAME: 'Ubuntu' } as NodeJS.ProcessEnv;
    expect(isWslRuntimeUsable(null, env)).toMatchObject({
      available: false,
      reason: 'wsl-present-distro-missing',
    });
    expect(isWslRuntimeUsable('Ubuntu', env)).toMatchObject({
      available: true,
      distroSlot: 'wsl:Ubuntu',
    });
    expect(isWslRuntimeUsable('Ubuntu', {} as NodeJS.ProcessEnv)).toMatchObject({
      available: false,
      reason: 'not-windows',
    });
  });

  it('treats a validated distro as proof on a Windows host without WSL env', () => {
    const env = {
      SystemRoot: 'C:\\Windows',
      OS: 'Windows_NT',
    } as NodeJS.ProcessEnv;
    expect(isWslRuntimeUsable('Ubuntu', env)).toMatchObject({
      available: true,
      reason: 'windows-host-listed-distro',
      distroSlot: 'wsl:Ubuntu',
    });
    expect(isWslRuntimeUsable(null, env)).toMatchObject({
      available: false,
      reason: 'windows-host-wsl-unverified',
      distroSlot: null,
    });
    expect(isWslRuntimeUsable('bad/name', env)).toMatchObject({
      available: false,
      reason: 'wsl-distro-name-unsafe',
      distroSlot: null,
    });
  });
});
