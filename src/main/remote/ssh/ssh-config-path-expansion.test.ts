import { describe, expect, it } from 'vitest';
import { resolveSshConfigHomePath } from './ssh-config-path-expansion';

describe('resolveSshConfigHomePath', () => {
  it('expands ~ and ~/', () => {
    expect(resolveSshConfigHomePath('~', '/home/u')).toBe('/home/u');
    expect(resolveSshConfigHomePath('~/.ssh/id_ed25519', '/home/u')).toBe(
      '/home/u/.ssh/id_ed25519',
    );
  });

  it('leaves absolute paths unchanged', () => {
    expect(resolveSshConfigHomePath('/etc/ssh/key', '/home/u')).toBe('/etc/ssh/key');
  });
});
