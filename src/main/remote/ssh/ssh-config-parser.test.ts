import { describe, expect, it } from 'vitest';
import {
  parseSshConfig,
  resolveSshHostConfig,
  sshHostPatternMatches,
} from './ssh-config-parser';

describe('parseSshConfig', () => {
  it('parses Host blocks with identity expansion', () => {
    const configs = parseSshConfig(
      `
Host dev
  HostName 10.0.0.1
  User deploy
  Port 2222
  IdentityFile ~/.ssh/dev_ed25519
Host *.lab
  User lab
`,
      { home: '/Users/me' },
    );
    expect(configs).toHaveLength(2);
    const dev = resolveSshHostConfig(configs, 'dev');
    expect(dev?.hostname).toBe('10.0.0.1');
    expect(dev?.port).toBe(2222);
    expect(dev?.identityFiles[0]).toBe('/Users/me/.ssh/dev_ed25519');
    expect(sshHostPatternMatches('*.lab', 'a.lab')).toBe(true);
    expect(resolveSshHostConfig(configs, 'x.lab')?.user).toBe('lab');
  });

  it('keeps the first value for a directive repeated in one Host block (OpenSSH semantics)', () => {
    const configs = parseSshConfig(`
Host dev
  Port 22
  Port 2222
  User first
  User second
`);
    const dev = resolveSshHostConfig(configs, 'dev');
    expect(dev?.port).toBe(22);
    expect(dev?.user).toBe('first');
  });
});
